import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,bootstrap,get,post,work,headers} from './experience-fixture.mjs';

test('persistent Codex/ChatGPT inventory is unavailable with no capability, auth, launch or readiness',async t=>{
  const f=fixture(t);await bootstrap(f);
  const first=await get(f,'/api/connections');assert.equal(first.statusCode,200,first.body);
  const connections=first.json().connections;assert.deepEqual(connections.map(c=>c.id).sort(),['chatgpt','codex']);
  for(const connection of connections) {
    assert.equal(connection.id,connection.target);assert.equal(connection.state,'unavailable');assert.deepEqual(connection.capabilities,[]);
    assert.equal(connection.lastSeenAt,null);assert.ok(connection.reason.length>0);
    const r=await post(f,`/api/connections/${connection.id}/connect`,{});assert.equal(r.statusCode,503,r.body);
    assert.equal(r.json().code,'CONNECTION_UNAVAILABLE');assert.deepEqual(r.json().connection,connection);
    const d=await post(f,`/api/connections/${connection.id}/disconnect`,{});assert.equal(d.statusCode,200,d.body);assert.deepEqual(d.json().connection,connection);
  }
  await f.reopen();await bootstrap(f);assert.deepEqual((await get(f,'/api/connections')).json().connections,connections);
  assert.equal((await get(f,'/api/workspace')).json().connections.length,2);
});

test('each protected grant/connect/disconnect mutation uses a real valid cookie and rejects forged/duplicate/expired values',async t=>{
  const f=fixture(t);await bootstrap(f);
  for(const [url,body,expected] of [
    ['/api/projects/sample-calculator/settings',{expectedGrantRevision:1,grant:'read_only'},200],
    ['/api/connections/codex/connect',{},503],['/api/connections/codex/disconnect',{},200],
    ['/api/connections/chatgpt/connect',{},503],['/api/connections/chatgpt/disconnect',{},200],
  ]) {
    for(const cookie of [null,'sovrad_local_action=forged',`${f.cookie}; ${f.cookie}`]) {
      const r=await post(f,url,body,cookie);assert.equal(r.statusCode,403,r.body);assert.equal(r.json().code,'LOCAL_SESSION_REQUIRED');
    }
    for(const extra of [{actor:'owner'},{sessionId:f.session.id},{token:'fictional'},{endpoint:'https://example.invalid'},{binary:'fictional'}]) assert.equal((await post(f,url,{...body,...extra})).statusCode,400);
    assert.equal((await post(f,url,body)).statusCode,expected,url);
  }
  f.advance(1_800_001);
  for(const url of ['/api/connections/codex/connect','/api/connections/codex/disconnect','/api/projects/sample-calculator/settings']) {
    const r=await post(f,url,url.includes('settings')?{expectedGrantRevision:2,grant:'synthetic_execute'}:{});assert.equal(r.statusCode,403);
  }
  await bootstrap(f);assert.equal((await post(f,'/api/projects/sample-calculator/settings',{expectedGrantRevision:2,grant:'synthetic_execute'})).statusCode,200);
  assert.equal((await post(f,'/api/projects/sample-workflow-navigation/settings',{expectedGrantRevision:1,grant:'synthetic_execute'})).statusCode,403,'cookie does not widen grant eligibility');
});

test('disconnect revokes dependent explicit/automatic pending and claimed dispatch, preserving unrelated target/history',async t=>{
  const f=fixture(t);await bootstrap(f);
  const codex=await work(f,{target:'codex'},null),automatic=await work(f,{target:'automatic'},null),other=await work(f,{target:'chatgpt'},null);
  const claimed=await work(f,{target:'codex'},null);
  const {WorkController}=await import('./work-controller.ts');let resolve,calls=0;
  const controller=new WorkController(f.storage.work,{target:'codex',async interpret(){calls++;return new Promise(done=>{resolve=done;});}});
  const pending=controller.dispatchPending(claimed.work.id);assert.equal(calls,1);
  const r=await post(f,'/api/connections/codex/disconnect',{});assert.equal(r.statusCode,200,r.body);
  for(const saved of [codex,automatic,claimed]) {
    const row=f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(saved.work.id);assert.equal(row.state,'revoked');
    const detail=(await get(f,`/api/work/${saved.work.id}`)).json();assert.equal(detail.work.state,'blocked');assert.deepEqual(detail.annotation,saved.annotation);
  }
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(other.work.id).state,'pending');
  resolve({kind:'question',summary:'An obsolete callback.',acceptance:[],ruleIds:[]});await pending;
  assert.equal(f.storage.work.get(claimed.work.id).interpretation,null);
  assert.equal((await post(f,'/api/connections/codex/connect',{})).statusCode,503);
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(codex.work.id).state,'revoked');
});

test('new GET/HEAD and protected POST routes retain no-store local boundary, strict query and 16KiB body cap',async t=>{
  const f=fixture(t);await bootstrap(f);
  for(const url of ['/api/local-session','/api/connections','/api/evidence','/api/activity','/api/decisions']) {
    for(const method of ['GET','HEAD']) {
      const r=await get(f,url,{cookie:f.cookie},method);assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');
      for(const bad of [{host:'evil.example'},{origin:'https://evil.example'},{origin:'null'},{'sec-fetch-site':'cross-site'}]) {
        const no=await get(f,url,bad,method);assert.equal(no.statusCode,403);assert.equal(no.headers['cache-control'],'no-store');
      }
    }
    assert.equal((await get(f,`${url}?unexpected=true`)).statusCode,400);
  }
  for(const url of ['/api/connections/codex/connect','/api/connections/codex/disconnect']) {
    for(const bad of [{host:'evil.example'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'},{'x-sovrad-action':''}]) assert.equal((await post(f,url,{},f.cookie,bad)).statusCode,403);
    assert.equal((await post(f,url,{text:'x'.repeat(17000)})).statusCode,413);assert.equal((await post(f,`${url}?extra=true`,{})).statusCode,400);
  }
  assert.equal((await post(f,'/api/connections/missing/connect',{})).statusCode,404);
  assert.equal((await post(f,'/api/evidence',{})).statusCode,404);
  assert.equal((await post(f,'/api/decisions',{})).statusCode,404);
  assert.equal((await post(f,'/api/runtime',{})).statusCode,404);
  assert.equal((await f.app.inject({url:'/api/connections',headers})).body.includes('OPENAI_API_KEY'),false);
});
