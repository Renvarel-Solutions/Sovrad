import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Clock3,LockKeyhole,PanelLeftClose} from 'lucide-react';
import type {Decision,RegisteredProject,WorkflowDetailResponse,WorkspaceResponse} from '@renvarel/architect-core';
import {api,APIError} from './api';
import {ProjectSidebar} from './projects/ProjectSidebar';
import {ProjectOverview} from './projects/ProjectOverview';
import {ProjectEditor,type EditorTarget} from './projects/ProjectEditor';
import {ProjectManagement} from './projects/ProjectManagement';
import {WorkspaceView} from './projects/WorkspaceView';
import {WorkflowCanvas} from './workflows/WorkflowCanvas';
import {WorkflowInspector,type ProposalDraft} from './workflows/WorkflowInspector';
import {useWorkflowNavigation} from './workflows/useWorkflowNavigation';
import {AnnotationComposer,type AnnotationTarget} from './annotations/AnnotationComposer';
import {WorkCenter} from './work-items/WorkCenter';
import {DecisionCenter,type DecisionTarget} from './decisions/DecisionCenter';

type View = 'workspace'|'overview'|'workflow'|'work'|'decisions';
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
  const [annotationTarget,setAnnotationTarget]=useState<AnnotationTarget|null>(null);
  const [annotationNotice,setAnnotationNotice]=useState('');
  const [decisionTarget,setDecisionTarget]=useState<DecisionTarget|null>(null);
  const [decisionDrafts,setDecisionDrafts]=useState<Record<string,{projectId:string;value:string}>>({});
  const navigation=useWorkflowNavigation();
  const workflowId=view==='workflow'&&navigation.current?.projectId===projectId?navigation.current.workflowId:'';
  const activeWorkflow=useRef(workflowId);activeWorkflow.current=workflowId;
  const detailRequest=useRef(0);
  const workspaceRequest=useRef(0);
  const workspaceDenied=useRef(false);
  const project=workspace?.projects.find(value=>value.id===projectId);
  const visibleProjectIds=workspace?.projects.map(value=>value.id)??[];
  const visibilityKey=JSON.stringify(visibleProjectIds);
  useEffect(()=>{
    if(!workspace)return;
    const allowed=new Set(visibleProjectIds);
    setDecisionDrafts(previous=>{
      const retained=Object.entries(previous).filter(([,draft])=>allowed.has(draft.projectId));
      return retained.length===Object.keys(previous).length?previous:Object.fromEntries(retained);
    });
    setDecisionTarget(previous=>{
      if(!previous)return previous;
      if(previous.scope.projectId&&!allowed.has(previous.scope.projectId))return null;
      if(previous.decision&&!allowed.has(previous.decision.projectId))return {scope:previous.scope};
      return previous;
    });
  },[visibilityKey]);
  useEffect(()=>{void api.bootstrapSession().catch(()=>{});},[]);

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
    const timer=window.setInterval(()=>{if(!workspaceDenied.current)void refreshWorkspace();},5000);
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
    const timer=window.setInterval(()=>void refreshWorkflow(workflowId,abort.signal),5000);
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
    setDecisionTarget(null);
    setProjectId(id);setView('overview');setProjectTab('overview');navigation.clear();setDetail(null);setList(false);
  }
  function openWorkflow(id:string,name:string,itemId:string|null):void {
    setDecisionTarget(null);
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
  function openDecision(decision:Decision):void {
    setDecisionTarget({scope:{projectId:decision.projectId,workflowId:decision.context.workflowId,stepId:decision.context.stepId},decision});
  }
  function forgetDecision(projectId:string,decisionId?:string):void {
    setDecisionDrafts(previous=>Object.fromEntries(Object.entries(previous).filter(([id,draft])=>decisionId?id!==decisionId:draft.projectId!==projectId)));
    setDecisionTarget(previous=>{
      if(!previous)return previous;
      if(!decisionId&&previous.scope.projectId===projectId)return null;
      if(previous.decision&&(decisionId?previous.decision.id===decisionId:previous.decision.projectId===projectId))return {scope:previous.scope};
      return previous;
    });
  }
  async function experienceChanged():Promise<void> {
    await refreshWorkspace();setRefreshToken(value=>value+1);
    if(activeWorkflow.current)await refreshWorkflow(activeWorkflow.current);
  }
  function projectView(next:View):void {setDecisionTarget(null);setView(next);}
  function annotate(scope:'project'|'workflow'|'step'):void {
    if(!project)return;
    setAnnotationTarget({text:scope==='step'?draft.message:'',context:{projectId:project.id,mapRevision:project.mapRevision,
      ...(scope!=='project'&&workflow?{workflowId:workflow.id,specRevision:workflow.revision,
        ...(navigation.current?.itemId?{itemId:navigation.current.itemId}:{})}:{}),
      ...(scope==='step'&&chosen?{stepId:chosen.id}:{}),
    }});
  }
  return <div className="app-shell">
    <header className="topbar"><div className="brand-logo">S<span>V</span></div>
      <button className="icon-button" onClick={()=>setSidebar(value=>!value)} title="Toggle projects sidebar" aria-label="Toggle projects sidebar" aria-expanded={sidebar}><PanelLeftClose size={17}/></button>
      <div className="brand-copy"><b>Sovrad</b><span>by Renvarel</span></div><div className="topbar-spacer"/>
      <button className="secondary-button global-decision-count" onClick={()=>{setDecisionTarget({scope:{}});setView('decisions');}}>Needs your decision {workspace?.pendingDecisionCount??0}</button>
      <span className="small-status">Local workspace</span><span className="privacy-pill"><LockKeyhole size={13}/>Private project data</span>
    </header>
    <div className="workspace">
      {sidebar&&<ProjectSidebar workspace={workspace} selected={view==='workspace'?'':projectId} onSelect={selectProject}
        onWorkspace={()=>projectView('workspace')} onAdd={()=>setEditor({kind:'project'})} onManage={()=>setManagement(true)}/>}
      <div className="project-area">
        {error&&<div className="error" role="alert">{error}<button className="secondary-button" onClick={()=>void refreshWorkspace()}>Refresh workspace</button></div>}
        {annotationNotice&&<div className="notice annotation-saved" role="status">{annotationNotice}<button className="text-button" onClick={()=>setAnnotationNotice('')}>Dismiss</button></div>}
        {!workspace&&<div className="loading-view" role="status">Loading workspace…</div>}
        {workspace&&view==='workspace'&&<WorkspaceView workspace={workspace} onChanged={experienceChanged} onSelect={selectProject} onAnnotate={value=>setAnnotationTarget({
          text:'',context:{projectId:value.id,mapRevision:value.mapRevision},
        })}/>}
        {workspace&&view!=='workspace'&&project&&<>
          <div className="project-page-head"><nav className="crumb" aria-label="Breadcrumb"><button className="text-button" onClick={()=>setView('workspace')}>Projects</button><span>/</span>
            <button className="text-button" onClick={()=>setView('overview')}>{project.name}</button>
            {view==='workflow'&&navigation.frames.map((frame,index)=><span key={`${frame.workflowId}:${index}`}>/ {frame.name}</span>)}</nav>
            <div className="title-row"><div><h1>{view==='workflow'?(workflow&&workflow.name===chosen?.title?`${workflow.name} workflow`:workflow?.name??navigation.current?.name??'Workflow'):project.name}</h1>
              <p>{view==='workflow'?(workflow?.description??'Loading selected workflow…'):(project.description||'No description yet.')}</p></div>
              <div className="item-actions"><button className="secondary-button" onClick={()=>annotate('project')}>Annotate project</button>
                {view==='workflow'&&<><button className="secondary-button" disabled={!workflow} onClick={()=>annotate('workflow')}>Annotate workflow</button>
                  <div className="rev-pill"><Clock3 size={15}/>Revision {workflow?.revision??'—'}</div></>}</div></div>
            <nav className="project-tabs" aria-label="Project views">
              <button className={view==='overview'&&projectTab==='overview'?'active':''} onClick={()=>{projectView('overview');setProjectTab('overview');}}>Overview</button>
              <button className={view==='workflow'||(view==='overview'&&projectTab==='workflows')?'active':''} onClick={()=>{projectView('overview');setProjectTab('workflows');}}>Workflows</button>
              <button className={view==='work'?'active':''} onClick={()=>projectView('work')}>Work & results</button><button onClick={()=>{setView('decisions');setDecisionTarget({scope:{projectId}});}}>Decisions</button><button disabled title="Activity is not available yet">Activity</button>
            </nav>
          </div>
          <ProjectOverview key={`overview:${projectId}`} projectId={projectId} active={view==='overview'} workflowTab={projectTab==='workflows'}
            refreshToken={refreshToken} onOpen={openWorkflow} onEdit={setEditor} onDecisions={()=>{setView('decisions');setDecisionTarget({scope:{projectId}});}}/>
          {view==='work'&&<WorkCenter key={`work:${projectId}`} projectId={projectId} refreshToken={refreshToken}
            onDecision={openDecision}
            onAmend={value=>setAnnotationTarget({context:value.annotation.context,text:value.annotation.text,annotation:value.annotation,work:value.work})}/>}
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
                onRefresh={()=>refreshWorkflow(workflow.id)} onChild={id=>navigation.child(id,'Child workflow')} onSelect={id=>navigation.update({stepId:id})} onAnnotate={()=>annotate('step')}
                onDecision={openDecision} onDecisions={()=>setDecisionTarget({scope:{projectId,workflowId:workflow.id,stepId:chosen.id}})}/>
            </div>}
            {!workflow&&!workflowError&&<p className="loading-view" role="status">Loading workflow…</p>}
          </>}
        </>}
        {decisionTarget&&<DecisionCenter target={decisionTarget} projectIds={visibleProjectIds} drafts={Object.fromEntries(Object.entries(decisionDrafts).map(([id,draft])=>[id,draft.value]))}
          onSelection={decision=>setDecisionTarget(previous=>previous?{scope:previous.scope,decision:decision??undefined}:previous)} onForget={forgetDecision}
          onDraft={(decision,value)=>setDecisionDrafts(previous=>({...previous,[decision.id]:{projectId:decision.projectId,value}}))}
          onChanged={experienceChanged} onClose={()=>{setDecisionTarget(null);if(view==='decisions')setView(project?'overview':'workspace');}}/>}
      </div>
    </div>
    {editor&&<ProjectEditor key={`${editor.kind}:${'item' in editor?editor.item?.id??'new':''}`} target={editor} onClose={()=>setEditor(null)} onSaved={result=>void saved(result)}/>}
    {management&&<ProjectManagement onClose={()=>setManagement(false)} onChanged={async()=>{setRefreshToken(value=>value+1);await refreshWorkspace();}}/>}
    {annotationTarget&&<AnnotationComposer target={annotationTarget} onClose={()=>setAnnotationTarget(null)} onSaved={result=>{
      setAnnotationTarget(null);setRefreshToken(value=>value+1);void refreshWorkspace();
      setAnnotationNotice(result.annotation.dispatch.mode==='local'?'Annotation kept in Sovrad. View its original text and history in Work & results.':
        'Instruction recorded. The agent connection is unavailable; work is blocked. View Work & results for details.');
    }}/>}
  </div>;
}
