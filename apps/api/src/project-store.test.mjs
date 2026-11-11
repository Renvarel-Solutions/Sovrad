import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Storage} from './storage.ts';
import {buildApp} from './server.ts';
import {CALCULATOR_WORKFLOW} from '@renvarel/architect-core';

const headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:5173','x-sovrad-action':'1'};
function setup(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'sovrad-projects-'));
  const storage=new Storage(directory);
  const app=buildApp(storage,{ai:{enabled:false,apiKey:'synthetic-registry-key'}});
  const db=new Database(path.join(directory,'sovrad.sqlite'));
  t.after(async()=>{db.close();await app.close();rmSync(directory,{recursive:true,force:true});});
  return {storage,app,db};
}
const create=(app,name='Fictional planner',clientRequestId=crypto.randomUUID())=>app.inject({method:'POST',url:'/api/projects',headers,payload:{clientRequestId,name,description:'Synthetic planning only'}});
const item=(revision,name,development='planning',extra={})=>({clientRequestId:crypto.randomUUID(),expectedMapRevision:revision,parentId:null,kind:'feature',name,description:'Synthetic',development,workflowId:null,...extra});

test('existing calculator upgrades with unchanged IDs rules and ledger', async t=>{
  const {storage,db}=setup(t);
  const before=JSON.stringify(storage.workflow(CALCULATOR_WORKFLOW.id));
  const history=JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id));
  storage.reserveAIRequest(new Date().toISOString().slice(0,10),10);
  const reservation=storage.budget.reserve(50);
  storage.budget.unknown(reservation);
  assert.ok(storage.registry,'ProjectStore integration must be present');
  const listed=storage.registry.list();
  assert.ok(listed.some(p=>p.id==='sample-calculator'&&p.grant==='synthetic_execute'));
  assert.ok(listed.some(p=>p.id==='sample-workflow-navigation'&&p.grant==='planning_only'));
  assert.equal(JSON.stringify(storage.workflow(CALCULATOR_WORKFLOW.id)),before);
  assert.equal(JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id)),history);
  assert.equal(storage.budget.status().dailyAttempts,1);
  assert.equal(storage.budget.status().paused,true);
  assert.equal(db.pragma('user_version',{simple:true}),5);
});

test('planning project has no source or execution',async t=>{
  const {app,storage}=setup(t);
  const key=crypto.randomUUID();
  const response=await create(app,'Fictional planner',key);
  assert.equal(response.statusCode,201,response.body);
  const created=response.json();
  assert.equal(created.project.grant,'planning_only');
  assert.equal(created.project.sourceState,'unmapped');
  assert.equal(created.project.archived,false);
  assert.deepEqual(storage.workflows(created.project.id),[]);
  const replay=await create(app,'Fictional planner',key);
  assert.equal(replay.json().project.id,created.project.id);
  assert.equal((await create(app,'Changed',key)).statusCode,409);
  const overview=await app.inject({url:`/api/projects/${created.project.id}/overview`,headers});
  assert.equal(overview.statusCode,200);
  assert.equal(overview.json().verification,'not_checked');
  assert.equal(overview.json().freshness,'unknown');
});

test('renamed item labels preserve IDs history and parents',async t=>{
  const {app,storage}=setup(t);
  const {project}= (await create(app)).json();
  assert.ok(project,'project creation must succeed');
  const parent=await app.inject({method:'POST',url:`/api/projects/${project.id}/items`,headers,payload:item(1,'Parent')});
  assert.equal(parent.statusCode,201,parent.body);
  const child=await app.inject({method:'POST',url:`/api/projects/${project.id}/items`,headers,payload:item(2,'Child','future',{parentId:parent.json().item.id})});
  assert.equal(child.statusCode,201,child.body);
  const history=JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id));
  const edited=await app.inject({method:'POST',url:`/api/projects/${project.id}/items/${child.json().item.id}`,headers,payload:{expectedMapRevision:3,name:'Renamed',description:'Changed',development:'planning'}});
  assert.equal(edited.statusCode,200,edited.body);
  assert.equal(edited.json().item.id,child.json().item.id);
  assert.equal(edited.json().item.parentId,parent.json().item.id);
  assert.equal(JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id)),history);
});

test('layout revision changes without semantic revision or approved bytes and stale layout rejects overwrite',async t=>{
  const {app,storage,db}=setup(t);
  const proposal=storage.propose({workflowId:CALCULATOR_WORKFLOW.id,stepId:'number-a',baseRevision:1,text:'Synthetic change',proposedRules:['Accept finite inputs.'],explanation:'Synthetic',provenance:'manual'});
  storage.decide(proposal.id,'approve');
  const before=JSON.stringify(storage.workflow(CALCULATOR_WORKFLOW.id));
  const approved=db.prepare('SELECT specification_json FROM audit_events').all();
  const history=JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id));
  const result=await app.inject({method:'POST',url:`/api/workflows/${CALCULATOR_WORKFLOW.id}/layout`,headers,payload:{expectedLayoutRevision:0,positions:CALCULATOR_WORKFLOW.steps.map(s=>({stepId:s.id,x:s.position.x+17,y:4}))}});
  assert.equal(result.statusCode,200,result.body);
  assert.equal(result.json().layout.layoutRevision,1);
  assert.equal(JSON.stringify(storage.workflow(CALCULATOR_WORKFLOW.id)),before);
  assert.equal(JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id)),history);
  assert.deepEqual(db.prepare('SELECT specification_json FROM audit_events').all(),approved);
  assert.equal((await app.inject({method:'POST',url:`/api/workflows/${CALCULATOR_WORKFLOW.id}/layout`,headers,payload:{expectedLayoutRevision:0,positions:[]}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:`/api/workflows/${CALCULATOR_WORKFLOW.id}/layout`,headers,payload:{expectedLayoutRevision:1,positions:[{stepId:'foreign',x:1,y:1}]}})).statusCode,400);
});

test('cross-project children cycles and stale edits reject; existing topology edit fields are refused',async t=>{
  const {app}=setup(t);
  const a=(await create(app,'A')).json().project;
  const b=(await create(app,'B')).json().project;
  assert.ok(a&&b,'project creation must succeed');
  const parent=(await app.inject({method:'POST',url:`/api/projects/${a.id}/items`,headers,payload:item(1,'Parent')})).json().item;
  assert.ok(parent);
  assert.equal((await app.inject({method:'POST',url:`/api/projects/${b.id}/items`,headers,payload:item(1,'Foreign','planning',{parentId:parent.id})})).statusCode,400);
  for (const extra of [{parentId:parent.id},{kind:'module'},{workflowId:'other'}]) {
    assert.equal((await app.inject({method:'POST',url:`/api/projects/${a.id}/items/${parent.id}`,headers,payload:{expectedMapRevision:2,name:'Renamed',description:'',development:'planning',...extra}})).statusCode,400);
  }
  assert.equal((await app.inject({method:'POST',url:`/api/projects/${a.id}/items/${parent.id}`,headers,payload:{expectedMapRevision:1,name:'Renamed',description:'',development:'planning'}})).statusCode,409);
  const graph={clientRequestId:crypto.randomUUID(),expectedMapRevision:2,itemId:null,name:'Loop',description:'',steps:[{id:'a',title:'A',purpose:'',kind:'process',rules:[],errorBehavior:'',position:{x:0,y:0},childWorkflowId:'absent'}],connections:[]};
  assert.equal((await app.inject({method:'POST',url:`/api/projects/${a.id}/workflows`,headers,payload:graph})).statusCode,400);
});

test('mixed status counts match filtered rows',async t=>{
  const {app}=setup(t);
  const project=(await create(app)).json().project;
  assert.ok(project,'project creation must succeed');
  for (const [n,development] of ['future','planning','implemented'].entries()) {
    const result=await app.inject({method:'POST',url:`/api/projects/${project.id}/items`,headers,payload:item(n+1,development,development)});
    assert.equal(result.statusCode,201,result.body);
  }
  const overview=(await app.inject({url:`/api/projects/${project.id}/overview`,headers})).json();
  assert.deepEqual(overview.counts,{future:1,planning:1,implementation:0,implemented:1});
  for (const state of ['future','planning','implemented']) {
    const filtered=(await app.inject({url:`/api/projects/${project.id}/overview?development=${state}`,headers})).json();
    assert.equal(filtered.items.length,1);
    assert.equal(filtered.items[0].development,state);
    assert.equal(filtered.counts[state],1);
    assert.equal(Object.values(filtered.counts).reduce((a,b)=>a+b,0),1);
  }
});

test('workflow detail and overview share step verification',async t=>{
  const {app}=setup(t);
  const detail=await app.inject({url:`/api/workflows/${CALCULATOR_WORKFLOW.id}`,headers});
  assert.equal(detail.statusCode,200);
  const projection=detail.json().stepVerification;
  assert.ok(Array.isArray(projection),'detail must return server verification');
  assert.equal(projection.length,5);
  for (const row of projection) assert.deepEqual(row,{stepId:row.stepId,verification:'not_checked',freshness:'unknown',lastCheckedAt:null,evidenceIds:[],reason:'Acceptance evidence is not available yet.'});
  const overview=await app.inject({url:'/api/projects/sample-calculator/overview',headers});
  assert.equal(overview.statusCode,200);
  assert.deepEqual(overview.json().workflows.find(w=>w.id===CALCULATOR_WORKFLOW.id).stepVerification,projection);
});

test('grant HTTP changes fail closed until a real local session while ordinary metadata edits work',async t=>{
  const {app,storage}=setup(t);
  const project=(await create(app)).json().project;
  assert.ok(project);
  const url=`/api/projects/${project.id}/settings`;
  const label=await app.inject({method:'POST',url,headers,payload:{expectedGrantRevision:1,name:'Renamed'}});
  assert.equal(label.statusCode,200,label.body);
  const grant=await app.inject({method:'POST',url,headers,payload:{expectedGrantRevision:1,grant:'read_only'}});
  assert.equal(grant.statusCode,503,grant.body);
  assert.equal(grant.json().code,'LOCAL_SESSION_UNAVAILABLE');
  assert.equal(storage.registry.list().find(p=>p.id===project.id).grant,'planning_only');
  assert.equal(storage.registry.setGrant(project.id,{expectedGrantRevision:1,grant:'read_only'}).project.grantRevision,2);
  assert.throws(()=>storage.registry.setGrant(project.id,{expectedGrantRevision:1,grant:'planning_only'}),/stale/i);
  assert.throws(()=>storage.registry.setGrant(project.id,{expectedGrantRevision:2,grant:'synthetic_execute'}),/forbidden|synthetic/i);
});

test('access selection does not widen grants and pending repositories stay private and inert',async t=>{
  const {app}=setup(t);
  const project=(await create(app)).json().project;
  assert.ok(project);
  const linked=await app.inject({method:'POST',url:`/api/projects/${project.id}/repositories`,headers,payload:{clientRequestId:crypto.randomUUID(),expectedGrantRevision:1,alias:'Fictional root',absolutePath:'C:/fictional-does-not-exist/private-root'}});
  assert.equal(linked.statusCode,201,linked.body);
  assert.deepEqual(Object.keys(linked.json().repository).sort(),['alias','id','state']);
  assert.equal(linked.json().repository.state,'pending');
  const selected=await app.inject({method:'POST',url:'/api/workspace/access',headers,payload:{mode:'selected',selectedProjectIds:[project.id]}});
  assert.equal(selected.statusCode,200,selected.body);
  assert.equal((await app.inject({url:`/api/workflows/${CALCULATOR_WORKFLOW.id}`,headers})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/api/proposals',headers,payload:{workflowId:CALCULATOR_WORKFLOW.id,stepId:'number-a',baseRevision:1,text:'Synthetic test',proposedRules:['Safe rule']}})).statusCode,404);
  const workspace=await app.inject({url:'/api/workspace',headers});
  assert.ok(!workspace.body.includes('private-root'));
  assert.equal(workspace.json().projects.length,1);
  assert.equal(workspace.json().projects[0].grant,'planning_only');
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/access',headers,payload:{mode:'all_connected',selectedProjectIds:[]}})).statusCode,200);
  assert.equal((await app.inject({url:'/api/workspace',headers})).json().projects.find(p=>p.id===project.id).grant,'planning_only');
});

test('all new actions reject unexpected keys and raw credential leaves before persistence',async t=>{
  const {app}=setup(t);
  assert.equal((await create(app)).statusCode,201);
  for(const name of ['sk-'+'x'.repeat(30),'synthetic-registry-key','password="synthetic-password-value"']) {
    const response=await create(app,name);
    assert.equal(response.statusCode,400,response.body);
    assert.ok(!response.body.includes(name));
  }
  assert.equal((await app.inject({method:'POST',url:'/api/projects',headers,payload:{clientRequestId:crypto.randomUUID(),name:'Allowed',description:'',grant:'read_only'}})).statusCode,400);
  assert.equal((await app.inject({url:'/api/workspace?absolutePath=ignored',headers})).statusCode,400);
});

test('read-only grants allow planning rule review while nonsynthetic implementation is forbidden',async t=>{
  const {app,storage}=setup(t);
  assert.ok(storage.registry,'ProjectStore integration must be present');
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Fictional read-only map',description:''}).project;
  storage.registry.setGrant(project.id,{expectedGrantRevision:1,grant:'read_only'});
  const workflow=storage.registry.saveWorkflow(project.id,{clientRequestId:crypto.randomUUID(),expectedMapRevision:1,itemId:null,
    name:'Planning graph',description:'',steps:[{id:'inspect',title:'Inspect',purpose:'Review the plan.',kind:'process',rules:['Keep the plan explicit.'],errorBehavior:'Explain uncertainty.',position:{x:0,y:0}}],connections:[]}).workflow;
  const proposed=await app.inject({method:'POST',url:'/api/proposals',headers,payload:{workflowId:workflow.id,stepId:'inspect',baseRevision:1,text:'Clarify the plan',proposedRules:['Describe the plan clearly.']}});
  assert.equal(proposed.statusCode,201,proposed.body);
  const reviewed=await app.inject({method:'POST',url:`/api/proposals/${proposed.json().proposal.id}/decision`,headers,payload:{action:'approve'}});
  assert.equal(reviewed.statusCode,200,reviewed.body);
  const execution=await app.inject({method:'POST',url:'/api/implementation/tasks',headers,payload:{workflowId:workflow.id,revision:2}});
  assert.equal(execution.statusCode,403,execution.body);
});

test('child graph membership and depth cycles reject but ordinary connected retry edges are valid',async t=>{
  const {app,storage,db}=setup(t);
  const project=(await create(app)).json().project;
  assert.ok(project);
  const step={id:'review',title:'Review',purpose:'Review fictional input.',kind:'decision',rules:['Require valid format.'],errorBehavior:'Explain correction.',position:{x:0,y:0}};
  const draft={clientRequestId:crypto.randomUUID(),expectedMapRevision:1,itemId:null,name:'Retry graph',description:'',steps:[step,{...step,id:'correct',title:'Correct'}],
    connections:[{id:'invalid',source:'review',target:'correct',label:'Invalid'},{id:'retry',source:'correct',target:'review',label:'Try again'}]};
  const created=await app.inject({method:'POST',url:`/api/projects/${project.id}/workflows`,headers,payload:draft});
  assert.equal(created.statusCode,201,created.body);
  const cross=await app.inject({method:'POST',url:`/api/projects/${project.id}/workflows`,headers,payload:{...draft,clientRequestId:crypto.randomUUID(),expectedMapRevision:2,steps:[{...step,childWorkflowId:CALCULATOR_WORKFLOW.id}],connections:[]}});
  assert.equal(cross.statusCode,400,cross.body);
  // A retained/imported malformed graph must not become a valid child through a new graph.
  const graph=storage.workflow(created.json().workflow.id);
  graph.steps[0].childWorkflowId=graph.id;
  db.prepare('UPDATE workflows SET payload=? WHERE id=?').run(JSON.stringify(graph),graph.id);
  const cycle=await app.inject({method:'POST',url:`/api/projects/${project.id}/workflows`,headers,payload:{...draft,clientRequestId:crypto.randomUUID(),expectedMapRevision:2,steps:[{...step,childWorkflowId:graph.id}],connections:[]}});
  assert.equal(cycle.statusCode,400,cycle.body);
});

test('each new project mutation validates strict shape and screens raw leaves without changing revisions',async t=>{
  const {app,storage}=setup(t);
  const project=(await create(app)).json().project;
  assert.ok(project);
  const made=await app.inject({method:'POST',url:`/api/projects/${project.id}/items`,headers,payload:item(1,'Allowed item')});
  assert.equal(made.statusCode,201,made.body);
  const itemId=made.json().item.id;
  const step={id:'safe',title:'Safe',purpose:'',kind:'process',rules:['Safe'],errorBehavior:'',position:{x:0,y:0}};
  const mutations=[
    [`/api/projects/${project.id}/settings`,{expectedGrantRevision:1,name:'Allowed'}],
    [`/api/projects/${project.id}/items`,item(2,'Allowed')],
    [`/api/projects/${project.id}/items/${itemId}`,{expectedMapRevision:2,name:'Allowed',description:'',development:'planning'}],
    [`/api/projects/${project.id}/workflows`,{clientRequestId:crypto.randomUUID(),expectedMapRevision:2,itemId:null,name:'Allowed',description:'',steps:[step],connections:[]}],
    [`/api/projects/${project.id}/repositories`,{clientRequestId:crypto.randomUUID(),expectedGrantRevision:1,alias:'Allowed',absolutePath:'C:/fictional-pending'}],
  ];
  const before=storage.registry.list().find(p=>p.id===project.id);
  for (const [url,payload] of mutations) {
    assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,permissionProfile:'untrusted'}})).statusCode,400,url);
    const key='alias' in payload?'alias':'name';
    for (const secret of ['synthetic-registry-key','api_key="synthetic-quoted-key-value"','sk-'+'q'.repeat(30)]) {
      const result=await app.inject({method:'POST',url,headers,payload:{...payload,[key]:secret}});
      assert.equal(result.statusCode,400,url+' '+result.body);
      assert.ok(!result.body.includes(secret));
    }
  }
  assert.deepEqual(storage.registry.list().find(p=>p.id===project.id),before);
  assert.equal((await app.inject({url:`/api/projects/${project.id}/overview?itemId=foreign`,headers})).statusCode,404);
  assert.equal((await app.inject({url:`/api/projects/${project.id}/overview?limit=101`,headers})).statusCode,400);
});

test('authority removal revokes a retained legacy approval before grant restoration',t=>{
  const {storage,db}=setup(t);
  assert.ok(storage.registry,'ProjectStore integration must be present');
  const task={id:'synthetic-retained-task',manifest:{workflowId:CALCULATOR_WORKFLOW.id,specRevision:1,specDigest:'a'.repeat(64),specReceiptId:'synthetic',repositoryId:'synthetic',baseCommit:'a'.repeat(40),allowedFiles:['calculator.mjs'],acceptanceSuite:'calculator-v1',acceptanceDigest:'b'.repeat(64),maxSeconds:600},
    manifestDigest:'c'.repeat(64),state:'awaiting_approval',approval:{id:'synthetic-approval',manifestDigest:'c'.repeat(64),actor:'delegated-review',time:'2026-01-01T00:00:00.000Z'},findings:[],diff:null,tests:[]};
  db.prepare('INSERT INTO implementation_tasks(id,workflow_id,state,payload) VALUES (?,?,?,?)').run(task.id,CALCULATOR_WORKFLOW.id,task.state,JSON.stringify({task,repository:{id:'synthetic',directory:'C:/fictional-never-read',baseCommit:'a'.repeat(40)}}));
  storage.registry.setGrant('sample-calculator',{expectedGrantRevision:1,grant:'planning_only'});
  storage.registry.setGrant('sample-calculator',{expectedGrantRevision:2,grant:'synthetic_execute'});
  assert.equal(storage.implementation.get(task.id).approval,null);
  assert.ok(storage.implementation.events(task.id).some(event=>event.kind==='authority_revoked'));
});

function retainedGraph(projectId,id,children=[]) {
  const steps=(children.length?children:[null]).map((child,index)=>({id:`node-${index}`,title:`Review ${index}`,purpose:'Fictional retained planning graph.',kind:'process',
    rules:['Review the plan.'],errorBehavior:'Explain uncertainty.',position:{x:index,y:0},...(child?{childWorkflowId:child}:{})}));
  return {id,projectId,name:`Fixture ${id}`,description:'Synthetic planning map.',revision:1,steps,
    connections:steps.slice(1).map((node,index)=>({id:`edge-${index}`,source:steps[index].id,target:node.id}))};
}
function insertRetained(db,graphs) {
  const insert=db.prepare('INSERT INTO workflows(id,project_id,revision,payload) VALUES (?,?,?,?)');
  db.transaction(()=>{for(const graph of graphs)insert.run(graph.id,graph.projectId,graph.revision,JSON.stringify(graph));})();
}
function graphInput(graph,expectedMapRevision=1) {
  return {clientRequestId:crypto.randomUUID(),expectedMapRevision,itemId:null,name:graph.name,description:graph.description,steps:graph.steps,connections:graph.connections};
}

test('shared child DAG validation reads each distinct retained workflow at most once',t=>{
  const {storage,db}=setup(t);
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Shared DAG',description:''}).project;
  const graphs=[retainedGraph(project.id,'dag-leaf')];
  for(let index=1;index<12;index++)graphs.push(retainedGraph(project.id,`dag-${index}`,[graphs.at(-1).id,graphs.at(-1).id]));
  insertRetained(db,graphs);
  const original=storage.workflow;
  let reads=0;
  storage.workflow=function(id){reads++;return original.call(this,id);};
  t.after(()=>{storage.workflow=original;});
  const created=storage.registry.saveWorkflow(project.id,graphInput(retainedGraph(project.id,'dag-root',[graphs.at(-1).id,graphs.at(-1).id])));
  assert.equal(created.workflow.steps.length,2);
  assert.ok(reads<=12,`12 distinct graphs must require at most12 reads; observed ${reads}`);
  assert.equal(storage.registry.project(project.id).mapRevision,2);
});

test('cached shared-subtree heights retain depth100 acceptance and depth101 rejection',t=>{
  const {storage,db}=setup(t);
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Depth planning',description:''}).project;
  const graphs=[retainedGraph(project.id,'height-leaf')];
  for(let index=1;index<=99;index++)graphs.push(retainedGraph(project.id,`height-${index}`,[graphs.at(-1).id]));
  graphs.push(retainedGraph(project.id,'height-wrapper',['height-99']));
  insertRetained(db,graphs);
  const boundary=storage.registry.saveWorkflow(project.id,graphInput(retainedGraph(project.id,'height-boundary',['height-99'])));
  assert.equal(boundary.workflow.steps[0].childWorkflowId,'height-99');
  const before=db.prepare('SELECT count(*) AS n FROM workflows WHERE project_id=?').get(project.id).n;
  assert.throws(()=>storage.registry.saveWorkflow(project.id,graphInput(retainedGraph(project.id,'height-overflow',['height-99','height-wrapper']),2)),
    error=>error.status===400&&/depth/i.test(error.message),'cached shallow validation must still reject the later deeper path');
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflows WHERE project_id=?').get(project.id).n,before);
  assert.equal(storage.registry.project(project.id).mapRevision,2);
});

test('shared completed children do not hide active-path child cycles',t=>{
  const {storage,db}=setup(t);
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Cycle planning',description:''}).project;
  insertRetained(db,[retainedGraph(project.id,'cycle-leaf'),retainedGraph(project.id,'cycle-a',['cycle-leaf','cycle-b']),retainedGraph(project.id,'cycle-b',['cycle-leaf','cycle-a'])]);
  assert.throws(()=>storage.registry.saveWorkflow(project.id,graphInput(retainedGraph(project.id,'cycle-root',['cycle-leaf','cycle-a']))),
    error=>error.status===400&&/cycle/i.test(error.message));
  assert.equal(storage.registry.project(project.id).mapRevision,1);
});

test('child validation permits1000 unique graphs and rejects the1001st globally',t=>{
  const {storage,db}=setup(t);
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Graph budget',description:''}).project;
  const leaves=Array.from({length:990},(_,index)=>retainedGraph(project.id,`budget-leaf-${index}`));
  const hubs=Array.from({length:10},(_,index)=>retainedGraph(project.id,`budget-hub-${index}`,
    leaves.slice(index*100,index===9?989:(index+1)*100).map(graph=>graph.id)));
  insertRetained(db,[...leaves,...hubs]);
  const root=retainedGraph(project.id,'budget-root',hubs.map(graph=>graph.id));
  assert.ok(storage.registry.saveWorkflow(project.id,graphInput(root)).workflow.id,'root+10 hubs+989 leaves must be allowed');
  const expanded=retainedGraph(project.id,'budget-hub-9',leaves.slice(900).map(graph=>graph.id));
  db.prepare('UPDATE workflows SET payload=? WHERE id=?').run(JSON.stringify(expanded),expanded.id);
  const before=db.prepare('SELECT count(*) AS n FROM workflows WHERE project_id=?').get(project.id).n;
  assert.throws(()=>storage.registry.saveWorkflow(project.id,graphInput(root,2)),error=>error.status===400&&/budget|limit/i.test(error.message));
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflows WHERE project_id=?').get(project.id).n,before);
  assert.equal(storage.registry.project(project.id).mapRevision,2);
});

test('child validation permits10000 child references and rejects10001 even with few unique graphs',t=>{
  const {storage,db}=setup(t);
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Reference budget',description:''}).project;
  const leaf=retainedGraph(project.id,'ref-leaf');
  const hubs=Array.from({length:99},(_,index)=>retainedGraph(project.id,`ref-hub-${index}`,Array(100).fill(leaf.id)));
  const extra=retainedGraph(project.id,'ref-extra',[leaf.id]);
  insertRetained(db,[leaf,...hubs,extra]);
  const root=retainedGraph(project.id,'ref-root',[...hubs.map(graph=>graph.id),hubs[0].id]);
  assert.ok(storage.registry.saveWorkflow(project.id,graphInput(root)).workflow.id,'9900 stored references+100 root references must be allowed');
  const tooMany=retainedGraph(project.id,'ref-overflow',[...hubs.map(graph=>graph.id),extra.id]);
  const before=db.prepare('SELECT count(*) AS n FROM workflows WHERE project_id=?').get(project.id).n;
  assert.throws(()=>storage.registry.saveWorkflow(project.id,graphInput(tooMany,2)),error=>error.status===400&&/budget|limit/i.test(error.message));
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflows WHERE project_id=?').get(project.id).n,before);
  assert.equal(storage.registry.project(project.id).mapRevision,2);
});

test('HTTP archive hides ordinary reads and exact-current narrow restore preserves history and grant',async t=>{
  const {app,storage,db}=setup(t);
  const url='/api/projects/sample-calculator/settings';
  const workflow=JSON.stringify(storage.workflow(CALCULATOR_WORKFLOW.id));
  const history=JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id));
  const change=payload=>app.inject({method:'POST',url,headers,payload});
  const archived=await change({expectedGrantRevision:1,archived:true});
  assert.equal(archived.statusCode,200,archived.body);
  assert.equal(archived.json().project.grantRevision,2);
  assert.equal(archived.json().project.archived,true);
  for(const path of ['/api/projects/sample-calculator/overview','/api/projects/sample-calculator/workflows',`/api/workflows/${CALCULATOR_WORKFLOW.id}`]) {
    assert.equal((await app.inject({url:path,headers})).statusCode,404,path);
    assert.equal((await app.inject({method:'HEAD',url:path,headers})).statusCode,404,path);
  }
  assert.equal((await change({expectedGrantRevision:2,name:'Hidden edit'})).statusCode,404);
  assert.equal((await change({expectedGrantRevision:2,archived:false,name:'Combined restore'})).statusCode,404);
  assert.equal((await change({expectedGrantRevision:1,archived:false})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/access',headers,payload:{mode:'selected',selectedProjectIds:['sample-workflow-navigation']}})).statusCode,200);
  assert.equal((await change({expectedGrantRevision:2,archived:false})).statusCode,404,'restore must not bypass access selection');
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/access',headers,payload:{mode:'selected',selectedProjectIds:['sample-calculator']}})).statusCode,200);
  const restored=await change({expectedGrantRevision:2,archived:false});
  assert.equal(restored.statusCode,200,restored.body);
  assert.equal(restored.json().project.archived,false);
  assert.equal(restored.json().project.grantRevision,3);
  assert.equal(restored.json().project.grant,'synthetic_execute');
  assert.equal(restored.json().project.mapRevision,1);
  assert.equal((await app.inject({url:`/api/workflows/${CALCULATOR_WORKFLOW.id}`,headers})).statusCode,200);
  assert.equal((await change({expectedGrantRevision:2,archived:false})).statusCode,409);
  const blocked=await change({expectedGrantRevision:3,grant:'planning_only'});
  assert.equal(blocked.statusCode,503);
  assert.equal(blocked.json().code,'LOCAL_SESSION_UNAVAILABLE');
  assert.equal(JSON.stringify(storage.workflow(CALCULATOR_WORKFLOW.id)),workflow);
  assert.equal(JSON.stringify(storage.history(CALCULATOR_WORKFLOW.id)),history);
  const audit=db.prepare("SELECT payload FROM project_audit_events WHERE project_id='sample-calculator' AND kind='authority_revoked' ORDER BY sequence").all().map(row=>JSON.parse(row.payload));
  assert.deepEqual(audit.map(row=>[row.previousArchived,row.archived]),[[false,true],[true,false]]);
});

test('overview workflow limits and verification counts use the same nonempty returned collection',async t=>{
  const {app,storage,db}=setup(t);
  const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Many planning maps',description:''}).project;
  const graphs=Array.from({length:51},(_,index)=>retainedGraph(project.id,`listed-${String(index).padStart(2,'0')}`));
  graphs[50].name='Last matched planning map';
  insertRetained(db,graphs);
  for(const [query,count] of [['?limit=1',1],['?limit=2',2],['',50],['?limit=100',51],['?q=Last&limit=1',1]]) {
    const response=await app.inject({url:`/api/projects/${project.id}/overview${query}`,headers});
    assert.equal(response.statusCode,200,response.body);
    const body=response.json();
    assert.equal(body.workflows.length,count,query);
    assert.deepEqual(body.verificationCounts,{not_checked:count,checking:0,verified:0,failed:0,stale:0});
    assert.ok(body.workflows.every(graph=>graph.stepVerification.length===1));
    if(query.includes('q='))assert.equal(body.workflows[0].id,'listed-50');
  }
  for(const limit of [0,101])assert.equal((await app.inject({url:`/api/projects/${project.id}/overview?limit=${limit}`,headers})).statusCode,400);
});

function completeListFixture(t,itemCount=103,mapCount=107) {
  const fixture=setup(t);
  const project=fixture.storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Complete fictional map',description:''}).project;
  const graphs=Array.from({length:mapCount},(_,index)=>({...retainedGraph(project.id,`map-${String(index).padStart(3,'0')}`),name:`Matching map ${index}`}));
  insertRetained(fixture.db,[...graphs].reverse());
  const insert=fixture.db.prepare('INSERT INTO project_items(id,project_id,parent_id,workflow_id,payload) VALUES (?,?,?,?,?)');
  fixture.db.transaction(()=>{
    for(let index=itemCount-1;index>=0;index--) {
      const item={id:`item-${String(index).padStart(3,'0')}`,projectId:project.id,parentId:null,kind:'workflow',name:`Matching item ${index}`,
        description:'Synthetic complete list.',development:'planning',workflowId:graphs[index%graphs.length]?.id??null};
      insert.run(item.id,project.id,null,item.workflowId,JSON.stringify(item));
    }
  })();
  return {...fixture,project,graphs,url:`/api/projects/${project.id}/overview`};
}
const getPage=(app,url,query={})=>app.inject({url:url+(Object.keys(query).length?'?'+new URLSearchParams(query):''),headers});
function assertStale(response) {
  assert.equal(response.statusCode,409,response.body);
  assert.deepEqual(response.json(),{error:'This list changed. Refresh to continue.',code:'STALE_CURSOR'});
}

test('complete overview traverses103 items107 workflows and source-owned dependencies across three bounded pages',async t=>{
  const {app,db,project,url}=completeListFixture(t);
  db.prepare('INSERT INTO project_dependencies(project_id,source_item_id,target_item_id) VALUES (?,?,?)').run(project.id,'item-000','item-102');
  const itemIds=[],workflowIds=[],edges=[];
  let cursor;
  for(const [items,maps] of [[50,50],[50,50],[3,7]]) {
    const response=await getPage(app,url,{q:'Matching',...(cursor?{cursor}:{})});
    assert.equal(response.statusCode,200,response.body);
    const page=response.json();
    assert.equal(page.items.length,items);assert.equal(page.workflows.length,maps);
    assert.deepEqual(page.counts,{future:0,planning:items,implementation:0,implemented:0});
    assert.deepEqual(page.verificationCounts,{not_checked:maps,checking:0,verified:0,failed:0,stale:0});
    assert.deepEqual(page.totals,{items:103,workflows:107,counts:{future:0,planning:103,implementation:0,implemented:0},
      verificationCounts:{not_checked:107,checking:0,verified:0,failed:0,stale:0},verification:'not_checked',freshness:'unknown'});
    assert.equal(page.page.limit,50);assert.equal(page.page.hasMoreItems,items===50);assert.equal(page.page.hasMoreWorkflows,maps===50);
    if(items===3)assert.equal(page.page.nextCursor,null);else assert.equal(typeof page.page.nextCursor,'string');
    itemIds.push(...page.items.map(item=>item.id));workflowIds.push(...page.workflows.map(graph=>graph.id));edges.push(...page.dependencies);
    if(itemIds.length===50)assert.deepEqual(page.dependencies,[{sourceItemId:'item-000',targetItemId:'item-102'}]);
    cursor=page.page.nextCursor;
  }
  assert.deepEqual(itemIds,Array.from({length:103},(_,index)=>`item-${String(index).padStart(3,'0')}`));
  assert.deepEqual(workflowIds,Array.from({length:107},(_,index)=>`map-${String(index).padStart(3,'0')}`));
  assert.equal(new Set(itemIds).size,103);assert.equal(new Set(workflowIds).size,107);
  assert.deepEqual(edges,[{sourceItemId:'item-000',targetItemId:'item-102'}]);
});

test('overview exhausted collections stay empty while the other continues and full-item filtering precedes paging',async t=>{
  const {app,url}=completeListFixture(t,1,107);
  const first=(await getPage(app,url,{limit:100})).json();
  assert.ok(first.page,'bounded page metadata must exist');
  assert.equal(first.items.length,1);assert.equal(first.workflows.length,100);assert.equal(first.page.hasMoreItems,false);assert.equal(first.page.hasMoreWorkflows,true);
  const last=(await getPage(app,url,{limit:100,cursor:first.page.nextCursor})).json();
  assert.equal(last.items.length,0);assert.equal(last.workflows.length,7);assert.equal(last.counts.planning,0);assert.equal(last.totals.items,1);assert.equal(last.page.nextCursor,null);
  const full=completeListFixture(t);
  const filtered=(await getPage(full.app,full.url,{development:'planning',limit:1})).json();
  assert.equal(filtered.workflows.length,1);assert.equal(filtered.totals.workflows,103,'linked workflow predicate must use all103matching items');
  const empty=(await getPage(full.app,full.url,{q:'No matching fixture'})).json();
  assert.deepEqual([empty.items.length,empty.workflows.length,empty.totals.items,empty.totals.workflows],[0,0,0,0]);
  assert.deepEqual(empty.page,{limit:50,hasMoreItems:false,hasMoreWorkflows:false,nextCursor:null});
  const inverse=completeListFixture(t,103,1);
  const inverseFirst=(await getPage(inverse.app,inverse.url)).json();
  const inverseSecond=(await getPage(inverse.app,inverse.url,{cursor:inverseFirst.page.nextCursor})).json();
  assert.deepEqual([inverseFirst.items.length,inverseFirst.workflows.length,inverseSecond.items.length,inverseSecond.workflows.length],[50,1,50,0]);
  assert.equal(inverseSecond.page.hasMoreWorkflows,false);assert.equal(inverseSecond.page.hasMoreItems,true);
});

test('overview page and totals use one private database read snapshot despite a concurrent semantic write',async t=>{
  const {app,storage,db,url,graphs}=completeListFixture(t,1,1);
  const original=storage.workflows;
  let changed=false;
  storage.workflows=function(id) {
    if(!changed){changed=true;db.prepare('UPDATE workflows SET revision=2,payload=? WHERE id=?').run(JSON.stringify({...graphs[0],revision:2}),graphs[0].id);}
    return original.call(this,id);
  };
  t.after(()=>{storage.workflows=original;});
  const snapshot=await getPage(app,url);
  assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().workflows[0].revision,1,'the earlier project/item read must pin this same response snapshot');
  assert.equal(snapshot.json().totals.workflows,1);
  const next=await getPage(app,url);assert.equal(next.statusCode,200,next.body);assert.equal(next.json().workflows[0].revision,2);
});

test('overview cursors replay and survive layout changes while malformed scope filter limit and tamper refuse partial pages',async t=>{
  const {app,storage,url,graphs}=completeListFixture(t,3,4);
  const first=(await getPage(app,url,{limit:1})).json();
  assert.equal(typeof first.page?.nextCursor,'string');
  const cursor=first.page.nextCursor;
  const good=await getPage(app,url,{limit:1,cursor});assert.equal(good.statusCode,200,good.body);
  assert.deepEqual((await getPage(app,url,{limit:1,cursor})).json(),good.json());
  storage.registry.saveLayout(graphs[0].id,{expectedLayoutRevision:0,positions:[{stepId:'node-0',x:900,y:12}]});
  assert.deepEqual((await getPage(app,url,{limit:1,cursor})).json(),good.json());
  for(const query of [{limit:2,cursor},{limit:1,q:'Changed filter',cursor}])assertStale(await getPage(app,url,query));
  const [payload,signature]=cursor.split('.');
  assertStale(await getPage(app,url,{limit:1,cursor:payload+'.'+(signature[0]==='A'?'B':'A')+signature.slice(1)}));
  const other=storage.registry.create({clientRequestId:crypto.randomUUID(),name:'Other route',description:''}).project;
  assertStale(await getPage(app,`/api/projects/${other.id}/overview`,{limit:1,cursor}));
  for(const bad of ['not-a-cursor','x'.repeat(2049)])assert.equal((await getPage(app,url,{limit:1,cursor:bad})).statusCode,400);
});

for(const drift of ['map','grant','view'])test(`overview cursor rejects ${drift} drift after an authorized positive continuation`,async t=>{
  const {app,storage,project,url,graphs}=completeListFixture(t,3,4);
  const first=(await getPage(app,url,{limit:1})).json();assert.equal(typeof first.page?.nextCursor,'string');
  const query={limit:1,cursor:first.page.nextCursor};
  assert.equal((await getPage(app,url,query)).statusCode,200);
  if(drift==='map')storage.registry.saveItem(project.id,item(1,'New semantic item'));
  if(drift==='grant')storage.registry.setGrant(project.id,{expectedGrantRevision:1,grant:'read_only'});
  if(drift==='view') {
    const proposal=storage.propose({workflowId:graphs[0].id,stepId:'node-0',baseRevision:1,text:'New semantic rule',proposedRules:['Changed semantic rule.'],explanation:'Synthetic',provenance:'manual'});
    storage.decide(proposal.id,'approve');
  }
  assertStale(await getPage(app,url,query));
});

test('archive and access guards reject before cursor parsing and a simulated key restart invalidates otherwise-current continuation',async t=>{
  const {app,storage,db,project,url}=completeListFixture(t,3,4);
  const first=(await getPage(app,url,{limit:1})).json();assert.equal(typeof first.page?.nextCursor,'string');
  const {ProjectPagination}=await import('./project-pagination.ts').catch(()=>({}));assert.equal(typeof ProjectPagination,'function');
  const {ProjectStore}=await import('./project-store.ts');
  const restarted=new ProjectStore(db,storage,new ProjectPagination(Buffer.alloc(32,21)));
  assert.throws(()=>restarted.overview(project.id,{limit:1,cursor:first.page.nextCursor}),error=>error.status===409&&error.code==='STALE_CURSOR');
  storage.registry.updateSettings(project.id,{expectedGrantRevision:1,archived:true});
  assert.equal((await getPage(app,url,{limit:1,cursor:'not-a-cursor'})).statusCode,404);
  assert.equal((await app.inject({method:'HEAD',url:url+'?cursor=not-a-cursor',headers})).statusCode,404);
  storage.registry.setAccess({mode:'selected',selectedProjectIds:['sample-calculator']});
  assert.equal((await getPage(app,url,{limit:1,cursor:'not-a-cursor'})).statusCode,404);
});

test('management pages expose all registered archived and unselected choices through exactly five summary fields',async t=>{
  const {app,storage}=setup(t);
  const projects=Array.from({length:103},(_,index)=>storage.registry.create({clientRequestId:crypto.randomUUID(),name:`Registered ${index}`,description:'PRIVATE_MANAGEMENT_DESCRIPTION'}).project);
  storage.registry.linkCandidate(projects[1].id,{clientRequestId:crypto.randomUUID(),expectedGrantRevision:1,alias:'Hidden candidate',absolutePath:'C:/fictional-management-hidden-root'});
  storage.registry.updateSettings(projects[1].id,{expectedGrantRevision:1,archived:true});
  storage.registry.setAccess({mode:'selected',selectedProjectIds:[projects[0].id,projects[1].id]});
  const ordinary=(await getPage(app,'/api/workspace')).json();assert.deepEqual(ordinary.projects.map(p=>p.id),[projects[0].id]);assert.equal(ordinary.management,undefined);
  const ids=[];let cursor;
  for(const count of [50,50,5]) {
    const response=await getPage(app,'/api/workspace',{management:true,...(cursor?{cursor}:{})});
    assert.equal(response.statusCode,200,response.body);
    const page=response.json().management;assert.equal(page.total,105);assert.equal(page.projects.length,count);assert.equal(page.page.limit,50);
    for(const project of page.projects)assert.deepEqual(Object.keys(project).sort(),['archived','grantRevision','id','name','selected']);
    assert.ok(!JSON.stringify(page).includes('PRIVATE_MANAGEMENT_DESCRIPTION'));assert.ok(!JSON.stringify(page).includes('fictional-management-hidden-root'));
    ids.push(...page.projects.map(p=>p.id));cursor=page.page.nextCursor;
    if(count===5)assert.equal(cursor,null);else assert.equal(typeof cursor,'string');
  }
  assert.deepEqual(ids,[...projects.map(p=>p.id),'sample-calculator','sample-workflow-navigation'].sort());assert.equal(new Set(ids).size,105);
  const all=(await getPage(app,'/api/workspace',{management:true,limit:100})).json().management;
  assert.equal(all.projects.length,100);assert.equal(all.total,105);
  const second=(await getPage(app,'/api/workspace',{management:true,limit:100,cursor:all.page.nextCursor})).json().management;
  const summaries=[...all.projects,...second.projects];
  assert.deepEqual(summaries.find(p=>p.id===projects[1].id),{id:projects[1].id,name:projects[1].name,archived:true,selected:true,grantRevision:2});
  assert.equal(summaries.find(p=>p.id===projects[2].id).selected,false);
  for(const id of [projects[1].id,projects[2].id])for(const method of ['GET','HEAD'])assert.equal((await app.inject({method,url:`/api/projects/${id}/overview`,headers})).statusCode,404);
  for(const query of [{limit:1},{cursor:'ignored'},{management:false},{management:true,limit:0},{management:true,limit:101},{management:true,extra:'ignored'}])assert.equal((await getPage(app,'/api/workspace',query)).statusCode,400);
  assert.equal((await getPage(app,'/api/workspace',{management:true,limit:1})).json().management.projects.length,1);
});

test('management continuation binds selection archive rename grant and namespace with unchanged replay positive controls',async t=>{
  const {app,storage}=setup(t);
  for(const kind of ['selection','archive','rename','grant']) {
    storage.registry.setAccess({mode:'all_connected',selectedProjectIds:[]});
    const project=storage.registry.create({clientRequestId:crypto.randomUUID(),name:`Management ${kind}`,description:''}).project;
    const first=await getPage(app,'/api/workspace',{management:true,limit:1});assert.equal(first.statusCode,200,first.body);
    const cursor=first.json().management.page.nextCursor;assert.equal(typeof cursor,'string');
    const query={management:true,limit:1,cursor};const good=await getPage(app,'/api/workspace',query);assert.equal(good.statusCode,200,good.body);
    assert.deepEqual((await getPage(app,'/api/workspace',query)).json(),good.json());
    assertStale(await getPage(app,'/api/workspace',{management:true,limit:2,cursor}));
    assertStale(await getPage(app,`/api/projects/${project.id}/overview`,{limit:1,cursor}));
    if(kind==='selection')storage.registry.setAccess({mode:'selected',selectedProjectIds:[project.id]});
    if(kind==='archive')storage.registry.updateSettings(project.id,{expectedGrantRevision:1,archived:true});
    if(kind==='rename')storage.registry.updateSettings(project.id,{expectedGrantRevision:1,name:'Renamed choice'});
    if(kind==='grant')storage.registry.setGrant(project.id,{expectedGrantRevision:1,grant:'read_only'});
    assertStale(await getPage(app,'/api/workspace',query));
  }
});

test('management opt-in retains hostile-boundary denial and select-restore cannot revive an archived approval',async t=>{
  const {app,storage,db}=setup(t);
  const task={id:crypto.randomUUID(),manifest:{workflowId:CALCULATOR_WORKFLOW.id,specRevision:1,specDigest:'a'.repeat(64),specReceiptId:'synthetic',repositoryId:'synthetic',baseCommit:'a'.repeat(40),allowedFiles:['calculator.mjs'],acceptanceSuite:'calculator-v1',acceptanceDigest:'b'.repeat(64),maxSeconds:600},
    manifestDigest:'c'.repeat(64),state:'awaiting_approval',approval:{id:'must-stay-revoked',manifestDigest:'c'.repeat(64),actor:'delegated-review',time:'2026-01-01T00:00:00.000Z'},findings:[],diff:null,tests:[]};
  db.prepare('INSERT INTO implementation_tasks(id,workflow_id,state,payload) VALUES (?,?,?,?)').run(task.id,CALCULATOR_WORKFLOW.id,task.state,JSON.stringify({task,repository:{id:'synthetic',directory:'C:/fictional-never-read',baseCommit:'a'.repeat(40)}}));
  const settings='/api/projects/sample-calculator/settings';
  assert.equal((await app.inject({method:'POST',url:settings,headers,payload:{expectedGrantRevision:1,archived:true}})).statusCode,200);
  storage.registry.setAccess({mode:'selected',selectedProjectIds:['sample-workflow-navigation']});
  const management=await getPage(app,'/api/workspace',{management:true});assert.equal(management.statusCode,200,management.body);
  assert.ok(management.json().management.projects.some(p=>p.id==='sample-calculator'&&p.archived&&!p.selected));
  for(const url of ['/api/workspace','/api/workspace?management=true'])for(const method of ['GET','HEAD'])for(const extra of [{host:'evil.example'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}])
    assert.equal((await app.inject({method,url,headers:{...headers,...extra}})).statusCode,403);
  const selection={mode:'selected',selectedProjectIds:['sample-calculator']};
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/access',headers:{...headers,origin:'https://evil.example'},payload:selection})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/access',headers,payload:selection})).statusCode,200);
  const restore={expectedGrantRevision:2,archived:false};
  assert.equal((await app.inject({method:'POST',url:settings,headers:{...headers,origin:'https://evil.example'},payload:restore})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:settings,headers,payload:restore})).statusCode,200);
  assert.equal(storage.registry.project('sample-calculator').grant,'synthetic_execute');
  assert.equal(storage.implementation.get(task.id).approval,null);
  assert.equal((await app.inject({url:`/api/workflows/${CALCULATOR_WORKFLOW.id}`,headers})).statusCode,200);
});

test('framework query container normalization preserves strict keys and raw credential leaves',async t=>{
  const {app,url}=completeListFixture(t,3,4);
  const valid=await getPage(app,url,{q:'Matching',limit:1});
  assert.equal(valid.statusCode,200,valid.body);assert.equal(valid.json().items.length,1);assert.equal(valid.json().workflows.length,1);
  for(const secret of ['synthetic-registry-key','password="synthetic-password-value"','sk-'+'x'.repeat(30)]) {
    const refused=await getPage(app,url,{q:secret,limit:1});
    assert.equal(refused.statusCode,400,refused.body);assert.match(refused.json().error,/credential/i);assert.ok(!refused.body.includes(secret));
  }
  assert.equal((await getPage(app,url,{q:'Matching',unapproved:'retained'})).statusCode,400);
  assert.equal((await app.inject({url:url+'?q=Matching&q=ignored',headers})).statusCode,400);
  assert.equal((await getPage(app,'/api/workspace',{management:true,unapproved:'retained'})).statusCode,400);
});
