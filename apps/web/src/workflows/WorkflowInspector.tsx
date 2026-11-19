import {useEffect,useState} from 'react';
import {BrainCircuit,Check,Code2,GitPullRequest,MessageSquarePlus,X} from 'lucide-react';
import type {Decision,Proposal,Step,StepVerification,Workflow} from '@renvarel/architect-core';
import {api,APIError} from '../api';
import {AIStatus} from '../AIStatus';
import {verificationLabel} from './WorkflowList';

export type ProposalDraft = {message:string;rules:string;explanation:string;baseRevision:number;dirty:boolean};
export function WorkflowInspector({workflow,step,verification,proposals,draft,onDraft,onRefresh,onChild,onSelect,onAnnotate,onDecision,onDecisions}:{
  workflow:Workflow;step:Step;verification:StepVerification|undefined;proposals:Proposal[];
  draft:ProposalDraft;onDraft:(draft:ProposalDraft)=>void;onRefresh:()=>Promise<void>;
  onChild:(id:string)=>void;onSelect:(id:string)=>void;onAnnotate:()=>void;
  onDecision:(decision:Decision)=>void;onDecisions:()=>void;
}) {
  const [decisions,setDecisions]=useState<Decision[]>([]);
  useEffect(()=>{
    const abort=new AbortController();let current=true,denied=false,sequence=0;
    const refresh=():void=>{if(denied)return;const id=++sequence;
      void api.decisions({projectId:workflow.projectId,workflowId:workflow.id,stepId:step.id,state:'pending',limit:50},abort.signal)
      .then(result=>{if(current&&id===sequence)setDecisions(result.decisions);}).catch(value=>{if(current&&id===sequence){
        denied=value instanceof APIError&&(value.status===403||value.status===404);setDecisions([]);
      }});};
    refresh();const timer=window.setInterval(refresh,5000);
    return()=>{current=false;abort.abort();window.clearInterval(timer);};
  },[workflow.projectId,workflow.id,step.id,verification?.pendingDecisionCount]);
  const [tab,setTab]=useState<'rules'|'changes'>('rules');
  const [consent,setConsent]=useState(false);
  const [aiAvailable,setAiAvailable]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  useEffect(()=>{setConsent(false);setError('');setNotice('');setTab('rules');},[workflow.id,step.id]);
  useEffect(()=>{setConsent(false);},[workflow.revision]);
  useEffect(()=>{
    if(draft.baseRevision!==workflow.revision&&!draft.dirty){
      onDraft({...draft,baseRevision:workflow.revision,rules:step.rules.join('\n')});
    }
  },[workflow.revision,step.id,draft.baseRevision,draft.dirty]);
  const current=proposals.filter(proposal=>proposal.stepId===step.id);
  const stale=draft.baseRevision!==workflow.revision;
  function edit(patch:Partial<ProposalDraft>):void {onDraft({...draft,...patch,dirty:true});}
  async function submit(useAI:boolean):Promise<void> {
    if(busy||stale||!draft.message.trim())return;
    setBusy(true);setError('');setNotice('');
    try{
      if(useAI){
        if(!consent)throw new Error('Explicit permission to send this selected step to OpenAI is required.');
        await api.aiProposal({workflowId:workflow.id,stepId:step.id,baseRevision:draft.baseRevision,text:draft.message,sendToAI:true});
      }else{
        await api.manualProposal({workflowId:workflow.id,stepId:step.id,baseRevision:draft.baseRevision,text:draft.message,
          proposedRules:draft.rules.split('\n').map(value=>value.trim()).filter(Boolean),
          explanation:draft.explanation.trim()||'Prepared manually for approval'});
      }
      onDraft({...draft,message:'',explanation:'',dirty:false});setConsent(false);setTab('changes');
      setNotice(useAI?'AI has drafted a proposal; nothing was approved.':'Proposal saved; nothing was approved.');
      await onRefresh();
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  }
  async function decide(id:string,action:'approve'|'reject'):Promise<void> {
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{
      await api.decide(id,action);await onRefresh();
      setNotice(action==='approve'?'Approved requirement saved as a new immutable revision. No code changes were made.':'Proposal rejected. Workflow was not changed.');
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  }
  return <aside className="inspector" aria-label="Stage inspector">
    <div className="inspector-head"><div><span className="inspector-overline">Inspector</span><h2>{step.title}</h2><p>{step.purpose||'Purpose has not been defined.'}</p>
      <span className="verification-badge">{verificationLabel(verification?.verification??'not_checked')}</span></div><div className="inspector-icon"><MessageSquarePlus size={19}/></div></div>
    <div className="inspector-tabs"><button className={tab==='rules'?'active':''} onClick={()=>setTab('rules')}>Rules & conditions</button>
      <button className={tab==='changes'?'active':''} onClick={()=>setTab('changes')}>Proposals <span>{current.length}</span></button></div>
    <div className="inspector-body">
      {notice&&<div className="notice" role="status"><Check size={16}/>{notice}<button title="Dismiss" onClick={()=>setNotice('')}><X size={13}/></button></div>}
      {error&&<div className="error" role="alert">{error}<button title="Dismiss" onClick={()=>setError('')}><X size={13}/></button></div>}
      {tab==='rules'?<>
        <section aria-label="Stage decisions"><h3>Needs your decision {verification?.pendingDecisionCount??0}</h3>
          {decisions.map(decision=><button key={decision.id} className="secondary-button" aria-label={`Open decision ${decision.id}`} onClick={()=>onDecision(decision)}>{decision.explanation.action}</button>)}
          {(verification?.pendingDecisionCount??0)>decisions.length&&<button className="secondary-button" onClick={onDecisions}>View all stage decisions</button>}
        </section>
        <div className="section-kicker">Current workflow rules</div><div className="rules-list">
          {step.rules.map((rule,index)=><div key={index} className="rule-item"><div className="rule-number">{String(index+1).padStart(2,'0')}</div><span>{rule}</span></div>)}
          {!step.rules.length&&<p className="helper">No rules have been defined for this stage.</p>}
        </div>
        <div className="stage-io"><h3>Inputs</h3>{step.inputs?.length?<ul>{step.inputs.map((value,index)=><li key={index}>{value}</li>)}</ul>:<p>Not defined.</p>}
          <h3>Outputs</h3>{step.outputs?.length?<ul>{step.outputs.map((value,index)=><li key={index}>{value}</li>)}</ul>:<p>Not defined.</p>}</div>
        <div className="exception"><span>Exception / error handling</span><p>{step.errorBehavior||'Exception behavior has not been defined.'}</p></div>
        <div className="connected-stages"><h3>Connected stages</h3>{workflow.connections.filter(edge=>edge.source===step.id).map(edge=>
          <button className="text-button" key={edge.id} onClick={()=>onSelect(edge.target)}>{edge.label||'Continue'} → {workflow.steps.find(target=>target.id===edge.target)?.title||'Unavailable stage'}</button>)}
          {!workflow.connections.some(edge=>edge.source===step.id)&&<p className="helper">No outgoing path is defined.</p>}</div>
        {step.childWorkflowId&&<button className="secondary-button" onClick={()=>onChild(step.childWorkflowId!)}>Open child workflow</button>}
        <div className="verification-detail"><p>{verification?.reason||'Acceptance evidence is not available yet.'}</p>
          <p>Last checked: {verification?.lastCheckedAt?new Date(verification.lastCheckedAt).toLocaleString():'Not yet checked'}</p>
          <p>Evidence freshness: {verification?.freshness||'unknown'}</p></div>
        <div className="divider"/><div className="section-heading"><MessageSquarePlus size={16}/>Suggest a correction</div>
        <p className="helper">Your suggestion applies only to <b>{step.title}</b>. It never changes code automatically.</p>
        {stale&&<div className="notice" role="status"><div>The specification changed. Your unsent draft is retained. Review the current rules before using the latest revision.
          <button className="secondary-button" onClick={()=>onDraft({...draft,baseRevision:workflow.revision})}>Use current revision</button></div></div>}
        <label htmlFor="change-request">What should change?</label><textarea id="change-request" rows={3} maxLength={2000} value={draft.message} onChange={event=>edit({message:event.target.value})}/>
        <label htmlFor="rules-edit">Proposed rules (one per line)</label><textarea id="rules-edit" rows={5} value={draft.rules} onChange={event=>edit({rules:event.target.value})}/>
        <label htmlFor="explanation">Reason (optional)</label><input id="explanation" maxLength={2000} value={draft.explanation} onChange={event=>edit({explanation:event.target.value})}/>
        <button className="primary-button" disabled={busy||stale||!draft.message.trim()||!draft.rules.trim()} onClick={()=>void submit(false)}><GitPullRequest size={16}/>Save proposal for review</button>
        <div className="ai-panel"><div className="ai-panel-heading"><BrainCircuit size={17}/>Optional OpenAI proposal</div>
          <AIStatus refreshToken={busy} onAvailable={setAiAvailable}/>
          <p>Send this step’s title, purpose, current rules and your suggestion to the configured OpenAI API. No repository code is included.</p>
          <label className="consent-label"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>I approve sending these selected details to OpenAI.</span></label>
          <button className="secondary-button" disabled={busy||stale||!draft.message.trim()||!consent||!aiAvailable} onClick={()=>void submit(true)}><BrainCircuit size={15}/>Ask AI to draft rules</button>
          {!aiAvailable&&<p className="muted-tiny">AI is off until configured in the local backend.</p>}
        </div>
        <div className="future-controls"><button className="secondary-button" onClick={onAnnotate}>Annotate this stage</button><p className="helper">Keep a contextual note in Sovrad or request help. This draft is copied into the annotation; it does not change the proposal.</p></div>
      </>:<><div className="section-kicker">Change history for this step</div>
        {!current.length?<div className="empty-state"><GitPullRequest size={28}/><b>No proposals yet</b><p>Describe a correction in the Rules tab. Proposed changes appear here for approval.</p>
          <button className="secondary-button" onClick={()=>setTab('rules')}>Write a proposal</button></div>:current.map(proposal=><div className="proposal-card" key={proposal.id}>
          <div className="proposal-head"><span className={`status-tag ${proposal.status}`}>{proposal.status.toUpperCase()}</span><span>{new Date(proposal.createdAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</span></div>
          <p className="proposal-request">{proposal.text}</p><div className="proposal-meta">Based on revision {proposal.baseRevision} · {proposal.provenance==='manual'?'Manual suggestion':'AI-generated proposal'}</div>
          <p className="proposal-explanation">{proposal.explanation}</p><div className="proposed-rules-title">Proposed rules</div>
          <ul>{proposal.proposedRules.map((rule,index)=><li key={index}>{rule}</li>)}</ul>
          {proposal.status==='draft'&&<div className="proposal-actions"><button className="secondary-button" disabled={busy} onClick={()=>void decide(proposal.id,'reject')}><X size={14}/>Reject</button>
            <button className="primary-button" disabled={busy} onClick={()=>void decide(proposal.id,'approve')}><Check size={15}/>Approve</button></div>}
        </div>)}<div className="safety-note"><Code2 size={16}/>Codex execution is not enabled. Approvals only update the local specification.</div>
      </>}
    </div>
  </aside>;
}
