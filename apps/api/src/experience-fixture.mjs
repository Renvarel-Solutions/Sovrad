// Test-only synthetic metadata. No repository preparation, provider or native runner.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Storage} from './storage.ts';
import {buildApp} from './server.ts';
import {CALCULATOR_WORKFLOW, buildSelectedAnnotationMaterial, digestSelectedAnnotationMaterial} from '@renvarel/architect-core';

export const headers = {host:'127.0.0.1:4317', origin:'http://127.0.0.1:5173', 'x-sovrad-action':'1'};
export const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const get = (f, url, extra={}, method='GET') => f.app.inject({method, url, headers:{...headers,...extra}});
export const post = (f, url, payload, cookie=f.cookie, extra={}) => f.app.inject({method:'POST',url,payload,headers:{...headers,...(cookie ? {cookie} : {}),...extra}});
export const conflict = fn => assert.throws(fn, error => error?.statusCode === 409 || error?.status === 409);
export const forbidden = fn => assert.throws(fn, error => error?.statusCode === 403 || error?.status === 403);

export function fixture(t, {trusted=true,appOptions={ai:{enabled:false}}}={}) {
  const directory = mkdtempSync(path.join(os.tmpdir(),'sovrad-experience-'));
  const facts = new Map();
  let clock = Date.parse('2026-11-11T10:00:00.000Z');
  const authority = {current:work => structuredClone(facts.get(work.id) ?? null)};
  const options = {now:()=>clock,...(trusted ? {authority} : {})};
  let storage = new Storage(directory, options);
  let app = buildApp(storage, appOptions);
  const db = new Database(path.join(directory,'sovrad.sqlite'));
  const f = {directory,db,facts,cookie:null,session:null,
    get storage(){return storage;}, get app(){return app;},get now(){return clock;},
    advance(ms){clock += ms;},
    async reopen(trust=trusted) {await app.close(); storage = new Storage(directory,{now:()=>clock,...(trust?{authority}:{})}); app = buildApp(storage,appOptions);},
  };
  t.after(async()=>{db.close();await app.close();rmSync(directory,{recursive:true,force:true});});
  return f;
}

export async function bootstrap(f) {
  assert.equal((await get(f,'/api/health')).statusCode,200,'existing HTTP control');
  const r = await get(f,'/api/local-session',f.cookie ? {cookie:f.cookie}:{});
  assert.equal(r.statusCode,200,r.body);
  f.session = r.json().session;
  const set = r.headers['set-cookie'];
  if(set) f.cookie = (Array.isArray(set)?set[0]:set).split(';')[0];
  assert.ok(f.cookie,'cookie must come from actual HTTP bootstrap');
  return r;
}

export function approveSpec(f) {
  const w = f.storage.workflow(CALCULATOR_WORKFLOW.id);
  const p = f.storage.propose({workflowId:w.id,stepId:'number-a',baseRevision:w.revision,
    text:'Clarify the fictional finite-number contract.',proposedRules:[...w.steps[0].rules,'Use finite operands.'],
    explanation:'Synthetic specification review',provenance:'manual'});
  f.storage.decide(p.id,'approve');
}

export async function draft(f, overrides={}) {
  const w = f.storage.workflow(CALCULATOR_WORKFLOW.id), p=f.storage.registry.project('sample-calculator');
  const context = overrides.context ?? {projectId:p.id,workflowId:w.id,stepId:'number-a',specRevision:w.revision,mapRevision:p.mapRevision};
  const input = {clientRequestId:randomUUID(),context,text:'Implement the fictional accepted calculation.',
    target:'codex',intent:'instruction',promoteFuture:false,...overrides};
  const selected = f.storage.registry.resolveContext(context);
  const material = buildSelectedAnnotationMaterial({draft:input,...selected});
  return {...input,dispatch:{mode:'connected',consent:true,contextDigest:await digestSelectedAnnotationMaterial(material),...overrides.dispatch}};
}

export async function work(f, overrides={}, interpretation={kind:'implementation',summary:'Implement the synthetic finite operand rule.',
  acceptance:[{id:'input-a',description:'Accept a finite first operand.'},{id:'input-b',description:'Reject nonfinite first operands.'}],ruleIds:[]}) {
  const r=await post(f,'/api/annotations',await draft(f,overrides));
  assert.equal(r.statusCode,201,r.body);
  const saved=r.json();
  if(interpretation) {
    const {WorkController}=await import('./work-controller.ts');
    const controller = new WorkController(f.storage.work,{target:'codex',async interpret(){return interpretation;}});
    await controller.dispatchPending(saved.work.id);
    saved.work=f.storage.work.get(saved.work.id);
    assert.equal(saved.work.interpretation?.kind,interpretation.kind,'trusted interpreter positive control');
  }
  return saved;
}

export function installAuthority(f, w) {
  const workflow=f.storage.workflow(w.context.workflowId);
  const receipt=f.db.prepare("SELECT id FROM audit_events WHERE workflow_id=? AND action='approve' AND resulting_revision=? ORDER BY rowid DESC LIMIT 1").get(workflow.id,workflow.revision);
  assert.ok(receipt,'fixture requires real approved-spec audit receipt');
  const specDigest=sha(workflow),acceptanceDigest=sha('fixed fictional calculator acceptance suite v1');
  const manifest={workflowId:workflow.id,specRevision:workflow.revision,specDigest,specReceiptId:receipt.id,
    repositoryId:'calculator-v1',baseCommit:'a'.repeat(40),allowedFiles:['calculator.mjs'],
    acceptanceSuite:'calculator-v1',acceptanceDigest,maxSeconds:600};
  const value={repositoryId:manifest.repositoryId,baseCommit:manifest.baseCommit,sourceRevision:'a'.repeat(40),
    specDigest,specReceiptId:receipt.id,acceptanceDigest,acceptanceSnapshot:structuredClone(w.interpretation.acceptance),manifestDigest:sha(manifest),manifest};
  f.facts.set(w.id,value);
  return value;
}

export const explanation = () => ({action:'Review the fictional request.',reasonOutsideGrant:'A separate owner decision is required.',
  expectedResult:'Record one bounded approval only.',directEffects:['Store an immutable receipt.'],indirectEffects:['No runtime is launched.'],
  uncertainties:['The native adapter is unavailable.'],cost:{oneTimeMicros:0,ongoingMicros:0,capMicros:0,payer:'Local owner'},
  failure:'No implementation is produced.',interruption:'The pending request remains blocked.',detection:'Read the event history.',
  recovery:'Review a fresh request.',backup:'Private SQLite history is retained.',irreversibility:'The receipt remains in history.',
  alternatives:['Reject','Request revision'],recommendation:'Inspect the exact bound revision.'});

export function decisionInput(f,w=null,overrides={}) {
  const p=f.storage.registry.project(w?.projectId ?? 'sample-calculator');
  const a=w ? f.facts.get(w.id):null;
  return {clientRequestId:randomUUID(),projectId:p.id,workId:w?.id ?? null,expectedWorkVersion:w?.version ?? null,
    context:w?.context ?? {projectId:p.id,mapRevision:p.mapRevision},
    binding:{specRevision:w?.context.specRevision ?? null,mapRevision:p.mapRevision,grantRevision:p.grantRevision,
      repositoryId:a?.repositoryId ?? null,baseCommit:a?.baseCommit ?? null,action:a?'synthetic_execute':'review',
      permissionScope:a?['synthetic_execute']:[],expiresAt:new Date(f.now+600_000).toISOString(),costCapMicros:0},
    explanation:explanation(),...overrides};
}

export const action = (d,kind='approve',overrides={}) => ({clientRequestId:randomUUID(),expectedVersion:d.version,
  proposalDigest:d.proposalDigest,action:kind,reason:'Reviewed this exact fictional request.',...overrides});

export async function approved(f,{overrides={},interpretation}={}) {
  if(!f.cookie) await bootstrap(f);
  if(f.storage.workflow(CALCULATOR_WORKFLOW.id).revision===1) approveSpec(f);
  const saved=await work(f,overrides,interpretation);
  installAuthority(f,saved.work);
  const d=f.storage.decisions.create(decisionInput(f,saved.work));
  const input=action(d);
  const response=await post(f,`/api/decisions/${d.id}/action`,input);
  assert.equal(response.statusCode,200,response.body);
  const current=f.storage.work.get(saved.work.id);
  return {...saved,work:current,decision:response.json().decision,input};
}

export async function running(f,options={}) {
  const a=await approved(f,options);
  const frozen=f.storage.executionBindings.freeze({workId:a.work.id,expectedVersion:a.work.version,decisionId:a.decision.id});
  return {...a,...frozen};
}

export function evidence(f,r,acceptanceId=r.binding.acceptanceSnapshot[0]?.id,overrides={}) {
  return f.storage.evidence.record({kind:'runtime',...r.handle,sourceClass:'test_runtime',environment:'synthetic in-process fixture',
    checkedAt:new Date(f.now).toISOString(),acceptanceId,outcome:'passed',summary:'The fictional acceptance assertion passed.',...overrides});
}
export const passes=(f,r)=>r.binding.acceptanceSnapshot.map(a=>evidence(f,r,a.id));
export const complete=(f,r,outcome='completed')=>f.storage.executionBindings.complete({handle:r.handle,outcome});
export async function views(f,r,expected) {
  const detail=await get(f,`/api/work/${r.work.id}`);assert.equal(detail.statusCode,200,detail.body);
  assert.equal(detail.json().verification,expected,'Work detail projection');
  const workflow=await get(f,`/api/workflows/${r.work.context.workflowId}`);
  const node=workflow.json().stepVerification.find(s=>s.stepId===r.work.context.stepId);
  assert.equal(node.verification,expected,'workflow/graph projection');
  const overview=await get(f,`/api/projects/${r.work.projectId}/overview`);
  assert.equal(overview.json().workflows.find(w=>w.id===r.work.context.workflowId).stepVerification.find(s=>s.stepId===r.work.context.stepId).verification,expected,'overview projection');
  return detail.json();
}
