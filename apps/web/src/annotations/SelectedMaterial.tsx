import {serializeSelectedAnnotationMaterial,type SelectedAnnotationMaterialV1} from '@renvarel/architect-core';

export function SelectedMaterial({material}:{material:SelectedAnnotationMaterialV1}) {
  const {project,item,workflow,step}=material.selection;
  return <section className="selected-material" aria-label="Selected material">
    <h3>Selected material</h3><p className="helper">Only these selected details and your annotation are included. Review them before sending.</p>
    <dl><dt>Project</dt><dd>{project.name}</dd>{project.description&&<><dt>Project description</dt><dd>{project.description}</dd></>}
      {item&&<><dt>Item</dt><dd>{item.name}</dd><dt>Item description</dt><dd>{item.description||'Not defined.'}</dd></>}
      {workflow&&<><dt>Workflow</dt><dd>{workflow.name} · Revision {workflow.revision}</dd><dt>Workflow description</dt><dd>{workflow.description||'Not defined.'}</dd></>}
      {step&&<><dt>Stage</dt><dd>{step.title}</dd><dt>Purpose</dt><dd>{step.purpose}</dd>
        <dt>Rules</dt><dd>{step.rules.length?<ul>{step.rules.map((rule,index)=><li key={index}>{rule}</li>)}</ul>:'Not defined.'}</dd>
        <dt>Inputs</dt><dd>{step.inputs.join('\n')||'Not defined.'}</dd><dt>Outputs</dt><dd>{step.outputs.join('\n')||'Not defined.'}</dd>
        <dt>Error behavior</dt><dd>{step.errorBehavior||'Not defined.'}</dd></>}
      <dt>Annotation</dt><dd>{material.text||'Write an annotation above.'}</dd>
      <dt>Target</dt><dd>{targetLabel(material.target)}</dd><dt>Intent</dt><dd>{intentLabel(material.intent)}</dd>
      <dt>Future scope</dt><dd>{material.promoteFuture?'Requested for current review; no permission is granted.':'No promotion requested.'}</dd>
    </dl>
    <details><summary>Exact selected JSON</summary><pre>{serializeSelectedAnnotationMaterial(material)}</pre></details>
  </section>;
}

export function targetLabel(target:SelectedAnnotationMaterialV1['target']):string {
  return target==='automatic'?'Automatic':target==='codex'?'Codex':'ChatGPT';
}
export function intentLabel(intent:SelectedAnnotationMaterialV1['intent']):string {
  return {question:'Question',instruction:'Instruction',rule:'Rule suggestion',future_plan:'Future plan'}[intent];
}
