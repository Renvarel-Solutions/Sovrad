import {useEffect,useRef,useState,type ReactElement} from 'react';
import type {Decision} from '@renvarel/architect-core';
import {DecisionDetail} from './DecisionDetail';
import {refreshDecision,useDecisions,type DecisionScope} from './useDecisions';
import {APIError} from '../api';

export type DecisionTarget={scope:DecisionScope;decision?:Decision};
export function DecisionCenter({target,projectIds,drafts,onDraft,onSelection,onForget,onChanged,onClose}:{target:DecisionTarget;drafts:Record<string,string>;
  projectIds:string[];onDraft:(decision:Decision,value:string)=>void;onSelection:(decision:Decision|null)=>void;
  onForget:(projectId:string,decisionId?:string)=>void;onChanged:()=>Promise<void>;onClose:()=>void;
}):ReactElement {
  const queue=useDecisions(target.scope);
  const [reviewEpoch,setReviewEpoch]=useState<number|null>(null);
  const [detailError,setDetailError]=useState<{epoch:number;message:string}|null>(null);
  const [blockedRevision,setBlockedRevision]=useState<number|null>(null);
  const [reviewCompletion,setReviewCompletion]=useState(0);
  const live=useRef({target,epoch:0,operation:0,mounted:true,reading:false,abort:null as AbortController|null});
  if(live.current.target!==target){live.current.target=target;live.current.epoch++;live.current.operation++;live.current.reading=false;}
  const epoch=live.current.epoch;
  const needsReview=reviewEpoch===epoch;
  const latest=useRef({queue,projectIds,onChanged,onSelection,onForget});
  latest.current={queue,projectIds,onChanged,onSelection,onForget};
  const selected=target.decision&&projectIds.includes(target.decision.projectId)?target.decision:null;
  const visibilityKey=JSON.stringify(projectIds),scopeKey=JSON.stringify(target.scope);
  function current(expected:number,projectId:string):boolean {
    return live.current.mounted&&live.current.epoch===expected&&latest.current.projectIds.includes(projectId);
  }
  function forget(value:Decision):void {
    live.current.epoch++;live.current.operation++;live.current.abort?.abort();live.current.reading=false;
    setBlockedRevision(latest.current.queue.revision);
    latest.current.onForget(value.projectId,value.id);setDetailError(null);setReviewEpoch(null);
  }
  useEffect(()=>{
    live.current.mounted=true;setReviewEpoch(null);setDetailError(null);
    return()=>{live.current.operation++;live.current.abort?.abort();live.current.reading=false;};
  },[target]);
  useEffect(()=>()=>{live.current.mounted=false;live.current.operation++;live.current.abort?.abort();},[]);
  useEffect(()=>{
    if(target.decision&&!projectIds.includes(target.decision.projectId))latest.current.onForget(target.decision.projectId);
    if(target.scope.projectId&&!projectIds.includes(target.scope.projectId))latest.current.onForget(target.scope.projectId);
    void latest.current.queue.load();
  },[visibilityKey]);
  useEffect(()=>{
    if(queue.unavailable){
      if(target.scope.projectId)latest.current.onForget(target.scope.projectId);
      else if(selected)forget(selected);
    }
  },[queue.unavailable]);
  async function refresh(manual=false):Promise<void> {
    if(!selected)return;
    if(!manual&&live.current.reading)return;
    live.current.abort?.abort();const abort=new AbortController();live.current.abort=abort;
    const operation=++live.current.operation;live.current.reading=true;
    const valid=():boolean=>current(epoch,selected.projectId)&&operation===live.current.operation&&!abort.signal.aborted;
    try{
      const next=await refreshDecision(selected,target.scope,abort.signal);
      if(!valid())return;
      if(!next){forget(selected);return;}
      if(manual||next.status!=='pending'){
        if(JSON.stringify(next)!==JSON.stringify(selected))latest.current.onSelection(next);
        setReviewEpoch(null);setDetailError(null);
      }else if(next.version!==selected.version||next.proposalDigest!==selected.proposalDigest)setReviewEpoch(epoch);
      if(manual)setReviewCompletion(value=>value+1);
      if(manual){await latest.current.queue.load();await latest.current.onChanged();}
    }catch(reason){
      if(!valid())return;
      if(reason instanceof APIError&&(reason.status===403||reason.status===404)){forget(selected);return;}
      if(manual)throw reason;
      setDetailError({epoch,message:reason instanceof Error?reason.message:String(reason)});setReviewEpoch(epoch);
    }finally{if(valid())live.current.reading=false;}
  }
  useEffect(()=>{void refresh();},[queue.revision,scopeKey]);
  async function resolved(value:Decision):Promise<void> {
    if(current(epoch,value.projectId)){
      latest.current.onSelection(value);setReviewEpoch(null);setDetailError(null);
    }
    // A completed server mutation still updates shared facts after navigation;
    // only the latest scope's loader may run, never the captured old loader.
    await latest.current.onChanged();
    if(live.current.mounted)await latest.current.queue.load();
  }
  const visibilityPending=blockedRevision===queue.revision||queue.data?.decisions.some(row=>!projectIds.includes(row.projectId));
  return <section className="overview decision-center" aria-label="Decisions">
    <div className="overview-heading"><h2>Needs your decision</h2><button className="secondary-button" onClick={onClose}>Close decisions</button></div>
    {queue.notice&&<p role="status" className="notice">{queue.notice}</p>}
    {queue.error&&<p className="error" role="alert">{queue.error}<button onClick={()=>void queue.load()}>Refresh decisions</button></p>}
    {visibilityPending&&<p role="status">Project access changed. Refreshing decisions…</p>}
    {queue.data&&!visibilityPending&&<><p className="list-scope">Showing {queue.data.decisions.length} of {queue.data.total} decisions</p>
      <p className="helper">Use Tab to enter the requests, then the arrow keys to move between them. Enter opens the selected request.</p>
      <div className="decision-rows" role="toolbar" aria-label="Decision requests" aria-orientation="vertical" onKeyDown={event=>{
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
        buttons[next]?.focus();
      }}>{queue.data.decisions.map((row,index)=><article key={row.id} data-decision-id={row.id} className="decision-row">
        <p>{row.explanation.action}</p><button className="secondary-button" tabIndex={selected&&queue.data!.decisions.some(value=>value.id===selected.id)?selected.id===row.id?0:-1:index===0?0:-1}
          aria-label={`Open decision ${row.id}`} onClick={()=>{live.current.epoch++;live.current.operation++;live.current.abort?.abort();latest.current.onSelection(row);setReviewEpoch(null);}}>Review request</button>
      </article>)}</div>
      <div className="load-actions" aria-live="polite">{!queue.complete&&queue.data.page.hasMore&&<button className="secondary-button" disabled={queue.loading} onClick={()=>void queue.load(true)}>Load more</button>}
        <span>{queue.complete?'Complete decision list loaded':'List incomplete'}</span></div>
    </>}
    {queue.loading&&<p role="status">Loading decisions…</p>}
    {detailError?.epoch===epoch&&<p className="error" role="alert">{detailError.message}</p>}
    {selected&&<DecisionDetail key={`${selected.id}:${scopeKey}`} decision={selected} viewEpoch={epoch} reviewCompletion={reviewCompletion} needsReview={needsReview} reason={drafts[selected.id]??''}
      isCurrent={()=>current(epoch,selected.projectId)} onUnavailable={()=>{if(current(epoch,selected.projectId))forget(selected);}}
      onReason={value=>{if(current(epoch,selected.projectId))onDraft(selected,value);}}
      onRefresh={()=>refresh(true)} onResolved={resolved}/>}
  </section>;
}
