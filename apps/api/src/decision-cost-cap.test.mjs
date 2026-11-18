import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,bootstrap,post,work,decisionInput,action,sha,conflict} from './experience-fixture.mjs';
import {snapshot} from './endpoint-security-fixture.mjs';

function withCaps(f,w,bindingCap,displayCap=bindingCap,estimates={}) {
  const base=decisionInput(f,w);
  return {...base,binding:{...base.binding,costCapMicros:bindingCap},
    explanation:{...structuredClone(base.explanation),cost:{...base.explanation.cost,...estimates,capMicros:displayCap}}};
}
const invalid=fn=>assert.throws(fn,error=>error?.name==='ZodError'||error?.status===400,'Invalid caps must fail trusted-create validation.');
const count=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

async function approveExact(f,input) {
  const decision=f.storage.decisions.create(input);
  assert.equal(decision.binding.costCapMicros,input.binding.costCapMicros);
  assert.deepEqual(decision.explanation.cost,input.explanation.cost);
  const frozen=f.db.prepare('SELECT digest_json FROM decisions WHERE id=?').get(decision.id).digest_json;
  assert.equal(sha(frozen),decision.proposalDigest);
  const bytes=JSON.parse(frozen);
  assert.equal(bytes.binding.costCapMicros,input.binding.costCapMicros);
  assert.equal(bytes.explanation.cost.capMicros,input.explanation.cost.capMicros);
  const request=action(decision),response=await post(f,`/api/decisions/${decision.id}/action`,request);
  assert.equal(response.statusCode,200,response.body);
  const approved=response.json().decision;
  assert.equal(approved.status,'approved');assert.equal(approved.receipt.actor,'local-owner-session');
  assert.equal(approved.receipt.proposalDigest,decision.proposalDigest);
  assert.deepEqual(approved.binding,decision.binding);assert.deepEqual(approved.explanation,decision.explanation);
  const stored=JSON.parse(f.db.prepare('SELECT payload FROM decisions WHERE id=?').get(decision.id).payload);
  assert.deepEqual(stored,approved);
  assert.equal(f.db.prepare('SELECT digest_json FROM decisions WHERE id=?').get(decision.id).digest_json,frozen);
  assert.equal(count(f,'execution_bindings'),0,'An owner cost cap and approval do not launch execution.');
  return {decision,approved,request};
}

for(const cap of [0,5_000_000])test(`equal owner-visible and binding cap ${cap} survives genuine cookie approval and immutable digest`,async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);
  const saved=await work(f,{intent:'question'},null);
  await approveExact(f,withCaps(f,saved.work,cap));
  assert.equal(f.storage.work.get(saved.work.id).state,'blocked');
  assert.equal(count(f,'decision_receipts'),1);
});

for(const [bindingCap,displayCap] of [[5_000_000,0],[0,5_000_000]])test(`binding cap ${bindingCap} versus visible ${displayCap} rejects before refresh and every write`,async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);
  const saved=await work(f,{intent:'question'},null);
  const waiting=f.storage.decisions.create(decisionInput(f));
  f.advance(600_001); // Its pending row proves invalid input must not trigger reconciliation either.
  const input=withCaps(f,saved.work,bindingCap,displayCap),before=snapshot(f);
  assert.equal(before.decisions.find(row=>row.id===waiting.id).status,'pending');
  assert.equal(before.work_outbox.length,1,'A real pending dispatch participates in the no-write invariant.');
  invalid(()=>f.storage.decisions.create(input));
  assert.deepEqual(snapshot(f),before,'Mismatch must not mutate decisions, receipts, audit, Work, idempotency, outbox or sequence rows.');
  await approveExact(f,withCaps(f,saved.work,0));
  assert.equal(f.storage.work.get(saved.work.id).state,'blocked');
});

test('both cap fields remain required non-null numbers with no persistence on null input',async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);
  const saved=await work(f,{intent:'question'},null),before=snapshot(f);
  for(const [bindingCap,displayCap] of [[null,0],[0,null]]) {
    invalid(()=>f.storage.decisions.create(withCaps(f,saved.work,bindingCap,displayCap)));
    assert.deepEqual(snapshot(f),before);
  }
  await approveExact(f,withCaps(f,saved.work,5_000_000));
});

test('unknown one-time and ongoing estimates remain unknown under an explicit matching finite maximum',async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);
  const input=withCaps(f,null,5_000_000,5_000_000,{oneTimeMicros:null,ongoingMicros:null});
  const {approved}=await approveExact(f,input);
  assert.equal(approved.explanation.cost.oneTimeMicros,null);assert.equal(approved.explanation.cost.ongoingMicros,null);
  assert.equal(approved.binding.costCapMicros,5_000_000);assert.equal(approved.explanation.cost.capMicros,5_000_000);
});

test('changing both equal caps under one create key conflicts while exact create/action replay has one effect',async t=>{
  const f=fixture(t,{trusted:false});await bootstrap(f);
  const saved=await work(f,{intent:'question'},null),input=withCaps(f,saved.work,5_000_000);
  const pending=f.storage.decisions.create(input),beforeReplay=snapshot(f);
  assert.deepEqual(f.storage.decisions.create(structuredClone(input)),pending);assert.deepEqual(snapshot(f),beforeReplay);
  const changed={...structuredClone(input),binding:{...input.binding,costCapMicros:6_000_000},
    explanation:{...structuredClone(input.explanation),cost:{...input.explanation.cost,capMicros:6_000_000}}};
  conflict(()=>f.storage.decisions.create(changed));assert.deepEqual(snapshot(f),beforeReplay);
  const request=action(pending),first=await post(f,`/api/decisions/${pending.id}/action`,request);
  assert.equal(first.statusCode,200,first.body);const approved=first.json().decision,after=snapshot(f);
  assert.deepEqual(f.storage.decisions.create(structuredClone(input)),approved);
  assert.deepEqual((await post(f,`/api/decisions/${pending.id}/action`,request)).json().decision,approved);
  conflict(()=>f.storage.decisions.create(changed));assert.deepEqual(snapshot(f),after);
  assert.equal(count(f,'decisions'),1);assert.equal(count(f,'decision_receipts'),1);assert.equal(count(f,'execution_bindings'),0);
  assert.equal(approved.receipt.proposalDigest,pending.proposalDigest);
  assert.equal(approved.binding.costCapMicros,5_000_000);assert.equal(approved.explanation.cost.capMicros,5_000_000);
});
