import {useMemo,useState} from 'react';
import type {DevelopmentState,OverviewFilter,ProjectItem,RegisteredProject} from '@renvarel/architect-core';
import {useProjectOverview} from './useProjectOverview';
import type {EditorTarget} from './ProjectEditor';
import {verificationLabel} from '../workflows/WorkflowList';

export const developmentLabels:Record<DevelopmentState,string>={planning:'Planning',implementation:'Being implemented',future:'Future scope',implemented:'Implemented'};
export function ProjectOverview({projectId,active,workflowTab,refreshToken,onOpen,onEdit}:{
  projectId:string;active:boolean;workflowTab:boolean;refreshToken:number;
  onOpen:(workflowId:string,name:string,itemId:string|null)=>void;onEdit:(target:EditorTarget)=>void;
}) {
  const [query,setQuery]=useState('');
  const [development,setDevelopment]=useState<DevelopmentState|''>('');
  const filter=useMemo<OverviewFilter>(()=>({q:query,...(development?{development}:{})}),[query,development]);
  const {data,loading,error,notice,unavailable,complete,load,cancel}=useProjectOverview(projectId,filter,refreshToken);
  const project=data?.project;
  function editItem(item?:ProjectItem):void {
    if(project&&data)onEdit({kind:'item',project,item,items:data.items,complete});
  }
  return <section className="overview" hidden={!active} aria-label="Project overview">
    {notice&&<p className="notice" role="status">{notice}</p>}
    {error&&<div className="error" role="alert">{error}{!unavailable&&<button className="secondary-button" onClick={()=>void load(Boolean(data?.page.nextCursor))}>Retry loading</button>}</div>}
    {unavailable&&<div className="empty-state"><h2>Project access removed</h2><p>Choose another project or update access in Manage projects. Unsaved drafts remain in this session.</p></div>}
    {project&&data&&<>
      <div className="project-context"><span className="development-badge">{grantLabel(project)}</span><span className="verification-badge">Source {project.sourceState}</span>
        <span className="verification-badge">{verificationLabel(data.totals.verification)}</span>
        <button className="secondary-button" onClick={()=>onEdit({kind:'settings',project})}>Edit project</button></div>
      <p className="helper">{project.sourceState==='unmapped'?'Source is unmapped. This planning map does not establish source coverage.':'Source status is reported by the registry. Checked behavior needs separate evidence.'}</p>
      <div className="summary-counts" aria-label="Complete filtered totals">
        {Object.entries(data.totals.counts).map(([state,count])=><span key={state}>{developmentLabels[state as DevelopmentState]}: <b>{count}</b></span>)}
        <span>Not yet checked steps: <b>{data.totals.verificationCounts.not_checked}</b></span>
      </div>
      <div className="overview-heading"><h2>{workflowTab?'Workflows':'Modules & features'}</h2><div className="load-actions">
        <button className="secondary-button" onClick={()=>editItem()}>Add item</button>
        <button className="secondary-button" onClick={()=>onEdit({kind:'workflow',project,item:null})}>Add workflow</button>
      </div></div>
    </>}
    {!unavailable&&<div className="project-filters"><label className="search-label">Search project<input aria-label="Search project" maxLength={100} value={query} placeholder="Find a module, feature or workflow" onChange={event=>setQuery(event.target.value)}/></label>
        <label>Development filter<select aria-label="Development filter" value={development} onChange={event=>setDevelopment(event.target.value as DevelopmentState|'')}>
          <option value="">All development stages</option>{Object.entries(developmentLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label></div>}
    {project&&data&&<>
      <p className="list-scope" aria-live="polite">Showing {data.items.length} of {data.totals.items} items / {data.workflows.length} of {data.totals.workflows} workflows</p>
      <p className="helper">Counts above cover the complete matching list. The rows below contain loaded pages.</p>
      {!workflowTab&&<div className="feature-grid">{data.items.map(item=>{
        const parent=item.parentId?data.items.find(value=>value.id===item.parentId):null;
        const dependencies=data.dependencies.filter(edge=>edge.sourceItemId===item.id);
        const mapped=data.workflows.find(value=>value.id===item.workflowId);
        const statuses=new Set(mapped?.stepVerification.map(value=>value.verification));
        const checkLabel=mapped&&statuses.size===1?verificationLabel(mapped.stepVerification[0].verification):mapped?'Mixed check states':item.workflowId?'Verification not loaded':'Map not linked';
        return <article className="feature" key={item.id} data-item-id={item.id}>
          <span className="scope-tag">{item.kind}</span><h3>{item.name}</h3><p>{item.description||'No description yet.'}</p>
          <div className="feature-bottom"><span className="development-badge">{developmentLabels[item.development]}</span><span className="verification-badge">{checkLabel}</span></div>
          {item.parentId&&<p className="relationship">Parent: {parent?.name||'Not loaded yet'}</p>}
          {dependencies.map(edge=><p className="relationship" key={edge.targetItemId}>Depends on: {data.items.find(value=>value.id===edge.targetItemId)?.name||'Not loaded yet'}</p>)}
          <div className="item-actions"><button className="secondary-button" onClick={()=>editItem(item)}>Edit item</button>
            {item.workflowId?<button className="secondary-button" onClick={()=>onOpen(item.workflowId!,mapped?.name??item.name,item.id)}>Open workflow</button>:
              <button className="secondary-button" onClick={()=>onEdit({kind:'workflow',project,item})}>Create workflow</button>}</div>
        </article>;
      })}</div>}
      {!data.items.length&&!workflowTab&&<div className="empty-state"><b>No matching items</b><p>{query||development?'Try another search or development stage.':'Add a module or feature to start this planning map.'}</p></div>}
      <div className="workflow-summaries"><h2>Workflow maps</h2>{data.workflows.map(workflow=><div className="workflow-summary" key={workflow.id}>
        <div><h3>{workflow.name}</h3><p>{workflow.description||'No description yet.'}</p>
          <span className="verification-badge">{workflow.stepVerification.length} stages · {workflow.stepVerification.filter(step=>step.verification==='not_checked').length} not yet checked</span></div>
        <button className="secondary-button" aria-label={`Open ${workflow.name}`} onClick={()=>onOpen(workflow.id,workflow.name,null)}>Open workflow</button>
      </div>)}{!data.workflows.length&&<p className="helper">No matching workflow maps. Unmapped behavior remains unknown.</p>}</div>
      <div className="load-actions" aria-live="polite">{loading?<button className="secondary-button" onClick={cancel}>Cancel loading</button>:<>
        {data.page.nextCursor&&<><button className="secondary-button" onClick={()=>void load(true)}>Load more</button><button className="secondary-button" onClick={()=>void load(true,true)}>Load all</button></>}
        {complete?<span>Complete list loaded</span>:<span>List incomplete</span>}
      </>}</div>
    </>}
    {!data&&loading&&<p className="loading-view" role="status">Loading project…</p>}
  </section>;
}
export function grantLabel(project:RegisteredProject):string {
  return project.grant==='planning_only'?'Planning only':project.grant==='read_only'?'Read only':'Synthetic execution grant';
}
