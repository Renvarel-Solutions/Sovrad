import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,bootstrap,get,post,work,approveSpec,installAuthority,decisionInput,action,conflict,sha} from './experience-fixture.mjs';

test('expired owner cookie alone refuses a still-live60minute Decision and renewed cookie resolves that same request',async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);
  const input=decisionInput(f);input.binding.expiresAt=new Date(f.now+3_600_000).toISOString();
  const d=f.storage.decisions.create(input),body=action(d),url=`/api/decisions/${d.id}/action`;
  f.advance(1_800_001);
  assert.ok(Date.parse(d.binding.expiresAt)>f.now,'Decision is still independently current');
  const before={decision:f.storage.decisions.raw(d.id),receipts:f.db.prepare('SELECT * FROM decision_receipts').all(),
    events:f.db.prepare('SELECT * FROM project_audit_events ORDER BY sequence').all(),requests:f.db.prepare('SELECT * FROM work_requests ORDER BY rowid').all()};
  const no=await post(f,url,body);assert.equal(no.statusCode,403,no.body);assert.equal(no.json().code,'LOCAL_SESSION_REQUIRED');
  assert.deepEqual({decision:f.storage.decisions.raw(d.id),receipts:f.db.prepare('SELECT * FROM decision_receipts').all(),
    events:f.db.prepare('SELECT * FROM project_audit_events ORDER BY sequence').all(),requests:f.db.prepare('SELECT * FROM work_requests ORDER BY rowid').all()},before);
  await bootstrap(f);
  const good=await post(f,url,body);assert.equal(good.statusCode,200,good.body);
  assert.equal(good.json().decision.id,d.id);assert.equal(good.json().decision.status,'approved');
  assert.equal(good.json().decision.receipt.sessionId,f.session.id);
});

test('real session cookie is hash-only nonrolling 30 minutes; HEAD does not mint; expiry renews',async t=>{
  const f=fixture(t);
  const head=await get(f,'/api/local-session',{},'HEAD');
  assert.equal(head.statusCode,200);assert.equal(head.headers['set-cookie'],undefined);
  const boot=await bootstrap(f),set=boot.headers['set-cookie'];
  for(const flag of ['Path=/api','HttpOnly','SameSite=Strict','Max-Age=1800']) assert.ok(String(set).includes(flag),flag);
  assert.ok(!String(set).includes('Domain='));
  const token=f.cookie.split('=')[1];assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(!boot.body.includes(token));
  assert.equal(Date.parse(f.session.expiresAt)-f.now,1_800_000);
  const rows=f.db.prepare('SELECT * FROM local_sessions').all();
  assert.equal(rows.length,1);assert.ok(JSON.stringify(rows).includes(sha(token)));assert.ok(!JSON.stringify(rows).includes(token));
  const original=structuredClone(f.session);f.advance(60_000);
  const again=await get(f,'/api/local-session',{cookie:f.cookie});assert.deepEqual(again.json().session,original);
  assert.equal(again.headers['set-cookie'],undefined);
  f.advance(1_800_000);
  const no=await post(f,'/api/connections/codex/disconnect',{});assert.equal(no.statusCode,403);assert.equal(no.json().code,'LOCAL_SESSION_REQUIRED');
  await bootstrap(f);assert.notEqual(f.session.id,original.id);
});

for(const kind of ['approve','reject','request_revision']) test(`owner ${kind} is atomic, immutable, session-bound and replayed once`,async t=>{
  const f=fixture(t);await bootstrap(f);
  const saved=await work(f,{},null),input=decisionInput(f,saved.work),d=f.storage.decisions.create(input);
  assert.equal(d.version,1);assert.equal(d.status,'pending');assert.match(d.proposalDigest,/^[a-f0-9]{64}$/);assert.ok(d.sequence>0);
  assert.deepEqual(f.storage.decisions.create({...input,explanation:{...input.explanation}}),d);
  conflict(()=>f.storage.decisions.create({...input,explanation:{...input.explanation,recovery:'Another recovery'}}));
  const a=action(d,kind),url=`/api/decisions/${d.id}/action`;
  for(const cookie of [null,'sovrad_local_action=forged',`${f.cookie}; ${f.cookie}`]) assert.equal((await post(f,url,a,cookie)).statusCode,403);
  for(const extra of [{actor:'local-owner-session'},{sessionId:f.session.id},{receipt:{}},{status:'approved'}]) assert.equal((await post(f,url,{...a,...extra})).statusCode,400);
  assert.equal((await post(f,url,{...a,expectedVersion:9})).statusCode,409);
  assert.equal((await post(f,url,{...a,proposalDigest:'f'.repeat(64)})).statusCode,409);
  const good=await post(f,url,a);assert.equal(good.statusCode,200,good.body);
  const resolved=good.json().decision;
  assert.equal(resolved.status,{approve:'approved',reject:'rejected',request_revision:'revision_requested'}[kind]);
  assert.equal(resolved.receipt.actor,'local-owner-session');assert.equal(resolved.receipt.sessionId,f.session.id);
  assert.equal(resolved.receipt.reason,a.reason);assert.equal(resolved.receipt.action,kind);assert.equal(resolved.receipt.proposalDigest,d.proposalDigest);
  const detail=(await get(f,`/api/work/${saved.work.id}`)).json();assert.equal(detail.work.state,'blocked');assert.ok(detail.events.length>1);
  const before=f.db.prepare('SELECT * FROM project_audit_events ORDER BY sequence').all();
  assert.ok(before.length>0);assert.deepEqual((await post(f,url,a)).json().decision,resolved);
  assert.deepEqual(f.db.prepare('SELECT * FROM project_audit_events ORDER BY sequence').all(),before);
  assert.equal((await post(f,url,{...a,reason:'Changed reason'})).statusCode,409);
  assert.equal((await post(f,url,action(resolved))).statusCode,409);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_bindings').get().n,0,'resolution cannot launch');
});

test('one pending Decision per non-null Work: second different action is a no-write409; null Work unrestricted',async t=>{
  const f=fixture(t);await bootstrap(f);const x=await work(f,{},null),y=await work(f,{},null);
  const input=decisionInput(f,x.work),a=f.storage.decisions.create(input);
  const before={work:f.storage.work.get(x.work.id),events:f.db.prepare('SELECT * FROM work_events').all(),requests:f.db.prepare('SELECT * FROM work_requests').all()};
  const b=decisionInput(f,f.storage.work.get(x.work.id));b.binding.action='different_review';
  conflict(()=>f.storage.decisions.create(b));
  assert.deepEqual(f.storage.work.get(x.work.id),before.work);assert.deepEqual(f.db.prepare('SELECT * FROM work_events').all(),before.events);
  assert.deepEqual(f.db.prepare('SELECT * FROM work_requests').all(),before.requests);
  assert.equal(f.storage.decisions.create(input).id,a.id);
  assert.ok(f.storage.decisions.create(decisionInput(f,y.work)).id);
  for(let n=0;n<3;n++) assert.ok(f.storage.decisions.create(decisionInput(f)).id);
  const row=f.db.prepare('SELECT * FROM decisions WHERE id=?').get(a.id);
  const keys=Object.keys(row).filter(k=>k!=='sequence'),values=keys.map(k=>k==='id'?randomUUID():row[k]);
  assert.throws(()=>f.db.prepare(`INSERT INTO decisions(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...values),/UNIQUE/i);
  assert.equal((await post(f,`/api/decisions/${a.id}/action`,action(a))).statusCode,200);
});

test('exact action replay reconciles current revocation/expiry while original receipt stays immutable',async t=>{
  const f=fixture(t);await bootstrap(f);
  const d=f.storage.decisions.create(decisionInput(f)),a=action(d),url=`/api/decisions/${d.id}/action`;
  const first=(await post(f,url,a)).json().decision;assert.equal(first.status,'approved');
  f.advance(600_001);
  const expired=await post(f,url,a);assert.equal(expired.statusCode,200,expired.body);
  assert.equal(expired.json().decision.status,'expired');assert.deepEqual(expired.json().decision.receipt,first.receipt);
  const sibling=f.storage.decisions.create(decisionInput(f));assert.equal((await post(f,`/api/decisions/${sibling.id}/action`,action(sibling))).statusCode,200);
  f.storage.registry.setAccess({mode:'selected',selectedProjectIds:['sample-workflow-navigation']});
  assert.equal((await post(f,url,a)).statusCode,404);
});

test('125 pending Decisions exhaust 50/50/25 with full totals, same-view digest and persistent sequences',async t=>{
  const f=fixture(t);await bootstrap(f);
  const all=Array.from({length:125},()=>f.storage.decisions.create(decisionInput(f)));
  const pages=[];let after=0;
  do {const r=await get(f,`/api/decisions?state=pending&limit=50&afterSequence=${after}`);assert.equal(r.statusCode,200,r.body);
    const p=r.json();assert.equal(p.total,125);pages.push(p);after=p.page.nextAfterSequence;if(!p.page.hasMore)break;
  }while(pages.length<4);
  assert.deepEqual(pages.map(p=>p.decisions.length),[50,50,25]);
  assert.equal(new Set(pages.flatMap(p=>p.decisions.map(d=>d.id))).size,125);
  assert.equal(new Set(pages.map(p=>p.page.viewDigest)).size,1);
  const filter={projectId:null,itemId:null,workflowId:null,stepId:null,state:'pending',limit:50};
  assert.equal(pages[0].page.viewDigest,sha({filter,rows:all.map(({id,sequence,version,status})=>({id,sequence,version,status}))}));
  const ws=(await get(f,'/api/workspace')).json();assert.equal(ws.pendingDecisions.length,50);assert.equal(ws.pendingDecisionCount,125);
  await f.reopen();await bootstrap(f);
  assert.deepEqual((await get(f,'/api/decisions?state=pending')).json().decisions.map(d=>d.sequence),all.slice(0,50).map(d=>d.sequence));
  const last=all.at(-1);assert.equal((await post(f,`/api/decisions/${last.id}/action`,action(last))).statusCode,200);
  assert.equal((await get(f,'/api/workspace')).json().pendingDecisionCount,124);
});

test('queue viewDigest detects equal-total replacement, widening and status updates; excluded project does not change scoped view',async t=>{
  const f=fixture(t);await bootstrap(f);
  const a=f.storage.decisions.create(decisionInput(f));f.storage.decisions.create(decisionInput(f));
  const url='/api/decisions?projectId=sample-calculator&state=pending&limit=1';
  const first=(await get(f,url)).json();assert.equal(first.total,2);
  await post(f,`/api/decisions/${a.id}/action`,action(a,'reject'));f.storage.decisions.create(decisionInput(f));
  const replacement=(await get(f,url)).json();assert.equal(replacement.total,2);assert.notEqual(replacement.page.viewDigest,first.page.viewDigest);
  const p=f.storage.registry.project('sample-workflow-navigation');
  f.storage.decisions.create(decisionInput(f,null,{projectId:p.id,context:{projectId:p.id,mapRevision:p.mapRevision},binding:{...decisionInput(f).binding,mapRevision:p.mapRevision,grantRevision:p.grantRevision}}));
  assert.equal((await get(f,url)).json().page.viewDigest,replacement.page.viewDigest);
  f.storage.registry.setAccess({mode:'selected',selectedProjectIds:[p.id]});const narrow=(await get(f,'/api/decisions')).json();
  f.storage.registry.setAccess({mode:'all_connected',selectedProjectIds:[]});const wide=(await get(f,'/api/decisions')).json();
  assert.ok(wide.total>narrow.total);assert.notEqual(wide.page.viewDigest,narrow.page.viewDigest);
});

for(const field of ['repositoryId','baseCommit','sourceRevision','specDigest','specReceiptId','acceptanceDigest','manifestDigest','acceptanceSnapshot']) test(`runtime approval independently refuses changed ${field}; layout sibling approves`,async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);
  const x=await work(f),y=await work(f);installAuthority(f,x.work);installAuthority(f,y.work);
  const a=f.storage.decisions.create(decisionInput(f,x.work)),b=f.storage.decisions.create(decisionInput(f,y.work));
  const facts=f.facts.get(x.work.id);facts[field]=field==='acceptanceSnapshot'?[{id:'foreign',description:'Changed'}]:field==='baseCommit'?'b'.repeat(40):sha(`changed ${field}`);
  assert.equal((await post(f,`/api/decisions/${a.id}/action`,action(a))).statusCode,409);
  const w=f.storage.workflow(y.work.context.workflowId);
  f.storage.registry.saveLayout(w.id,{expectedLayoutRevision:0,positions:w.steps.map(s=>({stepId:s.id,x:s.position.x+20,y:s.position.y}))});
  assert.equal((await post(f,`/api/decisions/${b.id}/action`,action(b))).statusCode,200);
});

test('strict decision/activity/evidence queries and present project visibility precede continuation',async t=>{
  const f=fixture(t);await bootstrap(f);f.storage.decisions.create(decisionInput(f));
  for(const route of ['decisions','evidence','activity']) {
    assert.equal((await get(f,`/api/${route}`)).statusCode,200);
    for(const query of ['limit=0','limit=101','limit=1&limit=2','afterSequence=-1','afterSequence=9007199254740992','cursor=x','all=true','unknown=x','projectId=missing']) {
      assert.equal((await get(f,`/api/${route}?${query}`)).statusCode,query==='projectId=missing'?404:400,`${route}?${query}`);
    }
    assert.equal((await get(f,`/api/${route}?state=imaginary`)).statusCode,400);
  }
  assert.equal((await get(f,'/api/activity?state=done')).statusCode,400);
  assert.equal((await get(f,'/api/decisions?stepId=number-a&workflowId=sample-navigation-main')).statusCode,404);
});

for(const kind of ['approve','reject','request_revision']) test(`${kind} permits exact empty reason; reason remains bounded/private and preserves whitespace`,async t=>{
  const f=fixture(t);await bootstrap(f);const d=f.storage.decisions.create(decisionInput(f)),url=`/api/decisions/${d.id}/action`;
  for(const reason of ['x'.repeat(2001),'password="fictional-secret-value"']) assert.equal((await post(f,url,action(d,kind,{reason}))).statusCode,400);
  const good=await post(f,url,action(d,kind,{reason:''}));assert.equal(good.statusCode,200,good.body);assert.equal(good.json().decision.receipt.reason,'');
  const sibling=f.storage.decisions.create(decisionInput(f));const exact='  Reviewed\nwith spaces  ';
  assert.equal((await post(f,`/api/decisions/${sibling.id}/action`,action(sibling,kind,{reason:exact}))).json().decision.receipt.reason,exact);
});
