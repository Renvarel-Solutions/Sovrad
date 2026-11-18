import {useCallback,useEffect,useRef,useState} from 'react';
import type {OverviewFilter,OverviewResponse} from '@renvarel/architect-core';
import {api,APIError} from '../api';

function mergePages(previous:OverviewResponse,next:OverviewResponse):OverviewResponse {
  return {...next,
    items:Array.from(new Map([...previous.items,...next.items].map(item=>[item.id,item])).values()),
    workflows:Array.from(new Map([...previous.workflows,...next.workflows].map(workflow=>[workflow.id,workflow])).values()),
    dependencies:Array.from(new Map([...previous.dependencies,...next.dependencies].map(edge=>[`${edge.sourceItemId}:${edge.targetItemId}`,edge])).values()),
  };
}
export function useProjectOverview(projectId:string,filter:OverviewFilter,refreshToken:number) {
  const [data,setData]=useState<OverviewResponse|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [unavailable,setUnavailable]=useState(false);
  const control=useRef<{id:number;abort:AbortController|null}>({id:0,abort:null});
  const snapshot=useRef<OverviewResponse|null>(null);
  const filterKey=JSON.stringify(filter);

  const load=useCallback(async(append=false,all=false):Promise<void>=>{
    control.current.abort?.abort();
    const id=++control.current.id;
    const abort=new AbortController();control.current.abort=abort;
    setLoading(true);setError('');setUnavailable(false);
    let cursor=append?snapshot.current?.page.nextCursor:null;
    if(!append){snapshot.current=null;setData(null);}
    try{
      do{
        const next=await api.overview(projectId,{...filter,limit:50,...(cursor?{cursor}:{})},abort.signal);
        if(id!==control.current.id)return;
        const combined=append&&snapshot.current?mergePages(snapshot.current,next):next;
        snapshot.current=combined;setData(combined);cursor=next.page.nextCursor;append=true;
      }while(all&&cursor);
    }catch(reason){
      if(id!==control.current.id||abort.signal.aborted)return;
      if(reason instanceof APIError&&reason.code==='STALE_CURSOR'){
        snapshot.current=null;setData(null);setNotice('This list changed. Refreshed from the beginning.');
        // A new first-page read never reuses an expired cursor.
        const first=await api.overview(projectId,{...filter,limit:50},abort.signal).catch(retryError=>{
          if(id===control.current.id&&!abort.signal.aborted){
            setError(retryError instanceof Error?retryError.message:String(retryError));
            setUnavailable(retryError instanceof APIError&&(retryError.status===403||retryError.status===404));
          }
          return null;
        });
        if(first&&id===control.current.id){snapshot.current=first;setData(first);}
      }else{
        setError(reason instanceof Error?reason.message:String(reason));
        const denied=reason instanceof APIError&&(reason.status===403||reason.status===404);
        setUnavailable(denied);if(denied){snapshot.current=null;setData(null);}
      }
    }finally{if(id===control.current.id)setLoading(false);}
  },[projectId,filterKey]);

  useEffect(()=>{
    setNotice('');void load();
    return()=>{++control.current.id;control.current.abort?.abort();};
  },[load,refreshToken]);
  useEffect(()=>{
    if(unavailable)return;
    let mounted=true;
    let polling=false;
    const pollAbort=new AbortController();
    const timer=window.setInterval(()=>{
      if(loading||polling||!snapshot.current)return;
      polling=true;
      const id=control.current.id;
      const prior=snapshot.current;
      // Refresh only as many bounded pages as the user has loaded. Equal totals
      // cannot establish that the server's per-step evidence is unchanged.
      const pages=Math.max(1,Math.ceil(Math.max(prior.items.length,prior.workflows.length)/50));
      void (async()=>{
        let result=await api.overview(projectId,{...filter,limit:50},pollAbort.signal);
        if(result.project.mapRevision!==prior.project.mapRevision){
          if(mounted&&id===control.current.id){setNotice('Project changed. Refreshed from the beginning.');void load();}
          return;
        }
        for(let page=1;page<pages&&result.page.nextCursor;page++){
          const next=await api.overview(projectId,{...filter,limit:50,cursor:result.page.nextCursor},pollAbort.signal);
          result=mergePages(result,next);
        }
        if(mounted&&id===control.current.id&&!pollAbort.signal.aborted){snapshot.current=result;setData(result);setError('');}
      })().catch(reason=>{
        if(!mounted||id!==control.current.id||pollAbort.signal.aborted)return;
        if(reason instanceof APIError&&reason.code==='STALE_CURSOR'){
          setNotice('This list changed. Refreshed from the beginning.');void load();
        }else if(reason instanceof APIError&&(reason.status===403||reason.status===404)){
          setUnavailable(true);setError('Project access is no longer available.');snapshot.current=null;setData(null);
        }else setError('Could not refresh this list. Loaded information may be out of date.');
      }).finally(()=>{polling=false;});
    },5000);
    return()=>{mounted=false;pollAbort.abort();window.clearInterval(timer);};
  },[projectId,filterKey,loading,load,unavailable]);
  const cancel=():void=>{
    ++control.current.id;control.current.abort?.abort();setLoading(false);
    setNotice('Loading stopped. This list is incomplete.');
  };
  const complete=Boolean(data&&!loading&&!error&&!data.page.nextCursor&&!data.page.hasMoreItems&&!data.page.hasMoreWorkflows
    &&data.items.length===data.totals.items&&data.workflows.length===data.totals.workflows);
  return {data,loading,error,notice,unavailable,complete,load,cancel};
}
