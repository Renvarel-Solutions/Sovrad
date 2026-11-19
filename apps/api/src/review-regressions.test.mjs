import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Storage} from './storage.ts';
import {fixture,bootstrap,get,post,work,approveSpec,installAuthority,decisionInput,action,approved,running,evidence,passes,complete,views,conflict,sha} from './experience-fixture.mjs';

test('completed passing authority is permanently historical after deselect/reselect without any intervening read',async t=>{
  const f=fixture(t),r=await running(f);passes(f,r);complete(f,r);await views(f,r,'verified');
  const other=f.storage.registry.project('sample-workflow-navigation');
  const control=f.storage.decisions.create(decisionInput(f,null,{projectId:other.id,context:{projectId:other.id,mapRevision:other.mapRevision},
    binding:{...decisionInput(f).binding,mapRevision:other.mapRevision,grantRevision:other.grantRevision}}));
  const origin=structuredClone(r.binding),receipt=structuredClone(r.decision.receipt);
  // No GET, projection, Work read or explicit reconciliation between these writes.
  f.storage.registry.setAccess({mode:'selected',selectedProjectIds:[other.id]});
  f.storage.registry.setAccess({mode:'all_connected',selectedProjectIds:[]});
  const stale=await views(f,r,'stale');assert.equal(stale.work.state,'blocked');
  assert.equal(f.storage.executionBindings.current(r.work.id),null);
  assert.equal(f.storage.evidence.forWork(r.work.id).every(e=>e.freshness==='historical'),true);
  const replay=(await post(f,`/api/decisions/${r.decision.id}/action`,r.input)).json().decision;
  assert.equal(replay.status,'superseded');assert.deepEqual(replay.receipt,receipt);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT payload FROM execution_bindings WHERE id=?').get(origin.id).payload),origin);
  assert.equal((await post(f,`/api/decisions/${control.id}/action`,action(control))).statusCode,200,'the continuously accessible project is unaffected');
  const fresh=await running(f,{overrides:{context:{...r.work.context,stepId:'operator'}}});passes(f,fresh);complete(f,fresh);await views(f,fresh,'verified');
});

test('approved unconsumed receipt also revokes across a no-read access gap and never becomes reusable permission',async t=>{
  const f=fixture(t),r=await approved(f);assert.equal(r.decision.status,'approved');
  f.storage.registry.setAccess({mode:'selected',selectedProjectIds:['sample-workflow-navigation']});
  f.storage.registry.setAccess({mode:'all_connected',selectedProjectIds:[]});
  conflict(()=>f.storage.executionBindings.freeze({workId:r.work.id,expectedVersion:r.work.version,decisionId:r.decision.id}));
  const replay=(await post(f,`/api/decisions/${r.decision.id}/action`,r.input)).json().decision;
  assert.equal(replay.status,'superseded');assert.deepEqual(replay.receipt,r.decision.receipt);
  assert.equal(f.db.prepare('SELECT count(*) n FROM execution_bindings WHERE decision_id=?').get(r.decision.id).n,0);
  const fresh=await running(f,{overrides:{context:{...r.work.context,stepId:'number-b'}}});passes(f,fresh);complete(f,fresh);await views(f,fresh,'verified');
});

test('workflow-only independent runtime coverage completes and verifies its Work without inventing node coverage',async t=>{
  const f=fixture(t);await bootstrap(f);approveSpec(f);
  const context={projectId:'sample-calculator',workflowId:'sample-calculator-arithmetic',specRevision:2,mapRevision:1};
  const r=await running(f,{overrides:{context}});
  assert.equal(f.storage.registry.classifyWorkSource(context).scope,'independent_scope');
  const recorded=passes(f,r);assert.equal(recorded.length,2);assert.ok(recorded.every(e=>e.context.stepId===undefined&&e.context.itemId===undefined));
  const result=complete(f,r);assert.equal(result.state,'done');
  const detail=(await get(f,`/api/work/${r.work.id}`)).json();assert.equal(detail.verification,'verified');assert.equal(detail.freshness,'current');
  assert.deepEqual(detail.annotation,r.annotation);
  const graph=(await get(f,`/api/workflows/${context.workflowId}`)).json();
  assert.equal(graph.stepVerification.every(s=>s.verification==='not_checked'),true,'workflow-only success is never relabeled as any node');
  const normal=fixture(t,{trusted:false});await bootstrap(normal);approveSpec(normal);
  const candidate=await work(normal,{context});installAuthority(normal,candidate.work);
  assert.throws(()=>normal.storage.decisions.create(decisionInput(normal,candidate.work)),e=>e.status===403||e.status===409);
  assert.equal(normal.db.prepare('SELECT count(*) n FROM execution_bindings').get().n,0);
});

async function nested(t) {
  const f=fixture(t);await bootstrap(f);
  const p=f.storage.registry.create({clientRequestId:randomUUID(),name:'Fictional nested filter project',description:''}).project;
  const parent=f.storage.registry.saveItem(p.id,{clientRequestId:randomUUID(),expectedMapRevision:1,parentId:null,kind:'workflow',name:'Fictional root item',description:'',development:'planning',workflowId:null}).item;
  const node=(id,extra={})=>({id,title:id,purpose:'Review fictional context.',kind:'process',rules:['Retain selected scope.'],errorBehavior:'Explain a correction.',position:{x:0,y:0},...extra});
  const graph=(revision,name,steps,itemId=null)=>f.storage.registry.saveWorkflow(p.id,{clientRequestId:randomUUID(),expectedMapRevision:revision,itemId,name,description:'',steps,connections:[]}).workflow;
  const child=graph(2,'Reachable fictional child',[node('child-step')]);
  const unrelated=graph(3,'Unrelated fictional child',[node('unrelated-step')]);
  graph(4,'Fictional root',[node('root-step',{childWorkflowId:child.id})],parent.id);
  const context={projectId:p.id,itemId:parent.id,workflowId:child.id,stepId:'child-step',specRevision:1,mapRevision:5};
  assert.equal(f.storage.registry.resolveContext(context).step.id,'child-step');
  const saved=await work(f,{context,intent:'question'},{kind:'question',summary:'A bounded child discussion.',acceptance:[],ruleIds:[]});
  const decision=f.storage.decisions.create(decisionInput(f,saved.work));
  const record=f.storage.evidence.record({kind:'knowledge',projectId:p.id,workId:saved.work.id,context,sourceClass:'documentation',sourceRevision:null,
    environment:'fictional nested filter',checkedAt:new Date(f.now).toISOString(),outcome:'not_checked',summary:'Selected nested child documentation.'});
  return {f,p,parent,child,unrelated,context,decision,record};
}

for(const route of ['decisions','evidence','activity'])test(`${route} accepts populated reachable-child item context and refuses unrelated/cross-project context`,async t=>{
  const {f,p,parent,child,unrelated,decision,record}=await nested(t);
  const key=route==='activity'?'events':route;
  const unfiltered=await get(f,`/api/${route}?projectId=${p.id}`);assert.equal(unfiltered.statusCode,200,unfiltered.body);
  assert.ok(unfiltered.json()[key].length>0,'an actual matching record must exist before filter validation');
  const query=new URLSearchParams({projectId:p.id,itemId:parent.id,workflowId:child.id,stepId:'child-step'});
  const filtered=await get(f,`/api/${route}?${query}`);assert.equal(filtered.statusCode,200,filtered.body);
  assert.ok(filtered.json()[key].length>0);
  if(route==='decisions')assert.ok(filtered.json().decisions.some(d=>d.id===decision.id));
  if(route==='evidence')assert.ok(filtered.json().evidence.some(e=>e.id===record.id));
  for(const replacement of [{workflowId:unrelated.id,stepId:'unrelated-step'},{workflowId:'sample-calculator-arithmetic',stepId:'number-a'},{workflowId:child.id,stepId:'foreign-step'}]) {
    const invalid=new URLSearchParams({projectId:p.id,itemId:parent.id,...replacement});
    assert.equal((await get(f,`/api/${route}?${invalid}`)).statusCode,404);
  }
});

test('stale Work/node projections retain only the latest relevant historical attempt evidence IDs and time',async t=>{
  const f=fixture(t),a=await running(f);
  const oldRows=a.binding.acceptanceSnapshot.map(x=>evidence(f,a,x.id,{checkedAt:'2090-01-01T00:00:00.000Z'}));complete(f,a);await views(f,a,'verified');
  const original=structuredClone(f.facts.get(a.work.id));f.facts.get(a.work.id).sourceRevision=sha('First fictional source drift');
  f.storage.work.get(a.work.id);f.facts.set(a.work.id,original);
  const decision=f.storage.decisions.create(decisionInput(f,f.storage.work.get(a.work.id))),input=action(decision);
  const response=await post(f,`/api/decisions/${decision.id}/action`,input);assert.equal(response.statusCode,200,response.body);
  const next=f.storage.executionBindings.freeze({workId:a.work.id,expectedVersion:f.storage.work.get(a.work.id).version,decisionId:decision.id});
  const b={...a,...next};assert.notEqual(b.binding.id,a.binding.id);
  const latest=evidence(f,b,b.binding.acceptanceSnapshot[0].id,{checkedAt:'2026-11-11T09:00:00.000Z'});complete(f,b);
  assert.equal((await get(f,`/api/work/${b.work.id}`)).json().verification,'checking');
  f.facts.get(b.work.id).sourceRevision=sha('Second fictional source drift');
  await views(f,b,'stale');
  const graph=(await get(f,`/api/workflows/${b.work.context.workflowId}`)).json(),projection=graph.stepVerification.find(s=>s.stepId===b.work.context.stepId);
  assert.deepEqual(projection.evidenceIds,[latest.id]);assert.equal(projection.lastCheckedAt,latest.checkedAt);
  assert.equal(projection.evidenceIds.some(id=>oldRows.some(e=>e.id===id)),false,'another attempt cannot donate IDs or its later timestamp');
  const overview=(await get(f,'/api/projects/sample-calculator/overview')).json();
  assert.deepEqual(overview.workflows.find(w=>w.id===b.work.context.workflowId).stepVerification.find(s=>s.stepId===b.work.context.stepId),projection);
  assert.equal(f.storage.evidence.forWork(b.work.id).length,3,'all historical records remain available separately');
});

test('second-writer cancellation between evidence refresh and insert cannot reopen terminal Work or repair its lease chain',async t=>{
  const f=fixture(t),r=await running(f);complete(f,r);evidence(f,r,r.binding.acceptanceSnapshot[0].id);
  const timely=await running(f,{overrides:{context:{...r.work.context,stepId:'number-b'}}});passes(f,timely);complete(f,timely);await views(f,timely,'verified');
  const writer=new Storage(f.directory,{now:()=>f.now,authority:{current:w=>structuredClone(f.facts.get(w.id)??null)}});
  try {
  const before=f.db.prepare('SELECT * FROM controller_leases WHERE execution_binding_id=?').get(r.binding.id);
  const current=f.storage.work.get(r.work.id);assert.equal(current.state,'checking');
  const context=f.storage.evidence.c,original=context.refresh;let cancellations=0,cancelledVersion;
  context.refresh=function(){
    original.call(this);
    if(cancellations===0){
      const result=writer.work.cancel(r.work.id,{clientRequestId:randomUUID(),expectedVersion:current.version,reason:'Stop this fictional completed-but-unverified Work.'});
      cancellations++;cancelledVersion=result.work.version;assert.equal(result.work.state,'cancelled');
    }
  };
  let late;
  try {late=evidence(f,r,r.binding.acceptanceSnapshot[1].id);}finally{context.refresh=original;}
  assert.equal(cancellations,1,'the competing store must actually commit in the refresh/insert gap');
  const detail=(await get(f,`/api/work/${r.work.id}`)).json();
  assert.equal(detail.work.state,'cancelled');assert.equal(detail.work.version,cancelledVersion);
  assert.equal(f.storage.evidence.view(late.id).freshness,'historical');assert.equal(late.executionBindingId,r.binding.id);
  const after=f.db.prepare('SELECT * FROM controller_leases WHERE execution_binding_id=?').get(r.binding.id);
  assert.equal(after.state,'revoked');assert.equal(after.expected_work_version,before.expected_work_version,'never copy the unrelated cancellation version into a lease');
  assert.equal(detail.events.filter(e=>e.kind==='coverage_changed'&&e.sequence>detail.events.find(e=>e.kind==='cancelled').sequence).length,0);
  await views(f,timely,'verified');
  } finally {writer.close();}
});
