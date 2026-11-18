import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSelectedAnnotationMaterial,digestSelectedAnnotationMaterial} from '@renvarel/architect-core';
import {
  marker,securityFixture,routeCases,positive,inject,unchanged,snapshot,safeResponse,
  makeDecision,workflowId,proposalBody,importBody,uuid,annotationBody,
} from './endpoint-security-fixture.mjs';

const quoted='password="fictional-task6-secret-value"';
const escaped=quoted.replaceAll('"','\\"');
const apiKeyQuoted='api_key="fictional-task6-key-value"';
const apiKeyEscaped=apiKeyQuoted.replaceAll('"','\\"');
const variants=[marker,'sk-'+'q'.repeat(30),quoted,escaped,escaped.replaceAll('\\','\\\\').replaceAll('"','\\"'),
  'api_key=fictional-task6-key-value',apiKeyQuoted,apiKeyEscaped,apiKeyEscaped.replaceAll('\\','\\\\').replaceAll('"','\\"')];
const privateForms=value=>[value,JSON.stringify(value).slice(1,-1),value.replace(/\\([\\"'])/g,'$1')];

function absent(value,secrets=variants) {
  const text=typeof value==='string'?value:JSON.stringify(value);
  for(const secret of secrets)for(const form of privateForms(secret))assert.ok(!text.includes(form),'synthetic private material escaped to a sink');
}
async function captureConsole(operation) {
  const names=['log','warn','error','info','debug'],originals=names.map(n=>console[n]),output=[];
  for(const name of names)console[name]=(...args)=>output.push(args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '));
  try {const result=await operation();absent(output);return result;}
  finally {for(const [i,name]of names.entries())console[name]=originals[i];}
}
function setField(value,field,next) {
  const result=structuredClone(value),parts=field.split('.');let target=result;
  for(const part of parts.slice(0,-1))target=target[part];
  target[parts.at(-1)]=next;return result;
}
function fieldValue(value,field) {return field.split('.').reduce((current,key)=>current[key],value);}
async function screenedPayload(f,c,field,secret) {
  const payload=setField(c.payload,field,field==='absolutePath'?'C:/fictional-not-read/'+secret:secret);
  if(payload.clientRequestId)payload.clientRequestId=uuid();
  if(field==='text'&&payload.context&&payload.dispatch) {
    const selected=f.storage.registry.resolveContext(payload.context);
    const material=buildSelectedAnnotationMaterial({draft:payload,...selected});
    payload.dispatch.contextDigest=await digestSelectedAnnotationMaterial(material);
  }
  return payload;
}
const contentCases=[
  ['POST /api/projects','name'],['POST /api/projects','description'],
  ['POST /api/projects/:id/settings','name'],['POST /api/projects/:id/settings','description'],
  ['POST /api/projects/:id/items','name'],['POST /api/projects/:id/items','description'],
  ['POST /api/projects/:id/items/:itemId','name'],['POST /api/projects/:id/items/:itemId','description'],
  ['POST /api/projects/:id/workflows','name'],['POST /api/projects/:id/workflows','description'],
  ['POST /api/projects/:id/workflows','steps.0.title'],['POST /api/projects/:id/workflows','steps.0.purpose'],
  ['POST /api/projects/:id/workflows','steps.0.rules.0'],['POST /api/projects/:id/workflows','steps.0.errorBehavior'],
  ['POST /api/projects/:id/repositories','alias'],['POST /api/projects/:id/repositories','absolutePath'],
  ['POST /api/annotations','text'],['POST /api/work/:id/amend','text'],['POST /api/work/:id/cancel','reason'],
  ['POST /api/proposals','text'],['POST /api/proposals','explanation'],['POST /api/proposals','proposedRules.0'],
];

for(const [key,field]of contentCases)test(`Task6 private raw quoted escaped ${key} ${field}`,{concurrency:false},async t=>{
  assert.ok(routeCases[key],'content case must bind to an inventoried route fixture');
  const control=await securityFixture(t),good=await routeCases[key](control);
  // Settings has two independent metadata fields; exercise the ordinary field
  // being screened even when the base action happens to rename only.
  if(field==='description'&&good.payload.description===undefined)good.payload.description='Synthetic reviewed description.';
  const success=await positive(control,good);
  assert.ok(fieldValue(good.payload,field).length,'the selected ordinary field must be nonempty');
  const result=success.json(),saved=result.project??result.item??result.workflow??result.repository??result.annotation??result.proposal;
  if(field==='reason')assert.ok(control.storage.work.events(result.work.id,{}).events.some(e=>e.detail===good.payload.reason));
  else if(field==='absolutePath')assert.equal(control.db.prepare('SELECT absolute_path FROM repository_candidates WHERE id=?').get(result.repository.id).absolute_path,good.payload.absolutePath);
  else assert.equal(fieldValue(saved,field),fieldValue(good.payload,field),'ordinary selected value is genuinely retained');
  const f=await securityFixture(t),c=await routeCases[key](f);
  for(const secret of variants) {
    const payload=await screenedPayload(f,c,field,secret);
    await captureConsole(async()=>{
      const r=await unchanged(f,c,{payload},400,variants);absent(r.body);absent(snapshot(f));
    });
  }
  await positive(f,c);
});

for(const kind of ['approve','reject','request_revision'])test(`Task6 ${kind} reason refuses every private representation before receipt event or replay row`,{concurrency:false},async t=>{
  const control=await securityFixture(t);await positive(control,makeDecision(control,null,kind));
  const f=await securityFixture(t),c=makeDecision(f,null,kind);
  for(const secret of variants)await captureConsole(async()=>{
    const payload={...c.payload,clientRequestId:uuid(),reason:secret};
    const r=await unchanged(f,c,{payload},400,variants);absent(r.body);absent(snapshot(f));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM decision_receipts').get().n,0);
  });
  await positive(f,c);
});

test('Task6 connected annotation secret refusal has fresh consent and exact digest but creates no receipt or outbox',async t=>{
  const f=await securityFixture(t),body=await annotationBody(f,{dispatch:{mode:'connected',consent:true}});
  const c={method:'POST',url:'/api/annotations',payload:body};
  for(const secret of variants)await captureConsole(async()=>{
    const payload=await screenedPayload(f,c,'text',secret);
    await unchanged(f,c,{payload},400,variants);absent(snapshot(f));
  });
  const good=await inject(f,c);assert.equal(good.statusCode,201,good.body);
  const saved=good.json();assert.equal(saved.work.state,'blocked');assert.equal(saved.work.interpretation,null);
  assert.ok(saved.annotation.consentReceipt);assert.equal(saved.annotation.material.text,body.text);
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(saved.work.id).state,'pending');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_bindings').get().n,0);
});

test('Task6 imports refuse valid private-looking selections at the disabled gate without capture or retained content',async t=>{
  const f=await securityFixture(t),c=await routeCases['POST /api/imports'](f);
  // The unchanged503 positive establishes the actual import gate; a400 here
  // would only establish validation, not a content-screening guarantee.
  await positive(f,c);
  for(const secret of variants)for(const field of ['repository','files.0'])await captureConsole(async()=>{
    const payload=setField(importBody(),field,secret);
    const r=await unchanged(f,c,{payload},503,variants);absent(r.body);absent(snapshot(f));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM imported_snapshots').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM import_quarantines').get().n,0);
  });
});

function fakeTransport() {
  const calls=[];
  const fetch=async(url,options)=>{
    calls.push({url:String(url),body:JSON.parse(options.body)});
    const body=String(url).endsWith('/input_tokens')?{input_tokens:100}:{id:'resp_task6_synthetic',object:'response',status:'completed',
      usage:{input_tokens:100,output_tokens:20},output:[{type:'message',role:'assistant',content:[{type:'output_text',
        text:JSON.stringify({proposedRules:['Accept finite fictional operands.'],explanation:'Synthetic AI draft.'})}]}]};
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  return {calls,fetch};
}
test('Task6 enabled AI synthetic transport reaches a real201 but all private inputs stop before transport quota or spending',async t=>{
  const transport=fakeTransport(),f=await securityFixture(t,{enabled:true,apiKey:marker,hardLimitConfirmed:true,fetch:transport.fetch});
  const {proposedRules,explanation,...selected}=proposalBody(f),payload={...selected,sendToAI:true};
  const c={method:'POST',url:'/api/ai/proposal',payload};
  const good=await inject(f,c);assert.equal(good.statusCode,201,good.body);safeResponse(good);
  assert.equal(good.json().proposal.status,'draft');assert.equal(good.json().proposal.provenance,'openai-api');
  assert.equal(transport.calls.length,2);assert.equal(transport.calls[1].body.store,false);
  const baselineCalls=structuredClone(transport.calls);
  for(const secret of variants)await captureConsole(async()=>{
    const r=await unchanged(f,c,{payload:{...payload,text:secret}},400,variants);
    absent(r.body);absent(snapshot(f));assert.deepEqual(transport.calls,baselineCalls,'refused selection must not contact even the fake transport');
  });
  assert.equal(f.storage.workflow(workflowId).revision,1);
});

test('Task6 credential query and parser errors do not echo raw or escaped input or mint unauthorized sessions',async t=>{
  const f=await securityFixture(t);
  for(const secret of variants)await captureConsole(async()=>{
    for(const c of [{method:'GET',url:'/api/missing?key='+encodeURIComponent(secret)},
      {method:'GET',url:'/api/local-session?unexpected='+encodeURIComponent(secret)}]) {
      const r=await unchanged(f,c,{},c.url.includes('/missing?')?404:400,variants);absent(r.body);
    }
    const r=await unchanged(f,{method:'POST',url:'/api/annotations'},
      {payload:'{"text":'+JSON.stringify(secret),headers:{'content-type':'application/json'}},400,variants);
    absent(r.body);absent(snapshot(f));
  });
  const sessions=f.db.prepare('SELECT * FROM local_sessions').all();assert.equal(sessions.length,1);
  assert.ok(!JSON.stringify(sessions).includes(f.cookie.split('=')[1]));
});
