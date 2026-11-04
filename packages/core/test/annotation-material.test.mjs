import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as core from '../src/index.ts';

const literal = '{"schemaVersion":1,"context":{"projectId":"p","itemId":null,"workflowId":null,"stepId":null,"specRevision":null,"mapRevision":1},"text":"Line 1\\nسطر 2","target":"codex","intent":"instruction","promoteFuture":false,"selection":{"project":{"id":"p","name":"Sample","description":""},"item":null,"workflow":null,"step":null}}';
const hash = '6ad48b0d934e94b5d916a1509cdc1772bdfc752285dac9ec5d651799e090ba02';
const draft = {context:{projectId:'p',mapRevision:1},text:'Line 1\nسطر 2',target:'codex',intent:'instruction',promoteFuture:false};
const project = {id:'p',name:'Sample',description:'',visibility:'local-private',archived:false,grant:'planning_only',grantRevision:1,mapRevision:1,sourceState:'unmapped'};

test('material bytes and digest are identical across key order unicode and newlines', async () => {
  assert.equal(createHash('sha256').update(literal, 'utf8').digest('hex'), hash);
  assert.equal(typeof core.buildSelectedAnnotationMaterial, 'function', 'shared material builder must exist');
  const material = core.buildSelectedAnnotationMaterial({draft,project,item:null,workflow:null,step:null});
  assert.equal(core.serializeSelectedAnnotationMaterial(material), literal);
  assert.equal(await core.digestSelectedAnnotationMaterial(material), hash);
  const reordered = JSON.parse(literal);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])) : value;
  assert.equal(core.serializeSelectedAnnotationMaterial(reverse(reordered)), literal);
  assert.equal(await core.digestSelectedAnnotationMaterial(reverse(reordered)), hash);
});

test('selection excludes siblings paths layout evidence credentials and extra properties', () => {
  assert.equal(typeof core.buildSelectedAnnotationMaterial, 'function');
  const step = {...core.CALCULATOR_WORKFLOW.steps[0],inputs:['value'],outputs:['valid'],credential:'PRIVATE',childWorkflowId:'child',extra:'PRIVATE'};
  const material = core.buildSelectedAnnotationMaterial({draft:{...draft,context:{projectId:'p',workflowId:'w',stepId:step.id,specRevision:2,mapRevision:1}},
    project:{...project,absolutePath:'PRIVATE',evidence:['PRIVATE']}, item:null,
    workflow:{...core.CALCULATOR_WORKFLOW,id:'w',projectId:'p',revision:2,steps:[step,{id:'PRIVATE'}]},step});
  assert.deepEqual(Object.keys(material.selection.step),['id','title','purpose','rules','inputs','outputs','errorBehavior']);
  assert.deepEqual(material.selection.workflow,{id:'w',name:'Basic arithmetic',description:'User enters two numbers and chooses an operation.',revision:2});
  assert.ok(!JSON.stringify(material).includes('PRIVATE'));
  assert.ok(!JSON.stringify(material).includes('position'));
});

test('edited selected field changes digest but layout does not', async () => {
  assert.equal(typeof core.buildSelectedAnnotationMaterial, 'function');
  const build = (name,positions) => core.buildSelectedAnnotationMaterial({draft,project:{...project,name,positions},item:null,workflow:null,step:null});
  assert.equal(await core.digestSelectedAnnotationMaterial(build('Sample',[])),hash);
  assert.equal(await core.digestSelectedAnnotationMaterial(build('Sample',[{x:900,y:12}])),hash);
  assert.notEqual(await core.digestSelectedAnnotationMaterial(build('Changed',[])),hash);
});
