import type {StepVerification, Workflow} from '@renvarel/architect-core';

export function verificationLabel(value:StepVerification['verification']):string {
  return {not_checked:'Not yet checked',checking:'Checking',verified:'Verified',failed:'Check failed',stale:'Previous check is stale'}[value];
}
export function WorkflowList({workflow,selected,verification,onSelect}:{
  workflow:Workflow; selected:string; verification:StepVerification[]; onSelect:(id:string)=>void;
}) {
  return <div className="stage-list" aria-label="Workflow stages as a list">
    {workflow.steps.map(step => <div key={step.id} className="stage-list-row">
      <button className={`step-node ${step.id===selected?'step-node-active':''}`} aria-label={`Select ${step.title}`}
        aria-pressed={step.id===selected} onClick={()=>onSelect(step.id)}>
        <span className="node-kicker">{step.kind}</span><strong className="node-title">{step.title}</strong>
        <span className="node-description">{step.purpose}</span>
        <span className="verification-badge">{verificationLabel(verification.find(value=>value.stepId===step.id)?.verification ?? 'not_checked')}</span>
      </button>
      {workflow.connections.filter(edge=>edge.source===step.id).map(edge=><p className="stage-connection" key={edge.id}>
        {edge.label || 'Continue'} → {workflow.steps.find(target=>target.id===edge.target)?.title || 'Stage unavailable'}
      </p>)}
    </div>)}
  </div>;
}
