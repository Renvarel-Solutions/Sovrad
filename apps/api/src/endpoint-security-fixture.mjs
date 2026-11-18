// Synthetic HTTP fixtures only. Legacy task cases use the existing temporary
// calculator repository; no native coding, provider or import capture is used.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {
  fixture,bootstrap,headers,post,draft,approveSpec,decisionInput,action,
} from './experience-fixture.mjs';

export {headers,post,bootstrap,decisionInput,action};
export const marker='synthetic-task6-private-marker-never-retain';
export const projectId='sample-calculator';
export const workflowId='sample-calculator-arithmetic';
export const stepId='number-a';
export const uuid=()=>randomUUID();
export const projectBody=()=>({clientRequestId:uuid(),name:'Fictional boundary project',description:'Synthetic planning data.'});
export const itemBody=(f,id=projectId)=>({clientRequestId:uuid(),expectedMapRevision:f.storage.registry.project(id).mapRevision,
  parentId:null,kind:'feature',name:'Fictional item',description:'Synthetic scope.',development:'planning',workflowId:null});
export const workflowBody=(f,id=projectId)=>({clientRequestId:uuid(),expectedMapRevision:f.storage.registry.project(id).mapRevision,
  itemId:null,name:'Fictional workflow',description:'Synthetic map.',steps:[{id:'inspect',title:'Inspect',purpose:'Review fictional input.',
    kind:'process',rules:['Keep fictional input bounded.'],errorBehavior:'Explain invalid input.',position:{x:0,y:0}}],connections:[]});
export const proposalBody=f=>({workflowId,stepId,baseRevision:f.storage.workflow(workflowId).revision,
  text:'Clarify fictional finite input.',proposedRules:['Accept finite operands.'],explanation:'Synthetic review.'});
export const importBody=()=>({repository:'C:/fictional-not-read',commit:'a'.repeat(40),files:['readme.md']});

export async function securityFixture(t,ai={enabled:false,apiKey:marker}) {
  const f=fixture(t,{trusted:false,appOptions:{ai}});
  await bootstrap(f);
  return f;
}
export function snapshot(f) {
  // Table names originate only from this synthetic fixture's SQLite schema.
  const names=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
  return Object.fromEntries(names.map(name=>[name,f.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));
}
export async function inject(f,c,overrides={}) {
  const {headers:extra={},omitHeaders=[],...rest}=overrides,requestHeaders={...headers,cookie:f.cookie,...extra};
  for(const name of omitHeaders)delete requestHeaders[name];
  return f.app.inject({method:c.method,url:c.url,...(c.payload===undefined?{}:{payload:c.payload}),...rest,headers:requestHeaders});
}
export function safeResponse(r,secrets=[marker]) {
  assert.equal(r.headers['cache-control'],'no-store');
  assert.equal(r.headers['x-content-type-options'],'nosniff');
  for(const secret of secrets) {
    assert.ok(!r.body.includes(secret),'response must not echo synthetic private content');
    assert.ok(!r.body.includes(JSON.stringify(secret).slice(1,-1)),'response must not echo escaped private content');
  }
}
export async function positive(f,c) {
  const r=await inject(f,c);
  assert.equal(r.statusCode,c.code,`${c.method} ${c.url}: ${r.body}`);
  safeResponse(r);
  c.verify(r.json(),f);
  return r;
}
export async function unchanged(f,c,overrides,code,secrets=[marker]) {
  const before=snapshot(f),r=await inject(f,c,overrides);
  assert.equal(r.statusCode,code,`${c.method} ${c.url}: ${r.body}`);
  safeResponse(r,secrets);
  assert.deepEqual(snapshot(f),before,'refusal/HEAD must preserve all synthetic semantic rows and sequence counters');
  return r;
}
const read=(url,verify)=>({method:'GET',url,code:200,verify});
const write=(url,payload,code,verify)=>({method:'POST',url,payload,code,verify});
const has=(rows,id)=>assert.ok(rows.some(row=>row.id===id),`expected fixture row ${id}`);
export function context(f,id=projectId,wid=workflowId,sid=stepId) {
  const p=f.storage.registry.project(id),w=wid?f.storage.workflow(wid):null;
  return {projectId:id,mapRevision:p.mapRevision,...(w?{workflowId:wid,specRevision:w.revision}:{}),...(sid?{stepId:sid}:{})};
}
export async function annotationBody(f,overrides={}) {
  return draft(f,{text:'Explain this fictional requirement.',intent:'question',...overrides,
    dispatch:{mode:'local',consent:false,...overrides.dispatch}});
}
export async function saveWork(f,overrides={}) {
  const body=await annotationBody(f,overrides),r=await post(f,'/api/annotations',body);
  assert.equal(r.statusCode,201,r.body);
  const value=r.json();assert.equal(value.work.annotationId,value.annotation.id);
  return value;
}
export function makeProject(f) {return f.storage.registry.create(projectBody()).project;}
export function makeItem(f,id=projectId) {return f.storage.registry.saveItem(id,itemBody(f,id)).item;}
export function makeWorkflow(f,id=projectId) {return f.storage.registry.saveWorkflow(id,workflowBody(f,id)).workflow;}
export function layoutBody(f,id=workflowId) {
  const w=f.storage.workflow(id),layout=f.storage.registry.layout(id);
  return {expectedLayoutRevision:layout.layoutRevision,positions:w.steps.map(s=>({stepId:s.id,x:s.position.x+10,y:s.position.y}))};
}
export function candidateBody(f,id=projectId) {
  return {clientRequestId:uuid(),expectedGrantRevision:f.storage.registry.project(id).grantRevision,
    alias:'Fictional candidate',absolutePath:'C:/fictional-not-read'};
}
export function makeDecision(f,w=null,kind='approve',overrides={}) {
  const d=f.storage.decisions.create(decisionInput(f,w,overrides));
  return write(`/api/decisions/${d.id}/action`,action(d,kind),200,(body)=>{
    const next=body.decision;
    assert.equal(next.id,d.id);assert.equal(next.status,{approve:'approved',reject:'rejected',request_revision:'revision_requested'}[kind]);
    assert.equal(next.receipt.actor,'local-owner-session');assert.equal(next.receipt.sessionId,f.session.id);
    assert.equal(next.receipt.reason,'Reviewed this exact fictional request.');assert.equal(next.receipt.proposalDigest,d.proposalDigest);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM decision_receipts WHERE decision_id=?').get(d.id).n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_bindings').get().n,0);
  });
}
function knowledge(f) {
  return f.storage.evidence.record({kind:'knowledge',projectId,workId:null,context:context(f),sourceClass:'documentation',
    sourceRevision:null,environment:'synthetic test',checkedAt:new Date(f.now).toISOString(),outcome:'not_checked',summary:'Fictional documentation observation.'});
}
function snapshotRow(f) {
  const content='Fictional public documentation fixture.',sha=createHash('sha256').update(content).digest('hex');
  const row={id:uuid(),sourceCommit:'a'.repeat(40),repositoryId:'fictional-import-fixture',capturedAt:new Date(f.now).toISOString(),
    readOnly:true,executable:false,files:[{path:'readme.md',sha256:sha,gitBlob:'b'.repeat(40),content,category:'documented'}]};
  f.db.prepare('INSERT INTO imported_snapshots(id,payload) VALUES (?,?)').run(row.id,JSON.stringify(row));return row;
}
async function legacyTask(f,approved=false) {
  approveSpec(f);
  const created=await post(f,'/api/implementation/tasks',{workflowId,revision:f.storage.workflow(workflowId).revision});
  assert.equal(created.statusCode,201,created.body);const task=created.json().task;
  assert.equal(task.manifest.allowedFiles[0],'calculator.mjs');
  if(approved) {
    const r=await post(f,`/api/implementation/tasks/${task.id}/approve`,{manifestDigest:task.manifestDigest});
    assert.equal(r.statusCode,200,r.body);assert.equal(r.json().task.approval.actor,'delegated-review');
  }
  return f.storage.implementation.get(task.id);
}

export const retainedCases={
  'GET /api/health':async()=>read('/api/health',b=>{assert.equal(b.ok,true);assert.equal(b.mode,'local-only');assert.equal(b.runnerEnabled,false);}),
  'GET /api/projects':async()=>read('/api/projects',b=>has(b.projects,projectId)),
  'GET /api/projects/:id/workflows':async()=>read(`/api/projects/${projectId}/workflows`,b=>has(b.workflows,workflowId)),
  'GET /api/workflows/:id':async()=>read(`/api/workflows/${workflowId}`,b=>{assert.equal(b.workflow.id,workflowId);assert.ok(b.workflow.steps.length);assert.ok(b.stepVerification.length);}),
  'POST /api/proposals':async f=>write('/api/proposals',proposalBody(f),201,b=>{assert.equal(b.proposal.status,'draft');assert.equal(f.storage.proposals(workflowId).length,1);}),
  'POST /api/proposals/:id/decision':async f=>{
    const p=f.storage.propose({...proposalBody(f),provenance:'manual'}),revision=p.baseRevision;
    return write(`/api/proposals/${p.id}/decision`,{action:'approve'},200,b=>{
      assert.equal(b.proposal.status,'approved');assert.equal(f.storage.workflow(workflowId).revision,revision+1);
      assert.ok(f.storage.history(workflowId).length>1);
    });
  },
  'GET /api/ai/status':async()=>read('/api/ai/status',b=>{assert.equal(b.configured,false);assert.equal(typeof b.paused,'boolean');}),
  'POST /api/ai/proposal':async f=>write('/api/ai/proposal',{...(({proposedRules,explanation,...body})=>body)(proposalBody(f)),sendToAI:true},503,b=>{
    assert.match(b.error,/disabled/);assert.equal(f.storage.proposals(workflowId).length,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ai_daily_usage').get().n,0);
  }),
  'GET /api/implementation/status':async()=>read('/api/implementation/status',b=>{assert.equal(b.enabled,false);assert.match(b.reason,/isolation/i);}),
  'GET /api/workflows/:id/tasks':async f=>{const task=await legacyTask(f);return read(`/api/workflows/${workflowId}/tasks`,b=>has(b.tasks,task.id));},
  'POST /api/implementation/tasks':async f=>{
    approveSpec(f);return write('/api/implementation/tasks',{workflowId,revision:f.storage.workflow(workflowId).revision},201,b=>{
      assert.equal(b.task.state,'awaiting_approval');assert.equal(b.task.approval,null);assert.equal(b.task.manifest.allowedFiles[0],'calculator.mjs');
      assert.ok(f.storage.implementation.events(b.task.id).some(e=>e.kind==='created'));
    });
  },
  'GET /api/implementation/tasks/:id':async f=>{const task=await legacyTask(f);return read(`/api/implementation/tasks/${task.id}`,b=>assert.deepEqual(b.task,task));},
  'GET /api/implementation/tasks/:id/events':async f=>{const task=await legacyTask(f);return read(`/api/implementation/tasks/${task.id}/events`,b=>assert.ok(b.events.some(e=>e.kind==='created')));},
  'POST /api/implementation/tasks/:id/approve':async f=>{
    const task=await legacyTask(f);return write(`/api/implementation/tasks/${task.id}/approve`,{manifestDigest:task.manifestDigest},200,b=>{
      assert.equal(b.task.id,task.id);assert.equal(b.task.approval.manifestDigest,task.manifestDigest);assert.equal(b.task.approval.actor,'delegated-review');
    });
  },
  'POST /api/implementation/tasks/:id/start':async f=>{
    const task=await legacyTask(f,true);return write(`/api/implementation/tasks/${task.id}/start`,{},503,b=>{
      assert.equal(b.blocked,true);assert.equal(b.task.id,task.id);assert.ok(b.task.findings.length);
      assert.ok(f.storage.implementation.events(task.id).some(e=>e.kind==='preflight_blocked'));assert.equal(b.task.state,'awaiting_approval');
    });
  },
  'POST /api/implementation/tasks/:id/cancel':async f=>{
    const task=await legacyTask(f);return write(`/api/implementation/tasks/${task.id}/cancel`,{},200,b=>{
      assert.equal(b.task.id,task.id);assert.equal(b.task.state,'cancelled');assert.equal(b.task.approval,null);
    });
  },
  'GET /api/imports/status':async()=>read('/api/imports/status',b=>{assert.equal(b.enabled,false);assert.match(b.reason,/isolation/i);}),
  'GET /api/imports':async f=>{const row=snapshotRow(f);return read('/api/imports',b=>{assert.deepEqual(b.snapshots,[row]);assert.ok(b.snapshots[0].files[0].content);});},
  'GET /api/imports/:id':async f=>{const row=snapshotRow(f);return read(`/api/imports/${row.id}`,b=>assert.deepEqual(b.snapshot,row));},
  'POST /api/imports':async f=>write('/api/imports',importBody(),503,b=>{assert.match(b.error,/blocked/i);assert.equal(f.db.prepare('SELECT count(*) AS n FROM imported_snapshots').get().n,0);}),
};

export const projectCases={
  'GET /api/workspace':async f=>{
    const saved=await saveWork(f);return read('/api/workspace',b=>{has(b.projects,projectId);assert.equal(b.counts.new,1);assert.ok(saved.work.id);});
  },
  'POST /api/workspace/access':async f=>write('/api/workspace/access',{mode:'selected',selectedProjectIds:[projectId]},200,b=>{
    assert.deepEqual(b.access,{mode:'selected',selectedProjectIds:[projectId]});assert.equal(f.storage.registry.project(projectId).grant,'synthetic_execute');
  }),
  'POST /api/projects':async f=>write('/api/projects',projectBody(),201,b=>{assert.equal(b.project.grant,'planning_only');assert.equal(b.project.sourceState,'unmapped');assert.equal(f.storage.registry.project(b.project.id).name,'Fictional boundary project');}),
  'POST /api/projects/:id/settings':async f=>{
    const p=f.storage.registry.project(projectId);return write(`/api/projects/${projectId}/settings`,{expectedGrantRevision:p.grantRevision,name:'Fictional renamed'},200,b=>{
      assert.equal(b.project.name,'Fictional renamed');assert.equal(b.project.mapRevision,p.mapRevision+1);assert.equal(b.project.grantRevision,p.grantRevision);
    });
  },
  'GET /api/projects/:id/overview':async f=>{
    const item=makeItem(f);return read(`/api/projects/${projectId}/overview`,b=>{has(b.items,item.id);has(b.workflows,workflowId);assert.equal(b.totals.items,b.items.length);assert.ok(b.totals.workflows);});
  },
  'POST /api/projects/:id/items':async f=>{
    const body=itemBody(f);return write(`/api/projects/${projectId}/items`,body,201,b=>{assert.equal(b.item.projectId,projectId);assert.equal(b.item.name,body.name);assert.equal(f.storage.registry.project(projectId).mapRevision,body.expectedMapRevision+1);});
  },
  'POST /api/projects/:id/items/:itemId':async f=>{
    const item=makeItem(f),m=f.storage.registry.project(projectId).mapRevision;
    return write(`/api/projects/${projectId}/items/${item.id}`,{expectedMapRevision:m,name:'Fictional revised item',description:'Synthetic edit.',development:'planning'},200,b=>{
      assert.equal(b.item.id,item.id);assert.equal(b.item.parentId,item.parentId);assert.equal(b.item.workflowId,item.workflowId);assert.equal(b.item.name,'Fictional revised item');assert.equal(f.storage.registry.project(projectId).mapRevision,m+1);
    });
  },
  'POST /api/projects/:id/workflows':async f=>{
    const body=workflowBody(f);return write(`/api/projects/${projectId}/workflows`,body,201,b=>{
      assert.equal(b.workflow.projectId,projectId);assert.equal(b.workflow.steps[0].id,'inspect');assert.equal(b.workflow.revision,1);assert.equal(f.storage.registry.project(projectId).mapRevision,body.expectedMapRevision+1);
    });
  },
  'POST /api/workflows/:id/layout':async f=>{
    const body=layoutBody(f),w=f.storage.workflow(workflowId),p=f.storage.registry.project(projectId);
    return write(`/api/workflows/${workflowId}/layout`,body,200,b=>{assert.equal(b.layout.layoutRevision,body.expectedLayoutRevision+1);assert.deepEqual(b.layout.positions,body.positions);assert.deepEqual(f.storage.workflow(workflowId),w);assert.equal(f.storage.registry.project(projectId).mapRevision,p.mapRevision);});
  },
  'POST /api/projects/:id/repositories':async f=>write(`/api/projects/${projectId}/repositories`,candidateBody(f),201,b=>{
    assert.deepEqual(Object.keys(b.repository).sort(),['alias','id','state']);assert.equal(b.repository.state,'pending');assert.ok(!JSON.stringify(b).includes('fictional-not-read'));
    assert.equal(f.db.prepare('SELECT absolute_path FROM repository_candidates WHERE id=?').get(b.repository.id).absolute_path,'C:/fictional-not-read');
  }),
};

export const workCases={
  'GET /api/annotations':async f=>{const saved=await saveWork(f);return read(`/api/annotations?projectId=${projectId}`,b=>{has(b.annotations,saved.annotation.id);assert.deepEqual(b.annotations[0],saved.annotation);});},
  'POST /api/annotations':async f=>write('/api/annotations',await annotationBody(f),201,b=>{
    assert.equal(b.work.annotationId,b.annotation.id);assert.ok(b.annotation.materialJSON.length);assert.equal(b.annotation.consentReceipt,null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_outbox').get().n,0);assert.ok(f.storage.work.events(b.work.id,{}).events.length);
  }),
  'GET /api/work':async f=>{const saved=await saveWork(f);return read(`/api/work?projectId=${projectId}`,b=>has(b.work,saved.work.id));},
  'GET /api/work/:id':async f=>{const saved=await saveWork(f);return read(`/api/work/${saved.work.id}`,b=>{assert.equal(b.work.id,saved.work.id);assert.deepEqual(b.annotation,saved.annotation);assert.ok(b.events.length);});},
  'POST /api/work/:id/amend':async f=>{
    const saved=await saveWork(f),body={...await annotationBody(f,{text:'Revise this fictional requirement.'}),expectedVersion:saved.work.version};
    return write(`/api/work/${saved.work.id}/amend`,body,201,b=>{assert.notEqual(b.work.id,saved.work.id);assert.equal(b.annotation.supersedesId,saved.annotation.id);assert.equal(f.storage.work.get(saved.work.id).state,'superseded');assert.equal(b.annotation.revision,2);});
  },
  'POST /api/work/:id/cancel':async f=>{
    const saved=await saveWork(f);return write(`/api/work/${saved.work.id}/cancel`,{clientRequestId:uuid(),expectedVersion:saved.work.version,reason:'Stop this fictional request.'},200,b=>{
      assert.equal(b.work.state,'cancelled');assert.equal(b.work.version,saved.work.version+1);assert.deepEqual(f.storage.work.detail(saved.work.id).annotation,saved.annotation);assert.ok(f.storage.work.events(saved.work.id,{}).events.some(e=>e.kind==='cancelled'));
    });
  },
  'GET /api/work/:id/events':async f=>{const saved=await saveWork(f);return read(`/api/work/${saved.work.id}/events?afterSequence=0&limit=50`,b=>{assert.ok(b.events.length);assert.equal(b.nextAfterSequence,b.events.at(-1).sequence);});},
};

export const experienceCases={
  'GET /api/decisions':async f=>{
    const d=f.storage.decisions.create(decisionInput(f));return read(`/api/decisions?projectId=${projectId}`,b=>{has(b.decisions,d.id);assert.equal(b.total,1);assert.match(b.page.viewDigest,/^[a-f0-9]{64}$/);});
  },
  'POST /api/decisions/:id/action':async f=>makeDecision(f),
  'GET /api/activity':async f=>{
    f.storage.decisions.create(decisionInput(f));return read(`/api/activity?projectId=${projectId}`,b=>{assert.ok(b.events.some(e=>e.kind==='decision_created'));assert.ok(b.nextAfterSequence>0);});
  },
  'GET /api/evidence':async f=>{
    const e=knowledge(f);return read(`/api/evidence?projectId=${projectId}`,b=>{has(b.evidence,e.id);assert.equal(b.evidence[0].summary,e.summary);assert.equal(b.evidence[0].freshness,'historical');assert.equal(b.total,1);});
  },
  'GET /api/connections':async()=>read('/api/connections',b=>{assert.deepEqual(b.connections.map(c=>c.id).sort(),['chatgpt','codex']);for(const c of b.connections){assert.equal(c.state,'unavailable');assert.deepEqual(c.capabilities,[]);assert.equal(c.lastSeenAt,null);assert.ok(c.reason.length);}}),
  'POST /api/connections/:id/connect':async()=>write('/api/connections/codex/connect',{},503,b=>{assert.equal(b.code,'CONNECTION_UNAVAILABLE');assert.equal(b.connection.id,'codex');assert.equal(b.connection.state,'unavailable');assert.deepEqual(b.connection.capabilities,[]);}),
  'POST /api/connections/:id/disconnect':async f=>{
    const saved=await saveWork(f,{dispatch:{mode:'connected',consent:true}});
    return write('/api/connections/codex/disconnect',{},200,b=>{assert.equal(b.connection.state,'unavailable');assert.deepEqual(b.connection.capabilities,[]);assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(saved.work.id).state,'revoked');});
  },
  'GET /api/local-session':async f=>read('/api/local-session',b=>{assert.deepEqual(b.session,f.session);assert.equal(b.session.source,'local-owner-session');assert.ok(!JSON.stringify(b).includes(f.cookie.split('=')[1]));}),
};
export const routeCases={...retainedCases,...projectCases,...workCases,...experienceCases};
export const newRouteKeys=[...Object.keys(projectCases),...Object.keys(workCases),...Object.keys(experienceCases)];
