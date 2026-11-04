import {FolderGit2,LayoutDashboard,Plus,Settings2} from 'lucide-react';
import type {WorkspaceResponse} from '@renvarel/architect-core';

export function ProjectSidebar({workspace,selected,onSelect,onWorkspace,onAdd,onManage}:{
  workspace:WorkspaceResponse|null;selected:string;onSelect:(id:string)=>void;onWorkspace:()=>void;onAdd:()=>void;onManage:()=>void;
}) {
  return <aside className="sidebar" aria-label="Projects">
    <button className="project-button workspace-button" onClick={onWorkspace}><LayoutDashboard size={17}/>Workspace</button>
    <div className="sidebar-heading"><span>Projects</span><span className="tiny-count">{workspace?.projects.length??'—'}</span></div>
    <p className="sidebar-access">{workspace?.access.mode==='all_connected'?'All connected projects':'Selected-project access'}</p>
    <div className="project-list">{workspace?.projects.map(project=><button key={project.id} onClick={()=>onSelect(project.id)}
      className={`project-button ${selected===project.id?'active':''}`} aria-current={selected===project.id?'page':undefined}>
      <FolderGit2 size={17}/><span>{project.name}</span>
    </button>)}</div>
    {workspace?.projects.length===0&&<p className="helper">No projects selected. Manage access or create a planning project.</p>}
    <div className="sidebar-actions"><button className="secondary-button" onClick={onAdd}><Plus size={14}/>Add project</button>
      <button className="secondary-button" onClick={onManage}><Settings2 size={14}/>Manage projects</button></div>
    <div className="sidebar-spacer"/><div className="sidebar-foot"><p>Registered in Sovrad. Source access and execution are separate permissions.</p></div>
  </aside>;
}
