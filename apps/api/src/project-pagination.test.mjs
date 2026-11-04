import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';

async function codec() {
  const module=await import('./project-pagination.ts').catch(()=>({}));
  assert.equal(typeof module.ProjectPagination,'function','server-only authenticated pagination codec must exist');
  return module;
}
const binding={namespace:'overview',projectId:'p',mapRevision:1,grantRevision:2,
  filter:'{"projectId":"p","development":null,"q":"","itemId":null,"workflowId":null,"stepId":null,"limit":50}',viewDigest:'a'.repeat(64)};
const stale=error=>error.status===409&&error.code==='STALE_CURSOR'&&error.message==='This list changed. Refresh to continue.';

test('overview cursor canonical filter uses the pinned full-filter order and excludes cursor',async()=>{
  const {canonicalOverviewFilter}=await codec();
  assert.equal(typeof canonicalOverviewFilter,'function');
  assert.equal(canonicalOverviewFilter('p',{cursor:'ignored'}),binding.filter);
  assert.equal(canonicalOverviewFilter('p',{limit:1,q:'  سطر\n2  ',development:'future',stepId:'s',workflowId:'w',itemId:'i'}),
    '{"projectId":"p","development":"future","q":"  سطر\\n2  ","itemId":"i","workflowId":"w","stepId":"s","limit":1}');
});

test('cursor v1 has an independently checked HMAC and replays only under its exact binding',async()=>{
  const {ProjectPagination}=await codec();
  const key=Buffer.alloc(32,7);
  const pager=new ProjectPagination(key);
  const cursor=pager.encode(binding,50);
  assert.ok(cursor.length<=2048);
  const [payload,signature]=cursor.split('.');
  assert.equal(signature,createHmac('sha256',key).update(payload).digest('base64url'));
  assert.equal(pager.decode(cursor,binding),50);
  assert.equal(pager.decode(cursor,binding),50);
  for(const extra of [{namespace:'management'},{projectId:'other'},{mapRevision:2},{grantRevision:3},{filter:binding.filter.replace('50','1')},{viewDigest:'b'.repeat(64)}]) {
    assert.throws(()=>pager.decode(cursor,{...binding,...extra}),stale);
  }
  const changedSignature=(signature[0]==='A'?'B':'A')+signature.slice(1);
  assert.throws(()=>pager.decode(payload+'.'+changedSignature,binding),stale);
});

test('cursor signatures survive same-process instances but a replaced process key is stale',async()=>{
  const {ProjectPagination}=await codec();
  const cursor=new ProjectPagination().encode(binding,50);
  assert.equal(new ProjectPagination().decode(cursor,binding),50);
  assert.throws(()=>new ProjectPagination(Buffer.alloc(32,19)).decode(cursor,binding),stale);
});

test('malformed oversized cursors and invalid offsets are refused separately from signed stale cursors',async()=>{
  const {ProjectPagination}=await codec();
  const pager=new ProjectPagination();
  for(const cursor of ['', 'not-a-cursor', '@@@.@@@', 'x'.repeat(2049)])assert.throws(()=>pager.decode(cursor,binding),error=>error.status===400);
  for(const offset of [-1,1.1,NaN,Infinity])assert.throws(()=>pager.encode(binding,offset),error=>error.status===400);
});
