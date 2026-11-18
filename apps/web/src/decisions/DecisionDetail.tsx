import {useEffect,useRef,useState,type ReactElement} from 'react';
import type {Decision,DecisionAction} from '@renvarel/architect-core';
import {api,APIError} from '../api';

function money(value:number|null):string {
  return value===null?'Unknown':value===0?'Free ($0.00)':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(value/1_000_000);
}
export function DecisionDetail({decision,viewEpoch,reviewCompletion,needsReview,reason,isCurrent,onUnavailable,onReason,onResolved,onRefresh}:{
  decision:Decision;reason:string;onReason:(value:string)=>void;onResolved:(value:Decision)=>Promise<void>;onRefresh:()=>Promise<void>;
  needsReview:boolean;
  isCurrent:()=>boolean;onUnavailable:()=>void;
  viewEpoch:number;reviewCompletion:number;
}):ReactElement {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[recovery,setRecovery]=useState<'session'|'stale'|null>(null);
  const submission=useRef<{body:string;id:string}|null>(null);
  const acting=useRef(false);
  const lifetime=useRef({mounted:true,operation:0});
  useEffect(()=>{lifetime.current.mounted=true;return()=>{lifetime.current.mounted=false;lifetime.current.operation++;};},[]);
  useEffect(()=>{lifetime.current.operation++;acting.current=false;setBusy(false);},[viewEpoch]);
  useEffect(()=>{setRecovery(null);setError('');submission.current=null;},[reviewCompletion]);
  const d=decision.explanation;
  useEffect(()=>{if(needsReview){setRecovery('stale');setError('This request changed. Refresh and review its current details before choosing an action.');}},[needsReview]);
  async function action(action:DecisionAction['action']):Promise<void> {
    if(!isCurrent()||acting.current||decision.status!=='pending'||recovery||needsReview||reason.length>2000)return;
    acting.current=true;setBusy(true);setError('');
    const operation=++lifetime.current.operation;
    const valid=():boolean=>lifetime.current.mounted&&lifetime.current.operation===operation&&isCurrent();
    const input={expectedVersion:decision.version,proposalDigest:decision.proposalDigest,action,reason},body=JSON.stringify(input);
    if(submission.current?.body!==body)submission.current={body,id:crypto.randomUUID()};
    try{const result=await api.decisionAction(decision.id,{...input,clientRequestId:submission.current.id});await onResolved(result.decision);}
    catch(value){
      if(!valid())return;
      setError(value instanceof Error?value.message:String(value));
      if(value instanceof APIError){
        if(value.status===409)setRecovery('stale');
        else if(value.status===403&&value.code==='LOCAL_SESSION_REQUIRED')setRecovery('session');
        else if(value.status===403||value.status===404)onUnavailable();
      }
    }finally{if(valid()){acting.current=false;setBusy(false);}}
  }
  async function recover():Promise<void> {
    if(!isCurrent()||acting.current)return;
    acting.current=true;setBusy(true);
    const operation=++lifetime.current.operation;
    const valid=():boolean=>lifetime.current.mounted&&lifetime.current.operation===operation&&isCurrent();
    try{
      if(recovery==='session')await api.localSession();
      else await onRefresh();
      if(valid()){setRecovery(null);setError('');submission.current=null;}
    }catch(value){if(valid())setError(value instanceof Error?value.message:String(value));}
    finally{if(valid()){acting.current=false;setBusy(false);}}
  }
  return <section className="decision-detail" aria-label="Decision detail">
    <h2>Decision request</h2><p className="decision-state">{decision.status.replaceAll('_',' ')}</p>
    <section aria-label="Decision explanation" className="decision-explanation">
      <h3>Proposed action</h3><p>{d.action}</p>
      <h3>Why your decision is needed</h3><p>{d.reasonOutsideGrant}</p>
      <h3>Expected result</h3><p>{d.expectedResult}</p>
      <h3>What could be affected</h3><h4>Direct effects</h4><ul>{d.directEffects.map((value,index)=><li key={index}>{value}</li>)}</ul>
      <h4>Indirect effects</h4><ul>{d.indirectEffects.map((value,index)=><li key={index}>{value}</li>)}</ul>
      <h4>What is uncertain</h4><ul>{d.uncertainties.map((value,index)=><li key={index}>{value}</li>)}</ul>
      <dl><dt>One-time cost</dt><dd>{money(d.cost.oneTimeMicros)}</dd><dt>Ongoing cost</dt><dd>{money(d.cost.ongoingMicros)}</dd>
        <dt>Cost cap</dt><dd>{money(d.cost.capMicros)}. Unknown cost does not authorize unlimited spending.</dd><dt>Who pays</dt><dd>{d.cost.payer}</dd></dl>
      <h3>What could go wrong</h3><p>{d.failure}</p><h4>Interruption</h4><p>{d.interruption}</p><h4>How it will be detected</h4><p>{d.detection}</p>
      <h3>Recovery</h3><p>{d.recovery}</p><h4>Backup</h4><p>{d.backup}</p><h4>What cannot be undone</h4><p>{d.irreversibility}</p>
      <h3>Alternatives</h3><ul>{d.alternatives.map((value,index)=><li key={index}>{value}</li>)}</ul><h3>Recommendation</h3><p>{d.recommendation}</p>
      <h3>Permission and duration</h3><p>Action: {decision.binding.action}. Scope: {decision.binding.permissionScope.join(', ')||'Review only; no execution permission'}.</p>
      <p>Expires <time dateTime={decision.binding.expiresAt}>{new Date(decision.binding.expiresAt).toLocaleString()}</time>. Specification revision: {decision.binding.specRevision??'Not applicable'}. Map revision: {decision.binding.mapRevision}.</p>
      <p>Approval records this bounded decision. Execution requires its own current authority and is unavailable in this preview.</p>
    </section>
    <details><summary>Technical binding</summary><dl><dt>Proposal digest</dt><dd>{decision.proposalDigest}</dd><dt>Repository</dt><dd>{decision.binding.repositoryId??'Not applicable'}</dd><dt>Base revision</dt><dd>{decision.binding.baseCommit??'Not applicable'}</dd></dl></details>
    {decision.receipt&&<section aria-label="Decision outcome"><h3>Recorded outcome</h3><p>{decision.receipt.action.replaceAll('_',' ')} · Local owner session</p>
      <p className="decision-reason">{decision.receipt.reason||'No reason provided'}</p><p>The immutable receipt remains in history.</p></section>}
    <label className="decision-comment">Your reason (optional)<textarea value={reason} maxLength={2000} onChange={event=>onReason(event.target.value)} disabled={busy}/></label>
    {error&&<p role="alert" className="error">{error}</p>}
    {recovery&&<button className="secondary-button" disabled={busy} onClick={()=>void recover()}>{recovery==='session'?'Renew local session':'Refresh request'}</button>}
    <div className="item-actions decision-actions">{(['approve','reject','request_revision'] as const).map(kind=><button key={kind}
      className={kind==='approve'?'primary-button':'secondary-button'} disabled={busy||Boolean(recovery)||needsReview||decision.status!=='pending'||reason.length>2000}
      onClick={()=>void action(kind)}>{kind==='approve'?'Approve this action':kind==='reject'?'Reject':'Request revision'}</button>)}</div>
  </section>;
}
