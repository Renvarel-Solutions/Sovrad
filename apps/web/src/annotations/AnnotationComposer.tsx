import {useEffect,useMemo,useRef,useState} from 'react';
import {buildSelectedAnnotationMaterial,digestSelectedAnnotationMaterial,serializeSelectedAnnotationMaterial,
  type Annotation,type AnnotationInput,type ContextRef,type WorkDetailResponse,type WorkItem} from '@renvarel/architect-core';
import {api,APIError} from '../api';
import {Dialog} from '../projects/ProjectEditor';
import {useSelectedContext,type SelectedContext} from './useSelectedContext';
import {SelectedMaterial} from './SelectedMaterial';

export type AnnotationTarget={context:ContextRef;text:string;annotation?:Annotation;work?:WorkItem};

function sameOriginalWork(detail:WorkDetailResponse,target:AnnotationTarget):boolean {
  const {work,annotation}=detail;
  if(!target.work||!target.annotation)return false;
  const contextKey=(context:ContextRef):string=>JSON.stringify([context.projectId,context.itemId??null,
    context.workflowId??null,context.stepId??null,context.specRevision??null,context.mapRevision]);
  return work.id===target.work.id&&work.projectId===target.work.projectId&&work.annotationId===target.annotation.id&&
    annotation.id===target.annotation.id&&annotation.revision===target.annotation.revision&&
    annotation.materialJSON===target.annotation.materialJSON&&contextKey(work.context)===contextKey(target.work.context);
}

export function AnnotationComposer({target,onClose,onSaved}:{
  target:AnnotationTarget;onClose:()=>void;onSaved:(result:{annotation:Annotation;work:WorkItem})=>void;
}) {
  const original=target.annotation;
  const [text,setText]=useState(original?.text??target.text);
  const [agent,setAgent]=useState<AnnotationInput['target']>(original?.target??'automatic');
  const [intent,setIntent]=useState<AnnotationInput['intent']>(original?.intent??'instruction');
  const [mode,setMode]=useState<AnnotationInput['dispatch']['mode']>(original?.dispatch.mode??'local');
  const [promote,setPromote]=useState(original?.promoteFuture??false);
  const [consented,setConsented]=useState('');
  const [hashed,setHashed]=useState({json:'',digest:''});
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [expectedVersion,setExpectedVersion]=useState(target.work?.version);
  const [refreshing,setRefreshing]=useState(false);
  const [reviewSelection,setReviewSelection]=useState<SelectedContext|null>(null);
  const [workUnavailable,setWorkUnavailable]=useState('');
  const {selection,error:contextError,denied,loading,retry}=useSelectedContext(target.context);
  const pending=useRef<{body:string;id:string}|null>(null);
  const inFlight=useRef(false);
  const live=useRef(true);
  const priorContext=useRef('');
  const material=useMemo(()=>selection?buildSelectedAnnotationMaterial({
    ...selection,draft:{context:selection.context,text,target:agent,intent,promoteFuture:promote},
  }):null,[selection,text,agent,intent,promote]);
  const json=material?serializeSelectedAnnotationMaterial(material):'';
  const semantic=material?serializeSelectedAnnotationMaterial({...material,text:'',target:'automatic',intent:'instruction',promoteFuture:false}):'';
  const consent=mode==='connected'&&consented===json&&Boolean(json);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{
    if(priorContext.current&&semantic&&priorContext.current!==semantic){
      setConsented('');setNotice('Selected context changed. Review the current details and approve sending again.');
    }
    if(semantic)priorContext.current=semantic;
  },[semantic]);
  useEffect(()=>{
    let active=true;
    if(material)void digestSelectedAnnotationMaterial(material).then(digest=>{
      if(active)setHashed({json,digest});
    }).catch(()=>{if(active)setError('Unable to prepare the selected details. Close and reopen this annotation.');});
    return()=>{active=false;};
  },[json]);
  const ready=Boolean(material)&&hashed.json===json&&!loading&&!contextError&&!denied&&!refreshing&&
    !workUnavailable&&(!reviewSelection||reviewSelection!==selection);

  async function refreshReview():Promise<void> {
    if(refreshing||busy)return;
    setConsented('');setError('');setRefreshing(true);setReviewSelection(selection);
    try{
      if(target.work){
        const current=await api.workDetail(target.work.id);
        if(!live.current)return;
        if(!sameOriginalWork(current,target)||['done','cancelled','superseded'].includes(current.work.state)){
          setWorkUnavailable('This work was completed, stopped or replaced. Your unsent draft is retained here. Close this annotation and choose current work before amending.');
          return;
        }
        setExpectedVersion(current.work.version);setWorkUnavailable('');
      }
      retry();setNotice('Current work and selected context refreshed. Review the details and approve sending again. Nothing was sent.');
    }catch(reason){
      if(!live.current)return;
      if(reason instanceof APIError&&(reason.status===403||reason.status===404)){
        setWorkUnavailable('This work is no longer available. Your unsent draft is retained here. Close this annotation and choose an accessible project or work record.');
      }else setError(reason instanceof Error?reason.message:String(reason));
    }finally{if(live.current)setRefreshing(false);}
  }

  async function submit():Promise<void> {
    if(inFlight.current||!ready||!text.trim()||(mode==='connected'&&!consent)||!selection)return;
    inFlight.current=true;setBusy(true);setError('');
    const body={context:selection.context,text,target:agent,intent,promoteFuture:promote,
      dispatch:{mode,contextDigest:hashed.digest,consent},...(target.work?{expectedVersion}:{})};
    const fingerprint=JSON.stringify(body);
    if(pending.current?.body!==fingerprint)pending.current={body:fingerprint,id:crypto.randomUUID()};
    try{
      const input={...body,clientRequestId:pending.current.id};
      if(target.work&&expectedVersion===undefined)throw new Error('Current work is unavailable. Refresh before amending.');
      const result=target.work?await api.amendWork(target.work.id,{...input,expectedVersion:expectedVersion!}):await api.submitAnnotation(input);
      if(live.current)onSaved(result);
    }catch(reason){
      if(live.current){setConsented('');setError(reason instanceof Error?reason.message:String(reason));retry();}
    }finally{inFlight.current=false;if(live.current)setBusy(false);}
  }
  return <Dialog title={target.work?'Amend instruction':'Annotate selected context'} onClose={()=>{if(!busy)onClose();}}>
    <div className="editor-form annotation-form">
      {notice&&<p className="notice" role="status">{notice}</p>}
      {(error||contextError||workUnavailable)&&<div className="error" role="alert">{workUnavailable||error||contextError}
        {!denied&&!workUnavailable&&<button className="secondary-button" disabled={refreshing||busy} onClick={()=>void refreshReview()}>Refresh selected context</button>}</div>}
      {refreshing&&<p role="status">Refreshing current work and selected context…</p>}
      {loading&&<p role="status">Loading selected context…</p>}
      <fieldset disabled={busy} className="annotation-fields"><legend className="sr-only">Annotation draft</legend>
        <label>Annotation text<textarea rows={4} maxLength={2000} value={text} onChange={event=>{setText(event.target.value);setConsented('');}}/></label>
        <div className="annotation-options"><label>Target<select value={agent} onChange={event=>{setAgent(event.target.value as AnnotationInput['target']);setConsented('');}}>
          <option value="automatic">Automatic</option><option value="codex">Codex</option><option value="chatgpt">ChatGPT</option></select></label>
          <label>Intent<select value={intent} onChange={event=>{setIntent(event.target.value as AnnotationInput['intent']);setConsented('');}}>
            <option value="instruction">Instruction</option><option value="question">Question</option><option value="rule">Rule suggestion</option><option value="future_plan">Future plan</option></select></label></div>
        <label>Send mode<select value={mode} onChange={event=>{setMode(event.target.value as AnnotationInput['dispatch']['mode']);setConsented('');}}>
          <option value="local">Keep in Sovrad</option><option value="connected">Send for help</option></select></label>
        {intent==='future_plan'&&<label className="annotation-check"><input type="checkbox" checked={promote} onChange={event=>{setPromote(event.target.checked);setConsented('');}}/>Request review for current scope</label>}
      </fieldset>
      <p className="helper">{mode==='local'?'A local note stays in Sovrad. It will not be sent when an agent reconnects.':'Agent adapters are unavailable in this preview. This saves blocked work; it cannot start an agent.'}</p>
      {material&&<SelectedMaterial material={material}/>}
      {mode==='connected'&&<label className="annotation-check"><input type="checkbox" checked={consent} disabled={busy||!ready}
        onChange={event=>setConsented(event.target.checked?json:'')}/>I approve sending these selected details to the chosen agent.</label>}
      <button className="primary-button" disabled={busy||!ready||!text.trim()||(mode==='connected'&&!consent)} onClick={()=>void submit()}>
        {busy?'Saving…':mode==='local'?'Save locally':'Send instruction'}</button>
    </div>
  </Dialog>;
}
