import {useCallback, useEffect, useRef, useState} from 'react';
import type {Viewport} from '@xyflow/react';

export type NavigationFrame = {
  projectId:string; itemId:string | null; workflowId:string; name:string;
  stepId:string; viewport?:Viewport;
};
export function useWorkflowNavigation() {
  const [frames,setFrames] = useState<NavigationFrame[]>([{
    projectId:'sample-calculator',itemId:null,workflowId:'sample-calculator-arithmetic',name:'Basic arithmetic',stepId:'number-a',
  }]);
  const current = frames.at(-1) ?? null;
  const retained=useRef(new Map<string,NavigationFrame>());
  const key=(frame:NavigationFrame):string=>`${frame.projectId}|${frame.itemId??''}|${frame.workflowId}`;
  useEffect(()=>{for(const frame of frames)retained.current.set(key(frame),frame);},[frames]);
  const open = useCallback((frame:NavigationFrame) => {
    const previous=retained.current.get(key(frame));
    setFrames([previous?{...previous,name:frame.name}:frame]);
  },[]);
  const child = useCallback((workflowId:string,name:string) => setFrames(previous => {
    const parent = previous.at(-1);
    if(!parent)return previous;
    const frame={...parent,workflowId,name,stepId:'',viewport:undefined};
    return [...previous,retained.current.get(key(frame))??frame];
  }),[]);
  const update = useCallback((patch:Partial<Pick<NavigationFrame,'stepId'|'viewport'|'name'>>) => {
    setFrames(previous => previous.map((frame,index) => index===previous.length-1 ? {...frame,...patch} : frame));
  },[]);
  const back = useCallback(() => setFrames(previous => previous.slice(0,-1)),[]);
  const clear = useCallback(() => setFrames([]),[]);
  return {current,frames,open,child,update,back,clear};
}
