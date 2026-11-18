import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,bootstrap,get,post,work,approveSpec,installAuthority,decisionInput,action,approved,running,evidence,passes,complete,views,conflict,forbidden,sha,draft} from './experience-fixture.mjs';

const node=async f=>(await get(f,'/api/workflows/sample-calculator-arithmetic')).json().stepVerification.find(s=>s.stepId==='number-a');
const current=f=>f.storage.registry.project('sample-calculator');
function item(f,development='planning',parentId=null) {
  return f.storage.registry.saveItem('sample-calculator',{clientRequestId:randomUUID(),expectedMapRevision:current(f).mapRevision,
    parentId,kind:'feature',name:'Fictional feature',description:'Synthetic metadata',development,workflowId:'sample-calculator-arithmetic'}).item;
}
function itemContext(f,i) {return {projectId:'sample-calculator',itemId:i.id,workflowId:'sample-calculator-arithmetic',stepId:'number-a',specRevision:f.storage.workflow('sample-calculator-arithmetic').revision,mapRevision:current(f).mapRevision};}
function editRawItem(f,i,extra) {
  const value={...i,...extra};
  f.db.prepare('UPDATE project_items SET parent_id=?,payload=? WHERE id=?').run(value.parentId,JSON.stringify(value),i.id);
}

test('normal production Storage has null authority and cannot turn spec/session/consent into runtime permission',async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);approveSpec(f);
  const saved=await work(f);installAuthority(f,saved.work);
  assert.throws(()=>f.storage.decisions.create(decisionInput(f,saved.work)),e=>e.status===403||e.status===409);
  assert.equal(f.db.prepare('SELECT count(*) n FROM execution_bindings').get().n,0);
  assert.equal((await get(f,`/api/work/${saved.work.id}`)).json().verification,'not_checked');
});

test('one-use receipt freezes original identities, monotonic fence, separate interpretation/runtime phase and legitimate version chain',async t=>{
  const f=fixture(t),r=await running(f);
  assert.match(r.binding.id,/^[0-9a-f-]{36}$/);assert.match(r.binding.attemptId,/^[0-9a-f-]{36}$/);
  assert.equal(r.binding.workVersion,r.work.version+1);assert.equal(r.binding.annotationId,r.annotation.id);
  assert.equal(r.binding.annotationRevision,r.annotation.revision);assert.deepEqual(r.binding.acceptanceSnapshot,r.work.interpretation.acceptance);
  assert.equal(r.binding.specDigest,sha(f.storage.workflow(r.work.context.workflowId)));
  const snapshot=f.db.prepare('SELECT * FROM execution_bindings WHERE id=?').get(r.binding.id);
  const outbox=f.db.prepare('SELECT * FROM work_outbox WHERE work_id=?').all(r.work.id);assert.equal(outbox.length,1);assert.equal(outbox[0].phase,'runtime');
  conflict(()=>f.storage.executionBindings.freeze({workId:r.work.id,expectedVersion:r.binding.workVersion,decisionId:r.decision.id}));
  passes(f,r);assert.equal(f.storage.work.get(r.work.id).version,r.binding.workVersion,'active evidence does not advance Work');
  await views(f,r,'checking');
  const done=complete(f,r);assert.equal(done.state,'done');assert.equal(done.version,r.binding.workVersion+1);
  assert.equal(f.db.prepare('SELECT expected_work_version FROM controller_leases WHERE execution_binding_id=?').get(r.binding.id).expected_work_version,done.version);
  await views(f,r,'verified');
  assert.deepEqual(f.db.prepare('SELECT * FROM execution_bindings WHERE id=?').get(r.binding.id),snapshot,'frozen bytes never follow lifecycle');
  conflict(()=>f.storage.executionBindings.freeze({workId:r.work.id,expectedVersion:done.version,decisionId:r.decision.id}));
  const sibling=await running(f);assert.ok(sibling.binding.leaseFence>0);assert.notEqual(sibling.binding.attemptId,r.binding.attemptId);
});

test('completion without evidence stays Checking; passing coverage needs completed success in every projection',async t=>{
  const f=fixture(t),r=await running(f);
  const checking=complete(f,r);assert.equal(checking.state,'checking');await views(f,r,'not_checked');
  evidence(f,r);await views(f,r,'checking');
  evidence(f,r,r.binding.acceptanceSnapshot[1].id);const detail=await views(f,r,'verified');assert.equal(detail.work.state,'done');
  assert.deepEqual(detail.annotation,r.annotation,'original material/consent immutable');
  assert.equal((await get(f,'/api/workspace')).json().counts.done,1);
  assert.equal((await get(f,'/api/work')).json().work.find(w=>w.id===r.work.id).state,'done');
});

test('passing evidence before runtime completion and failed runtime never become Done or Verified',async t=>{
  const f=fixture(t),r=await running(f);passes(f,r);
  const before=await views(f,r,'checking');assert.equal(before.work.state,'working');
  const failed=complete(f,r,'failed');assert.equal(failed.state,'blocked');await views(f,r,'failed');
  for(const a of r.binding.acceptanceSnapshot) evidence(f,r,a.id,{checkedAt:'2099-01-01T00:00:00.000Z'});
  await views(f,r,'failed');
});

test('current acceptance failure wins beside a later pass; knowledge/observed-code cannot supply test coverage',async t=>{
  const f=fixture(t),r=await running(f);complete(f,r);passes(f,r);
  await views(f,r,'verified');evidence(f,r,r.binding.acceptanceSnapshot[0].id,{outcome:'failed'});
  evidence(f,r,r.binding.acceptanceSnapshot[0].id,{outcome:'passed',checkedAt:'2099-01-01T00:00:00.000Z'});
  const blocked=await views(f,r,'failed');assert.equal(blocked.work.state,'blocked');
  const other=await running(f,{overrides:{context:{...r.work.context,stepId:'number-b'}}});complete(f,other);
  evidence(f,other,other.binding.acceptanceSnapshot[0].id,{sourceClass:'observed_code'});
  const k=f.storage.evidence.record({kind:'knowledge',projectId:other.work.projectId,workId:other.work.id,context:other.work.context,
    sourceClass:'observed_code',sourceRevision:'a'.repeat(40),environment:'synthetic',checkedAt:new Date(f.now).toISOString(),outcome:'passed',summary:'Code exists but no tests were run.'});
  assert.equal(k.executionBindingId,null);assert.equal(k.acceptanceId,null);
  assert.equal((await get(f,`/api/work/${other.work.id}`)).json().verification,'not_checked');
});

test('runtime recorder rejects unknown/mismatched handles and foreign acceptance without rows, while valid control records',async t=>{
  const f=fixture(t),r=await running(f);
  const count=()=>f.db.prepare('SELECT count(*) n FROM project_evidence').get().n;
  for(const extra of [{executionBindingId:randomUUID()},{attemptId:randomUUID()},{leaseFence:r.handle.leaseFence+1},{acceptanceId:'not-in-snapshot'}]) {
    conflict(()=>evidence(f,r,r.binding.acceptanceSnapshot[0].id,extra));assert.equal(count(),0);
  }
  const e=evidence(f,r);assert.equal(e.executionBindingId,r.binding.id);assert.equal(count(),1);assert.equal(f.storage.evidence.view(e.id).freshness,'current');
});

test('heartbeat and completion obey active Decision TTL; successful completion before TTL survives time/restart but cannot relaunch',async t=>{
  const f=fixture(t),good=await running(f);passes(f,good);complete(f,good);
  const active=await running(f,{overrides:{context:{...good.work.context,stepId:'number-b'}}});
  f.advance(5_000);const lease=f.storage.executionBindings.heartbeat(active.handle);assert.equal(Date.parse(lease.expiresAt),f.now+20_000);
  conflict(()=>f.storage.executionBindings.heartbeat({...active.handle,leaseFence:active.handle.leaseFence+1}));
  // Extend actively in bounded increments up to (but never beyond) the Decision TTL.
  while(f.now+5_000<Date.parse(active.decision.binding.expiresAt)){f.advance(5_000);f.storage.executionBindings.heartbeat(active.handle);}
  f.advance(5_001);conflict(()=>f.storage.executionBindings.heartbeat(active.handle));conflict(()=>complete(f,active));
  assert.equal((await get(f,`/api/work/${active.work.id}`)).json().work.state,'blocked');
  await views(f,good,'verified');await f.reopen();await bootstrap(f);await views(f,good,'verified');
  conflict(()=>f.storage.executionBindings.freeze({workId:good.work.id,expectedVersion:f.storage.work.get(good.work.id).version,decisionId:good.decision.id}));
  const replay=await post(f,`/api/decisions/${good.decision.id}/action`,good.input);assert.equal(replay.statusCode,200);assert.equal(replay.json().decision.status,'approved');
});

test('expired lease blocks active completion; startup interrupts active only and a fresh reviewed Work succeeds',async t=>{
  const f=fixture(t),a=await running(f);f.advance(20_001);conflict(()=>complete(f,a));
  assert.equal((await get(f,`/api/work/${a.work.id}`)).json().work.state,'blocked');
  const b=await running(f,{overrides:{context:{...a.work.context,stepId:'number-b'}}});
  await f.reopen();await bootstrap(f);assert.equal((await get(f,`/api/work/${b.work.id}`)).json().work.state,'blocked');
  const c=await running(f,{overrides:{context:{...a.work.context,stepId:'operator'}}});passes(f,c);complete(f,c);await views(f,c,'verified');
});

test('A callback after revoke/regrant, replacement B and restart preserves A identities as historical; fresh C succeeds',async t=>{
  const f=fixture(t),a=await running(f),origin=structuredClone(a.binding);
  f.storage.registry.setGrant('sample-calculator',{expectedGrantRevision:current(f).grantRevision,grant:'read_only'});
  f.storage.registry.setGrant('sample-calculator',{expectedGrantRevision:current(f).grantRevision,grant:'synthetic_execute'});
  const b=await running(f);passes(f,b);complete(f,b);
  await f.reopen();await bootstrap(f);
  const late=evidence(f,a),view=f.storage.evidence.view(late.id);
  assert.equal(view.freshness,'historical');assert.equal(late.executionBindingId,origin.id);assert.deepEqual(late.context,origin.context);
  assert.equal(late.sourceRevision,origin.sourceRevision);assert.equal(late.workId,origin.workId);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT payload FROM execution_bindings WHERE id=?').get(origin.id).payload),origin);
  assert.notEqual((await get(f,`/api/work/${a.work.id}`)).json().work.state,'done');
  assert.equal((await get(f,`/api/work/${b.work.id}`)).json().verification,'verified');
  const c=await running(f,{overrides:{context:{...b.work.context,stepId:'number-b'}}});passes(f,c);complete(f,c);await views(f,c,'verified');
});

for(const field of ['sourceRevision','manifestDigest','acceptanceDigest','specReceiptId']) test(`pre-read cached ${field} drift permanently revokes completed authority without registry writes`,async t=>{
  const f=fixture(t),r=await running(f);passes(f,r);complete(f,r);await views(f,r,'verified');
  const history=f.storage.evidence.forWork(r.work.id).map(e=>({...e,freshness:undefined,staleReason:undefined}));
  const original=structuredClone(f.facts.get(r.work.id));f.facts.get(r.work.id)[field]=sha(`drift ${field}`);
  // First read is a global count: stale Done must disappear without an explicit mutation endpoint.
  assert.equal((await get(f,'/api/workspace')).json().counts.done,0);
  const stale=await views(f,r,'stale');assert.equal(stale.work.state,'blocked');
  const replay=(await post(f,`/api/decisions/${r.decision.id}/action`,r.input)).json().decision;
  assert.equal(replay.status,'superseded');assert.deepEqual(replay.receipt,r.decision.receipt);
  f.facts.set(r.work.id,original);await views(f,r,'stale');assert.equal(f.storage.executionBindings.current(r.work.id),null);
  assert.deepEqual(f.storage.evidence.forWork(r.work.id).map(e=>({...e,freshness:undefined,staleReason:undefined})),history);
});

test('an unrelated Work.version update cannot repair a runtime lease chain',async t=>{
  const f=fixture(t),r=await running(f);
  const original=f.storage.work.get(r.work.id),changed={...original,version:original.version+1};
  f.db.prepare('UPDATE work_items SET version=?,payload=? WHERE id=?').run(changed.version,JSON.stringify(changed),changed.id);
  evidence(f,r);assert.equal(f.storage.evidence.forWork(r.work.id)[0].freshness,'historical');
  conflict(()=>complete(f,r));assert.equal(f.storage.executionBindings.current(r.work.id),null);
});

test('required Works never combine complementary partial passes, and latest amendment removes only its predecessor',async t=>{
  const f=fixture(t),a=await running(f);complete(f,a);const b=await running(f);complete(f,b);
  evidence(f,a,a.binding.acceptanceSnapshot[0].id);evidence(f,b,b.binding.acceptanceSnapshot[1].id);
  assert.equal((await node(f)).verification,'checking');
  evidence(f,b,b.binding.acceptanceSnapshot[0].id);assert.equal((await get(f,`/api/work/${b.work.id}`)).json().verification,'verified');
  assert.equal((await node(f)).verification,'checking','incomplete independent A remains required');
  const input=await draft(f,{text:'Amend only the first Work to a local note.',dispatch:{mode:'local',consent:false}});
  const amended=await post(f,`/api/work/${a.work.id}/amend`,{...input,expectedVersion:f.storage.work.get(a.work.id).version});
  assert.equal(amended.statusCode,201,amended.body);assert.equal((await node(f)).verification,'verified');
});

test('unknown/empty implementation requirements remain required and block an otherwise Verified sibling',async t=>{
  const f=fixture(t),good=await running(f);passes(f,good);complete(f,good);await views(f,good,'verified');
  await work(f,{}, {kind:'implementation',summary:'Acceptance is unresolved.',acceptance:[],ruleIds:[]});
  assert.equal((await node(f)).verification,'not_checked');
  await work(f,{intent:'question'}, {kind:'implementation',summary:'A question is not implementation authority.',acceptance:[],ruleIds:[]});
  assert.equal((await node(f)).verification,'not_checked');
});

test('all evidence beyond display cap participates: late failure blocks and late complete passes verify independently',async t=>{
  const f=fixture(t),a=await running(f);complete(f,a);
  for(let n=0;n<125;n++) evidence(f,a,null,{summary:`Fictional diagnostic ${n}`});
  passes(f,a);await views(f,a,'verified');
  const list=(await get(f,'/api/evidence?limit=100')).json();assert.equal(list.evidence.length,100);assert.equal(list.total,127);assert.equal(list.page.hasMore,true);
  evidence(f,a,a.binding.acceptanceSnapshot[0].id,{outcome:'failed'});await views(f,a,'failed');
  const page=(await get(f,`/api/evidence?afterSequence=${list.page.nextAfterSequence}&limit=100`)).json();assert.equal(page.evidence.length,28);
  const empty=(await get(f,`/api/evidence?afterSequence=${page.page.nextAfterSequence}`)).json();assert.equal(empty.page.nextAfterSequence,page.page.nextAfterSequence);
  assert.equal(empty.page.hasMore,false);assert.deepEqual(empty.evidence,[]);
});

for(const ancestor of [false,true]) for(const intent of ['instruction','rule']) for(const promoteFuture of [false,true]) test(`future ${ancestor?'ancestor':'item'} ${intent} promotion=${promoteFuture} is interpreted but never executable or required`,async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);
  const parent=ancestor?item(f,'future'):null,selected=item(f,ancestor?'planning':'future',parent?.id ?? null);
  const context=itemContext(f,selected),saved=await work(f,{context,intent,promoteFuture});installAuthority(f,saved.work);
  assert.equal(f.storage.registry.classifyWorkSource(context).scope,'future');
  forbidden(()=>f.storage.decisions.create(decisionInput(f,saved.work)));
  forbidden(()=>f.storage.executionBindings.freeze({workId:saved.work.id,expectedVersion:saved.work.version,decisionId:randomUUID()}));
  assert.equal(f.db.prepare('SELECT count(*) n FROM execution_bindings').get().n,0);
  const good=await running(f);passes(f,good);complete(f,good);await views(f,good,'verified');
  assert.equal(f.storage.registry.items('sample-calculator').find(i=>i.id===selected.id).development,selected.development);
});

for(const intent of ['future_plan','question']) for(const promoteFuture of [false,true]) test(`fresh-consented future ${intent} promotion=${promoteFuture} reaches only interpretation; local/missing consent stays unsent`,async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);const selected=item(f,'future'),context=itemContext(f,selected);
  const saved=await work(f,{context,intent,promoteFuture},{kind:intent,summary:'Planning or discussion only.',acceptance:[],ruleIds:[]});
  assert.equal(saved.work.interpretation.kind,intent);assert.equal(f.db.prepare('SELECT count(*) n FROM execution_bindings').get().n,0);
  const bad=await post(f,'/api/annotations',await draft(f,{context,intent,dispatch:{mode:'connected',consent:false}}));assert.equal(bad.statusCode,400);
  const local=await work(f,{context,intent,dispatch:{mode:'local',consent:false}},null);
  const {WorkController}=await import('./work-controller.ts');let calls=0;
  await new WorkController(f.storage.work,{target:'codex',async interpret(){calls++;return {kind:intent,summary:'Must not be sent',acceptance:[],ruleIds:[]};}}).dispatchPending(local.work.id);
  assert.equal(calls,0);assert.equal(f.storage.work.get(local.work.id).interpretation,null);
});

for(const corrupt of ['missing','cycle','cross-project','over-limit','unknown-development']) test(`unresolved ${corrupt} ancestry remains required/nonverifying and cannot freeze; independent scope stays valid`,async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);let foreignItem=null;
  if(corrupt==='cross-project') {
    const foreign=f.storage.registry.create({clientRequestId:randomUUID(),name:'Fictional foreign ancestry project',description:'Synthetic classifier control.'}).project;
    foreignItem=f.storage.registry.saveItem(foreign.id,{clientRequestId:randomUUID(),expectedMapRevision:1,parentId:null,kind:'feature',
      name:'Fictional foreign ancestor',description:'Same-lab explicit foreign fixture.',development:'planning',workflowId:null}).item;
  }
  const selected=item(f),context=itemContext(f,selected);
  const r=await running(f,{overrides:{context}});passes(f,r);complete(f,r);await views(f,r,'verified');
  const independent=await running(f);passes(f,independent);complete(f,independent);
  f.db.pragma('foreign_keys=OFF');
  if(corrupt==='missing') editRawItem(f,selected,{parentId:'missing-parent'});
  if(corrupt==='cycle') editRawItem(f,selected,{parentId:selected.id});
  if(corrupt==='cross-project') {
    assert.ok(foreignItem);assert.notEqual(foreignItem.projectId,selected.projectId);editRawItem(f,selected,{parentId:foreignItem.id});
  }
  if(corrupt==='unknown-development') editRawItem(f,selected,{development:'unclassified'});
  if(corrupt==='over-limit') {
    let child=selected;
    for(let n=0;n<101;n++) {
      const parent={...selected,id:randomUUID(),workflowId:null,parentId:null};
      f.db.prepare('INSERT INTO project_items(id,project_id,parent_id,workflow_id,payload) VALUES (?,?,?,?,?)').run(parent.id,parent.projectId,null,null,JSON.stringify(parent));
      editRawItem(f,child,{parentId:parent.id});child=parent;
    }
  }
  assert.equal(f.storage.registry.classifyWorkSource(context).scope,'unknown');
  assert.equal((await get(f,`/api/work/${independent.work.id}`)).json().verification,'verified');
  assert.equal((await node(f)).verification,'stale','unknown required Work must not vanish to reveal sibling success');
  assert.equal((await get(f,`/api/work/${r.work.id}`)).json().work.state,'blocked');
  editRawItem(f,selected,{parentId:null,development:'planning'});assert.equal(f.storage.registry.classifyWorkSource(context).scope,'current');
  assert.equal((await node(f)).verification,'stale','repair does not revive old consumed authority');
});

test('current item becoming future excludes required Work but revokes its consumed authority permanently; explicit no-item scope remains independent',async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);const selected=item(f),context=itemContext(f,selected);
  const r=await running(f,{overrides:{context}});passes(f,r);complete(f,r);
  const independent=await running(f);passes(f,independent);complete(f,independent);await views(f,r,'verified');
  editRawItem(f,selected,{development:'future'});
  assert.equal(f.storage.registry.classifyWorkSource(independent.work.context).scope,'independent_scope');
  assert.equal((await get(f,`/api/work/${r.work.id}`)).json().work.state,'blocked');
  assert.equal((await get(f,`/api/work/${independent.work.id}`)).json().verification,'verified');assert.equal((await node(f)).verification,'verified');
  editRawItem(f,selected,{development:'planning'});assert.equal((await node(f)).verification,'stale');
});

test('global active runtime restriction is atomic: second eligible Work waits with no binding/consumption/event writes',async t=>{
  const f=fixture(t),a=await running(f),b=await approved(f);
  const before={bindings:f.db.prepare('SELECT * FROM execution_bindings ORDER BY rowid').all(),
    events:f.db.prepare('SELECT * FROM work_events ORDER BY sequence').all(),work:f.storage.work.get(b.work.id),
    leases:f.db.prepare('SELECT * FROM controller_leases ORDER BY rowid').all()};
  conflict(()=>f.storage.executionBindings.freeze({workId:b.work.id,expectedVersion:b.work.version,decisionId:b.decision.id}));
  assert.deepEqual(f.db.prepare('SELECT * FROM execution_bindings ORDER BY rowid').all(),before.bindings);
  assert.deepEqual(f.db.prepare('SELECT * FROM work_events ORDER BY sequence').all(),before.events);
  assert.deepEqual(f.db.prepare('SELECT * FROM controller_leases ORDER BY rowid').all(),before.leases);
  assert.deepEqual(f.storage.work.get(b.work.id),before.work);
  complete(f,a);
  const frozen=f.storage.executionBindings.freeze({workId:b.work.id,expectedVersion:b.work.version,decisionId:b.decision.id});
  assert.equal(frozen.binding.workId,b.work.id);assert.notEqual(frozen.binding.attemptId,a.binding.attemptId);
});

test('runtime Decision approval rechecks current/future ancestry independently of creation and promotion flag',async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);const selected=item(f),context=itemContext(f,selected);
  const saved=await work(f,{context,intent:'instruction',promoteFuture:true});installAuthority(f,saved.work);
  const d=f.storage.decisions.create(decisionInput(f,saved.work));editRawItem(f,selected,{development:'future'});
  const r=await post(f,`/api/decisions/${d.id}/action`,action(d));assert.equal(r.statusCode,403,r.body);
  assert.equal(f.db.prepare('SELECT count(*) n FROM execution_bindings').get().n,0);
});

for(const change of ['grant','map','spec','approved-spec-receipt']) test(`completed runtime reconciles real-store ${change} change before any status view`,async t=>{
  const f=fixture(t),r=await running(f);passes(f,r);complete(f,r);await views(f,r,'verified');
  if(change==='grant')f.storage.registry.setGrant('sample-calculator',{expectedGrantRevision:current(f).grantRevision,grant:'read_only'});
  if(change==='map')f.storage.registry.updateSettings('sample-calculator',{expectedGrantRevision:current(f).grantRevision,name:'Updated fictional label'});
  if(change==='spec')approveSpec(f);
  if(change==='approved-spec-receipt')f.db.prepare('DELETE FROM audit_events WHERE id=?').run(r.binding.specReceiptId);
  const listed=(await get(f,'/api/work')).json().work.find(w=>w.id===r.work.id);assert.equal(listed.state,'blocked');
  await views(f,r,'stale');assert.equal((await get(f,'/api/workspace')).json().counts.done,0);
  assert.equal(f.storage.evidence.forWork(r.work.id).every(e=>e.freshness==='historical'),true);
});

test('current planning-development item succeeds while local/question/future_plan notes cannot fabricate required coverage',async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);const selected=item(f,'planning');
  const r=await running(f,{overrides:{context:itemContext(f,selected)}});passes(f,r);complete(f,r);await views(f,r,'verified');
  await work(f,{intent:'question'}, {kind:'implementation',summary:'A discussion only.',acceptance:[],ruleIds:[]});
  await work(f,{intent:'future_plan',promoteFuture:true},{kind:'implementation',summary:'A proposed future change only.',acceptance:[],ruleIds:[]});
  await work(f,{dispatch:{mode:'local',consent:false}},null);
  assert.equal((await node(f)).verification,'verified');
  const other=(await get(f,'/api/workflows/sample-navigation-main')).json().stepVerification;
  assert.equal(other.every(s=>s.verification==='not_checked'),true,'empty required Work set never verifies');
});

test('internal evidence schemas are strict and privacy-screened; activity uses one persisted monotonic safe journal',async t=>{
  const f=fixture(t),r=await running(f);passes(f,r);complete(f,r);
  const body={kind:'runtime',...r.handle,sourceClass:'test_runtime',environment:'synthetic',checkedAt:new Date(f.now).toISOString(),acceptanceId:r.binding.acceptanceSnapshot[0].id,outcome:'passed',summary:'Fictional check'};
  const before=f.db.prepare('SELECT count(*) n FROM project_evidence').get().n;
  for(const extra of [{actor:'owner'},{sourceRevision:'forged'},{context:r.work.context},{summary:'password="fictional-secret-value"'}]) assert.throws(()=>f.storage.evidence.record({...body,...extra}));
  assert.equal(f.db.prepare('SELECT count(*) n FROM project_evidence').get().n,before);
  const activity=await get(f,'/api/activity?limit=100');assert.equal(activity.statusCode,200,activity.body);
  const a=activity.json();assert.ok(a.events.length>0);assert.ok(a.events.every((e,n)=>n===0||e.sequence>a.events[n-1].sequence));
  for(const e of a.events) assert.deepEqual(Object.keys(e).sort(),['detail','kind','sequence','time']);
  assert.ok(!activity.body.includes(f.cookie.split('=')[1]));
  await f.reopen();const next=(await get(f,`/api/activity?afterSequence=${a.nextAfterSequence}`)).json();
  assert.ok(next.events.every(e=>e.sequence>a.nextAfterSequence));
  const last=next.nextAfterSequence;const empty=(await get(f,`/api/activity?afterSequence=${last}`)).json();assert.equal(empty.nextAfterSequence,last);
});

test('unknown missing item without any prior binding remains required not_checked/unknown beside a verified independent sibling',async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);const selected=item(f),context=itemContext(f,selected);
  const unresolved=await work(f,{context});
  assert.equal((await get(f,`/api/work/${unresolved.work.id}`)).json().verification,'not_checked');
  const control=await running(f);passes(f,control);complete(f,control);
  assert.equal((await get(f,`/api/work/${control.work.id}`)).json().verification,'verified');
  assert.equal((await node(f)).verification,'not_checked','the unbound implementation sibling is already required');
  f.db.pragma('foreign_keys=OFF');f.db.prepare('DELETE FROM project_items WHERE id=?').run(selected.id);
  assert.equal(f.storage.registry.classifyWorkSource(context).scope,'unknown');
  assert.equal(f.db.prepare('SELECT count(*) n FROM execution_bindings WHERE work_id=?').get(unresolved.work.id).n,0);
  const detail=(await get(f,`/api/work/${unresolved.work.id}`)).json();
  assert.equal(detail.verification,'not_checked');assert.equal(detail.freshness,'unknown');
  assert.equal((await node(f)).verification,'not_checked');
  assert.equal((await get(f,`/api/work/${control.work.id}`)).json().verification,'verified');
});

test('successful completion retains approval after TTL alone, then authority revocation supersedes its immutable receipt',async t=>{
  const f=fixture(t),r=await running(f);passes(f,r);complete(f,r);await views(f,r,'verified');
  f.advance(600_001);await views(f,r,'verified');
  const stillApproved=(await post(f,`/api/decisions/${r.decision.id}/action`,r.input)).json().decision;
  assert.equal(stillApproved.status,'approved');assert.deepEqual(stillApproved.receipt,r.decision.receipt);
  f.facts.get(r.work.id).sourceRevision=sha('Changed source after factual completion and expired launch permission.');
  await views(f,r,'stale');
  const revoked=await post(f,`/api/decisions/${r.decision.id}/action`,r.input);assert.equal(revoked.statusCode,200,revoked.body);
  assert.equal(revoked.json().decision.status,'superseded');assert.deepEqual(revoked.json().decision.receipt,r.decision.receipt);
  const late=evidence(f,r);assert.equal(f.storage.evidence.view(late.id).freshness,'historical');
});
