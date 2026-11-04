import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.ts';

test('new navigation sample drills without changing legacy calculator bytes', () => {
  const calculator = JSON.stringify(core.CALCULATOR_WORKFLOW);
  assert.ok(core.NAVIGATION_SAMPLE_PROJECT,'separate fictional navigation fixture');
  assert.equal(core.NAVIGATION_SAMPLE_PROJECT.id,'sample-workflow-navigation');
  assert.equal(core.NAVIGATION_SAMPLE_PROJECT.grant,'planning_only');
  assert.equal(core.NAVIGATION_MAIN_WORKFLOW.id,'sample-navigation-main');
  assert.equal(core.NAVIGATION_CHILD_WORKFLOW.id,'sample-navigation-validation');
  const review=core.NAVIGATION_MAIN_WORKFLOW.steps.find(s=>s.id==='review-input');
  assert.equal(review.title,'Review input');
  assert.equal(review.childWorkflowId,core.NAVIGATION_CHILD_WORKFLOW.id);
  assert.ok(core.NAVIGATION_CHILD_WORKFLOW.steps.some(s=>s.id==='check-format'&&s.title==='Check format'));
  for (const workflow of [core.NAVIGATION_MAIN_WORKFLOW,core.NAVIGATION_CHILD_WORKFLOW]) {
    core.assertValidWorkflow(workflow);
    for (const step of workflow.steps) assert.ok(workflow.connections.some(e=>e.source===step.id||e.target===step.id));
  }
  assert.equal(JSON.stringify(core.CALCULATOR_WORKFLOW),calculator);
  assert.equal(core.CALCULATOR_WORKFLOW.steps.length,5);
  assert.ok(core.CALCULATOR_WORKFLOW.steps.every(s=>!s.childWorkflowId));
});
