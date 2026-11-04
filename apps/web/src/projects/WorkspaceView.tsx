import type {WorkspaceResponse} from '@renvarel/architect-core';

export function WorkspaceView({workspace,onSelect}:{workspace:WorkspaceResponse;onSelect:(id:string)=>void}) {
  return <main className="overview workspace-overview"><div className="page-heading"><h1>Your workspace</h1><p>Projects explicitly registered in Sovrad.</p></div>
    <section className="lead-strip"><h2>Agent connections</h2><p>Planning and specification review are available locally. Connected work is not available in this preview.</p>
      {workspace.connections.map(connection=><div className="connection-row" key={connection.id}><b>{connection.target==='codex'?'Codex':'ChatGPT'}</b><span>{connection.state.replaceAll('_',' ')}</span><p>{connection.reason}</p></div>)}
      {!workspace.connections.length&&<p>No agent connection is available.</p>}
    </section>
    <h2>Projects</h2><div className="feature-grid">{workspace.projects.map(project=><button className="feature" key={project.id} onClick={()=>onSelect(project.id)}>
      <h3>{project.name}</h3><p>{project.description||'No description yet.'}</p><span>{project.grant==='planning_only'?'Planning only':project.grant==='read_only'?'Read only':'Synthetic execution grant'}</span>
      <span className="verification-badge">Source {project.sourceState}</span>
    </button>)}</div>
    {!workspace.projects.length&&<p className="empty-state">Create a planning project or choose a registered project in Manage projects.</p>}
    <p className="helper">Work, annotations, decisions and activity controls will become available when their controllers are implemented.</p>
  </main>;
}
