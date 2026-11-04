import type Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function backupPath(directory: string): string {
  const backups = path.join(directory, 'backups');
  mkdirSync(backups, {recursive: true, mode: 0o700});
  return path.join(backups, `snapshot-${randomUUID()}.sqlite`);
}

export function migrate(db: Database.Database, directory: string, existing: boolean): void {
  const version = db.pragma('user_version', {simple: true}) as number;
  if (version > 4) throw new Error('Database is newer than this Sovrad version');
  if (version === 4) return;
  // VACUUM INTO is SQLite's consistent snapshot API and includes committed WAL data.
  if (existing) db.prepare('VACUUM INTO ?').run(backupPath(directory));
  db.transaction(() => {
    if (version < 1) db.exec(`CREATE TABLE ai_spending (
      id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown')),
      reserved_micros INTEGER NOT NULL CHECK(reserved_micros>=0),
      input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
      actual_micros INTEGER NOT NULL CHECK(actual_micros>=0), created_at TEXT NOT NULL
    );`);
    if (version < 2) db.exec(`CREATE TABLE implementation_tasks(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id),state TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE implementation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES implementation_tasks(id),kind TEXT NOT NULL,time TEXT NOT NULL,detail TEXT NOT NULL);`);
    if (version < 3) db.exec(`CREATE TABLE imported_snapshots(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE import_quarantines(id TEXT PRIMARY KEY,time TEXT NOT NULL,file_hash TEXT NOT NULL,reason TEXT NOT NULL);`);
    // Additive overlays preserve the original project, workflow and approval bytes.
    db.exec(`
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
    `);
    db.pragma('user_version = 4');
  }).immediate();
}
