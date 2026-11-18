import type {RegisteredProject,WorkspaceResponse} from '@renvarel/architect-core';
import {ConnectionPanel} from '../connections/ConnectionPanel';
import {workStateLabel} from '../work-items/WorkDetail';

export function WorkspaceView({workspace,onSelect,onAnnotate,onChanged}:{workspace:WorkspaceResponse;onSelect:(id:string)=>void;onAnnotate:(project:RegisteredProject)=>void;onChanged:()=>Promise<void>}) {
  return <main className="overview workspace-overview"><div className="page-heading"><h1>Your workspace</h1><p>Projects explicitly registered in Sovrad.</p></div>
    <section aria-label="Work summary" className="summary-counts">{Object.entries(workspace.counts).map(([state,count])=><span key={state} data-work-state={state}>{workStateLabel(state as Parameters<typeof workStateLabel>[0])}: {count}</span>)}</section>
    <ConnectionPanel connections={workspace.connections} onChanged={onChanged}/>
    <h2>Projects</h2><div className="feature-grid">{workspace.projects.map(project=><article className="feature" key={project.id}>
      <h3>{project.name}</h3><p>{project.description||'No description yet.'}</p><span>{project.grant==='planning_only'?'Planning only':project.grant==='read_only'?'Read only':'Synthetic execution grant'}</span>
      <span className="verification-badge">Source {project.sourceState}</span>
      <div className="item-actions"><button className="secondary-button" onClick={()=>onSelect(project.id)}>Open {project.name}</button>
        <button className="secondary-button" onClick={()=>onAnnotate(project)}>Annotate {project.name}</button></div>
    </article>)}</div>
    {!workspace.projects.length&&<p className="empty-state">Create a planning project or choose a registered project in Manage projects.</p>}
    <p className="helper">Local annotations, decisions and work history remain attached to their project context.</p>
  </main>;
}
