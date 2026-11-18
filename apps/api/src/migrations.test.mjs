import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {CALCULATOR_PROJECT, CALCULATOR_WORKFLOW} from '@renvarel/architect-core';
import {Storage} from './storage.ts';
import {buildApp} from './server.ts';

// Explicit historical DDL: v0 predates spending, v1 adds it, v2 adds tasks,
// and v3 adds imports. No fixture depends on Git history being available.
const baseline = `
  CREATE TABLE projects(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE workflows(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE proposals(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id),status TEXT NOT NULL CHECK(status IN ('draft','approved','rejected')),payload TEXT NOT NULL);
  CREATE TABLE audit_events(id TEXT PRIMARY KEY,time TEXT NOT NULL,action TEXT NOT NULL,workflow_id TEXT NOT NULL,base_revision INTEGER NOT NULL,resulting_revision INTEGER,proposal_id TEXT NOT NULL,specification_json TEXT NOT NULL);
  CREATE TABLE ai_daily_usage(day TEXT PRIMARY KEY,requests INTEGER NOT NULL CHECK(requests >= 0));
  CREATE TABLE workflow_revisions(workflow_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workflow_id,revision));
`;
const spending = `CREATE TABLE ai_spending(
  id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown')),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros>=0),input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
  actual_micros INTEGER NOT NULL CHECK(actual_micros>=0),created_at TEXT NOT NULL);`;
const tasks = `
  CREATE TABLE implementation_tasks(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id),state TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE implementation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES implementation_tasks(id),kind TEXT NOT NULL,time TEXT NOT NULL,detail TEXT NOT NULL);
`;
const imports = `
  CREATE TABLE imported_snapshots(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE import_quarantines(id TEXT PRIMARY KEY,time TEXT NOT NULL,file_hash TEXT NOT NULL,reason TEXT NOT NULL);
`;
// Frozen historical v4/v5 DDL. These fixtures never open a current Storage then
// downgrade user_version: that would conceal upgrade bugs and fake old state.
const registryV4 = `
  CREATE TABLE project_metadata(project_id TEXT PRIMARY KEY REFERENCES projects(id),payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),payload TEXT NOT NULL);
  CREATE TABLE project_items(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),parent_id TEXT REFERENCES project_items(id),workflow_id TEXT REFERENCES workflows(id),payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),payload TEXT NOT NULL);
  CREATE INDEX project_items_project ON project_items(project_id);
  CREATE TABLE project_dependencies(project_id TEXT NOT NULL REFERENCES projects(id),source_item_id TEXT NOT NULL REFERENCES project_items(id),target_item_id TEXT NOT NULL REFERENCES project_items(id),PRIMARY KEY(source_item_id,target_item_id));
  CREATE TABLE repository_candidates(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),alias TEXT NOT NULL,absolute_path TEXT NOT NULL,state TEXT NOT NULL CHECK(state='pending'));
  CREATE INDEX repository_candidates_project ON repository_candidates(project_id);
  CREATE TABLE project_evidence(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_id TEXT,execution_binding_id TEXT,payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),payload TEXT NOT NULL);
  CREATE INDEX project_evidence_project ON project_evidence(project_id);
  CREATE TABLE workspace_access(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
  CREATE TABLE project_requests(scope TEXT NOT NULL,request_id TEXT NOT NULL,input_json TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(scope,request_id));
  CREATE TABLE project_audit_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,time TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE workflow_layouts(workflow_id TEXT PRIMARY KEY REFERENCES workflows(id),layout_revision INTEGER NOT NULL,payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),payload TEXT NOT NULL);
`;
const workV5 = `
  CREATE TABLE annotations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),supersedes_id TEXT REFERENCES annotations(id),revision INTEGER NOT NULL CHECK(revision>0),payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),material_json TEXT NOT NULL,material_digest TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE INDEX annotations_project ON annotations(project_id);
  CREATE TABLE annotation_consent_receipts(annotation_id TEXT PRIMARY KEY REFERENCES annotations(id),payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),payload TEXT NOT NULL);
  CREATE TABLE work_items(id TEXT PRIMARY KEY,annotation_id TEXT NOT NULL UNIQUE REFERENCES annotations(id),project_id TEXT NOT NULL REFERENCES projects(id),state TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),payload TEXT NOT NULL);
  CREATE INDEX work_items_project ON work_items(project_id,state);
  CREATE TABLE work_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,work_id TEXT NOT NULL REFERENCES work_items(id),kind TEXT NOT NULL,time TEXT NOT NULL,detail TEXT NOT NULL);
  CREATE INDEX work_events_work ON work_events(work_id,sequence);
  CREATE TABLE work_requests(scope TEXT NOT NULL,request_id TEXT NOT NULL,input_json TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(scope,request_id));
  CREATE TABLE work_outbox(id TEXT PRIMARY KEY,work_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),annotation_id TEXT NOT NULL REFERENCES annotations(id),state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','revoked')),fence INTEGER NOT NULL DEFAULT 0,expires_at TEXT,actual_target TEXT,grant_revision INTEGER NOT NULL,payload_version INTEGER NOT NULL DEFAULT 1 CHECK(payload_version=1),created_at TEXT NOT NULL);
  CREATE INDEX work_outbox_pending ON work_outbox(state,work_id);
`;
const day = new Date().toISOString().slice(0, 10);
const time = '2026-01-01T00:00:00.000Z';
const legacy = {...CALCULATOR_WORKFLOW, id: 'fictional-legacy-workflow', projectId: 'fictional-legacy-project', revision: 2};

function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sovrad-migration-'));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    rmSync(directory, {recursive: true, force: true});
  });
  return {directory, cleanup};
}

function snapshot(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table');
  const rows = Object.fromEntries(tables.map(({name}) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  ]));
  return {version: db.pragma('user_version', {simple: true}), schema, rows};
}

function historical(t, version) {
  const {directory, cleanup} = temporary(t);
  const filename = path.join(directory, 'sovrad.sqlite');
  const db = new Database(filename);
  cleanup.push(() => { if (db.open) db.close(); });
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(baseline);
  if (version >= 1) db.exec(spending);
  if (version >= 2) db.exec(tasks);
  if (version >= 3) db.exec(imports);
  if (version >= 4) db.exec(registryV4);
  if (version >= 5) db.exec(workV5);
  db.pragma(`user_version = ${version}`);
  db.prepare('INSERT INTO projects VALUES (?,?)').run(legacy.projectId, JSON.stringify({...CALCULATOR_PROJECT, id: legacy.projectId}));
  db.prepare('INSERT INTO workflows VALUES (?,?,?,?)').run(legacy.id, legacy.projectId, 2, JSON.stringify(legacy));
  db.prepare('INSERT INTO workflow_revisions VALUES (?,?,?)').run(legacy.id, 1, JSON.stringify({...legacy, revision: 1}));
  db.pragma('wal_checkpoint(TRUNCATE)');
  const mainHash = createHash('sha256').update(readFileSync(filename)).digest('hex');
  // All rows below live in WAL while the original handle remains open.
  db.prepare('INSERT INTO ai_daily_usage VALUES (?,7)').run(day);
  db.prepare('INSERT INTO proposals VALUES (?,?,?,?)').run('fictional-proposal', legacy.id, 'approved', '{"synthetic":true}');
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)').run('fictional-receipt', time, 'approve', legacy.id, 1, 2, 'fictional-proposal', JSON.stringify(legacy));
  if (version >= 1) {
    const insert = db.prepare('INSERT INTO ai_spending VALUES (?,?,?,?,?,?)');
    insert.run('settled-charge', 'settled', 20_500, 1000, 3700, time);
    insert.run('pending-charge', 'pending', 19_250, 500, 0, time);
    insert.run('unknown-charge', 'unknown', 18_250, 100, 0, time);
  }
  if (version >= 2) {
    db.prepare('INSERT INTO implementation_tasks VALUES (?,?,?,?)').run('fictional-task', legacy.id, 'cancelled', '{"synthetic":true}');
    db.prepare('INSERT INTO implementation_events(task_id,kind,time,detail) VALUES (?,?,?,?)').run('fictional-task', 'cancelled', time, 'Synthetic receipt');
  }
  if (version >= 3) {
    db.prepare('INSERT INTO imported_snapshots VALUES (?,?)').run('fictional-snapshot', '{"synthetic":true}');
    db.prepare('INSERT INTO import_quarantines VALUES (?,?,?,?)').run('fictional-quarantine', time, 'a'.repeat(64), 'Synthetic refusal');
  }
  if(version>=4) {
    const context={projectId:legacy.projectId,workflowId:legacy.id,stepId:'number-a',specRevision:2,mapRevision:1};
    const value={id:'legacy-knowledge',projectId:legacy.projectId,workId:null,context,sourceClass:'documentation',sourceRevision:null,
      environment:'fictional historical v4',checkedAt:time,acceptanceId:null,outcome:'not_checked',summary:'Historical documentation only.',executionBindingId:null};
    db.prepare('INSERT INTO project_evidence(id,project_id,work_id,execution_binding_id,payload) VALUES (?,?,?,?,?)').run(value.id,legacy.projectId,null,null,JSON.stringify(value));
  }
  if(version>=5) {
    const context={projectId:legacy.projectId,workflowId:legacy.id,stepId:'number-a',specRevision:2,mapRevision:1};
    const material={schemaVersion:1,context:{...context,itemId:null},text:'Fictional historical local note.',target:'codex',intent:'question',promoteFuture:false,
      selection:{project:{id:legacy.projectId,name:'Historical sample',description:''},item:null,workflow:{id:legacy.id,name:legacy.name,description:legacy.description,revision:2},
        step:{id:'number-a',title:legacy.steps[0].title,purpose:legacy.steps[0].purpose,rules:legacy.steps[0].rules,inputs:[],outputs:[],errorBehavior:legacy.steps[0].errorBehavior}}};
    const materialJSON=JSON.stringify(material),digest=createHash('sha256').update(materialJSON).digest('hex');
    const annotation={clientRequestId:'00000000-0000-4000-8000-000000000005',context,text:material.text,target:'codex',intent:'question',promoteFuture:false,
      dispatch:{mode:'local',consent:false,contextDigest:digest},id:'historical-note',revision:1,supersedesId:null,createdAt:time,consentReceipt:null,material,materialJSON};
    const work={id:'historical-work',annotationId:annotation.id,projectId:legacy.projectId,parentWorkId:null,context,version:1,state:'new',interpretation:null,blockers:[],updatedAt:time};
    db.prepare('INSERT INTO annotations(id,project_id,supersedes_id,revision,material_json,material_digest,payload) VALUES (?,?,?,?,?,?,?)').run(annotation.id,legacy.projectId,null,1,materialJSON,digest,JSON.stringify(annotation));
    db.prepare('INSERT INTO work_items(id,annotation_id,project_id,state,version,payload) VALUES (?,?,?,?,?,?)').run(work.id,annotation.id,legacy.projectId,'new',1,JSON.stringify(work));
    db.prepare('INSERT INTO work_events(work_id,kind,time,detail) VALUES (?,?,?,?)').run(work.id,'created',time,'Synthetic local note retained.');
  }
  assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), mainHash, 'fixture rows must not already be checkpointed');
  assert.ok(statSync(filename + '-wal').size > 32, 'fixture must contain committed WAL frames');
  return {db, directory, cleanup, before: snapshot(db)};
}

for (const version of [0, 1, 2, 3]) {
  test(`schema v${version} preserves historical WAL rows and backs up before bootstrap or history backfill`, t => {
    const {db, directory, cleanup, before} = historical(t, version);
    const storage = new Storage(directory);
    cleanup.push(() => storage.close());
    if (version < 6) {
      const backups = readdirSync(path.join(directory, 'backups'));
      assert.equal(backups.length, 1);
      const backup = new Database(path.join(directory, 'backups', backups[0]), {readonly: true});
      try {
        assert.equal(backup.pragma('integrity_check', {simple: true}), 'ok');
        assert.deepEqual(snapshot(backup), before, 'backup must match the exact pre-bootstrap schema and data, including WAL');
      } finally { backup.close(); }
    } else {
      assert.ok(!readdirSync(directory).includes('backups'), 'current schema needs no migration backup');
    }
    assert.equal(db.pragma('user_version', {simple: true}), 6);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (table === 'projects' || table === 'workflows' || table === 'workflow_revisions') continue;
      assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table);
    }
    assert.deepEqual(storage.projects().find(project => project.id === legacy.projectId), {...CALCULATOR_PROJECT, id: legacy.projectId});
    assert.deepEqual(storage.workflow(legacy.id), legacy);
    assert.deepEqual(storage.history(legacy.id), [
      {revision: 1, workflow: {...legacy, revision: 1}},
      {revision: 2, workflow: legacy},
    ], 'existing history must be retained and the missing current snapshot backfilled after backup');
    assert.equal(storage.budget.status().dailyAttempts, 7);
    assert.equal(storage.budget.status().spentMicros, version === 0 ? 0 : 3700);
    assert.equal(storage.budget.status().reservedMicros, version === 0 ? 0 : 37_500);
    assert.equal(storage.budget.status().paused, version !== 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ai_spending').get().n, version === 0 ? 0 : 3);
  });
}

test('newer schema is rejected without changing source bytes, schema, data or journal mode', t => {
  const {directory, cleanup} = temporary(t);
  const filename = path.join(directory, 'sovrad.sqlite');
  const db = new Database(filename);
  cleanup.push(() => db.close());
  db.exec("CREATE TABLE future_only(id TEXT PRIMARY KEY,value TEXT); INSERT INTO future_only VALUES ('fictional','preserve'); PRAGMA user_version=7;");
  const before = snapshot(db);
  const hash = createHash('sha256').update(readFileSync(filename)).digest('hex');
  // Capture the rejected handle only for cleanup if the broken constructor leaks it.
  const original = Database.prototype.pragma;
  let rejected;
  Database.prototype.pragma = function (...args) { if (this !== db) rejected = this; return original.apply(this, args); };
  try {
    assert.throws(() => new Storage(directory), /newer/i);
    assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), hash);
    assert.equal(db.pragma('journal_mode', {simple: true}), 'delete');
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(readdirSync(directory).sort(), ['sovrad.sqlite']);
    assert.equal(rejected?.open, false, 'rejected database handle must be closed');
  } finally {
    Database.prototype.pragma = original;
    if (rejected?.open) rejected.close();
  }
});

test('initialization closes its database handle when bootstrap fails', t => {
  const {directory} = temporary(t);
  const original = Database.prototype.exec;
  let rejected;
  Database.prototype.exec = function () { rejected = this; throw new Error('Synthetic bootstrap failure'); };
  try {
    assert.throws(() => new Storage(directory), /Synthetic bootstrap failure/);
    assert.ok(rejected, 'must reach database bootstrap');
    assert.equal(rejected.open, false, 'failed initialization must close its handle');
  } finally {
    Database.prototype.exec = original;
    if (rejected?.open) rejected.close();
  }
});

test('unclean exit retains unknown charge and blocks the next fake paid request after reopen', async t => {
  const {directory, cleanup} = temporary(t);
  const childEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {Storage} from ${JSON.stringify(new URL('./storage.ts', import.meta.url).href)};
    const storage = new Storage(process.argv[1]);
    storage.reserveAIRequest(new Date().toISOString().slice(0, 10), 10);
    const id = storage.budget.reserve(1000);
    storage.budget.unknown(id);
    process.exit(29);
  `, directory], {env: childEnv, encoding: 'utf8', windowsHide: true});
  assert.equal(child.status, 29, child.stderr);
  const storage = new Storage(directory);
  let providerCalls = 0;
  const app = buildApp(storage, {ai: {enabled: true, apiKey: 'synthetic-migration-key', hardLimitConfirmed: true,
    fetch: async () => { providerCalls++; throw new Error('Paid transport must remain blocked'); },
  }});
  cleanup.push(() => app.close());
  const status = storage.budget.status();
  assert.equal(status.paused, true);
  assert.equal(status.reservedMicros, 20_500);
  assert.equal(status.dailyAttempts, 1);
  const response = await app.inject({method: 'POST', url: '/api/ai/proposal',
    headers: {host: '127.0.0.1:4317', origin: 'http://127.0.0.1:5173', 'x-sovrad-action': '1'},
    payload: {workflowId: CALCULATOR_WORKFLOW.id, stepId: 'number-a', baseRevision: 1, text: 'Accept whole numbers', sendToAI: true},
  });
  assert.equal(response.statusCode, 429, response.body);
  assert.match(response.json().error, /paused/i);
  assert.equal(providerCalls, 0);
  assert.equal(storage.budget.status().dailyAttempts, 1);
});

for(const version of [0,1,2,3,4,5]) test(`Task5 genuine historical v${version} upgrades to v6 and exact WAL backup predates all startup writes`,t=>{
  const {db,directory,cleanup,before}=historical(t,version);
  const storage=new Storage(directory);let closed=false;cleanup.push(()=>{if(!closed)storage.close();});
  assert.equal(db.pragma('user_version',{simple:true}),6);
  const backups=readdirSync(path.join(directory,'backups'));assert.equal(backups.length,1);
  const backup=new Database(path.join(directory,'backups',backups[0]),{readonly:true});
  try {assert.equal(backup.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(snapshot(backup),before);}
  finally {backup.close();}
  assert.equal(storage.budget.status().dailyAttempts,7);
  assert.equal(storage.budget.status().spentMicros,version===0?0:3700);
  assert.equal(storage.budget.status().reservedMicros,version===0?0:37_500);
  assert.deepEqual(storage.workflow(legacy.id),legacy);
  assert.equal(db.prepare('SELECT id FROM audit_events WHERE id=?').get('fictional-receipt').id,'fictional-receipt');
  for(const table of ['annotations','annotation_consent_receipts','work_items','work_events','project_evidence']) {
    const old=before.rows[table];if(!old?.length)continue;
    const columns=Object.keys(old[0]);
    assert.deepEqual(db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all(),old,`${table} original rows preserved`);
  }
  if(version>=4) assert.ok(db.prepare('SELECT sequence FROM project_evidence WHERE id=?').get('legacy-knowledge').sequence>0);
  for(const table of ['decisions','execution_bindings','controller_leases','connections','local_sessions']) assert.ok(db.prepare('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name=?').get(table),table);
  storage.close();closed=true;
  const reopened=new Storage(directory);cleanup.push(()=>reopened.close());
  assert.equal(db.pragma('user_version',{simple:true}),6);assert.equal(readdirSync(path.join(directory,'backups')).length,1);
  assert.equal(reopened.budget.status().dailyAttempts,7);
});

test('Task5 future v7 refuses before WAL/schema/bootstrap mutations',t=>{
  const {directory,cleanup}=temporary(t),filename=path.join(directory,'sovrad.sqlite'),db=new Database(filename);
  cleanup.push(()=>db.close());db.exec("CREATE TABLE future_only(id TEXT PRIMARY KEY,value TEXT); INSERT INTO future_only VALUES ('synthetic','preserve'); PRAGMA user_version=7;");
  const before=snapshot(db),bytes=readFileSync(filename);
  assert.throws(()=>new Storage(directory),/newer/i);assert.deepEqual(snapshot(db),before);assert.deepEqual(readFileSync(filename),bytes);
  assert.deepEqual(readdirSync(directory),['sovrad.sqlite']);assert.equal(db.pragma('journal_mode',{simple:true}),'delete');
});
