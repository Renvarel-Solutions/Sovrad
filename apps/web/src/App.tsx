import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Clock3,LockKeyhole,PanelLeftClose} from 'lucide-react';
import type {RegisteredProject,WorkflowDetailResponse,WorkspaceResponse} from '@renvarel/architect-core';
import {api,APIError} from './api';
import {ProjectSidebar} from './projects/ProjectSidebar';
import {ProjectOverview} from './projects/ProjectOverview';
import {ProjectEditor,type EditorTarget} from './projects/ProjectEditor';
import {ProjectManagement} from './projects/ProjectManagement';
import {WorkspaceView} from './projects/WorkspaceView';
import {WorkflowCanvas} from './workflows/WorkflowCanvas';
import {WorkflowInspector,type ProposalDraft} from './workflows/WorkflowInspector';
import {useWorkflowNavigation} from './workflows/useWorkflowNavigation';

type View = 'workspace'|'overview'|'workflow';
export default function App() {
  const [workspace,setWorkspace]=useState<WorkspaceResponse|null>(null);
  const [projectId,setProjectId]=useState('sample-calculator');
  const [view,setView]=useState<View>('workflow');
  const [projectTab,setProjectTab]=useState<'overview'|'workflows'>('overview');
  const [detail,setDetail]=useState<WorkflowDetailResponse|null>(null);
  const [error,setError]=useState('');
  const [workflowError,setWorkflowError]=useState('');
  const [denied,setDenied]=useState(false);
  const [sidebar,setSidebar]=useState(true);
  const [list,setList]=useState(false);
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 860px)').matches);
  const [editor,setEditor]=useState<EditorTarget|null>(null);
  const [management,setManagement]=useState(false);
  const [refreshToken,setRefreshToken]=useState(0);
  const [drafts,setDrafts]=useState<Record<string,ProposalDraft>>({});
  const navigation=useWorkflowNavigation();
  const workflowId=view==='workflow'&&navigation.current?.projectId===projectId?navigation.current.workflowId:'';
  const activeWorkflow=useRef(workflowId);activeWorkflow.current=workflowId;
  const detailRequest=useRef(0);
  const workspaceRequest=useRef(0);
  const workspaceDenied=useRef(false);
  const project=workspace?.projects.find(value=>value.id===projectId);

  const refreshWorkspace=useCallback(async():Promise<void>=>{
    const id=++workspaceRequest.current;
    try{
      const result=await api.workspace();
      if(id!==workspaceRequest.current)return;
      setWorkspace(result);setError('');workspaceDenied.current=false;
    }catch(reason){
      if(id!==workspaceRequest.current)return;
      setError(reason instanceof Error?reason.message:String(reason));
      workspaceDenied.current=reason instanceof APIError&&(reason.status===403||reason.status===404);
    }
  },[]);
  const refreshWorkflow=useCallback(async(id:string,signal?:AbortSignal):Promise<void>=>{
    const request=++detailRequest.current;
    try{
      const result=await api.workflow(id,signal);
      if(request!==detailRequest.current||activeWorkflow.current!==id||signal?.aborted)return;
      setDetail(result);setWorkflowError('');setDenied(false);
    }catch(reason){
      if(request!==detailRequest.current||activeWorkflow.current!==id||signal?.aborted)return;
      const inaccessible=reason instanceof APIError&&(reason.status===403||reason.status===404);
      setDenied(inaccessible);if(inaccessible)setDetail(null);
      setWorkflowError(reason instanceof Error?reason.message:String(reason));
    }
  },[]);
  useEffect(()=>{
    void refreshWorkspace();
    const timer=window.setInterval(()=>{if(!workspaceDenied.current)void refreshWorkspace();},15000);
    return()=>{++workspaceRequest.current;window.clearInterval(timer);};
  },[refreshWorkspace]);
  useEffect(()=>{
    const media=window.matchMedia('(max-width: 860px)');
    const changed=():void=>setMobile(media.matches);
    media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);
  },[]);
  useEffect(()=>{
    if(!workspace||workspace.projects.some(value=>value.id===projectId))return;
    setProjectId(workspace.projects[0]?.id??'');setView(workspace.projects.length?'overview':'workspace');
    navigation.clear();setDetail(null);
  },[workspace,projectId,navigation.clear]);
  useEffect(()=>{
    setDetail(null);setWorkflowError('');setDenied(false);
    const abort=new AbortController();
    if(workflowId)void refreshWorkflow(workflowId,abort.signal);
    return()=>{abort.abort();++detailRequest.current;};
  },[workflowId,refreshWorkflow]);
  useEffect(()=>{
    if(!workflowId||denied)return;
    const abort=new AbortController();
    const timer=window.setInterval(()=>void refreshWorkflow(workflowId,abort.signal),15000);
    return()=>{abort.abort();window.clearInterval(timer);};
  },[workflowId,denied,refreshWorkflow]);
  const workflow=detail?.workflow.id===workflowId?detail.workflow:null;
  const chosen=workflow?.steps.find(step=>step.id===navigation.current?.stepId)??workflow?.steps[0]??null;
  useEffect(()=>{
    if(workflow&&chosen&&navigation.current&&(navigation.current.stepId!==chosen.id||navigation.current.name!==workflow.name)){
      navigation.update({stepId:chosen.id,name:workflow.name});
    }
  },[workflow?.id,workflow?.name,chosen?.id,navigation.current?.stepId,navigation.current?.name,navigation.update]);
  function selectProject(id:string):void {
    setProjectId(id);setView('overview');setProjectTab('overview');navigation.clear();setDetail(null);setList(false);
  }
  function openWorkflow(id:string,name:string,itemId:string|null):void {
    const retained=navigation.current?.workflowId===id&&navigation.current.projectId===projectId&&navigation.current.itemId===itemId?navigation.current:null;
    navigation.open(retained??{projectId,itemId,workflowId:id,name,stepId:''});setView('workflow');setList(false);
  }
  async function saved(result:{project?:RegisteredProject;workflow?:WorkflowDetailResponse['workflow'];itemId?:string|null}):Promise<void> {
    setEditor(null);setRefreshToken(value=>value+1);await refreshWorkspace();
    if(result.project){
      setProjectId(result.project.id);
      if(editor?.kind==='project'){setView('overview');navigation.clear();}
    }
    if(result.workflow)openWorkflow(result.workflow.id,result.workflow.name,result.itemId??null);
  }
  const draftKey=chosen&&workflow?`${projectId}|${navigation.current?.itemId??''}|${workflow.id}|${chosen.id}`:'';
  const draft=draftKey&&drafts[draftKey]?drafts[draftKey]:{
    message:'',rules:chosen?.rules.join('\n')??'',explanation:'',baseRevision:workflow?.revision??1,dirty:false,
  };
  return <div className="app-shell">
    <header className="topbar"><div className="brand-logo">S<span>V</span></div>
      <button className="icon-button" onClick={()=>setSidebar(value=>!value)} title="Toggle projects sidebar" aria-label="Toggle projects sidebar" aria-expanded={sidebar}><PanelLeftClose size={17}/></button>
      <div className="brand-copy"><b>Sovrad</b><span>by Renvarel</span></div><div className="topbar-spacer"/>
      <span className="small-status">Local workspace</span><span className="privacy-pill"><LockKeyhole size={13}/>Private project data</span>
    </header>
    <div className="workspace">
      {sidebar&&<ProjectSidebar workspace={workspace} selected={view==='workspace'?'':projectId} onSelect={selectProject}
        onWorkspace={()=>setView('workspace')} onAdd={()=>setEditor({kind:'project'})} onManage={()=>setManagement(true)}/>}
      <div className="project-area">
        {error&&<div className="error" role="alert">{error}<button className="secondary-button" onClick={()=>void refreshWorkspace()}>Refresh workspace</button></div>}
        {!workspace&&<div className="loading-view" role="status">Loading workspace…</div>}
        {workspace&&view==='workspace'&&<WorkspaceView workspace={workspace} onSelect={selectProject}/>}
        {workspace&&view!=='workspace'&&project&&<>
          <div className="project-page-head"><nav className="crumb" aria-label="Breadcrumb"><button className="text-button" onClick={()=>setView('workspace')}>Projects</button><span>/</span>
            <button className="text-button" onClick={()=>setView('overview')}>{project.name}</button>
            {view==='workflow'&&navigation.frames.map((frame,index)=><span key={`${frame.workflowId}:${index}`}>/ {frame.name}</span>)}</nav>
            <div className="title-row"><div><h1>{view==='workflow'?(workflow&&workflow.name===chosen?.title?`${workflow.name} workflow`:workflow?.name??navigation.current?.name??'Workflow'):project.name}</h1>
              <p>{view==='workflow'?(workflow?.description??'Loading selected workflow…'):(project.description||'No description yet.')}</p></div>
              {view==='workflow'&&<div className="rev-pill"><Clock3 size={15}/>Revision {workflow?.revision??'—'}</div>}</div>
            <nav className="project-tabs" aria-label="Project views">
              <button className={view==='overview'&&projectTab==='overview'?'active':''} onClick={()=>{setView('overview');setProjectTab('overview');}}>Overview</button>
              <button className={view==='workflow'||projectTab==='workflows'?'active':''} onClick={()=>{setView('overview');setProjectTab('workflows');}}>Workflows</button>
              <button disabled title="Work tracking is not available yet">Work & results</button><button disabled title="Decision controls are not available yet">Decisions</button><button disabled title="Activity is not available yet">Activity</button>
            </nav>
          </div>
          <ProjectOverview key={projectId} projectId={projectId} active={view==='overview'} workflowTab={projectTab==='workflows'}
            refreshToken={refreshToken} onOpen={openWorkflow} onEdit={setEditor}/>
          {view==='workflow'&&<>
            <div className="workflow-backline">{navigation.frames.length>1?<button className="secondary-button" onClick={navigation.back}><ArrowLeft size={14}/>Back to {navigation.frames.at(-2)?.name}</button>:
              <button className="secondary-button" onClick={()=>setView('overview')}><ArrowLeft size={14}/>Back to project</button>}
              <span className="grow"/>{!mobile&&<button className="secondary-button" onClick={()=>setList(value=>!value)}>{list?'Graph view':'List view'}</button>}</div>
            {workflowError&&<div className="error" role="alert">{workflowError}{!denied&&<button className="secondary-button" onClick={()=>void refreshWorkflow(workflowId)}>Retry workflow</button>}</div>}
            {denied&&<div className="empty-state"><h2>Workflow access unavailable</h2><p>Return to the project or manage access. Unsaved drafts remain in this session.</p></div>}
            {workflow&&detail&&chosen&&<div className={`workflow-layout ${mobile||list?'list-layout':''}`}>
              <main className="main"><div className="canvas-toolbar"><span>Workflow canvas</span><span>{mobile||list?'Select a stage to inspect its rules':'Drag to pan · Zoom or fit with the controls'}</span></div>
                <WorkflowCanvas key={`${projectId}|${navigation.current?.itemId??''}|${workflow.id}`} workflow={workflow} layout={detail.layout} verification={detail.stepVerification} selected={chosen.id}
                  viewport={navigation.current?.viewport} list={list} mobile={mobile} onSelect={id=>navigation.update({stepId:id})} onViewport={viewport=>navigation.update({viewport})}/>
                <div className="workflow-caption">Specification map · Source {project.sourceState} · No implementation is started by opening a map.</div>
              </main>
              <WorkflowInspector key={draftKey} workflow={workflow} step={chosen} verification={detail.stepVerification.find(value=>value.stepId===chosen.id)}
                proposals={detail.proposals} draft={draft} onDraft={value=>setDrafts(previous=>({...previous,[draftKey]:value}))}
                onRefresh={()=>refreshWorkflow(workflow.id)} onChild={id=>navigation.child(id,'Child workflow')} onSelect={id=>navigation.update({stepId:id})}/>
            </div>}
            {!workflow&&!workflowError&&<p className="loading-view" role="status">Loading workflow…</p>}
          </>}
        </>}
      </div>
    </div>
    {editor&&<ProjectEditor key={`${editor.kind}:${'item' in editor?editor.item?.id??'new':''}`} target={editor} onClose={()=>setEditor(null)} onSaved={result=>void saved(result)}/>}
    {management&&<ProjectManagement onClose={()=>setManagement(false)} onChanged={async()=>{setRefreshToken(value=>value+1);await refreshWorkspace();}}/>}
  </div>;
}
