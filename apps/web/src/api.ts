import type {
  AccessPreference, OverviewFilter, OverviewResponse, ProjectCreateInput, ProjectItem,
  ProjectItemCreateInput, ProjectItemEditInput, ProjectSettingsInput, Proposal,
  RegisteredProject, Workflow, WorkflowCreateInput, WorkflowDetailResponse, WorkspaceQuery, WorkspaceResponse,
} from '@renvarel/architect-core';

export class APIError extends Error {
  constructor(message:string, readonly status:number, readonly code?:string) { super(message); }
}

async function request<T>(path:string, options?:RequestInit):Promise<T> {
  const response=await fetch('/api'+path,options);
  const data:unknown=await response.json();
  if(!response.ok) {
    const message=typeof data==='object'&&data!==null&&'error' in data?String(data.error):`Request failed (${response.status})`;
    throw new APIError(message,response.status,typeof data==='object' && data!==null && 'code' in data ? String(data.code) : undefined);
  }
  return data as T;
}
const postOptions=(body:unknown):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json','X-Sovrad-Action':'1'},body:JSON.stringify(body)});
function query(input:object):string {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(input)) if (value!==undefined && value!=='') params.set(key,String(value));
  return params.size ? '?'+params.toString() : '';
}
export const api={
  aiStatus:()=>request<{configured:boolean;model:string;limitMicros:number;remainingMicros:number;reservedMicros:number;spentMicros:number;paused:boolean;dailyAttempts:number}>('/ai/status'),
  health:()=>request<{ok:boolean;mode:string;aiConfigured:boolean}>('/health'),
  workspace:(input:WorkspaceQuery={},signal?:AbortSignal)=>request<WorkspaceResponse>('/workspace'+query(input),{signal}),
  access:(input:AccessPreference)=>request<{access:AccessPreference}>('/workspace/access',postOptions(input)),
  createProject:(input:ProjectCreateInput)=>request<{project:RegisteredProject}>('/projects',postOptions(input)),
  settings:(id:string,input:ProjectSettingsInput)=>request<{project:RegisteredProject}>(`/projects/${encodeURIComponent(id)}/settings`,postOptions(input)),
  overview:(id:string,input:OverviewFilter={},signal?:AbortSignal)=>request<OverviewResponse>(`/projects/${encodeURIComponent(id)}/overview`+query(input),{signal}),
  createItem:(id:string,input:ProjectItemCreateInput)=>request<{item:ProjectItem}>(`/projects/${encodeURIComponent(id)}/items`,postOptions(input)),
  editItem:(id:string,itemId:string,input:ProjectItemEditInput)=>request<{item:ProjectItem}>(`/projects/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,postOptions(input)),
  createWorkflow:(id:string,input:WorkflowCreateInput)=>request<{workflow:Workflow}>(`/projects/${encodeURIComponent(id)}/workflows`,postOptions(input)),
  workflow:(id:string,signal?:AbortSignal)=>request<WorkflowDetailResponse>(`/workflows/${encodeURIComponent(id)}`,{signal}),
  manualProposal:(body:{workflowId:string;stepId:string;baseRevision:number;text:string;proposedRules:string[];explanation:string})=>request<{proposal:Proposal}>('/proposals',postOptions(body)),
  aiProposal:(body:{workflowId:string;stepId:string;baseRevision:number;text:string;sendToAI:true})=>request<{proposal:Proposal}>('/ai/proposal',postOptions(body)),
  decide:(id:string,action:'approve'|'reject')=>request<{proposal:Proposal;workflow:Workflow}>(`/proposals/${encodeURIComponent(id)}/decision`,postOptions({action}))
};
