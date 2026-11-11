import {useCallback,useEffect,useRef,useState} from 'react';
import type {ContextRef,ProjectItem,RegisteredProject,Step,Workflow} from '@renvarel/architect-core';
import {api,APIError} from '../api';

export type SelectedContext = {
  context:ContextRef; project:RegisteredProject; item:ProjectItem|null; workflow:Workflow|null; step:Step|null;
};

async function fetchSelection(target:ContextRef,signal:AbortSignal):Promise<SelectedContext> {
  const [overview,detail]=await Promise.all([
    api.overview(target.projectId,target.itemId?{itemId:target.itemId}:{},signal),
    target.workflowId?api.workflow(target.workflowId,signal):Promise.resolve(null),
  ]);
  const item=target.itemId?overview.items.find(value=>value.id===target.itemId)??null:null;
  const workflow=detail?.workflow??null;
  const step=target.stepId?workflow?.steps.find(value=>value.id===target.stepId)??null:null;
  if((target.itemId&&!item)||(target.workflowId&&(!workflow||workflow.projectId!==target.projectId))||(target.stepId&&!step)){
    throw new APIError('Selected context is no longer available. Return to the project and choose it again.',404);
  }
  const context:ContextRef={projectId:overview.project.id,mapRevision:overview.project.mapRevision,
    ...(item?{itemId:item.id}:{}),...(workflow?{workflowId:workflow.id,specRevision:workflow.revision}:{}),...(step?{stepId:step.id}:{})};
  return {context,project:overview.project,item,workflow,step};
}

export function useSelectedContext(target:ContextRef) {
  const [selection,setSelection]=useState<SelectedContext|null>(null);
  const [error,setError]=useState('');
  const [denied,setDenied]=useState(false);
  const [loading,setLoading]=useState(true);
  const sequence=useRef(0);
  const stopped=useRef(false);
  const load=useCallback(async(signal:AbortSignal):Promise<void>=>{
    const request=++sequence.current;
    try{
      const next=await fetchSelection(target,signal);
      if(signal.aborted||request!==sequence.current)return;
      setSelection(next);setError('');setDenied(false);stopped.current=false;
    }catch(reason){
      if(signal.aborted||request!==sequence.current)return;
      stopped.current=reason instanceof APIError&&(reason.status===403||reason.status===404);
      setDenied(stopped.current);setError(reason instanceof Error?reason.message:String(reason));
    }finally{if(!signal.aborted&&request===sequence.current)setLoading(false);}
  },[target]);
  useEffect(()=>{
    const abort=new AbortController();
    void load(abort.signal);
    const timer=window.setInterval(()=>{if(!stopped.current)void load(abort.signal);},5000);
    return()=>{abort.abort();++sequence.current;window.clearInterval(timer);};
  },[load]);
  const retry=():void=>{stopped.current=false;void load(new AbortController().signal);};
  return {selection,error,denied,loading,retry};
}
