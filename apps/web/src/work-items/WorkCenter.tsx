import {useCallback,useEffect,useRef,useState} from 'react';
import type {Decision,WorkDetailResponse,WorkItem} from '@renvarel/architect-core';
import {api,APIError} from '../api';
import {WorkDetail,workStateLabel} from './WorkDetail';

export function WorkCenter({projectId,onAmend,refreshToken,onDecision}:{
  projectId:string;onAmend:(detail:WorkDetailResponse)=>void;refreshToken:number;
  onDecision:(decision:Decision)=>void;
}) {
  const [work,setWork]=useState<WorkItem[]>([]);
  const [selected,setSelected]=useState('');
  const [detail,setDetail]=useState<WorkDetailResponse|null>(null);
  const [error,setError]=useState('');
  const [detailError,setDetailError]=useState('');
  const [loading,setLoading]=useState(true);
  const stopped=useRef({list:false,detail:false});
  const listSequence=useRef(0);
  const detailSequence=useRef(0);
  const refresh=useCallback(async(signal?:AbortSignal):Promise<void>=>{
    const sequence=++listSequence.current;
    try{
      const result=await api.work(projectId,signal);
      if(signal?.aborted||sequence!==listSequence.current)return;
      setWork(result.work);setError('');stopped.current.list=false;
    }catch(reason){
      if(signal?.aborted||sequence!==listSequence.current)return;
      stopped.current.list=reason instanceof APIError&&(reason.status===403||reason.status===404);
      if(stopped.current.list){setWork([]);setDetail(null);}
      setError(reason instanceof Error?reason.message:String(reason));
    }finally{if(!signal?.aborted&&sequence===listSequence.current)setLoading(false);}
  },[projectId]);
  const refreshDetail=useCallback(async(signal?:AbortSignal):Promise<void>=>{
    if(!selected)return;
    const sequence=++detailSequence.current;
    try{
      const result=await api.workDetail(selected,signal);
      if(signal?.aborted||sequence!==detailSequence.current)return;
      setDetail(result);setDetailError('');stopped.current.detail=false;
    }catch(reason){
      if(signal?.aborted||sequence!==detailSequence.current)return;
      stopped.current.detail=reason instanceof APIError&&(reason.status===403||reason.status===404);
      if(stopped.current.detail)setDetail(null);
      setDetailError(reason instanceof Error?reason.message:String(reason));
    }
  },[selected]);
  useEffect(()=>{
    const abort=new AbortController();void refresh(abort.signal);
    const timer=window.setInterval(()=>{if(!stopped.current.list)void refresh(abort.signal);},5000);
    return()=>{abort.abort();++listSequence.current;window.clearInterval(timer);};
  },[refresh,refreshToken]);
  useEffect(()=>{
    setDetail(null);setDetailError('');stopped.current.detail=false;
    const abort=new AbortController();void refreshDetail(abort.signal);
    const timer=window.setInterval(()=>{if(!stopped.current.detail)void refreshDetail(abort.signal);},5000);
    return()=>{abort.abort();++detailSequence.current;window.clearInterval(timer);};
  },[refreshDetail,refreshToken]);
  return <main className="overview work-center" aria-label="Work & results">
    <h2>Work & results</h2><p className="helper">Showing up to 50 recent work records in this project. Older records may be outside this list.</p>
    {error&&<div className="error" role="alert">{error}{!stopped.current.list&&<button className="secondary-button" onClick={()=>void refresh()}>Retry work list</button>}</div>}
    {loading&&<p role="status">Loading work…</p>}
    {!loading&&!error&&!work.length&&<p className="empty-state">No work recorded yet. Add a local annotation from the project or a workflow.</p>}
    <div className="work-records">{work.map(value=><article key={value.id} className={`work-record ${selected===value.id?'active':''}`}>
      <div><span className="verification-badge">{workStateLabel(value.state)}</span><p>{new Date(value.updatedAt).toLocaleString()}</p>
        <small>{value.context.stepId?'Selected stage':value.context.workflowId?'Selected workflow':'Project annotation'}</small></div>
      <button className="secondary-button" aria-label={`Open work ${value.id}`} onClick={()=>{if(selected===value.id)void refreshDetail();else setSelected(value.id);}}>View work</button>
    </article>)}</div>
    {detailError&&<div className="error" role="alert">{detailError}{!stopped.current.detail&&<button className="secondary-button" onClick={()=>void refreshDetail()}>Retry work detail</button>}</div>}
    {selected&&!detail&&!detailError&&<p role="status">Loading original annotation and history…</p>}
    {detail&&<WorkDetail key={detail.work.id} detail={detail} onAmend={onAmend} onDecision={onDecision} onRefresh={async()=>{await refreshDetail();await refresh();}}/>}
  </main>;
}
