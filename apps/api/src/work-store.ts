import type Database from 'better-sqlite3';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {
  buildSelectedAnnotationMaterial, serializeSelectedAnnotationMaterial,
  type Annotation, type AnnotationInput, type AmendWorkInput, type Interpretation, type Lease,
  type SelectedAnnotationMaterialV1, type WorkDetailResponse, type WorkEvent, type WorkItem, type WorkState,
  type Decision,type DecisionAction,type LocalActionSession,type Evidence,type EvidenceInput,
} from '@renvarel/architect-core';
import {ProjectError, type ProjectStore} from './project-store.js';

const identity = z.string().min(1).max(100);
const revision = z.number().int().positive();
const state = z.enum(['new','understanding','queued','working','checking','done','needs_decision','blocked','cancelled','superseded']);
const context = z.object({projectId:identity,itemId:identity.optional(),workflowId:identity.optional(),stepId:identity.optional(),
  specRevision:revision.optional(),mapRevision:revision}).strict();
const annotation = z.object({clientRequestId:z.string().uuid(),context,text:z.string().min(1).max(2000).refine(text => text.trim().length > 0),
  target:z.enum(['automatic','codex','chatgpt']),intent:z.enum(['question','instruction','rule','future_plan']),promoteFuture:z.boolean(),
  dispatch:z.object({mode:z.enum(['local','connected']),contextDigest:z.string().regex(/^[a-f0-9]{64}$/),consent:z.boolean()}).strict()}).strict();
export const workSchemas = {
  annotation, amend:annotation.extend({expectedVersion:revision}).strict(),
  cancel:z.object({clientRequestId:z.string().uuid(),expectedVersion:revision,reason:z.string().min(1).max(2000)}).strict(),
  list:z.object({projectId:identity.optional(),state:state.optional(),itemId:identity.optional(),workflowId:identity.optional(),stepId:identity.optional(),
    limit:z.coerce.number().int().min(1).max(100).optional()}).strict(),
  events:z.object({afterSequence:z.coerce.number().int().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict(),
  interpretation:z.object({kind:z.enum(['question','future_plan','rule_change','implementation','conflict']),summary:z.string().min(1).max(2000),
    acceptance:z.array(z.object({id:identity,description:z.string().min(1).max(2000)}).strict()).max(100),
    ruleIds:z.array(identity).max(100)}).strict(),
};
type Intake = {annotation:Annotation; work:WorkItem};
type ListFilter = z.infer<typeof workSchemas.list>;
type CancelInput = z.infer<typeof workSchemas.cancel>;
type Payload = {payload:string};
export type PreparedAnnotation = {
  input:AnnotationInput; material:SelectedAnnotationMaterialV1; materialJSON:string; grantRevision:number;
};
export type InterpretationClaim = {lease:Lease; workVersion:number; annotationId:string; materialJSON:string};
type Outbox = {id:string; work_id:string; annotation_id:string; state:string; fence:number; grant_revision:number; expires_at:string|null};
const terminal = new Set<WorkState>(['cancelled','superseded','done']);
const offline = 'The requested agent connection is unavailable. This request has not been sent.';
const hash = (text:string):string => createHash('sha256').update(text,'utf8').digest('hex');

export class WorkStore {
  private experience?:{read:<T>(fn:()=>T)=>T;detail:(work:WorkItem)=>Pick<WorkDetailResponse,'evidence'|'decisions'|'verification'|'freshness'|'pendingDecisionCount'>;
    resolveDecision:(id:string,input:DecisionAction,session:LocalActionSession)=>Decision;recordEvidence:(input:EvidenceInput)=>Evidence};
  constructor(private readonly db:Database.Database, private readonly registry:ProjectStore,private readonly now:()=>number=()=>Date.now()) { this.reconcile(); }
  setExperience(value:NonNullable<WorkStore['experience']>):void{this.experience=value;}
  private read<T>(fn:()=>T):T{return this.experience?this.experience.read(fn):this.db.transaction(fn).immediate();}
  resolveDecision(id:string,input:DecisionAction,session:LocalActionSession):Decision {
    if(!this.experience)throw new ProjectError(403,'Decision authority is unavailable.');return this.experience.resolveDecision(id,input,session);
  }
  recordEvidence(input:EvidenceInput):Evidence {
    if(!this.experience)throw new ProjectError(403,'Evidence authority is unavailable.');return this.experience.recordEvidence(input);
  }

  parseInput(input:AnnotationInput):AnnotationInput {
    this.registry.validateContent(input);
    const value = workSchemas.annotation.parse(input);
    if ((value.dispatch.mode === 'connected') !== value.dispatch.consent) throw new ProjectError(400,'Fresh connected consent is required; local notes must not grant consent');
    return value;
  }
  parseAmendment(input:AmendWorkInput):AmendWorkInput {
    this.registry.validateContent(input);
    const value = workSchemas.amend.parse(input);
    this.parseInput(this.annotationInput(value));
    return value;
  }
  annotationInput(input:AmendWorkInput):AnnotationInput {
    const {expectedVersion:_,...value} = input;
    return value;
  }
  prepare(input:AnnotationInput):PreparedAnnotation {
    const selected = this.registry.resolveContext(input.context);
    const material = buildSelectedAnnotationMaterial({draft:input,...selected});
    this.registry.validateContent(material);
    return {input,material,materialJSON:serializeSelectedAnnotationMaterial(material),grantRevision:selected.project.grantRevision};
  }
  replay(scope:string, input:AnnotationInput|AmendWorkInput):Intake|null {
    return this.db.transaction(() => {
      this.registry.project(input.context.projectId);
      return this.previous<Intake>(scope,input.clientRequestId,input);
    }).deferred();
  }
  private previous<T>(scope:string, requestId:string, input:unknown):T|null {
    const row = this.db.prepare('SELECT input_json,result_json FROM work_requests WHERE scope=? AND request_id=?').get(scope,requestId) as {input_json:string;result_json:string}|undefined;
    if (!row) return null;
    if (row.input_json !== JSON.stringify(input)) throw new ProjectError(409,'Request key already used with different content');
    return JSON.parse(row.result_json) as T;
  }
  private remember(scope:string, requestId:string, input:unknown, result:unknown):void {
    this.db.prepare('INSERT INTO work_requests(scope,request_id,input_json,result_json) VALUES (?,?,?,?)')
      .run(scope,requestId,JSON.stringify(input),JSON.stringify(result));
  }
  private recheck(prepared:PreparedAnnotation):void {
    const current = this.prepare(prepared.input);
    if (current.grantRevision !== prepared.grantRevision || current.materialJSON !== prepared.materialJSON) {
      throw new ProjectError(409,'Selected material changed. Refresh and review it again.');
    }
  }
  commit(prepared:PreparedAnnotation, digest:string, amendment?:{workId:string; input:AmendWorkInput}):Intake {
    return this.db.transaction(() => {
      const input = amendment?.input ?? prepared.input;
      const scope = amendment ? `work:amend:${amendment.workId}` : 'annotation:create';
      this.registry.project(input.context.projectId);
      const existing = this.previous<Intake>(scope,input.clientRequestId,input);
      if (existing) return existing;
      const old = amendment ? this.amendable(amendment.workId,amendment.input) : null;
      this.recheck(prepared);
      if (digest !== input.dispatch.contextDigest) throw new ProjectError(400,'Selected material does not match the reviewed digest');
      const supersedes = old ? this.annotation(old.annotationId) : null;
      const result = this.insert(prepared,digest,supersedes);
      if (old) this.transition(old,'superseded','superseded','A new immutable amendment replaced this request.');
      this.remember(scope,input.clientRequestId,input,result);
      return result;
    }).immediate();
  }
  private amendable(workId:string, input:AmendWorkInput):WorkItem {
    const work = this.get(workId);
    if (work.projectId !== input.context.projectId) throw new ProjectError(404,'Work not found');
    if (work.version !== input.expectedVersion || terminal.has(work.state)) throw new ProjectError(409,'Work changed. Refresh before amending.');
    return work;
  }
  private insert(prepared:PreparedAnnotation, digest:string, previous:Annotation|null):Intake {
    const {input,material,materialJSON,grantRevision} = prepared;
    const id = randomUUID(), createdAt = new Date(this.now()).toISOString(), revision = (previous?.revision ?? 0) + 1;
    const consentReceipt = input.dispatch.mode === 'connected' ? {annotationId:id,annotationRevision:revision,
      contextDigest:digest,grantRevision,target:input.target,grantedAt:createdAt} : null;
    const annotation:Annotation = {...input,id,revision,supersedesId:previous?.id ?? null,createdAt,consentReceipt,material,materialJSON};
    const work:WorkItem = {id:randomUUID(),annotationId:id,projectId:input.context.projectId,parentWorkId:null,context:input.context,
      version:1,state:consentReceipt ? 'blocked' : 'new',interpretation:null,blockers:consentReceipt ? [offline] : [],updatedAt:createdAt};
    this.db.prepare('INSERT INTO annotations(id,project_id,supersedes_id,revision,material_json,material_digest,payload) VALUES (?,?,?,?,?,?,?)')
      .run(id,work.projectId,annotation.supersedesId,revision,materialJSON,digest,JSON.stringify(annotation));
    if (consentReceipt) this.db.prepare('INSERT INTO annotation_consent_receipts(annotation_id,payload) VALUES (?,?)').run(id,JSON.stringify(consentReceipt));
    this.db.prepare('INSERT INTO work_items(id,annotation_id,project_id,state,version,payload) VALUES (?,?,?,?,?,?)')
      .run(work.id,id,work.projectId,work.state,1,JSON.stringify(work));
    this.event(work.id,consentReceipt ? 'blocked' : 'saved_locally',consentReceipt ? offline : 'Saved locally. No agent dispatch was created.');
    if (consentReceipt) this.db.prepare("INSERT INTO work_outbox(id,work_id,annotation_id,state,grant_revision,created_at) VALUES (?,?,?,'pending',?,?)")
      .run(randomUUID(),work.id,id,grantRevision,createdAt);
    return {annotation,work};
  }
  private annotation(id:string):Annotation {
    const row = this.db.prepare('SELECT payload FROM annotations WHERE id=?').get(id) as Payload|undefined;
    if (!row) throw new ProjectError(404,'Annotation not found');
    return JSON.parse(row.payload) as Annotation;
  }
  get(id:string):WorkItem {
    return this.read(()=>this.getRaw(id));
  }
  private getRaw(id:string):WorkItem {
    const row = this.db.prepare('SELECT payload FROM work_items WHERE id=?').get(id) as Payload|undefined;
    if (!row) throw new ProjectError(404,'Work not found');
    const work = JSON.parse(row.payload) as WorkItem;
    this.registry.project(work.projectId);
    return work;
  }
  detail(id:string):WorkDetailResponse {
    return this.read(() => {
      const work = this.get(id), annotation = this.annotation(work.annotationId);
      const subtasks = this.filtered({}).filter(item => item.parentWorkId === id);
      return {work,annotation,subtasks,events:this.readEvents(id),evidence:[],decisions:[],verification:'not_checked',freshness:'unknown',pendingDecisionCount:0,...this.experience?.detail(work)};
    });
  }
  private readEvents(id:string, afterSequence=0, limit?:number):WorkEvent[] {
    const sql = 'SELECT sequence,kind,time,detail FROM work_events WHERE work_id=? AND sequence>? ORDER BY sequence';
    return (limit === undefined ? this.db.prepare(sql).all(id,afterSequence) : this.db.prepare(sql+' LIMIT ?').all(id,afterSequence,limit)) as WorkEvent[];
  }
  events(id:string, input:unknown):{events:WorkEvent[]; nextAfterSequence:number} {
    return this.read(() => {
      this.get(id);
      const query = workSchemas.events.parse(input), after = query.afterSequence ?? 0;
      const events = this.readEvents(id,after,query.limit ?? 50);
      return {events,nextAfterSequence:events.at(-1)?.sequence ?? after};
    });
  }
  private filtered(filter:ListFilter):WorkItem[] {
    const visible = new Set(this.registry.list().map(project => project.id));
    if (filter.projectId) this.registry.project(filter.projectId);
    return (this.db.prepare('SELECT payload FROM work_items ORDER BY rowid DESC').all() as Payload[])
      .map(row => JSON.parse(row.payload) as WorkItem).filter(work => visible.has(work.projectId) &&
        (!filter.projectId || work.projectId === filter.projectId) && (!filter.state || work.state === filter.state) &&
        (!filter.itemId || work.context.itemId === filter.itemId) && (!filter.workflowId || work.context.workflowId === filter.workflowId) &&
        (!filter.stepId || work.context.stepId === filter.stepId));
  }
  list(input:unknown):{work:WorkItem[]} {
    return this.read(() => {
      const query = workSchemas.list.parse(input);
      return {work:this.filtered(query).slice(0,query.limit ?? 50)};
    });
  }
  annotations(input:unknown):{annotations:Annotation[]} {
    return this.read(() => {
      const query = workSchemas.list.parse(input);
      return {annotations:this.filtered(query).slice(0,query.limit ?? 50).map(work => this.annotation(work.annotationId))};
    });
  }
  counts(projectIds:readonly string[]):Record<WorkState,number> {
    return this.read(()=>this.rawCounts(projectIds));
  }
  private rawCounts(projectIds:readonly string[]):Record<WorkState,number> {
    const counts:Record<WorkState,number> = {new:0,understanding:0,queued:0,working:0,checking:0,done:0,needs_decision:0,blocked:0,cancelled:0,superseded:0};
    const visible = new Set(projectIds);
    const rows = this.db.prepare('SELECT project_id,state,count(*) AS count FROM work_items GROUP BY project_id,state').all() as {project_id:string;state:WorkState;count:number}[];
    for (const row of rows) if (visible.has(row.project_id)) counts[row.state] += row.count;
    return counts;
  }
  private event(id:string, kind:string, detail:string):void {
    const time=new Date(this.now()).toISOString();
    this.db.prepare('INSERT INTO work_events(work_id,kind,time,detail) VALUES (?,?,?,?)').run(id,kind,time,detail);
    const work=this.db.prepare('SELECT project_id,payload FROM work_items WHERE id=?').get(id) as {project_id:string;payload:string};
    this.db.prepare('INSERT INTO project_audit_events(project_id,kind,time,payload) VALUES (?,?,?,?)').run(work.project_id,kind,time,JSON.stringify({context:(JSON.parse(work.payload) as WorkItem).context}));
  }
  private save(work:WorkItem, kind:string, detail:string):WorkItem {
    this.db.prepare('UPDATE work_items SET state=?,version=?,payload=? WHERE id=?').run(work.state,work.version,JSON.stringify(work),work.id);
    this.event(work.id,kind,detail);
    return work;
  }
  private transition(work:WorkItem, state:WorkState, kind:string, detail:string):WorkItem {
    this.revoke(work.id);
    return this.save({...work,state,version:work.version + 1,blockers:state === 'blocked' ? [detail] : work.blockers,
      updatedAt:new Date(this.now()).toISOString()},kind,detail);
  }
  private revoke(workId:string):void {
    this.db.prepare("UPDATE work_outbox SET state='revoked',fence=fence+1,expires_at=NULL WHERE work_id=? AND state IN ('pending','claimed')").run(workId);
  }
  cancel(id:string, input:unknown):{work:WorkItem} {
    this.registry.validateContent(input);
    const value = workSchemas.cancel.parse(input);
    return this.db.transaction(() => {
      const work = this.get(id), scope = `work:cancel:${id}`;
      const previous = this.previous<{work:WorkItem}>(scope,value.clientRequestId,value);
      if (previous) return previous;
      if (work.version !== value.expectedVersion || terminal.has(work.state)) throw new ProjectError(409,'Work changed. Refresh before stopping.');
      const result = {work:this.transition(work,'cancelled','cancelled',value.reason)};
      this.remember(scope,value.clientRequestId,value,result);
      return result;
    }).immediate();
  }
  revokeProject(projectId:string):void {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT w.payload FROM work_items w JOIN work_outbox o ON o.work_id=w.id WHERE w.project_id=? AND o.state IN ('pending','claimed')").all(projectId) as Payload[];
      for (const row of rows) this.transition(JSON.parse(row.payload) as WorkItem,'blocked','authority_revoked','Project authority or semantic context changed. Fresh review and consent are required.');
    }).immediate();
  }
  private reconcile():void {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT w.payload FROM work_items w JOIN work_outbox o ON o.work_id=w.id WHERE o.state='claimed' AND o.phase='interpretation'").all() as Payload[];
      for (const row of rows) this.transition(JSON.parse(row.payload) as WorkItem,'blocked','interrupted','The previous interpretation was interrupted. It will not be retried automatically.');
    }).immediate();
  }
  private dispatchMaterial(work:WorkItem, outbox:Outbox, target:'codex'|'chatgpt'):Annotation {
    const annotation = this.annotation(work.annotationId), receipt = annotation.consentReceipt;
    const storedReceipt = this.db.prepare('SELECT payload FROM annotation_consent_receipts WHERE annotation_id=?').get(annotation.id) as Payload|undefined;
    const current = this.prepare(annotation);
    if (terminal.has(work.state) || annotation.dispatch.mode !== 'connected' || !annotation.dispatch.consent || !receipt ||
        receipt.annotationId !== annotation.id || receipt.annotationRevision !== annotation.revision || receipt.target !== annotation.target ||
        receipt.contextDigest !== annotation.dispatch.contextDigest || hash(annotation.materialJSON) !== receipt.contextDigest ||
        current.materialJSON !== annotation.materialJSON || current.grantRevision !== receipt.grantRevision || outbox.grant_revision !== receipt.grantRevision ||
        outbox.annotation_id !== annotation.id || !storedReceipt || storedReceipt.payload !== JSON.stringify(receipt)) throw new ProjectError(409,'Consent or selected context is no longer current');
    if (annotation.target !== 'automatic' && annotation.target !== target) throw new ProjectError(409,'The selected agent connection is unavailable');
    this.registry.validateContent(annotation.materialJSON);
    return annotation;
  }
  claim(id:string, target:'codex'|'chatgpt'):InterpretationClaim|null {
    return this.db.transaction(() => {
      const outbox = this.db.prepare("SELECT * FROM work_outbox WHERE work_id=? AND phase='interpretation'").get(id) as Outbox|undefined;
      if (!outbox || outbox.state !== 'pending') return null;
      let work:WorkItem;
      try { work = this.get(id); this.dispatchMaterial(work,outbox,target); }
      catch { this.blockPending(id,'Dispatch is blocked: connection, consent, future-note or project authority is unavailable.'); return null; }
      const lease:Lease = {workId:id,outboxId:outbox.id,fence:outbox.fence + 1,expiresAt:new Date(this.now() + 20_000).toISOString()};
      this.db.prepare("UPDATE work_outbox SET state='claimed',fence=?,expires_at=?,actual_target=? WHERE id=? AND state='pending'")
        .run(lease.fence,lease.expiresAt,target,outbox.id);
      const next = this.save({...work,state:'understanding',version:work.version + 1,blockers:[],updatedAt:new Date(this.now()).toISOString()},
        'interpretation_started','The explicitly selected in-process interpreter received this immutable material.');
      return {lease,workVersion:next.version,annotationId:work.annotationId,materialJSON:this.annotation(work.annotationId).materialJSON};
    }).immediate();
  }
  private blockPending(id:string, reason:string):void {
    const row = this.db.prepare('SELECT payload FROM work_items WHERE id=?').get(id) as Payload|undefined;
    if (row) {
      const work = JSON.parse(row.payload) as WorkItem;
      if (!terminal.has(work.state)) this.transition(work,'blocked','dispatch_blocked',reason);
    }
  }
  pendingIds():string[] {
    return (this.db.prepare("SELECT work_id FROM work_outbox WHERE state='pending' AND phase='interpretation' ORDER BY rowid").all() as {work_id:string}[]).map(row => row.work_id);
  }
  private validClaim(claim:InterpretationClaim):WorkItem|null {
    const row = this.db.prepare('SELECT * FROM work_outbox WHERE id=?').get(claim.lease.outboxId) as Outbox|undefined;
    if (!row || row.state !== 'claimed' || row.fence !== claim.lease.fence ||
        row.work_id !== claim.lease.workId || row.annotation_id !== claim.annotationId) return null;
    const work = this.get(claim.lease.workId);
    if (work.version !== claim.workVersion || work.annotationId !== claim.annotationId) return null;
    const expiresAt = row.expires_at ? Date.parse(row.expires_at) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.transition(work,'blocked','interpretation_expired','The interpretation lease expired. Its result was discarded and will not be retried automatically.');
      return null;
    }
    const target = this.db.prepare('SELECT actual_target FROM work_outbox WHERE id=?').get(row.id) as {actual_target:'codex'|'chatgpt'};
    this.dispatchMaterial(work,row,target.actual_target);
    return work;
  }
  finish(claim:InterpretationClaim, result:unknown):void {
    this.db.transaction(() => {
      let work:WorkItem|null;
      try { work = this.validClaim(claim); } catch { this.blockPending(claim.lease.workId,'Interpretation authority changed. Fresh consent is required.'); return; }
      if (!work) return;
      const next = this.interpreted(work,result);
      this.db.prepare("UPDATE work_outbox SET state='completed',expires_at=NULL WHERE id=? AND fence=?").run(claim.lease.outboxId,claim.lease.fence);
      this.save(next,'interpretation_recorded','Interpretation recorded. No execution or acceptance authority was granted.');
    }).immediate();
  }
  fail(claim:InterpretationClaim):void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT state,fence FROM work_outbox WHERE id=?').get(claim.lease.outboxId) as {state:string;fence:number}|undefined;
      if (row?.state === 'claimed' && row.fence === claim.lease.fence) this.blockPending(claim.lease.workId,'Interpretation is unavailable or invalid. It will not be retried automatically.');
    }).immediate();
  }
  private interpreted(work:WorkItem, input:unknown):WorkItem {
    this.registry.validateContent(input);
    const parsed = workSchemas.interpretation.parse(input);
    const annotation = this.annotation(work.annotationId), project = this.registry.resolveContext(work.context).project;
    const interpretation:Interpretation = {...parsed,acceptance:parsed.acceptance.map(item => ({
      id:hash(JSON.stringify({context:annotation.material.context,description:item.description})),description:item.description}))};
    const reason = interpretation.kind === 'implementation'
      ? `Implementation execution is unavailable${project.grant === 'read_only' ? ' under a read-only grant' : ''}; native isolation and a separate approved manifest are required.`
      : 'Interpretation is available; trusted acceptance or review is not available yet.';
    return {...work,interpretation,state:'blocked',version:work.version + 1,blockers:[reason],updatedAt:new Date(this.now()).toISOString()};
  }
  applyInterpretation(id:string, expectedVersion:number, input:Interpretation):WorkItem {
    return this.db.transaction(() => {
      const work = this.get(id);
      if (work.version !== expectedVersion || terminal.has(work.state)) throw new ProjectError(409,'Work changed. Refresh before interpreting.');
      const annotation = this.annotation(work.annotationId);
      if (annotation.dispatch.mode !== 'connected' || !annotation.consentReceipt) throw new ProjectError(403,'Local notes cannot receive a connected interpretation');
      this.recheck({input:annotation,material:annotation.material,materialJSON:annotation.materialJSON,grantRevision:annotation.consentReceipt.grantRevision});
      const next = this.interpreted(work,input);
      this.revoke(id);
      return this.save(next,'interpretation_recorded','Trusted interpretation recorded; execution and acceptance remain unavailable.');
    }).immediate();
  }
}
