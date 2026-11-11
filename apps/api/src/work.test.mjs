import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {Storage} from './storage.ts';
import {buildApp} from './server.ts';
import {
  CALCULATOR_WORKFLOW, buildSelectedAnnotationMaterial,
  digestSelectedAnnotationMaterial, serializeSelectedAnnotationMaterial,
} from '@renvarel/architect-core';

const headers = {host:'127.0.0.1:4317', origin:'http://127.0.0.1:5173', 'x-sovrad-action':'1'};
const marker = 'synthetic-annotation-private-value';
const post = (app, url, payload, extra = {}) => app.inject({method:'POST', url, headers:{...headers, ...extra}, payload});
const get = (app, url, method = 'GET', extra = {}) => app.inject({method, url, headers:{...headers, ...extra}});

function setup(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sovrad-work-'));
  let storage = new Storage(directory);
  let app = buildApp(storage, {ai:{enabled:false, apiKey:marker}});
  const db = new Database(path.join(directory, 'sovrad.sqlite'));
  t.after(async () => {db.close(); await app.close(); rmSync(directory, {recursive:true, force:true});});
  return {
    directory, db, get storage() {return storage;}, get app() {return app;},
    async reopen() {await app.close(); storage = new Storage(directory); app = buildApp(storage, {ai:{enabled:false, apiKey:marker}});},
  };
}

async function draft(storage, overrides = {}) {
  const context = overrides.context ?? {projectId:'sample-calculator', workflowId:CALCULATOR_WORKFLOW.id,
    stepId:'number-a', specRevision:1, mapRevision:1};
  const project = storage.registry.project(context.projectId);
  const item = context.itemId ? storage.registry.items(project.id).find(row => row.id === context.itemId) : null;
  const workflow = context.workflowId ? storage.workflow(context.workflowId) : null;
  const step = context.stepId ? workflow?.steps.find(row => row.id === context.stepId) : null;
  const value = {clientRequestId:crypto.randomUUID(), context, text:'Explain this fictional requirement.',
    target:'codex', intent:'question', promoteFuture:false, ...overrides};
  const material = buildSelectedAnnotationMaterial({draft:value, project, item, workflow, step});
  return {...value, dispatch:{mode:'local', consent:false, contextDigest:await digestSelectedAnnotationMaterial(material), ...overrides.dispatch}};
}

async function submit(fixture, input) {
  const response = await post(fixture.app, '/api/annotations', input);
  assert.equal(response.statusCode, 201, response.body);
  assert.ok(response.json().annotation?.id);
  assert.equal(response.json().work.annotationId, response.json().annotation.id);
  return response.json();
}

function counts(db) {
  return ['annotations', 'work_items', 'work_outbox'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
}

async function fakeController(storage, captured = [], result = {kind:'question', summary:'A fictional explanation.', acceptance:[], ruleIds:[]}) {
  // Import only after an HTTP positive control; missing production modules must
  // not prevent every HTTP assertion in this new suite from executing at RED.
  const {WorkController} = await import('./work-controller.ts');
  return new WorkController(storage.work, {target:'codex', async interpret(materialJSON) {captured.push(materialJSON); return result;}});
}

async function delayedController(storage, captured) {
  const {WorkController} = await import('./work-controller.ts');
  let resolve;
  const response = new Promise(done => {resolve = done;});
  return {resolve,controller:new WorkController(storage.work, {
    target:'codex', async interpret(materialJSON) {captured.push(materialJSON); return response;},
  })};
}

test('double submit creates one annotation work and dispatch with the same returned work ID', async t => {
  const f = setup(t);
  const input = await draft(f.storage, {dispatch:{mode:'connected', consent:true}});
  const first = await post(f.app, '/api/annotations', input);
  assert.equal(first.statusCode, 201, first.body);
  const second = await post(f.app, '/api/annotations', input);
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().work.id, first.json().work.id);
  assert.equal(second.json().annotation.id, first.json().annotation.id);
  assert.deepEqual(counts(f.db), [1, 1, 1]);
  const captured = [];
  const controller = await fakeController(f.storage, captured);
  await controller.dispatchPending(first.json().work.id);
  await controller.dispatchPending(first.json().work.id);
  assert.equal(captured.length, 1);
  assert.equal(captured[0], first.json().annotation.materialJSON);
});

test('altered idempotency content returns 409 without another annotation work or dispatch', async t => {
  const f = setup(t);
  const input = await draft(f.storage, {dispatch:{mode:'connected', consent:true}});
  await submit(f, input);
  const changed = await draft(f.storage, {...input, text:'A different exact instruction.', dispatch:{mode:'connected', consent:true}});
  assert.equal((await post(f.app, '/api/annotations', changed)).statusCode, 409);
  assert.deepEqual(counts(f.db), [1, 1, 1]);
});

test('ordinary local note works with AI off and has nonempty history but no dispatch or consent receipt', async t => {
  const f = setup(t);
  const input = await draft(f.storage, {text:'  Local العربية\nKeep this exact text.  '});
  const saved = await submit(f, input);
  assert.equal(saved.annotation.text, input.text);
  assert.equal(saved.annotation.consentReceipt, null);
  assert.equal(saved.work.interpretation, null);
  assert.deepEqual(counts(f.db), [1, 1, 0]);
  const detail = await get(f.app, `/api/work/${saved.work.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().annotation, saved.annotation);
  assert.ok(detail.json().events.length > 0);
  assert.deepEqual(detail.json().evidence, []);
  assert.deepEqual(detail.json().decisions, []);
  const history = await get(f.app, `/api/work/${saved.work.id}/events?afterSequence=0&limit=1`);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().events.length, 1);
  assert.equal(typeof history.json().nextAfterSequence, 'number');
});

test('workspace counts all permitted work beyond list caps and excludes hidden or archived project work', async t => {
  const f = setup(t);
  for (let n = 0; n < 52; n++) await submit(f, await draft(f.storage, {text:`Calculator local note ${n}`}));
  const navigation = await submit(f, await draft(f.storage, {
    context:{projectId:'sample-workflow-navigation', mapRevision:1}, text:'Visible navigation note',
  }));
  const total = value => Object.values(value.counts).reduce((sum, n) => sum + n, 0);
  const workspace = await get(f.app, '/api/workspace');
  assert.equal(workspace.statusCode, 200, workspace.body);
  assert.equal(total(workspace.json()), 53);
  assert.equal((await get(f.app, '/api/work?limit=50')).json().work.length, 50);
  f.storage.registry.setAccess({mode:'selected', selectedProjectIds:['sample-workflow-navigation']});
  assert.equal(total((await get(f.app, '/api/workspace')).json()), 1);
  assert.equal((await get(f.app, '/api/work')).json().work[0].id, navigation.work.id);
  f.storage.registry.updateSettings('sample-workflow-navigation', {expectedGrantRevision:1, archived:true});
  assert.equal(total((await get(f.app, '/api/workspace')).json()), 0);
  assert.deepEqual((await get(f.app, '/api/work')).json().work, []);
  assert.deepEqual(counts(f.db), [53, 53, 0]);
});

test('no connection cannot become understanding or working and reports an explicit offline blocker', async t => {
  const f = setup(t);
  const saved = await submit(f, await draft(f.storage, {dispatch:{mode:'connected', consent:true}}));
  assert.equal(saved.work.state, 'blocked');
  assert.equal(saved.work.interpretation, null);
  assert.ok(saved.work.blockers.some(reason => /connection|offline|unavailable/i.test(reason)));
  assert.equal(saved.annotation.consentReceipt.contextDigest, saved.annotation.dispatch.contextDigest);
  assert.equal(saved.annotation.consentReceipt.annotationId, saved.annotation.id);
  const reloaded = (await get(f.app, `/api/work/${saved.work.id}`)).json();
  assert.equal(reloaded.work.state, 'blocked');
  assert.equal(reloaded.work.interpretation, null);
  assert.deepEqual(reloaded.evidence, []);
});

test('wrong project node item membership and stale revisions reject with no write', async t => {
  const f = setup(t);
  const input = await draft(f.storage);
  await submit(f, input); // Positive context and real table controls.
  for (const [context, status] of [
    [{...input.context, projectId:'sample-workflow-navigation'}, 404],
    [{...input.context, stepId:'foreign-node'}, 404],
    [{...input.context, itemId:crypto.randomUUID()}, 404],
    [{...input.context, specRevision:2}, 409],
    [{...input.context, mapRevision:2}, 409],
  ]) {
    assert.equal((await post(f.app, '/api/annotations', {...input, clientRequestId:crypto.randomUUID(), context})).statusCode, status);
  }
  assert.deepEqual(counts(f.db), [1, 1, 0]);
});

test('mapped parent item supports exact child workflow step annotation but rejects an unrelated same-project sibling', async t => {
  const f = setup(t);
  const {project:created} = f.storage.registry.create({clientRequestId:crypto.randomUUID(), name:'Fictional child annotation', description:''});
  const {item:unmapped} = f.storage.registry.saveItem(created.id, {clientRequestId:crypto.randomUUID(), expectedMapRevision:1,
    parentId:null, kind:'workflow', name:'Parent mapped item', description:'Parent selection', development:'planning', workflowId:null});
  const node = (id, extra = {}) => ({id, title:id, purpose:'Fictional selected purpose', kind:'process', rules:['Review the selected requirement.'],
    inputs:['Fictional input'], outputs:['Fictional output'], errorBehavior:'Explain the correction.', position:{x:0,y:0}, ...extra});
  const createGraph = (expectedMapRevision, name, steps, itemId = null) => f.storage.registry.saveWorkflow(created.id, {
    clientRequestId:crypto.randomUUID(), expectedMapRevision, itemId, name, description:'Fictional graph', steps, connections:[],
  }).workflow;
  const child = createGraph(2, 'Linked child', [node('child-step')]);
  const root = createGraph(3, 'Mapped root', [node('root-step', {childWorkflowId:child.id})], unmapped.id);
  const sibling = createGraph(4, 'Unrelated sibling', [node('sibling-step')]);
  const project = f.storage.registry.project(created.id);
  const item = f.storage.registry.items(created.id).find(row => row.id === unmapped.id);
  assert.equal(item.workflowId, root.id);
  const payloadFor = workflow => {
    const context = {projectId:created.id, itemId:item.id, workflowId:workflow.id, stepId:workflow.steps[0].id, specRevision:1, mapRevision:5};
    const selected = {schemaVersion:1, context, text:'Explain this exact selected child\nالعربية', target:'chatgpt', intent:'rule', promoteFuture:false,
      selection:{project, item, workflow, step:workflow.steps[0]}};
    const materialJSON = serializeSelectedAnnotationMaterial(selected);
    return {clientRequestId:crypto.randomUUID(), context, text:selected.text, target:selected.target, intent:selected.intent, promoteFuture:false,
      dispatch:{mode:'connected', consent:true, contextDigest:createHash('sha256').update(materialJSON, 'utf8').digest('hex')}};
  };
  const input = payloadFor(child);
  const saved = await submit(f, input);
  assert.deepEqual(saved.annotation.context, input.context);
  assert.equal(saved.annotation.target, 'chatgpt');
  assert.deepEqual(saved.annotation.material.selection.item, {id:item.id, name:item.name, description:item.description});
  assert.equal(saved.annotation.material.selection.workflow.id, child.id);
  assert.equal(saved.annotation.material.selection.step.id, 'child-step');
  assert.equal(saved.annotation.materialJSON, serializeSelectedAnnotationMaterial(buildSelectedAnnotationMaterial({
    draft:input, project, item, workflow:child, step:child.steps[0],
  })));
  const unrelated = await post(f.app, '/api/annotations', payloadFor(sibling));
  assert.equal(unrelated.statusCode, 404, unrelated.body);
  assert.deepEqual(counts(f.db), [1, 1, 1]);
  const direct = await submit(f, {...payloadFor(root), dispatch:{...payloadFor(root).dispatch, mode:'local', consent:false}});
  assert.equal(direct.annotation.material.selection.workflow.id, root.id);
});

test('project and node IDs and original revision material survive a label rename', async t => {
  const f = setup(t);
  const before = JSON.stringify(f.storage.history(CALCULATOR_WORKFLOW.id));
  const saved = await submit(f, await draft(f.storage));
  f.storage.registry.updateSettings('sample-calculator', {expectedGrantRevision:1, name:'Renamed fictional calculator'});
  const detail = await get(f.app, `/api/work/${saved.work.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().annotation, saved.annotation);
  assert.equal(detail.json().work.context.stepId, 'number-a');
  assert.equal(detail.json().work.context.projectId, 'sample-calculator');
  assert.equal(detail.json().annotation.material.selection.project.name, saved.annotation.material.selection.project.name);
  assert.equal(JSON.stringify(f.storage.history(CALCULATOR_WORKFLOW.id)), before);
});

test('future notes are not automatically promoted and read-only instructions cannot execute while planning remains allowed', async t => {
  const f = setup(t);
  const future = await submit(f, await draft(f.storage, {intent:'future_plan', dispatch:{mode:'connected', consent:true}}));
  const captured = [];
  const controller = await fakeController(f.storage, captured, {kind:'implementation', summary:'Implement this.', acceptance:[{id:'untrusted-id', description:'Fictional acceptance.'}], ruleIds:[]});
  await controller.dispatchPending(future.work.id);
  assert.equal(captured.length, 0);
  assert.equal((await get(f.app, `/api/work/${future.work.id}`)).json().work.state, 'blocked');
  f.storage.registry.setGrant('sample-calculator', {expectedGrantRevision:1, grant:'read_only'});
  const instruction = await submit(f, await draft(f.storage, {intent:'instruction', dispatch:{mode:'connected', consent:true}}));
  await controller.dispatchPending(instruction.work.id);
  const detail = (await get(f.app, `/api/work/${instruction.work.id}`)).json();
  assert.ok(!['queued', 'working', 'checking', 'done'].includes(detail.work.state));
  assert.ok(detail.work.blockers.some(reason => /read.only|execution|implementation/i.test(reason)));
  const planning = await submit(f, await draft(f.storage, {intent:'rule'}));
  assert.equal(planning.annotation.intent, 'rule');
  assert.ok((await get(f.app, `/api/work/${planning.work.id}`)).json().events.length > 0);
});

test('amend requires full fresh consent and current context, supersedes old work and revokes old dispatch', async t => {
  const f = setup(t);
  const original = await submit(f, await draft(f.storage, {dispatch:{mode:'connected', consent:true}}));
  const edited = await draft(f.storage, {text:'Edited B\nمراجعة', dispatch:{mode:'connected', consent:true}});
  const url = `/api/work/${original.work.id}/amend`;
  for (const input of [
    {...edited, expectedVersion:1, dispatch:{...edited.dispatch, consent:false}},
    {...edited, expectedVersion:1, dispatch:{...edited.dispatch, contextDigest:original.annotation.dispatch.contextDigest}},
  ]) assert.equal((await post(f.app, url, input)).statusCode, 400);
  assert.equal((await post(f.app, url, {...edited, expectedVersion:2})).statusCode, 409);
  assert.deepEqual(counts(f.db), [1, 1, 1]);
  const local = {...edited, expectedVersion:1, dispatch:{...edited.dispatch, mode:'local', consent:false}};
  const response = await post(f.app, url, local);
  assert.equal(response.statusCode, 201, response.body);
  const amended = response.json();
  assert.notEqual(amended.work.id, original.work.id);
  assert.equal(amended.annotation.supersedesId, original.annotation.id);
  assert.equal(amended.annotation.revision, 2);
  assert.equal(amended.annotation.consentReceipt, null);
  const old = (await get(f.app, `/api/work/${original.work.id}`)).json();
  assert.equal(old.work.state, 'superseded');
  assert.deepEqual(old.annotation, original.annotation);
  assert.ok(old.events.some(event => event.kind === 'superseded'));
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(original.work.id).state, 'revoked');
  const captured = [];
  const controller = await fakeController(f.storage, captured);
  await controller.dispatchPending(original.work.id);
  await controller.dispatchPending(amended.work.id);
  assert.equal(captured.length, 0);
});

test('local only stays local after fake reconnect and real storage reopen then fresh connected amendment sends exactly once', async t => {
  const f = setup(t);
  const captured = [];
  const connected = await submit(f, await draft(f.storage, {text:'Connected A', dispatch:{mode:'connected', consent:true}}));
  const controller = await fakeController(f.storage, captured);
  await controller.dispatchPending(connected.work.id);
  assert.equal(captured.length, 1);
  const version = (await get(f.app, `/api/work/${connected.work.id}`)).json().work.version;
  const edited = await draft(f.storage, {text:'Local B'});
  const response = await post(f.app, `/api/work/${connected.work.id}/amend`, {...edited, expectedVersion:version});
  assert.equal(response.statusCode, 201, response.body);
  const local = response.json();
  await controller.dispatchPending(local.work.id);
  assert.equal(captured.length, 1);
  await f.reopen();
  const reconnected = await fakeController(f.storage, captured);
  await reconnected.dispatchPending(local.work.id);
  assert.equal(captured.length, 1);
  assert.deepEqual((await get(f.app, `/api/work/${local.work.id}`)).json().annotation, local.annotation);
  const fresh = await draft(f.storage, {text:'Local B', dispatch:{mode:'connected', consent:true}});
  const resent = await post(f.app, `/api/work/${local.work.id}/amend`, {...fresh, expectedVersion:local.work.version});
  assert.equal(resent.statusCode, 201, resent.body);
  await reconnected.dispatchPending(resent.json().work.id);
  await reconnected.dispatchPending(resent.json().work.id);
  assert.equal(captured.length, 2);
  assert.equal(captured[1], resent.json().annotation.materialJSON);
});

test('work detail returns exact original immutable annotation beyond bounded list and amendment starts there', async t => {
  const f = setup(t);
  const original = await submit(f, await draft(f.storage, {text:'Original exact snapshot', intent:'rule', target:'automatic'}));
  for (let n = 0; n < 55; n++) await submit(f, await draft(f.storage, {text:`Unrelated local note ${n}`}));
  const list = await get(f.app, '/api/annotations?limit=50');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().annotations.length, 50);
  assert.ok(!list.json().annotations.some(row => row.id === original.annotation.id));
  const detail = await get(f.app, `/api/work/${original.work.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().annotation, original.annotation);
  const input = await draft(f.storage, {...detail.json().annotation, clientRequestId:crypto.randomUUID(), text:'Amended from the original',
    dispatch:{mode:'local', consent:false}});
  const selected = buildSelectedAnnotationMaterial({draft:input, ...f.storage.registry.resolveContext(input.context)});
  assert.equal(input.dispatch.contextDigest, createHash('sha256').update(serializeSelectedAnnotationMaterial(selected), 'utf8').digest('hex'));
  assert.notEqual(input.dispatch.contextDigest, original.annotation.dispatch.contextDigest);
  const {id, revision, supersedesId, createdAt, consentReceipt, material, materialJSON, ...freshInput} = input;
  const amended = await post(f.app, `/api/work/${original.work.id}/amend`, {...freshInput, expectedVersion:1});
  assert.equal(amended.statusCode, 201, amended.body);
  assert.equal(amended.json().annotation.supersedesId, original.annotation.id);
});

test('preview stored and outward selected bytes match Unicode newlines and exclude hidden sibling and authority fields', async t => {
  const f = setup(t);
  const saved = await submit(f, await draft(f.storage, {text:'  Line 1\nسطر 2 😀 e\u0301  ', dispatch:{mode:'connected', consent:true}}));
  const detail = (await get(f.app, `/api/work/${saved.work.id}`)).json();
  const captured = [];
  await (await fakeController(f.storage, captured)).dispatchPending(saved.work.id);
  const json = serializeSelectedAnnotationMaterial(detail.annotation.material);
  assert.equal(json, detail.annotation.materialJSON);
  assert.equal(json, captured[0]);
  assert.equal(createHash('sha256').update(json, 'utf8').digest('hex'), detail.annotation.consentReceipt.contextDigest);
  assert.deepEqual(Object.keys(JSON.parse(json)), ['schemaVersion','context','text','target','intent','promoteFuture','selection']);
  assert.deepEqual(Object.keys(JSON.parse(json).selection), ['project','item','workflow','step']);
  assert.deepEqual(Object.keys(JSON.parse(json).selection.step), ['id','title','purpose','rules','inputs','outputs','errorBehavior']);
  for (const forbidden of ['number-b','connections','position','grantRevision','sourceState','absolutePath','evidence','childWorkflowId']) assert.ok(!json.includes(`"${forbidden}"`), forbidden);
  for (const extra of [{material:{source:'hidden'}}, {actor:'owner'}, {state:'working'}, {permissionScope:['all']}, {endpoint:'https://example.invalid'}]) {
    assert.equal((await post(f.app, '/api/annotations', {...await draft(f.storage), ...extra})).statusCode, 400);
  }
  assert.deepEqual(counts(f.db), [1, 1, 1]);
});

test('async hash context race returns 409 before write or outbound while layout alone preserves consent', async t => {
  const f = setup(t);
  const input = await draft(f.storage, {dispatch:{mode:'connected', consent:true}});
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  const original = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
  let changed = false;
  Object.defineProperty(crypto.subtle, 'digest', {configurable:true, value:async (...args) => {
    const digest = await nativeDigest(...args);
    if (!changed) {changed = true; f.storage.registry.updateSettings('sample-calculator', {expectedGrantRevision:1, name:'Changed during hash'});}
    return digest;
  }});
  t.after(() => {if (original) Object.defineProperty(crypto.subtle, 'digest', original); else delete crypto.subtle.digest;});
  const raced = await post(f.app, '/api/annotations', input);
  assert.equal(raced.statusCode, 409, raced.body);
  assert.deepEqual(counts(f.db), [0, 0, 0]);
  if (original) Object.defineProperty(crypto.subtle, 'digest', original); else delete crypto.subtle.digest;
  const current = await draft(f.storage, {context:{...input.context, mapRevision:2}, dispatch:{mode:'connected', consent:true}});
  f.storage.registry.saveLayout(CALCULATOR_WORKFLOW.id, {expectedLayoutRevision:0, positions:CALCULATOR_WORKFLOW.steps.map(s => ({stepId:s.id, x:s.position.x+20, y:s.position.y}))});
  const saved = await submit(f, current);
  assert.equal(saved.annotation.consentReceipt.contextDigest, current.dispatch.contextDigest);
});

test('cancel is strict idempotent versioned and preserves immutable annotation with monotonic events', async t => {
  const f = setup(t);
  const saved = await submit(f, await draft(f.storage, {dispatch:{mode:'connected', consent:true}}));
  const url = `/api/work/${saved.work.id}/cancel`;
  const cancel = {clientRequestId:crypto.randomUUID(), expectedVersion:1, reason:'Stop this fictional request.'};
  assert.equal((await post(f.app, url, {...cancel, actor:'owner'})).statusCode, 400);
  assert.equal((await post(f.app, url, {...cancel, expectedVersion:2})).statusCode, 409);
  const stopped = await post(f.app, url, cancel);
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().work.state, 'cancelled');
  assert.deepEqual((await post(f.app, url, cancel)).json(), stopped.json());
  assert.equal((await post(f.app, url, {...cancel, reason:'Different reason'})).statusCode, 409);
  const detail = (await get(f.app, `/api/work/${saved.work.id}`)).json();
  assert.deepEqual(detail.annotation, saved.annotation);
  assert.ok(detail.events.some(event => event.kind === 'cancelled'));
  assert.ok(detail.events.every((event, n, all) => n === 0 || event.sequence > all[n-1].sequence));
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(saved.work.id).state, 'revoked');
});

test('new routes preserve local HEAD action strict query body and credential boundaries with positive controls', async t => {
  const f = setup(t);
  const input = await draft(f.storage);
  const saved = await submit(f, input);
  const reads = ['/api/annotations', '/api/work', `/api/work/${saved.work.id}`, `/api/work/${saved.work.id}/events`];
  for (const url of reads) for (const method of ['GET','HEAD']) {
    const good = await get(f.app, url, method);
    assert.equal(good.statusCode, 200, good.body);
    assert.equal(good.headers['cache-control'], 'no-store');
    for (const extra of [{host:'evil.example'}, {origin:'https://evil.example'}, {'sec-fetch-site':'cross-site'}]) assert.equal((await get(f.app, url, method, extra)).statusCode, 403);
  }
  for (const url of ['/api/annotations?limit=0', '/api/work?limit=101', '/api/work?state=imaginary', '/api/work?unknown=1', '/api/annotations?limit=1&limit=2']) assert.equal((await get(f.app, url)).statusCode, 400);
  for (const extra of [{context:{...input.context, layoutRevision:1}}, {dispatch:{...input.dispatch, adapter:'fake'}}, {text:marker}, {text:'password="fictional-password-value"'}]) {
    const refused = await post(f.app, '/api/annotations', {...input, clientRequestId:crypto.randomUUID(), ...extra});
    assert.equal(refused.statusCode, 400, refused.body);
    assert.ok(!refused.body.includes(marker));
  }
  assert.equal((await post(f.app, '/api/annotations', input, {'x-sovrad-action':''})).statusCode, 403);
  assert.equal((await post(f.app, '/api/annotations', {...input, text:'x'.repeat(17000)})).statusCode, 413);
  f.storage.registry.setAccess({mode:'selected', selectedProjectIds:['sample-workflow-navigation']});
  for (const method of ['GET','HEAD']) {
    assert.equal((await get(f.app, `/api/work/${saved.work.id}`, method)).statusCode, 404);
    assert.equal((await get(f.app, `/api/work/${saved.work.id}/events`, method)).statusCode, 404);
  }
  assert.equal((await get(f.app, '/api/work')).json().work.length, 0);
});

test('expired interpretation success blocks and revokes once while before-expiry success is accepted', async t => {
  const f = setup(t), nativeNow = Date.now;
  let now = nativeNow();
  Date.now = () => now;
  t.after(() => {Date.now = nativeNow;});
  const timely = await submit(f, await draft(f.storage, {text:'Timely fictional result', dispatch:{mode:'connected', consent:true}}));
  const controlCalls = [];
  await (await fakeController(f.storage, controlCalls)).dispatchPending(timely.work.id);
  const control = (await get(f.app, `/api/work/${timely.work.id}`)).json();
  assert.equal(controlCalls.length, 1);
  assert.equal(control.work.interpretation.summary, 'A fictional explanation.');
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(timely.work.id).state, 'completed');
  assert.equal(control.events.filter(event => event.kind === 'interpretation_recorded').length, 1);
  const late = await submit(f, await draft(f.storage, {text:'Late fictional result', dispatch:{mode:'connected', consent:true}}));
  const calls = [], delayed = await delayedController(f.storage, calls);
  const dispatch = delayed.controller.dispatchPending(late.work.id);
  const claimed = f.db.prepare('SELECT state,expires_at FROM work_outbox WHERE work_id=?').get(late.work.id);
  assert.equal(claimed.state, 'claimed');
  assert.equal(calls.length, 1);
  assert.ok(Number.isFinite(Date.parse(claimed.expires_at)));
  now = Date.parse(claimed.expires_at) + 1;
  delayed.resolve({kind:'question', summary:'This expired result must be discarded.', acceptance:[], ruleIds:[]});
  await dispatch;
  const detail = (await get(f.app, `/api/work/${late.work.id}`)).json();
  assert.equal(detail.work.state, 'blocked');
  assert.equal(detail.work.interpretation, null);
  assert.ok(detail.work.blockers.some(reason => /expir/i.test(reason)));
  assert.equal(f.db.prepare('SELECT state FROM work_outbox WHERE work_id=?').get(late.work.id).state, 'revoked');
  assert.equal(detail.events.filter(event => event.kind === 'interpretation_expired').length, 1);
  assert.equal(detail.events.filter(event => event.kind === 'interpretation_recorded').length, 0);
  await delayed.controller.dispatchPending(late.work.id);
  assert.equal(calls.length, 1);
  assert.deepEqual((await get(f.app, `/api/work/${late.work.id}`)).json(), detail);
});

test('late interpretation callbacks leave cancelled and authority-revoked claims unchanged after expiry', async t => {
  const f = setup(t), nativeNow = Date.now;
  let now = nativeNow();
  Date.now = () => now;
  t.after(() => {Date.now = nativeNow;});
  for (const revoke of ['cancel','grant']) {
    const saved = await submit(f, await draft(f.storage, {text:`Late callback after ${revoke}`, dispatch:{mode:'connected', consent:true}}));
    const calls = [], delayed = await delayedController(f.storage, calls);
    const dispatch = delayed.controller.dispatchPending(saved.work.id);
    const claimed = f.db.prepare('SELECT state,expires_at FROM work_outbox WHERE work_id=?').get(saved.work.id);
    assert.equal(claimed.state, 'claimed');
    assert.equal(calls.length, 1);
    if (revoke === 'cancel') {
      const response = await post(f.app, `/api/work/${saved.work.id}/cancel`, {
        clientRequestId:crypto.randomUUID(), expectedVersion:2, reason:'Cancel before the fictional result arrives.',
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().work.state, 'cancelled');
    } else f.storage.registry.setGrant('sample-calculator', {expectedGrantRevision:1, grant:'read_only'});
    const before = (await get(f.app, `/api/work/${saved.work.id}`)).json();
    const outbox = f.db.prepare('SELECT * FROM work_outbox WHERE work_id=?').get(saved.work.id);
    assert.equal(before.work.state, revoke === 'cancel' ? 'cancelled' : 'blocked');
    assert.equal(before.work.interpretation, null);
    assert.equal(outbox.state, 'revoked');
    assert.ok(before.events.some(event => event.kind === (revoke === 'cancel' ? 'cancelled' : 'authority_revoked')));
    now = Date.parse(claimed.expires_at) + 1;
    delayed.resolve({kind:'question', summary:'An old result must never replace the newer state.', acceptance:[], ruleIds:[]});
    await dispatch;
    await delayed.controller.dispatchPending(saved.work.id);
    assert.equal(calls.length, 1);
    assert.deepEqual((await get(f.app, `/api/work/${saved.work.id}`)).json(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM work_outbox WHERE work_id=?').get(saved.work.id), outbox);
    assert.equal(before.events.filter(event => event.kind === 'interpretation_expired').length, 0);
  }
});
