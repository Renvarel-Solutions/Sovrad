import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {
  CALCULATOR_PROJECT, CALCULATOR_WORKFLOW, NAVIGATION_SAMPLE_PROJECT, NAVIGATION_MAIN_WORKFLOW,
  NAVIGATION_CHILD_WORKFLOW, assertValidWorkflow,
  type AccessPreference, type ContextRef, type LayoutInput, type OverviewFilter, type OverviewResponse,
  type Project, type ProjectCreateInput, type ProjectItem, type ProjectItemCreateInput, type ProjectItemEditInput,
  type ProjectSettingsInput, type RegisteredProject, type RepositoryCandidate, type RepositoryCandidateInput,
  type StepVerification, type Workflow, type WorkflowCreateInput, type WorkflowLayout, type WorkspaceResponse,
  type WorkspaceQuery, type ProjectManagementPage, type ProjectManagementSummary,
  type WorkState,
} from '@renvarel/architect-core';
import {containsPrivateContent} from './privacy.js';
import {projectStepVerification} from './verification-projection.js';
import type {ImplementationTask} from '../../runner/src/index.js';
import {canonicalOverviewFilter, projectViewDigest, ProjectPagination, type ProjectCursorBinding} from './project-pagination.js';

const identity = z.string().min(1).max(100);
const revision = z.number().int().positive();
const name = z.string().min(1).max(100).refine(value => value.trim().length > 0);
const description = z.string().max(2000);
const development = z.enum(['planning', 'implementation', 'future', 'implemented']);
const grant = z.enum(['planning_only', 'read_only', 'synthetic_execute']);
const step = z.object({id: identity, title: name, purpose: description, kind: z.enum(['input','decision','process','output']),
  rules: z.array(z.string().min(1).max(500)).max(20), errorBehavior: description,
  position: z.object({x: z.number().finite(), y: z.number().finite()}).strict(),
  inputs: z.array(z.string().max(500)).max(100).optional(), outputs: z.array(z.string().max(500)).max(100).optional(),
  childWorkflowId: identity.optional()}).strict();
export const projectSchemas = {
  create: z.object({clientRequestId: z.string().uuid(), name, description}).strict(),
  settings: z.object({expectedGrantRevision: revision, name: name.optional(), description: description.optional(),
    archived: z.boolean().optional(), grant: grant.optional()}).strict(),
  itemCreate: z.object({clientRequestId: z.string().uuid(), expectedMapRevision: revision, parentId: identity.nullable(),
    kind: z.enum(['module','feature','workflow']), name, description, development, workflowId: identity.nullable()}).strict(),
  itemEdit: z.object({expectedMapRevision: revision, name, description, development}).strict(),
  workflow: z.object({clientRequestId: z.string().uuid(), expectedMapRevision: revision, itemId: identity.nullable(), name, description,
    steps: z.array(step).min(1).max(100), connections: z.array(z.object({id: identity, source: identity, target: identity,
      label: z.string().max(100).optional()}).strict()).max(200)}).strict(),
  layout: z.object({expectedLayoutRevision: z.number().int().nonnegative(),
    positions: z.array(z.object({stepId: identity, x: z.number().finite(), y: z.number().finite()}).strict()).max(100)}).strict(),
  repository: z.object({clientRequestId: z.string().uuid(), expectedGrantRevision: revision, alias: name,
    absolutePath: z.string().min(1).max(1000).refine(value => !value.includes('\0') && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)))}).strict(),
  access: z.object({mode: z.enum(['selected','all_connected']), selectedProjectIds: z.array(identity).max(1000)}).strict(),
  overview: z.object({projectId: identity.optional(), itemId: identity.optional(), workflowId: identity.optional(), stepId: identity.optional(),
    development: development.optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(2048).optional()}).strict(),
  workspace: z.object({management:z.union([z.literal(true),z.literal('true')]).transform(() => true as const).optional(),
    limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(2048).optional()}).strict()
    .refine(value => value.management === true || (value.limit === undefined && value.cursor === undefined)),
};

export class ProjectError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
type Metadata = Pick<RegisteredProject, 'archived' | 'grant' | 'grantRevision' | 'mapRevision' | 'sourceState'>;
type StorageReader = {workflow(id: string): Workflow | null; workflows(id: string): Workflow[];
  workCounts(projectIds: readonly string[]): Record<WorkState,number>; revokeWork(projectId: string): void};
type WorkflowSummary = OverviewResponse['workflows'][number];
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareIds = (left: {id:string}, right: {id:string}): number => compareText(left.id,right.id);

export class ProjectStore {
  private readonly secrets = new Set<string>();
  constructor(private readonly db: Database.Database, private readonly reader: StorageReader,
    private readonly pagination: ProjectPagination = new ProjectPagination()) {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO workspace_access(id,payload) VALUES (1,?)').run(JSON.stringify({mode:'all_connected',selectedProjectIds:[]}));
      this.seedNavigation();
      const rows = this.db.prepare('SELECT id FROM projects').all() as {id: string}[];
      for (const {id} of rows) {
        const metadata: Metadata = {archived:false,grant:id === CALCULATOR_PROJECT.id ? 'synthetic_execute' : 'planning_only',
          grantRevision:1,mapRevision:1,sourceState:'unmapped'};
        this.db.prepare('INSERT OR IGNORE INTO project_metadata(project_id,payload) VALUES (?,?)').run(id,JSON.stringify(metadata));
      }
    }).immediate();
  }
  protectSecret(secret?: string): void { if (secret) this.secrets.add(secret); }
  validateContent(value: unknown): void {
    if (containsPrivateContent(value) || [...this.secrets].some(secret => containsPrivateContent(value,secret))) {
      throw new ProjectError(400,'Credential-like content refused');
    }
  }
  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    this.validateContent(input);
    return schema.parse(input);
  }
  private seedNavigation(): void {
    const project = NAVIGATION_SAMPLE_PROJECT;
    this.db.prepare('INSERT OR IGNORE INTO projects(id,payload) VALUES (?,?)').run(project.id,JSON.stringify({
      id:project.id,name:project.name,description:project.description,visibility:project.visibility}));
    for (const graph of [NAVIGATION_CHILD_WORKFLOW,NAVIGATION_MAIN_WORKFLOW]) {
      this.db.prepare('INSERT OR IGNORE INTO workflows(id,project_id,revision,payload) VALUES (?,?,?,?)')
        .run(graph.id,graph.projectId,graph.revision,JSON.stringify(graph));
      this.db.prepare('INSERT OR IGNORE INTO workflow_revisions(workflow_id,revision,payload) SELECT id,revision,payload FROM workflows WHERE id=?').run(graph.id);
    }
  }
  access(): AccessPreference {
    return JSON.parse((this.db.prepare('SELECT payload FROM workspace_access WHERE id=1').get() as {payload:string}).payload) as AccessPreference;
  }
  setAccess(input: AccessPreference): {access: AccessPreference} {
    const access = this.parse(projectSchemas.access,input);
    if (new Set(access.selectedProjectIds).size !== access.selectedProjectIds.length) throw new ProjectError(400,'Repeated project selection');
    for (const id of access.selectedProjectIds) this.project(id,false);
    this.db.transaction(() => {
      const previouslyAccessible = this.list();
      this.db.prepare('UPDATE workspace_access SET payload=? WHERE id=1').run(JSON.stringify(access));
      const now = new Set(this.list().map(project => project.id));
      for (const project of previouslyAccessible) if (!now.has(project.id)) this.revokeLegacy(project.id);
      for (const project of this.all()) this.audit(project.id,'access_changed',{mode:access.mode,selected:access.selectedProjectIds.includes(project.id)});
    }).immediate();
    return {access};
  }
  private all(): RegisteredProject[] {
    return (this.db.prepare('SELECT p.payload AS project,m.payload AS metadata FROM projects p JOIN project_metadata m ON m.project_id=p.id ORDER BY p.id').all() as {project:string;metadata:string}[])
      .map(row => {
        const project = JSON.parse(row.project) as Project;
        const metadata = JSON.parse(row.metadata) as Metadata;
        return {id:project.id,name:project.name,description:project.description,visibility:project.visibility,
          archived:metadata.archived,grant:metadata.grant,grantRevision:metadata.grantRevision,
          mapRevision:metadata.mapRevision,sourceState:metadata.sourceState};
      });
  }
  list(): RegisteredProject[] {
    const access = this.access();
    return this.all().filter(project => !project.archived && (access.mode === 'all_connected' || access.selectedProjectIds.includes(project.id)));
  }
  project(id: string, requireAccessible = true): RegisteredProject {
    const project = (requireAccessible ? this.list() : this.all()).find(value => value.id === id);
    if (!project) throw new ProjectError(404,'Project not found');
    return project;
  }
  private selectedProject(id: string): RegisteredProject {
    const project = this.project(id,false);
    const access = this.access();
    if (access.mode !== 'all_connected' && !access.selectedProjectIds.includes(id)) throw new ProjectError(404,'Project not found');
    return project;
  }
  workflow(id: string): Workflow {
    const workflow = this.reader.workflow(id);
    if (!workflow) throw new ProjectError(404,'Workflow not found');
    this.project(workflow.projectId);
    return workflow;
  }
  requireExecution(id: string): void {
    const workflow = this.workflow(id);
    const project = this.project(workflow.projectId);
    if (project.id !== CALCULATOR_PROJECT.id || workflow.id !== CALCULATOR_WORKFLOW.id || project.grant !== 'synthetic_execute') {
      throw new ProjectError(403,'Execution is forbidden for this project');
    }
  }
  private audit(projectId: string, kind: string, payload: unknown): void {
    this.db.prepare('INSERT INTO project_audit_events(project_id,kind,time,payload) VALUES (?,?,?,?)')
      .run(projectId,kind,new Date().toISOString(),JSON.stringify(payload));
  }
  private revokeLegacy(projectId: string): void {
    this.reader.revokeWork(projectId);
    const rows = this.db.prepare("SELECT t.id,t.payload FROM implementation_tasks t JOIN workflows w ON w.id=t.workflow_id WHERE w.project_id=? AND t.state IN ('awaiting_approval','running','interrupted')").all(projectId) as {id:string;payload:string}[];
    for (const row of rows) {
      const binding = JSON.parse(row.payload) as {task:ImplementationTask};
      if (!binding.task.approval && binding.task.state !== 'running') continue;
      binding.task.approval = null;
      if (binding.task.state === 'running') binding.task.state = 'interrupted';
      this.db.prepare('UPDATE implementation_tasks SET state=?,payload=? WHERE id=?').run(binding.task.state,JSON.stringify(binding),row.id);
      this.db.prepare('INSERT INTO implementation_events(task_id,kind,time,detail) VALUES (?,?,?,?)')
        .run(row.id,'authority_revoked',new Date().toISOString(),'Project authority changed; fresh review is required.');
    }
  }
  private metadata(project: RegisteredProject): void {
    const {archived,grant,grantRevision,mapRevision,sourceState} = project;
    this.db.prepare('UPDATE project_metadata SET payload=? WHERE project_id=?').run(JSON.stringify({archived,grant,grantRevision,mapRevision,sourceState}),project.id);
  }
  private replay<T>(scope: string, requestId: string, input: unknown, action: () => T): T {
    return this.db.transaction(() => {
      const json = JSON.stringify(input);
      const row = this.db.prepare('SELECT input_json,result_json FROM project_requests WHERE scope=? AND request_id=?').get(scope,requestId) as {input_json:string;result_json:string} | undefined;
      if (row) {
        if (row.input_json !== json) throw new ProjectError(409,'Request key already used with different content');
        return JSON.parse(row.result_json) as T;
      }
      const result = action();
      this.db.prepare('INSERT INTO project_requests(scope,request_id,input_json,result_json) VALUES (?,?,?,?)').run(scope,requestId,json,JSON.stringify(result));
      return result;
    }).immediate();
  }
  create(input: ProjectCreateInput): {project: RegisteredProject} {
    const value = this.parse(projectSchemas.create,input);
    const result = this.replay('project:create',value.clientRequestId,value,() => {
      const project: RegisteredProject = {id:randomUUID(),name:value.name,description:value.description,visibility:'local-private',
        archived:false,grant:'planning_only',grantRevision:1,mapRevision:1,sourceState:'unmapped'};
      this.db.prepare('INSERT INTO projects(id,payload) VALUES (?,?)').run(project.id,JSON.stringify({id:project.id,name:project.name,description:project.description,visibility:project.visibility}));
      this.db.prepare('INSERT INTO project_metadata(project_id,payload) VALUES (?,?)').run(project.id,'{}');
      this.metadata(project);
      const access = this.access();
      if (access.mode === 'selected') this.db.prepare('UPDATE workspace_access SET payload=? WHERE id=1')
        .run(JSON.stringify({...access,selectedProjectIds:[...access.selectedProjectIds,project.id]}));
      this.audit(project.id,'created',{grant:project.grant});
      return {project};
    });
    this.project(result.project.id);
    return result;
  }
  updateSettings(id: string, input: ProjectSettingsInput): {project: RegisteredProject} {
    const value = this.parse(projectSchemas.settings,input);
    return this.db.transaction(() => {
      const narrowRestore = value.archived === false && Object.keys(value).length === 2;
      const current = narrowRestore ? this.selectedProject(id) : this.project(id);
      if (value.expectedGrantRevision !== current.grantRevision) throw new ProjectError(409,'Stale project grant revision');
      if (value.grant === 'synthetic_execute' && id !== CALCULATOR_PROJECT.id) throw new ProjectError(403,'Synthetic execution is forbidden for real projects');
      const semantic = (value.name !== undefined && value.name !== current.name) || (value.description !== undefined && value.description !== current.description);
      const authority = (value.grant !== undefined && value.grant !== current.grant) || (value.archived !== undefined && value.archived !== current.archived);
      const project: RegisteredProject = {...current,name:value.name ?? current.name,description:value.description ?? current.description,
        grant:value.grant ?? current.grant,archived:value.archived ?? current.archived,
        mapRevision:current.mapRevision + (semantic ? 1 : 0),grantRevision:current.grantRevision + (authority ? 1 : 0)};
      if (semantic) this.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify({id:project.id,name:project.name,description:project.description,visibility:project.visibility}),id);
      this.metadata(project);
      if (semantic || authority) {
        this.revokeLegacy(id);
        this.audit(id,authority ? 'authority_revoked' : 'map_changed',{mapRevision:project.mapRevision,grantRevision:project.grantRevision,
          previousGrant:current.grant,grant:project.grant,previousArchived:current.archived,archived:project.archived});
      }
      return {project};
    }).immediate();
  }
  setGrant(id: string, input: Pick<ProjectSettingsInput, 'expectedGrantRevision' | 'grant'>): {project: RegisteredProject} {
    return this.updateSettings(id,input);
  }
  items(projectId: string): ProjectItem[] {
    this.project(projectId);
    return (this.db.prepare('SELECT payload FROM project_items WHERE project_id=? ORDER BY rowid').all(projectId) as {payload:string}[]).map(row => JSON.parse(row.payload) as ProjectItem);
  }
  private mapCurrent(projectId: string, expected: number): RegisteredProject {
    const project = this.project(projectId);
    if (expected !== project.mapRevision) throw new ProjectError(409,'Stale map revision');
    return project;
  }
  private changedMap(project: RegisteredProject): void {
    this.metadata({...project,mapRevision:project.mapRevision + 1});
    this.revokeLegacy(project.id);
    this.audit(project.id,'map_changed',{mapRevision:project.mapRevision + 1});
  }
  saveItem(projectId: string, input: ProjectItemCreateInput | ProjectItemEditInput, itemId?: string): {item: ProjectItem} {
    this.project(projectId);
    if (itemId) {
      const value = this.parse(projectSchemas.itemEdit,input);
      return this.db.transaction(() => {
        const project = this.mapCurrent(projectId,value.expectedMapRevision);
        const current = this.items(projectId).find(item => item.id === itemId);
        if (!current) throw new ProjectError(404,'Item not found');
        const item = {...current,name:value.name,description:value.description,development:value.development};
        this.db.prepare('UPDATE project_items SET payload=? WHERE id=?').run(JSON.stringify(item),itemId);
        this.changedMap(project);
        return {item};
      }).immediate();
    }
    const value = this.parse(projectSchemas.itemCreate,input);
    return this.replay(`item:create:${projectId}`,value.clientRequestId,value,() => {
      const project = this.mapCurrent(projectId,value.expectedMapRevision);
      if (value.parentId && !this.items(projectId).some(item => item.id === value.parentId)) throw new ProjectError(400,'Parent must belong to this project');
      if (value.workflowId && this.reader.workflow(value.workflowId)?.projectId !== projectId) throw new ProjectError(400,'Workflow must belong to this project');
      const item: ProjectItem = {id:randomUUID(),projectId,parentId:value.parentId,kind:value.kind,name:value.name,description:value.description,development:value.development,workflowId:value.workflowId};
      this.db.prepare('INSERT INTO project_items(id,project_id,parent_id,workflow_id,payload) VALUES (?,?,?,?,?)').run(item.id,projectId,item.parentId,item.workflowId,JSON.stringify(item));
      this.changedMap(project);
      return {item};
    });
  }
  private validateChildren(workflow: Workflow): Set<string> {
    const completed = new Map<string,number>();
    const active = new Set<string>();
    const graphs = new Map<string,Workflow>([[workflow.id,workflow]]);
    let references = 0;
    const visit = (graph: Workflow, depth: number): number => {
      if (depth > 100 || active.has(graph.id)) throw new ProjectError(400,'Child workflow cycle or depth limit');
      const cachedHeight = completed.get(graph.id);
      if (cachedHeight !== undefined) {
        if (depth + cachedHeight > 100) throw new ProjectError(400,'Child workflow depth limit');
        return cachedHeight;
      }
      active.add(graph.id);
      let height = 0;
      for (const step of graph.steps) {
        if (!step.childWorkflowId) continue;
        if (++references > 10_000) throw new ProjectError(400,'Child workflow reference budget exceeded');
        let child = graphs.get(step.childWorkflowId);
        if (!child) {
          if (graphs.size >= 1_000) throw new ProjectError(400,'Child workflow graph budget exceeded');
          child = this.reader.workflow(step.childWorkflowId) ?? undefined;
          if (child) graphs.set(child.id,child);
        }
        if (!child || child.id !== step.childWorkflowId || child.projectId !== workflow.projectId) throw new ProjectError(400,'Child workflow must belong to this project');
        height = Math.max(height,1 + visit(child,depth + 1));
      }
      active.delete(graph.id);
      completed.set(graph.id,height);
      return height;
    };
    visit(workflow,0);
    return new Set(graphs.keys());
  }
  saveWorkflow(projectId: string, input: WorkflowCreateInput): {workflow: Workflow} {
    this.project(projectId);
    const value = this.parse(projectSchemas.workflow,input);
    return this.replay(`workflow:create:${projectId}`,value.clientRequestId,value,() => {
      const project = this.mapCurrent(projectId,value.expectedMapRevision);
      const item = value.itemId ? this.items(projectId).find(item => item.id === value.itemId) : null;
      if (value.itemId && (!item || item.workflowId)) throw new ProjectError(400,'Creation requires an unlinked item in this project');
      const workflow: Workflow = {id:randomUUID(),projectId,name:value.name,description:value.description,revision:1,steps:value.steps,connections:value.connections};
      try { assertValidWorkflow(workflow); } catch { throw new ProjectError(400,'Invalid workflow graph'); }
      if (new Set(workflow.connections.map(edge => edge.id)).size !== workflow.connections.length) throw new ProjectError(400,'Repeated connection identity');
      if (workflow.steps.length > 1 && workflow.steps.some(step => !workflow.connections.some(edge => edge.source === step.id || edge.target === step.id))) throw new ProjectError(400,'Workflow nodes must have connected paths');
      this.validateChildren(workflow);
      this.db.prepare('INSERT INTO workflows(id,project_id,revision,payload) VALUES (?,?,?,?)').run(workflow.id,projectId,1,JSON.stringify(workflow));
      this.db.prepare('INSERT INTO workflow_revisions(workflow_id,revision,payload) VALUES (?,?,?)').run(workflow.id,1,JSON.stringify(workflow));
      if (item) this.db.prepare('UPDATE project_items SET workflow_id=?,payload=? WHERE id=?').run(workflow.id,JSON.stringify({...item,workflowId:workflow.id}),item.id);
      this.changedMap(project);
      return {workflow};
    });
  }
  layout(workflowId: string): WorkflowLayout {
    const workflow = this.workflow(workflowId);
    const row = this.db.prepare('SELECT payload FROM workflow_layouts WHERE workflow_id=?').get(workflowId) as {payload:string} | undefined;
    return row ? JSON.parse(row.payload) as WorkflowLayout : {workflowId,layoutRevision:0,positions:workflow.steps.map(step => ({stepId:step.id,...step.position}))};
  }
  saveLayout(workflowId: string, input: LayoutInput): {layout: WorkflowLayout} {
    const value = this.parse(projectSchemas.layout,input);
    return this.db.transaction(() => {
      const workflow = this.workflow(workflowId);
      const current = this.layout(workflowId);
      if (value.expectedLayoutRevision !== current.layoutRevision) throw new ProjectError(409,'Stale layout revision');
      const ids = new Set(value.positions.map(position => position.stepId));
      if (ids.size !== value.positions.length || ids.size !== workflow.steps.length || workflow.steps.some(step => !ids.has(step.id))) throw new ProjectError(400,'Positions must include every workflow node exactly once');
      const layout: WorkflowLayout = {workflowId,layoutRevision:current.layoutRevision + 1,positions:value.positions};
      this.db.prepare('INSERT INTO workflow_layouts(workflow_id,layout_revision,payload) VALUES (?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET layout_revision=excluded.layout_revision,payload=excluded.payload')
        .run(workflowId,layout.layoutRevision,JSON.stringify(layout));
      return {layout};
    }).immediate();
  }
  linkCandidate(projectId: string, input: RepositoryCandidateInput): {repository: RepositoryCandidate} {
    this.project(projectId);
    const value = this.parse(projectSchemas.repository,input);
    return this.replay(`repository:create:${projectId}`,value.clientRequestId,value,() => {
      const project = this.project(projectId);
      if (value.expectedGrantRevision !== project.grantRevision) throw new ProjectError(409,'Stale project grant revision');
      const repository: RepositoryCandidate = {id:randomUUID(),alias:value.alias,state:'pending'};
      // The path is inert private data: no realpath/stat, discovery or source read.
      this.db.prepare('INSERT INTO repository_candidates(id,project_id,alias,absolute_path,state) VALUES (?,?,?,?,?)')
        .run(repository.id,projectId,repository.alias,value.absolutePath,'pending');
      this.audit(projectId,'repository_candidate',{repositoryId:repository.id});
      return {repository};
    });
  }
  resolveContext(context: ContextRef): {project: RegisteredProject; item: ProjectItem | null; workflow: Workflow | null; step: Workflow['steps'][number] | null} {
    const project = this.mapCurrent(context.projectId,context.mapRevision);
    const item = context.itemId ? this.items(project.id).find(item => item.id === context.itemId) : null;
    if (context.itemId && !item) throw new ProjectError(404,'Item not found');
    const workflow = context.workflowId ? this.workflow(context.workflowId) : null;
    if (workflow && workflow.projectId !== project.id) throw new ProjectError(404,'Workflow not found');
    if (workflow ? context.specRevision !== workflow.revision : context.specRevision !== undefined) throw new ProjectError(409,'Stale or missing specification revision');
    if (item && workflow && item.workflowId !== workflow.id) {
      const root = item.workflowId ? this.workflow(item.workflowId) : null;
      if (!root || root.projectId !== project.id || !this.validateChildren(root).has(workflow.id)) {
        throw new ProjectError(404,'Workflow not found for item');
      }
    }
    const step = context.stepId ? workflow?.steps.find(step => step.id === context.stepId) : null;
    if (context.stepId && !step) throw new ProjectError(404,'Step not found');
    return {project,item:item ?? null,workflow,step:step ?? null};
  }
  stepVerification(workflow: Workflow): StepVerification[] {
    // Task 5 supplies immutable current bindings and acceptance requirements.
    return workflow.steps.map(step => projectStepVerification({stepId:step.id,requirementsKnown:false,requiredAcceptanceIds:[],evidence:[]}));
  }
  overview(projectId: string, input: OverviewFilter = {}): OverviewResponse {
    // Pin accessibility, full matching view, both pages and totals to one read snapshot.
    return this.db.transaction(() => {
      const project = this.project(projectId);
      const filter = this.parse(projectSchemas.overview,input);
      return this.overviewPage(project,filter);
    }).deferred();
  }
  private matchingOverview(project: RegisteredProject, filter: OverviewFilter): {
    items: ProjectItem[]; workflows: WorkflowSummary[]; dependencies: OverviewResponse['dependencies'];
  } {
    const projectId = project.id;
    if (filter.projectId && filter.projectId !== projectId) throw new ProjectError(404,'Project not found');
    const allItems = this.items(projectId);
    const graphs = this.reader.workflows(projectId);
    if (filter.itemId && !allItems.some(item => item.id === filter.itemId)) throw new ProjectError(404,'Item not found');
    if (filter.workflowId && !graphs.some(graph => graph.id === filter.workflowId)) throw new ProjectError(404,'Workflow not found');
    if (filter.stepId && (!filter.workflowId || !graphs.find(graph => graph.id === filter.workflowId)?.steps.some(step => step.id === filter.stepId))) throw new ProjectError(404,'Step not found');
    const selected = filter.itemId ? allItems.find(item => item.id === filter.itemId) : null;
    if (selected?.workflowId && filter.workflowId && selected.workflowId !== filter.workflowId) throw new ProjectError(404,'Workflow not found for item');
    const q = filter.q?.toLocaleLowerCase() ?? '';
    const items = allItems.filter(item => (!filter.itemId || item.id === filter.itemId) && (!filter.workflowId || item.workflowId === filter.workflowId) &&
      (!filter.development || item.development === filter.development) && `${item.name}\n${item.description}`.toLocaleLowerCase().includes(q)).sort(compareIds);
    const linkedWorkflows = new Set(items.flatMap(item => item.workflowId ? [item.workflowId] : []));
    const workflows = graphs.filter(graph => (!filter.workflowId || graph.id === filter.workflowId) && (!filter.itemId || selected?.workflowId === graph.id) &&
      (!filter.development || linkedWorkflows.has(graph.id)) && `${graph.name}\n${graph.description}`.toLocaleLowerCase().includes(q))
      .sort(compareIds).map(graph => ({id:graph.id,projectId,name:graph.name,description:graph.description,revision:graph.revision,
        stepVerification:this.stepVerification(graph).filter(step => !filter.stepId || step.stepId === filter.stepId)}));
    const visible = new Set(items.map(item => item.id));
    const dependencies = (this.db.prepare('SELECT source_item_id AS sourceItemId,target_item_id AS targetItemId FROM project_dependencies WHERE project_id=? ORDER BY source_item_id,target_item_id').all(projectId) as {sourceItemId:string;targetItemId:string}[])
      .filter(edge => visible.has(edge.sourceItemId) && visible.has(edge.targetItemId))
      .sort((left,right) => compareText(left.sourceItemId,right.sourceItemId) || compareText(left.targetItemId,right.targetItemId));
    return {items,workflows,dependencies};
  }
  private itemCounts(items: ProjectItem[]): OverviewResponse['counts'] {
    const counts = {future:0,planning:0,implementation:0,implemented:0};
    for (const item of items) counts[item.development]++;
    return counts;
  }
  private verificationCounts(workflows: WorkflowSummary[]): OverviewResponse['verificationCounts'] {
    const counts = {not_checked:0,checking:0,verified:0,failed:0,stale:0};
    for (const graph of workflows) for (const step of graph.stepVerification) counts[step.verification]++;
    return counts;
  }
  private overviewPage(project: RegisteredProject, filter: OverviewFilter): OverviewResponse {
    const matching = this.matchingOverview(project,filter);
    const binding: ProjectCursorBinding = {namespace:'overview',projectId:project.id,mapRevision:project.mapRevision,
      grantRevision:project.grantRevision,filter:canonicalOverviewFilter(project.id,filter),
      viewDigest:projectViewDigest({project:{id:project.id,name:project.name,description:project.description,sourceState:project.sourceState},...matching})};
    const limit = filter.limit ?? 50;
    const offset = filter.cursor !== undefined ? this.pagination.decode(filter.cursor,binding) : 0;
    const end = offset + limit;
    const items = matching.items.slice(offset,end);
    const workflows = matching.workflows.slice(offset,end);
    const sources = new Set(items.map(item => item.id));
    const hasMoreItems = end < matching.items.length;
    const hasMoreWorkflows = end < matching.workflows.length;
    return {project,items,workflows,dependencies:matching.dependencies.filter(edge => sources.has(edge.sourceItemId)),counts:this.itemCounts(items),
      verification:'not_checked',freshness:'unknown',verificationCounts:this.verificationCounts(workflows),
      page:{limit,hasMoreItems,hasMoreWorkflows,nextCursor:hasMoreItems || hasMoreWorkflows ? this.pagination.encode(binding,end) : null},
      totals:{items:matching.items.length,workflows:matching.workflows.length,counts:this.itemCounts(matching.items),
        verificationCounts:this.verificationCounts(matching.workflows),verification:'not_checked',freshness:'unknown'}};
  }
  private managementPage(input: WorkspaceQuery): ProjectManagementPage {
    const access = this.access();
    const projects: ProjectManagementSummary[] = this.all().map(project => ({id:project.id,name:project.name,archived:project.archived,
      selected:access.mode === 'all_connected' || access.selectedProjectIds.includes(project.id),grantRevision:project.grantRevision})).sort(compareIds);
    const limit = input.limit ?? 50;
    const binding: ProjectCursorBinding = {namespace:'management',projectId:null,mapRevision:null,grantRevision:null,
      filter:JSON.stringify({management:true,limit}),viewDigest:projectViewDigest({projects,access:{mode:access.mode,selectedProjectIds:[...access.selectedProjectIds].sort(compareText)}})};
    const offset = input.cursor !== undefined ? this.pagination.decode(input.cursor,binding) : 0;
    const end = offset + limit;
    return {projects:projects.slice(offset,end),total:projects.length,page:{limit,nextCursor:end < projects.length ? this.pagination.encode(binding,end) : null}};
  }
  workspace(input: WorkspaceQuery = {}): WorkspaceResponse {
    return this.db.transaction(() => {
      const query = this.parse(projectSchemas.workspace,input);
      const projects = this.list();
      return {access:this.access(),projects,counts:this.reader.workCounts(projects.map(project => project.id)),
        pendingDecisions:[],connections:[],...(query.management ? {management:this.managementPage(query)} : {})};
    }).deferred();
  }
}
