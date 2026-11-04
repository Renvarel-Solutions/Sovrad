import type {RegisteredProject} from './experience.js';
import type {Step, Workflow} from './index.js';

export const NAVIGATION_SAMPLE_PROJECT: RegisteredProject = {
  id: 'sample-workflow-navigation', name: 'Workflow navigation (fictional sample)',
  description: 'Fictional planning map for exploring child workflows. Not checked and non-executable.',
  visibility: 'local-private', archived: false, grant: 'planning_only', grantRevision: 1, mapRevision: 1, sourceState: 'unmapped',
};
function node(id: string, title: string, kind: Step['kind'], x: number): Step {
  return {id, title, kind, purpose: 'Explore this fictional planning example.', rules: ['Review the plan before acting.'],
    inputs: [], outputs: [], errorBehavior: 'Explain the correction and retain the input.', position: {x, y: 100}};
}
export const NAVIGATION_CHILD_WORKFLOW: Workflow = {
  id: 'sample-navigation-validation', projectId: NAVIGATION_SAMPLE_PROJECT.id,
  name: 'Validation details', description: 'Fictional format review with connected valid and correction paths.', revision: 1,
  steps: [node('check-format', 'Check format', 'decision', 0), node('format-valid', 'Format valid', 'output', 300),
    node('format-error', 'Explain format correction', 'output', 600)],
  connections: [{id: 'format-pass', source: 'check-format', target: 'format-valid', label: 'Valid'},
    {id: 'format-fail', source: 'check-format', target: 'format-error', label: 'Invalid'},
    {id: 'format-retry', source: 'format-error', target: 'check-format', label: 'Try again'}],
};
export const NAVIGATION_MAIN_WORKFLOW: Workflow = {
  id: 'sample-navigation-main', projectId: NAVIGATION_SAMPLE_PROJECT.id,
  name: 'Review input', description: 'Fictional planning-only navigation example. No execution or acceptance evidence.', revision: 1,
  steps: [{...node('review-input', 'Review input', 'decision', 0), childWorkflowId: NAVIGATION_CHILD_WORKFLOW.id},
    node('continue', 'Continue', 'output', 300), node('explain-correction', 'Explain correction', 'output', 600)],
  connections: [{id: 'review-valid', source: 'review-input', target: 'continue', label: 'Valid'},
    {id: 'review-invalid', source: 'review-input', target: 'explain-correction', label: 'Invalid'},
    {id: 'review-retry', source: 'explain-correction', target: 'review-input', label: 'Try again'}],
};
