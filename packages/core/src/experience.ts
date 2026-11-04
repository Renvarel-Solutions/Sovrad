import type {Project, Proposal, Workflow} from './index.js';
import type {SelectedAnnotationMaterialV1} from './annotation-material.js';

export type RegisteredProject = Project & {
  archived: boolean;
  grant: 'planning_only' | 'read_only' | 'synthetic_execute';
  grantRevision: number;
  mapRevision: number;
  sourceState: 'unmapped' | 'current' | 'stale' | 'unknown';
};
export type DevelopmentState = 'planning' | 'implementation' | 'future' | 'implemented';
export type ProjectItem = {
  id: string; projectId: string; parentId: string | null;
  kind: 'module' | 'feature' | 'workflow'; name: string; description: string;
  development: DevelopmentState; workflowId: string | null;
};
export type ItemDependency = {sourceItemId: string; targetItemId: string};
export type WorkflowLayout = {
  workflowId: string; layoutRevision: number;
  positions: {stepId: string; x: number; y: number}[];
};
export type ContextRef = {
  projectId: string; itemId?: string; workflowId?: string; stepId?: string;
  specRevision?: number; mapRevision: number;
};
export type AnnotationInput = {
  clientRequestId: string; context: ContextRef; text: string;
  target: 'automatic' | 'codex' | 'chatgpt';
  intent: 'question' | 'instruction' | 'rule' | 'future_plan'; promoteFuture: boolean;
  dispatch: {mode: 'local' | 'connected'; contextDigest: string; consent: boolean};
};
export type DispatchConsentReceipt = {
  annotationId: string; annotationRevision: number; contextDigest: string;
  grantRevision: number; target: AnnotationInput['target']; grantedAt: string;
};
export type Annotation = AnnotationInput & {
  id: string; revision: number; supersedesId: string | null; createdAt: string;
  consentReceipt: DispatchConsentReceipt | null;
  material: SelectedAnnotationMaterialV1; materialJSON: string;
};
export type AmendWorkInput = AnnotationInput & {expectedVersion: number};
export type Interpretation = {
  kind: 'question' | 'future_plan' | 'rule_change' | 'implementation' | 'conflict';
  summary: string; acceptance: {id: string; description: string}[]; ruleIds: string[];
};
export type WorkState = 'new' | 'understanding' | 'queued' | 'working' | 'checking' |
  'done' | 'needs_decision' | 'blocked' | 'cancelled' | 'superseded';
export type WorkItem = {
  id: string; annotationId: string; projectId: string; parentWorkId: string | null;
  context: ContextRef; version: number; state: WorkState; interpretation: Interpretation | null;
  blockers: string[]; updatedAt: string;
};
export type WorkEvent = {sequence: number; kind: string; time: string; detail: string};
export type Evidence = {
  id: string; projectId: string; workId: string | null; context: ContextRef;
  sourceClass: 'owner_spec' | 'observed_code' | 'test_runtime' | 'documentation' | 'plan' | 'inference' | 'unknown';
  sourceRevision: string | null; environment: string; checkedAt: string; acceptanceId: string | null;
  outcome: 'passed' | 'failed' | 'not_checked'; summary: string; executionBindingId: string | null;
};
export type EvidenceView = Evidence & {freshness: 'current' | 'historical'; staleReason: string | null};
export type DecisionBinding = {
  specRevision: number | null; mapRevision: number; grantRevision: number;
  repositoryId: string | null; baseCommit: string | null;
  action: string; permissionScope: string[]; expiresAt: string; costCapMicros: number;
};
export type DecisionExplanation = {
  action: string; reasonOutsideGrant: string; expectedResult: string;
  directEffects: string[]; indirectEffects: string[]; uncertainties: string[];
  cost: {oneTimeMicros: number | null; ongoingMicros: number | null; capMicros: number; payer: string};
  failure: string; interruption: string; detection: string;
  recovery: string; backup: string; irreversibility: string;
  alternatives: string[]; recommendation: string;
};
export type Decision = {
  id: string; projectId: string; workId: string | null; context: ContextRef; version: number;
  status: 'pending' | 'approved' | 'rejected' | 'revision_requested' | 'expired' | 'superseded';
  proposalDigest: string; binding: DecisionBinding; explanation: DecisionExplanation;
};
export type DecisionAction = {
  clientRequestId: string; expectedVersion: number; proposalDigest: string;
  action: 'approve' | 'reject' | 'request_revision'; reason: string;
};
export type AgentConnection = {
  id: string; target: 'codex' | 'chatgpt';
  capabilities: ('host_annotation' | 'discussion' | 'interpret' | 'synthetic_execute')[];
  state: 'unavailable' | 'setup_required' | 'offline' | 'connecting' | 'ready' | 'blocked';
  lastSeenAt: string | null; reason: string;
};
export type AccessPreference = {mode: 'selected' | 'all_connected'; selectedProjectIds: string[]};
export type StepVerification = {
  stepId: string; verification: 'not_checked' | 'checking' | 'verified' | 'failed' | 'stale';
  freshness: 'current' | 'stale' | 'unknown'; lastCheckedAt: string | null;
  evidenceIds: string[]; reason: string;
};
export type WorkflowDetailResponse = {
  workflow: Workflow; proposals: Proposal[]; history: {revision: number; workflow: Workflow}[];
  layout: WorkflowLayout; stepVerification: StepVerification[];
};
export type WorkDetailResponse = {
  work: WorkItem; annotation: Annotation; subtasks: WorkItem[];
  events: WorkEvent[]; evidence: EvidenceView[]; decisions: Decision[];
};
export type ExecutionBinding = {
  id: string; attemptId: string; workId: string; workVersion: number;
  annotationId: string; annotationRevision: number; projectId: string; context: ContextRef;
  grantRevision: number; repositoryId: string; baseCommit: string; sourceRevision: string;
  specDigest: string; specReceiptId: string; acceptanceDigest: string;
  acceptanceSnapshot: {id: string; description: string}[];
  manifestDigest: string; leaseFence: number; createdAt: string;
};
export type RuntimeEvidenceInput = {
  kind: 'runtime'; executionBindingId: string; attemptId: string; leaseFence: number;
  sourceClass: 'observed_code' | 'test_runtime'; environment: string; checkedAt: string;
  acceptanceId: string | null; outcome: Evidence['outcome']; summary: string;
};
export type KnowledgeEvidenceInput = {
  kind: 'knowledge'; projectId: string; workId: string | null; context: ContextRef;
  sourceClass: Exclude<Evidence['sourceClass'], 'test_runtime'>; sourceRevision: string | null;
  environment: string; checkedAt: string; outcome: Evidence['outcome']; summary: string;
};
export type EvidenceInput = RuntimeEvidenceInput | KnowledgeEvidenceInput;
export type LocalActionSession = {id: string; expiresAt: string; source: 'local-owner-session'};
export type Lease = {workId: string; outboxId: string; fence: number; expiresAt: string};
export type RepositoryCandidate = {id: string; alias: string; state: 'pending'};
export type ProjectCreateInput = {clientRequestId: string; name: string; description: string};
export type ProjectSettingsInput = {
  expectedGrantRevision: number; name?: string; description?: string;
  archived?: boolean; grant?: RegisteredProject['grant'];
};
export type ProjectItemCreateInput = Omit<ProjectItem, 'id' | 'projectId'> & {
  clientRequestId: string; expectedMapRevision: number;
};
export type ProjectItemEditInput = Pick<ProjectItem, 'name' | 'description' | 'development'> & {expectedMapRevision: number};
export type WorkflowCreateInput = Pick<Workflow, 'name' | 'description' | 'steps' | 'connections'> & {
  clientRequestId: string; expectedMapRevision: number; itemId: string | null;
};
export type LayoutInput = {expectedLayoutRevision: number; positions: WorkflowLayout['positions']};
export type RepositoryCandidateInput = {
  clientRequestId: string; expectedGrantRevision: number; alias: string; absolutePath: string;
};
export type OverviewFilter = {
  development?: DevelopmentState; q?: string; projectId?: string; itemId?: string;
  workflowId?: string; stepId?: string; limit?: number; cursor?: string;
};
export type OverviewPage = {
  limit: number; hasMoreItems: boolean; hasMoreWorkflows: boolean; nextCursor: string | null;
};
export type OverviewTotals = {
  items: number; workflows: number; counts: Record<DevelopmentState, number>;
  verificationCounts: Record<StepVerification['verification'], number>;
  verification: StepVerification['verification']; freshness: StepVerification['freshness'];
};
export type OverviewResponse = {
  project: RegisteredProject; items: ProjectItem[];
  workflows: (Pick<Workflow, 'id' | 'projectId' | 'name' | 'description' | 'revision'> & {stepVerification: StepVerification[]})[];
  dependencies: ItemDependency[]; counts: Record<DevelopmentState, number>;
  verification: StepVerification['verification']; freshness: StepVerification['freshness'];
  verificationCounts: Record<StepVerification['verification'], number>;
  page: OverviewPage; totals: OverviewTotals;
};
export type ProjectManagementSummary = {
  id: string; name: string; archived: boolean; selected: boolean; grantRevision: number;
};
export type WorkspaceQuery = {management?: true; limit?: number; cursor?: string};
export type ProjectManagementPage = {
  projects: ProjectManagementSummary[]; total: number; page: {limit: number; nextCursor: string | null};
};
export type WorkspaceResponse = {
  access: AccessPreference; projects: RegisteredProject[];
  counts: Record<WorkState, number>; pendingDecisions: Decision[]; connections: AgentConnection[];
  management?: ProjectManagementPage;
};
