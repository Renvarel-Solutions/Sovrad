import {useCallback,useEffect,useRef,useState} from 'react';
import type {Decision,DecisionQuery,DecisionsResponse} from '@renvarel/architect-core';
import {api,APIError} from '../api';

export type DecisionScope=Pick<DecisionQuery,'projectId'|'itemId'|'workflowId'|'stepId'>;
export type DecisionQueue={data:DecisionsResponse|null;loading:boolean;error:string;notice:string;complete:boolean;unavailable:boolean;
  revision:number;load:(append?:boolean,poll?:boolean)=>Promise<void>};
export function useDecisions(scope:DecisionScope):DecisionQueue {
  const [data,setData]=useState<DecisionsResponse|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [revision,setRevision]=useState(0);
  const current=useRef<DecisionsResponse|null>(null);
  const control=useRef({generation:0,abort:null as AbortController|null,busy:false,denied:false});
  const scopeKey=JSON.stringify(scope);
  const lifetime=useRef({key:scopeKey,epoch:0,mounted:true});
  if(lifetime.current.key!==scopeKey){lifetime.current.key=scopeKey;lifetime.current.epoch++;}
  const epoch=lifetime.current.epoch;
  const load=useCallback(async(append=false,poll=false):Promise<void>=>{
    const sameScope=():boolean=>lifetime.current.mounted&&lifetime.current.epoch===epoch;
    if(!sameScope())return;
    if(poll&&control.current.busy)return;
    control.current.abort?.abort();
    const generation=++control.current.generation,abort=new AbortController();
    control.current.abort=abort;control.current.busy=true;
    const valid=():boolean=>sameScope()&&!abort.signal.aborted&&generation===control.current.generation;
    if(!poll)setLoading(true);
    try{
      const previous=current.current;
      let next=await api.decisions({...scope,state:'pending',limit:50,afterSequence:append?previous?.page.nextAfterSequence??0:0},abort.signal);
      if(!valid())return;
      if(previous&&previous.page.viewDigest!==next.page.viewDigest){
        setNotice('This list changed. Refreshed from the beginning.');
        if(append)next=await api.decisions({...scope,state:'pending',limit:50,afterSequence:0},abort.signal);
        append=false;
      }else if(poll&&previous){setError('');setRevision(value=>value+1);return;}
      if(!valid())return;
      if(append&&previous){
        if(next.page.nextAfterSequence<=previous.page.nextAfterSequence&&next.page.hasMore)throw new Error('The decision page did not advance. Refresh this incomplete list.');
        const rows=[...previous.decisions,...next.decisions];
        if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('The decision list changed. Refresh this incomplete list.');
        next={...next,decisions:rows};
      }
      if(next.decisions.length>next.total)throw new Error('The decision count changed. Refresh this incomplete list.');
      current.current=next;setData(next);setError('');control.current.denied=false;setRevision(value=>value+1);
    }catch(reason){
      if(!valid())return;
      control.current.denied=reason instanceof APIError&&(reason.status===403||reason.status===404);
      if(control.current.denied){current.current=null;setData(null);}
      setError(reason instanceof Error?reason.message:String(reason));
    }finally{if(valid()){control.current.busy=false;setLoading(false);}}
  },[scopeKey,epoch]);
  useEffect(()=>{
    lifetime.current.mounted=true;
    current.current=null;setData(null);setNotice('');control.current.denied=false;void load();
    const timer=window.setInterval(()=>{if(!control.current.denied)void load(false,true);},5000);
    return()=>{lifetime.current.mounted=false;++control.current.generation;control.current.abort?.abort();control.current.busy=false;window.clearInterval(timer);};
  },[load]);
  const complete=Boolean(data&&!loading&&!error&&!data.page.hasMore&&new Set(data.decisions.map(row=>row.id)).size===data.total);
  return {data,loading,error,notice,complete,load,revision,unavailable:control.current.denied};
}

export async function refreshDecision(decision:Decision,scope:DecisionScope,signal?:AbortSignal):Promise<Decision|null> {
  if(decision.workId){
    const detail=await api.workDetail(decision.workId,signal);
    return detail.decisions.find(row=>row.id===decision.id)??null;
  }
  let afterSequence=0;
  while(true){
    const page=await api.decisions({...scope,limit:50,afterSequence},signal);
    const found=page.decisions.find(row=>row.id===decision.id);if(found)return found;
    if(!page.page.hasMore)return null;
    if(page.page.nextAfterSequence<=afterSequence)throw new Error('The request list did not advance. Please refresh.');
    afterSequence=page.page.nextAfterSequence;
  }
}
