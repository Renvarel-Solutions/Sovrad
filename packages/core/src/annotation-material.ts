import type {AnnotationInput, ContextRef, ProjectItem, RegisteredProject} from './experience.js';
import type {Step, Workflow} from './index.js';

export type AnnotationDraft = Pick<AnnotationInput, 'context' | 'text' | 'target' | 'intent' | 'promoteFuture'>;
export type SelectedAnnotationMaterialV1 = {
  schemaVersion: 1;
  context: {projectId: string; itemId: string | null; workflowId: string | null; stepId: string | null; specRevision: number | null; mapRevision: number};
  text: string; target: AnnotationInput['target']; intent: AnnotationInput['intent']; promoteFuture: boolean;
  selection: {
    project: Pick<RegisteredProject, 'id' | 'name' | 'description'>;
    item: Pick<ProjectItem, 'id' | 'name' | 'description'> | null;
    workflow: Pick<Workflow, 'id' | 'name' | 'description' | 'revision'> | null;
    step: Pick<Step, 'id' | 'title' | 'purpose' | 'rules' | 'errorBehavior'> & {inputs: string[]; outputs: string[]} | null;
  };
};

function canonicalContext(context: ContextRef | SelectedAnnotationMaterialV1['context']): SelectedAnnotationMaterialV1['context'] {
  return {projectId: context.projectId, itemId: context.itemId ?? null, workflowId: context.workflowId ?? null,
    stepId: context.stepId ?? null, specRevision: context.specRevision ?? null, mapRevision: context.mapRevision};
}

export function buildSelectedAnnotationMaterial(input: {
  draft: AnnotationDraft; project: RegisteredProject; item: ProjectItem | null; workflow: Workflow | null; step: Step | null;
}): SelectedAnnotationMaterialV1 {
  const {draft, project, item, workflow, step} = input;
  const context = draft.context;
  if (context.projectId !== project.id || context.mapRevision !== project.mapRevision ||
      (context.itemId ?? null) !== (item?.id ?? null) || (item && item.projectId !== project.id) ||
      (context.workflowId ?? null) !== (workflow?.id ?? null) || (workflow && workflow.projectId !== project.id) ||
      (workflow ? context.specRevision !== workflow.revision : context.specRevision !== undefined) ||
      (context.stepId ?? null) !== (step?.id ?? null) || (step && !workflow?.steps.some(s => s.id === step.id)) ||
      (item?.workflowId && workflow && item.workflowId !== workflow.id)) throw new Error('Invalid selected context');
  return canonicalMaterial({schemaVersion: 1, context: canonicalContext(context), text: draft.text,
    target: draft.target, intent: draft.intent, promoteFuture: draft.promoteFuture,
    selection: {project, item, workflow, step: step ? {...step, inputs: step.inputs ?? [], outputs: step.outputs ?? []} : null}});
}

function canonicalMaterial(material: SelectedAnnotationMaterialV1): SelectedAnnotationMaterialV1 {
  const {project, item, workflow, step} = material.selection;
  return {schemaVersion: 1, context: canonicalContext(material.context), text: material.text,
    target: material.target, intent: material.intent, promoteFuture: material.promoteFuture,
    selection: {
      project: {id: project.id, name: project.name, description: project.description},
      item: item ? {id: item.id, name: item.name, description: item.description} : null,
      workflow: workflow ? {id: workflow.id, name: workflow.name, description: workflow.description, revision: workflow.revision} : null,
      step: step ? {id: step.id, title: step.title, purpose: step.purpose, rules: [...step.rules],
        inputs: [...(step.inputs ?? [])], outputs: [...(step.outputs ?? [])], errorBehavior: step.errorBehavior} : null,
    }};
}

export function serializeSelectedAnnotationMaterial(material: SelectedAnnotationMaterialV1): string {
  return JSON.stringify(canonicalMaterial(material));
}

export async function digestSelectedAnnotationMaterial(material: SelectedAnnotationMaterialV1): Promise<string> {
  const bytes = new TextEncoder().encode(serializeSelectedAnnotationMaterial(material));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
