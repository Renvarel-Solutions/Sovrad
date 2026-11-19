import {useEffect,useRef,useState} from 'react';
import type {AccessPreference,ProjectManagementSummary} from '@renvarel/architect-core';
import {api,APIError} from '../api';
import {Dialog} from './ProjectEditor';

export function ProjectManagement({onClose,onChanged}:{onClose:()=>void;onChanged:()=>Promise<void>}) {
  const [projects,setProjects]=useState<ProjectManagementSummary[]>([]);
  const [total,setTotal]=useState(0);
  const [cursor,setCursor]=useState<string|null>(null);
  const [access,setAccess]=useState<AccessPreference>({mode:'selected',selectedProjectIds:[]});
  const [savedAccess,setSavedAccess]=useState<AccessPreference|null>(null);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [initialLoaded,setInitialLoaded]=useState(false);
  const [cancelled,setCancelled]=useState(false);
  const control=useRef<{id:number;abort:AbortController|null}>({id:0,abort:null});
  const choices=useRef<ProjectManagementSummary[]>([]);
  const continuation=useRef<string|null>(null);
  const draft=useRef<AccessPreference|null>(null);

  async function load(append=false,all=false,preserveDraft=true,targetCount=0):Promise<void> {
    control.current.abort?.abort();
    const id=++control.current.id;
    const abort=new AbortController();control.current.abort=abort;
    setLoading(true);setError('');setCancelled(false);if(cancelled)setNotice('');
    let next=append?continuation.current:null;
    try {
      do {
        const result=await api.workspace({management:true,limit:50,...(next?{cursor:next}:{})},abort.signal);
        if(id!==control.current.id)return;
        const management=result.management;
        if(!management)throw new Error('Registered project choices are unavailable.');
        const rows=append?choices.current:[];
        choices.current=Array.from(new Map([...rows,...management.projects].map(project=>[project.id,project])).values());
        continuation.current=management.page.nextCursor;next=continuation.current;
        setProjects(choices.current);setTotal(management.total);setCursor(next);setSavedAccess(result.access);setInitialLoaded(true);
        if(!preserveDraft||!draft.current){draft.current=result.access;setAccess(result.access);}
        append=true;
      }while(next&&(all||choices.current.length<targetCount));
    }catch(reason){
      if(id!==control.current.id||abort.signal.aborted)return;
      if(reason instanceof APIError&&reason.code==='STALE_CURSOR'){
        choices.current=[];continuation.current=null;setProjects([]);setCursor(null);
        setNotice('Project choices changed. Refreshed from the beginning.');
        void load(false,false,true);return;
      }
      setError(reason instanceof Error?reason.message:String(reason));
    }finally{if(id===control.current.id)setLoading(false);}
  }
  useEffect(()=>{void load();return()=>{++control.current.id;control.current.abort?.abort();};},[]);
  function changeAccess(value:AccessPreference):void {draft.current=value;setAccess(value);setNotice('');}
  function toggle(id:string,checked:boolean):void {
    const selected=new Set(access.selectedProjectIds);
    if(checked)selected.add(id);else selected.delete(id);
    changeAccess({...access,selectedProjectIds:[...selected]});
  }
  async function save():Promise<void> {
    if(saving)return;
    setSaving(true);setError('');
    try {
      const result=await api.access(access);setSavedAccess(result.access);draft.current=result.access;setAccess(result.access);
      setProjects(previous=>previous.map(project=>({...project,selected:result.access.mode==='all_connected'||result.access.selectedProjectIds.includes(project.id)})));
      choices.current=choices.current.map(project=>({...project,selected:result.access.mode==='all_connected'||result.access.selectedProjectIds.includes(project.id)}));
      setNotice('Project access saved. Grants did not change.');
      await onChanged();
      // Access changes invalidate the management cursor. Restart the bounded list.
      await load(false,false,true,choices.current.length);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setSaving(false);}
  }
  async function restore(project:ProjectManagementSummary):Promise<void> {
    if(saving)return;setSaving(true);setError('');
    try {
      const result=await api.settings(project.id,{expectedGrantRevision:project.grantRevision,archived:false});
      const replace=(value:ProjectManagementSummary):ProjectManagementSummary=>value.id===project.id
        ? {...value,archived:result.project.archived,grantRevision:result.project.grantRevision}:value;
      choices.current=choices.current.map(replace);setProjects(previous=>previous.map(replace));
      setNotice('Project restored. No work was started.');await onChanged();
      // A relevant mutation expires older continuation tokens; re-page on demand.
      continuation.current=null;setCursor(null);
      if(choices.current.length<total)await load(false,false,true,choices.current.length);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setSaving(false);}
  }
  function cancel():void {
    ++control.current.id;control.current.abort?.abort();setLoading(false);setCancelled(true);
    setNotice('Loading stopped. This list is incomplete.');
  }
  return <Dialog title="Manage projects" onClose={()=>{if(!saving)onClose();}}>
    <p className="helper">Registered in Sovrad. These choices contain names and access state only. Selecting a project does not read its source or start work.</p>
    <fieldset className="access-options" disabled={saving}>
      <legend>Project access</legend>
      <label><input type="radio" name="access" checked={access.mode==='selected'} onChange={()=>changeAccess({...access,mode:'selected'})}/>Selected projects</label>
      <label><input type="radio" name="access" checked={access.mode==='all_connected'} onChange={()=>changeAccess({...access,mode:'all_connected'})}/>All connected projects</label>
    </fieldset>
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}
    <p className="list-scope">{initialLoaded?`Showing ${projects.length} of ${total} registered projects`:'Registered project count is not available yet.'}</p>
    <div className="management-list">{projects.map(project=>{
      const selected=access.mode==='all_connected'||access.selectedProjectIds.includes(project.id);
      const savedSelected=savedAccess?.mode==='all_connected'||savedAccess?.selectedProjectIds.includes(project.id);
      return <div className="management-row" data-project-id={project.id} key={project.id}>
        <label><input type="checkbox" checked={selected} disabled={access.mode==='all_connected'||saving} onChange={event=>toggle(project.id,event.target.checked)}/><span>{project.name}</span></label>
        <div className="management-state">{project.archived&&<span>Archived</span>}{!project.selected&&<span>Not selected</span>}
          {project.archived&&<button className="secondary-button" disabled={!savedSelected||saving} onClick={()=>void restore(project)}>Restore</button>}
        </div>
      </div>;
    })}</div>
    <div className="load-actions">{loading?<button className="secondary-button" onClick={cancel}>Cancel loading</button>:<>
      {cursor&&<><button className="secondary-button" onClick={()=>void load(true)}>Load more</button><button className="secondary-button" onClick={()=>void load(true,true)}>Load all</button></>}
      {(error||cancelled||!initialLoaded)&&<button className="secondary-button" onClick={()=>void load(Boolean(continuation.current))}>Retry loading</button>}
      {initialLoaded&&!cancelled&&!cursor&&!error&&projects.length===total&&<span>All registered choices loaded</span>}
    </>}</div>
    <div className="dialog-footer"><button className="primary-button" disabled={saving||!savedAccess} onClick={()=>void save()}>{saving?'Saving…':'Save access'}</button></div>
  </Dialog>;
}
