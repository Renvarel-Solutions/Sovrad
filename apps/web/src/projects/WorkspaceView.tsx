import type {RegisteredProject,WorkspaceResponse} from '@renvarel/architect-core';

export function WorkspaceView({workspace,onSelect,onAnnotate}:{workspace:WorkspaceResponse;onSelect:(id:string)=>void;onAnnotate:(project:RegisteredProject)=>void}) {
  return <main className="overview workspace-overview"><div className="page-heading"><h1>Your workspace</h1><p>Projects explicitly registered in Sovrad.</p></div>
    <section className="lead-strip"><h2>Agent connections</h2><p>Planning and specification review are available locally. Connected work is not available in this preview.</p>
      {workspace.connections.map(connection=><div className="connection-row" key={connection.id}><b>{connection.target==='codex'?'Codex':'ChatGPT'}</b><span>{connection.state.replaceAll('_',' ')}</span><p>{connection.reason}</p></div>)}
      {!workspace.connections.length&&<p>No agent connection is available.</p>}
    </section>
    <h2>Projects</h2><div className="feature-grid">{workspace.projects.map(project=><article className="feature" key={project.id}>
      <h3>{project.name}</h3><p>{project.description||'No description yet.'}</p><span>{project.grant==='planning_only'?'Planning only':project.grant==='read_only'?'Read only':'Synthetic execution grant'}</span>
      <span className="verification-badge">Source {project.sourceState}</span>
      <div className="item-actions"><button className="secondary-button" onClick={()=>onSelect(project.id)}>Open {project.name}</button>
        <button className="secondary-button" onClick={()=>onAnnotate(project)}>Annotate {project.name}</button></div>
    </article>)}</div>
    {!workspace.projects.length&&<p className="empty-state">Create a planning project or choose a registered project in Manage projects.</p>}
    <p className="helper">Local annotations and their work history are available within each project. Decision and activity controls are not available yet.</p>
  </main>;
}
