import {useRef,useState} from 'react';
import type {Decision,WorkDetailResponse,WorkItem} from '@renvarel/architect-core';
import {EvidencePanel} from '../evidence/EvidencePanel';
import {api} from '../api';
import {SelectedMaterial,intentLabel,targetLabel} from '../annotations/SelectedMaterial';

export function workStateLabel(state:WorkItem['state']):string {
  return {new:'New',understanding:'Understanding',queued:'Queued',working:'Working',checking:'Checking',
    done:'Done',needs_decision:'Needs decision',blocked:'Blocked',cancelled:'Cancelled',superseded:'Superseded'}[state];
}

function StopWork({work,onRefresh}:{work:WorkItem;onRefresh:()=>Promise<void>}) {
  const [reason,setReason]=useState('');
  const [confirm,setConfirm]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const submission=useRef<{body:string;id:string}|null>(null);
  async function stop():Promise<void> {
    if(busy||!reason.trim())return;
    setBusy(true);setError('');
    const body=JSON.stringify({expectedVersion:work.version,reason});
    if(submission.current?.body!==body)submission.current={body,id:crypto.randomUUID()};
    try{
      await api.cancelWork(work.id,{clientRequestId:submission.current.id,expectedVersion:work.version,reason});
      setConfirm(false);await onRefresh();
    }catch(value){setError(value instanceof Error?value.message:String(value));}finally{setBusy(false);}
  }
  return <div className="stop-work">{!confirm?<button className="secondary-button" onClick={()=>setConfirm(true)}>Stop work</button>:<>
    <p>Stop this work and revoke any pending send. Its annotation and history will remain.</p>
    <label>Reason for stopping<textarea value={reason} maxLength={2000} onChange={event=>setReason(event.target.value)} disabled={busy}/></label>
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="item-actions"><button className="secondary-button" disabled={busy} onClick={()=>setConfirm(false)}>Keep work</button>
      <button className="secondary-button" disabled={busy||!reason.trim()} onClick={()=>void stop()}>Confirm stop</button></div>
  </>}</div>;
}

export function WorkDetail({detail,onAmend,onRefresh,onDecision}:{
  detail:WorkDetailResponse;onAmend:(detail:WorkDetailResponse)=>void;onRefresh:()=>Promise<void>;
  onDecision:(decision:Decision)=>void;
}) {
  const {work,annotation,events,subtasks}=detail;
  const editable=!['done','cancelled','superseded'].includes(work.state);
  return <section className="work-detail" aria-label="Work detail">
    <div className="overview-heading"><h2>Work detail</h2><span className="verification-badge">{workStateLabel(work.state)}</span></div>
    <p className="helper">{annotation.dispatch.mode==='local'?'Kept in Sovrad · Local only. This note is never sent automatically.':'Send for help requested. The state and blockers below describe what has actually happened.'}</p>
    {work.blockers.length>0&&<section className="work-blockers" aria-label="Blockers"><h3>Blocked</h3><ul>{work.blockers.map((blocker,index)=><li key={index}>{blocker}</li>)}</ul></section>}
    <h3>Original annotation · Revision {annotation.revision}</h3><p className="annotation-original" aria-label="Original annotation text">{annotation.text}</p>
    <p>{targetLabel(annotation.target)} · {intentLabel(annotation.intent)} · {annotation.dispatch.mode==='local'?'Keep in Sovrad':'Send for help'}</p>
    <p className="helper">Saved {new Date(annotation.createdAt).toLocaleString()}. This is the immutable annotation referenced by this work.</p>
    {annotation.consentReceipt?<p className="helper">Sending was approved for this exact revision and selected material.</p>:<p className="helper">No permission to send was granted for this revision.</p>}
    <section className="work-interpretation" aria-label="Understanding and acceptance"><h3>Understanding</h3>
      <p>{work.interpretation?.summary??'An agent interpretation is not available yet.'}</p><h3>Acceptance criteria</h3>
      {work.interpretation?.acceptance.length?<ul>{work.interpretation.acceptance.map(value=><li key={value.id}>{value.description}</li>)}</ul>:<p>Acceptance criteria are unknown. No runtime verification is established.</p>}
    </section>
    <div className="item-actions">{editable&&<button className="secondary-button" onClick={()=>onAmend(detail)}>Amend instruction</button>}
      {editable&&<StopWork key={work.id} work={work} onRefresh={onRefresh}/>}</div>
    <SelectedMaterial material={annotation.material}/>
    <section className="work-history" aria-label="History"><h3>History</h3><p className="helper">Recorded events for this work. No simulated progress is shown.</p>
      {events.length?<ol>{events.map(event=><li key={event.sequence}><time>{new Date(event.time).toLocaleString()}</time><p>{event.detail}</p></li>)}</ol>:<p>No events are available.</p>}
    </section>
    <section aria-label="Subtasks"><h3>Subtasks</h3>{subtasks.length?<ul>{subtasks.map(task=><li key={task.id}>{workStateLabel(task.state)} · {task.id}</li>)}</ul>:<p className="helper">No subtasks have been recorded.</p>}</section>
    <EvidencePanel detail={detail}/>
    <section aria-label="Work decisions"><h3>Needs your decision {detail.pendingDecisionCount}</h3>
      {detail.decisions.map(decision=><div key={decision.id}><p>{decision.explanation.action} · {decision.status.replaceAll('_',' ')}</p>
        <button className="secondary-button" aria-label={`Open decision ${decision.id}`} onClick={()=>onDecision(decision)}>Review request</button></div>)}</section>
  </section>;
}
