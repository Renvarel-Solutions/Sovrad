import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import type {DevelopmentState,ProjectItem,RegisteredProject,Workflow} from '@renvarel/architect-core';
import {api} from '../api';

export function Dialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input,button,textarea,select');
    first?.focus();
    return ()=>previous?.focus();
  },[]);
  return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="dialog-panel" role="dialog" aria-modal="true" aria-label={title} ref={panel} onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();onClose();}
      if(event.key!=='Tab')return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
      if(!controls?.length)return;
      const first=controls[0],last=controls[controls.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }}>
      <div className="dialog-heading"><h2>{title}</h2><button className="secondary-button" onClick={onClose}>Close</button></div>
      {children}
    </div>
  </div>;
}
export type EditorTarget = {kind:'project'} | {kind:'settings';project:RegisteredProject}
  | {kind:'item';project:RegisteredProject;item?:ProjectItem;items:ProjectItem[];complete:boolean}
  | {kind:'workflow';project:RegisteredProject;item:ProjectItem | null};
export function ProjectEditor({target,onClose,onSaved}:{
  target:EditorTarget;onClose:()=>void;onSaved:(result:{project?:RegisteredProject;workflow?:Workflow;itemId?:string|null})=>void;
}) {
  const item = target.kind==='item' ? target.item : undefined;
  const [name,setName]=useState(item?.name ?? (target.kind==='settings' ? target.project.name : ''));
  const [description,setDescription]=useState(item?.description ?? (target.kind==='settings' ? target.project.description : ''));
  const [development,setDevelopment]=useState<DevelopmentState>(item?.development ?? 'planning');
  const [itemKind,setItemKind]=useState<ProjectItem['kind']>('feature');
  const [parent,setParent]=useState('');
  const [steps,setSteps]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const submission=useRef<{body:string;id:string}|null>(null);
  const noun = target.kind==='project' || target.kind==='settings' ? 'Project' : target.kind==='workflow' ? 'Workflow' : 'Item';
  const title = target.kind==='settings' ? 'Edit project' : item ? 'Edit item' : `Add ${noun.toLowerCase()}`;
  async function save(event:FormEvent):Promise<void> {
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    const body=JSON.stringify({name,description,development,itemKind,parent,steps});
    if(submission.current?.body!==body)submission.current={body,id:crypto.randomUUID()};
    const clientRequestId=submission.current!.id;
    try {
      if(target.kind==='project'){
        const result=await api.createProject({clientRequestId,name,description});onSaved(result);
      }else if(target.kind==='settings'){
        const result=await api.settings(target.project.id,{expectedGrantRevision:target.project.grantRevision,name,description});onSaved(result);
      }else if(target.kind==='item'){
        const common={name,description,development,expectedMapRevision:target.project.mapRevision};
        if(item)await api.editItem(target.project.id,item.id,common);
        else await api.createItem(target.project.id,{...common,clientRequestId,parentId:parent||null,kind:itemKind,workflowId:null});
        onSaved({});
      }else{
        const names=steps.split('\n').map(value=>value.trim()).filter(Boolean);
        if(!names.length)throw new Error('Add at least one stage.');
        if(names.length>100)throw new Error('A new workflow can contain up to 100 stages.');
        const result=await api.createWorkflow(target.project.id,{clientRequestId,expectedMapRevision:target.project.mapRevision,
          itemId:target.item?.id??null,name,description,
          steps:names.map((title,index)=>({id:`stage-${index+1}`,title,purpose:'',kind:'process',rules:[],inputs:[],outputs:[],
            errorBehavior:'',position:{x:40+index*300,y:160}})),
          connections:names.slice(1).map((_title,index)=>({id:`path-${index+1}`,source:`stage-${index+1}`,target:`stage-${index+2}`})),
        });onSaved({...result,itemId:target.item?.id??null});
      }
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  }
  return <Dialog title={title} onClose={()=>{if(!busy)onClose();}}>
    <form className="editor-form" onSubmit={event=>void save(event)}>
      {error&&<p className="error" role="alert">{error}</p>}
      <label>{noun} name<input aria-label={`${noun} name`} required maxLength={100} value={name} onChange={event=>setName(event.target.value)}/></label>
      <label>{noun} description<textarea aria-label={`${noun} description`} maxLength={2000} value={description} onChange={event=>setDescription(event.target.value)}/></label>
      {target.kind==='project'&&<p className="helper">Creates a private planning project registered in Sovrad. Source remains unmapped; no work starts.</p>}
      {target.kind==='item'&&<>
        <label>Development<select aria-label="Development" value={development} onChange={event=>setDevelopment(event.target.value as DevelopmentState)}>
          <option value="planning">Planning</option><option value="implementation">Being implemented</option><option value="future">Future scope</option><option value="implemented">Implemented</option>
        </select></label>
        {!item&&<><label>Item type<select value={itemKind} onChange={event=>setItemKind(event.target.value as ProjectItem['kind'])}>
          <option value="feature">Feature</option><option value="module">Module</option><option value="workflow">Workflow</option>
        </select></label><label>Parent item<select value={parent} onChange={event=>setParent(event.target.value)}>
          <option value="">No parent</option>{target.items.map(value=><option value={value.id} key={value.id}>{value.name}</option>)}
        </select></label>{!target.complete&&<p className="helper">Parent choices include loaded items. Load all items first to choose another parent.</p>}</>}
        <p className="helper">Development labels describe the plan. They do not establish checked behavior. Existing parent and workflow links stay fixed.</p>
      </>}
      {target.kind==='workflow'&&<><label>Steps (one per line)<textarea aria-label="Steps (one per line)" rows={6} required value={steps} onChange={event=>setSteps(event.target.value)}/></label>
        <p className="helper">New stages connect in the listed order. Add rules through each stage’s proposal form after creation. Existing graph links cannot be edited.</p></>}
      <button className="primary-button" type="submit" disabled={busy||!name.trim()}>{busy?'Saving…':target.kind==='settings'?'Save project':item?'Save item':`Create ${noun.toLowerCase()}`}</button>
    </form>
  </Dialog>;
}
