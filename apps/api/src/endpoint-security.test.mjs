import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildApp} from './server.ts';
import {Storage} from './storage.ts';
import {
  routeCases,newRouteKeys,projectCases,workCases,experienceCases,securityFixture,
  inject,positive,unchanged,snapshot,safeResponse,makeProject,makeItem,makeWorkflow,
  projectId,workflowId,itemBody,workflowBody,context,annotationBody,saveWork,makeDecision,
} from './endpoint-security-fixture.mjs';
const headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:5173','x-sovrad-action':'1'};
const marker='synthetic-credential-never-in-http';
const expected=[
  'GET /api/health','GET /api/projects','GET /api/projects/:id/workflows','GET /api/workflows/:id',
  'POST /api/proposals','POST /api/proposals/:id/decision','GET /api/ai/status','POST /api/ai/proposal',
  'GET /api/implementation/status','GET /api/workflows/:id/tasks','POST /api/implementation/tasks',
  'GET /api/implementation/tasks/:id','GET /api/implementation/tasks/:id/events',
  'POST /api/implementation/tasks/:id/approve','POST /api/implementation/tasks/:id/start','POST /api/implementation/tasks/:id/cancel',
  'GET /api/imports/status','GET /api/imports','GET /api/imports/:id','POST /api/imports',
  'GET /api/workspace','POST /api/workspace/access','POST /api/projects',
  'POST /api/projects/:id/settings','GET /api/projects/:id/overview',
  'POST /api/projects/:id/items','POST /api/projects/:id/items/:itemId',
  'POST /api/projects/:id/workflows','POST /api/workflows/:id/layout','POST /api/projects/:id/repositories',
  'GET /api/annotations','POST /api/annotations','GET /api/work','GET /api/work/:id',
  'POST /api/work/:id/amend','POST /api/work/:id/cancel','GET /api/work/:id/events',
  'GET /api/decisions','POST /api/decisions/:id/action','GET /api/activity','GET /api/evidence',
  'GET /api/connections','POST /api/connections/:id/connect','POST /api/connections/:id/disconnect','GET /api/local-session',
].sort();

const hostileHeaders=[{host:'evil.example'},{origin:'https://evil.example'},{origin:'null'},{'sec-fetch-site':'cross-site'}];
const ownerActions=new Set(['POST /api/decisions/:id/action','POST /api/connections/:id/connect','POST /api/connections/:id/disconnect']);

// A separate positive fixture prevents a successful mutation from consuming the
// negative target. Every denial retains its real cookie/schema/context/versions.
for(const key of expected)test(`Task6 real positive and isolated boundary ${key}`,async t=>{
  const control=await securityFixture(t),controlCase=await routeCases[key](control);
  await positive(control,controlCase);
  const f=await securityFixture(t),c=await routeCases[key](f);
  for(const bad of hostileHeaders)await unchanged(f,c,{headers:bad},403);
  if(c.method==='GET') {
    const before=snapshot(f),head=await inject(f,c,{method:'HEAD'});
    assert.equal(head.statusCode,200);assert.equal(head.body,'');safeResponse(head);
    assert.equal(head.headers['set-cookie'],undefined);
    assert.deepEqual(snapshot(f),before,'HEAD on a stable authorized fixture is side-effect free');
    for(const bad of hostileHeaders)await unchanged(f,c,{method:'HEAD',headers:bad},403);
    await positive(f,c);
  } else {
    await unchanged(f,c,{omitHeaders:['x-sovrad-action']},403);
    await unchanged(f,c,{headers:{'x-sovrad-action':'0'}},403);
    await unchanged(f,c,{payload:{...c.payload,padding:'x'.repeat(17000)}},413);
    if(newRouteKeys.includes(key))await unchanged(f,c,{payload:{...c.payload,unexpected:true}},400);
    if(ownerActions.has(key))await positive(f,c);
    else {
      const r=await inject(f,c,{omitHeaders:['cookie']});
      assert.equal(r.statusCode,c.code,r.body);safeResponse(r);c.verify(r.json(),f);
    }
  }
});

test('manual proposals cannot persist or echo credential-like values, including the configured key',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'sovrad-secret-'));
  const storage=new Storage(directory);
  const app=buildApp(storage,{ai:{enabled:false,apiKey:marker}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const body={workflowId:'sample-calculator-arithmetic',stepId:'number-a',baseRevision:1,text:'A synthetic correction',proposedRules:['Finite numbers only'],explanation:'Synthetic'};
  assert.equal((await app.inject({method:'POST',url:'/api/proposals',headers,payload:body})).statusCode,201);
  for (const secret of [marker,'sk-'+'a'.repeat(30)]) {
    const rejected=await app.inject({method:'POST',url:'/api/proposals',headers,payload:{...body,explanation:secret}});
    assert.equal(rejected.statusCode,400);
    assert.ok(!rejected.body.includes(secret));
  }
  assert.equal(storage.proposals(body.workflowId).length,1);
});

test('Task5 literal non-HEAD surface is exactly45 and has every generated HEAD with no trusted-write or fixture endpoint',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'sovrad-task5-surface-'));
  const app=buildApp(new Storage(directory),{ai:{enabled:false}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  assert.equal(expected.length,45);assert.equal(new Set(expected).size,45);
  assert.deepEqual(Object.keys(routeCases).sort(),expected,'every literal route has an asserted valid action fixture');
  assert.deepEqual([Object.keys(projectCases).length,Object.keys(workCases).length,Object.keys(experienceCases).length],[10,7,8]);
  assert.equal(new Set(newRouteKeys).size,25);
  assert.deepEqual(app.routeInventory.filter(r=>r.method!=='HEAD').map(r=>r.method+' '+r.url).sort(),expected);
  assert.equal(app.routeInventory.filter(r=>r.method==='GET').length,23);
  assert.equal(app.routeInventory.filter(r=>r.method==='POST').length,22);
  assert.equal(app.routeInventory.length,68);
  assert.deepEqual(app.routeInventory.filter(r=>r.method==='HEAD').map(r=>r.url).sort(),app.routeInventory.filter(r=>r.method==='GET').map(r=>r.url).sort());
});

for(const key of newRouteKeys.filter(k=>k.startsWith('GET ')))test(`Task6 strict query on populated ${key}`,async t=>{
  const f=await securityFixture(t),c=await routeCases[key](f);await positive(f,c);
  await unchanged(f,c,{url:c.url+(c.url.includes('?')?'&':'?')+'unexpected=true'},400);
});

test('Task6 metadata and grant branches independently enforce action and owner-session prerequisites',async t=>{
  const f=await securityFixture(t),url=`/api/projects/${projectId}/settings`;
  const c={method:'POST',url,code:200,payload:{expectedGrantRevision:1,grant:'read_only'},verify:b=>assert.equal(b.project.grant,'read_only')};
  for(const bad of hostileHeaders)await unchanged(f,c,{headers:bad},403);
  await unchanged(f,c,{omitHeaders:['x-sovrad-action']},403);
  await unchanged(f,c,{payload:{...c.payload,padding:'x'.repeat(17000)}},413);
  for(const cookie of [null,'sovrad_local_action='+'z'.repeat(43),`${f.cookie}; ${f.cookie}`]) {
    const r=await unchanged(f,c,cookie===null?{omitHeaders:['cookie']}:{headers:{cookie}},403);
    assert.equal(r.json().code,'LOCAL_SESSION_REQUIRED');
  }
  const before=snapshot(f);
  await unchanged(f,c,{payload:{...c.payload,actor:'owner'}},400);
  assert.deepEqual(snapshot(f),before);
  await positive(f,c);
});

test('Task6 each owner Decision action has complete HTTP guards with an unconsumed current sibling',async t=>{
  for(const kind of ['approve','reject','request_revision']) {
    const control=await securityFixture(t);await positive(control,makeDecision(control,null,kind));
    const f=await securityFixture(t),c=makeDecision(f,null,kind);
    for(const bad of hostileHeaders)await unchanged(f,c,{headers:bad},403);
    await unchanged(f,c,{omitHeaders:['x-sovrad-action']},403);
    await unchanged(f,c,{url:c.url+'?unexpected=true'},400);
    await unchanged(f,c,{payload:{...c.payload,padding:'x'.repeat(17000)}},413);
    await positive(f,c);
  }
});

test('Task6 both connection targets retain null-origin and per-action guards with valid owner cookies',async t=>{
  for(const id of ['codex','chatgpt'])for(const action of ['connect','disconnect']) {
    const f=await securityFixture(t),c={...await routeCases[`POST /api/connections/:id/${action}`](f),url:`/api/connections/${id}/${action}`};
    // The shared disconnect verifier is codex-specific; chatgpt has its own
    // actual target record and positive response contract here.
    if(id==='chatgpt')c.verify=b=>{assert.equal(b.connection.id,id);assert.equal(b.connection.state,'unavailable');assert.deepEqual(b.connection.capabilities,[]);};
    for(const bad of hostileHeaders)await unchanged(f,c,{headers:bad},403);
    await unchanged(f,c,{omitHeaders:['x-sovrad-action']},403);
    await positive(f,c);
  }
});

test('Task6 layout validates nested keys and actual foreign nodes without changing semantic or presentation rows',async t=>{
  const f=await securityFixture(t),c=await projectCases['POST /api/workflows/:id/layout'](f);
  const q=makeProject(f),foreign=makeWorkflow(f,q.id);
  await unchanged(f,c,{payload:{...c.payload,positions:c.payload.positions.map((p,n)=>n? p:{...p,extra:true})}},400);
  await unchanged(f,c,{payload:{...c.payload,positions:c.payload.positions.map((p,n)=>n? p:{...p,stepId:foreign.steps[0].id})}},400);
  await positive(f,c);
});

test('Task6 project actions reject real foreign membership while their current same-project siblings succeed',async t=>{
  const f=await securityFixture(t),q=makeProject(f),foreign=makeItem(f,q.id),graph=makeWorkflow(f,q.id);
  const cases=[
    {c:{method:'GET',url:`/api/projects/${projectId}/overview?itemId=${foreign.id}`},code:404},
    {c:{method:'GET',url:`/api/projects/${projectId}/overview?workflowId=${graph.id}`},code:404},
    {c:{method:'POST',url:`/api/projects/${projectId}/items`,payload:{...itemBody(f),parentId:foreign.id}},code:400},
    {c:{method:'POST',url:`/api/projects/${projectId}/items`,payload:{...itemBody(f),workflowId:graph.id}},code:400},
    {c:{method:'POST',url:`/api/projects/${projectId}/items/${foreign.id}`,payload:{expectedMapRevision:1,name:'Fictional edit',description:'',development:'planning'}},code:404},
    {c:{method:'POST',url:`/api/projects/${projectId}/workflows`,payload:{...workflowBody(f),itemId:foreign.id}},code:400},
    {c:{method:'POST',url:`/api/projects/${projectId}/workflows`,payload:{...workflowBody(f),steps:[{...workflowBody(f).steps[0],childWorkflowId:graph.id}]}},code:400},
  ];
  assert.ok(f.storage.registry.overview(q.id).items.some(i=>i.id===foreign.id));
  assert.ok(f.storage.registry.overview(q.id).workflows.some(w=>w.id===graph.id));
  for(const {c,code}of cases)await unchanged(f,c,{},code);
  for(const key of ['POST /api/projects/:id/items','POST /api/projects/:id/workflows','POST /api/projects/:id/items/:itemId'])await positive(f,await projectCases[key](f));
});

test('Task6 amendment rejects valid foreign project context rather than a stale digest and preserves its real target',async t=>{
  const f=await securityFixture(t),saved=await saveWork(f),q=makeProject(f);
  const body=await annotationBody(f,{context:context(f,q.id,null,null)});
  const c={method:'POST',url:`/api/work/${saved.work.id}/amend`,payload:{...body,expectedVersion:saved.work.version}};
  await unchanged(f,c,{},404);
  const valid={...await annotationBody(f),expectedVersion:saved.work.version};
  const r=await inject(f,c,{payload:valid});assert.equal(r.statusCode,201,r.body);
  assert.equal(r.json().annotation.supersedesId,saved.annotation.id);
});

test('Task6 local annotation and amendment reject nested authority keys on schema-valid current material',async t=>{
  for(const key of ['POST /api/annotations','POST /api/work/:id/amend']) {
    const f=await securityFixture(t),c=await workCases[key](f);
    for(const payload of [{...c.payload,context:{...c.payload.context,grant:'synthetic_execute'}},
      {...c.payload,dispatch:{...c.payload.dispatch,adapter:'forged'}}])await unchanged(f,c,{payload},400);
    await unchanged(f,c,{url:c.url+'?unexpected=true'},400);
    await positive(f,c);
  }
});

test('Task6 cancellation refuses query authority keys on its current real Work',async t=>{
  const f=await securityFixture(t),c=await workCases['POST /api/work/:id/cancel'](f);
  await unchanged(f,c,{url:c.url+'?unexpected=true'},400);await positive(f,c);
});

test('Task6 hidden project targets refuse each remaining new mutation while registered-management preference stays usable',async t=>{
  for(const key of ['POST /api/projects/:id/settings','POST /api/projects/:id/items','POST /api/projects/:id/items/:itemId',
    'POST /api/projects/:id/workflows','POST /api/workflows/:id/layout','POST /api/projects/:id/repositories',
    'POST /api/work/:id/amend','POST /api/work/:id/cancel','POST /api/decisions/:id/action']) {
    const control=await securityFixture(t);await positive(control,await routeCases[key](control));
    const f=await securityFixture(t),c=await routeCases[key](f),q=makeProject(f);
    f.storage.registry.setAccess({mode:'selected',selectedProjectIds:[q.id]});
    // Reconcile expected revocation before snapshotting the denied request.
    f.storage.registry.workspace();await unchanged(f,c,{},404);
    const r=await inject(f,{method:'GET',url:'/api/workspace?management=true'});assert.equal(r.statusCode,200,r.body);
    assert.ok(r.json().management.projects.some(p=>p.id===projectId&&!p.selected));assert.equal(r.json().projects[0].id,q.id);
    assert.equal(f.storage.registry.project(q.id).name,'Fictional boundary project');
  }
});

test('Task6 Work match filters remain empty200 without leaking a populated foreign context',async t=>{
  const f=await securityFixture(t),saved=await saveWork(f),q=makeProject(f),graph=makeWorkflow(f,q.id);
  const other=await saveWork(f,{context:context(f,q.id,graph.id,graph.steps[0].id)});
  for(const route of ['annotations','work']) {
    const good=await inject(f,{method:'GET',url:`/api/${route}?projectId=${q.id}`});assert.equal(good.statusCode,200);
    assert.ok(good.json()[route].some(row=>row.id===(route==='work'?other.work.id:other.annotation.id)));
    const r=await inject(f,{method:'GET',url:`/api/${route}?projectId=${projectId}&workflowId=${graph.id}`});
    assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json()[route],[]);assert.ok(!r.body.includes(other.work.id));
  }
  assert.equal(f.storage.work.get(saved.work.id).projectId,projectId);
});
