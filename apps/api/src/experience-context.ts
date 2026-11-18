import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Annotation, ContextRef, ExecutionBinding, LocalActionSession, WorkItem, WorkState, Workflow} from '@renvarel/architect-core';
import type {Manifest} from '../../runner/src/index.js';
import {ProjectError, type ProjectStore} from './project-store.js';
import type {WorkStore} from './work-store.js';

export type RuntimeAuthority = Pick<ExecutionBinding,'repositoryId'|'baseCommit'|'sourceRevision'|'specDigest'|'specReceiptId'|'acceptanceDigest'|'acceptanceSnapshot'|'manifestDigest'> & {manifest:Manifest};
export type TrustedAuthorityReader = {current(work:Readonly<WorkItem>):RuntimeAuthority|null};
export type ExperienceStoreOptions = {authority?:TrustedAuthorityReader; now?:()=>number};
export const hash = (value:unknown):string => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value),'utf8').digest('hex');
export const identity=z.string().min(1).max(100);
export const revision=z.number().int().positive();
export const contextSchema=z.object({projectId:identity,itemId:identity.optional(),workflowId:identity.optional(),stepId:identity.optional(),specRevision:revision.optional(),mapRevision:revision}).strict();
export const timestamp=z.string().datetime();
export const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const contextFields={projectId:identity.optional(),itemId:identity.optional(),workflowId:identity.optional(),stepId:identity.optional()};
export const pagingFields={afterSequence:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),limit:z.coerce.number().int().min(1).max(100).optional()};
export type ContextFilter={projectId?:string;itemId?:string;workflowId?:string;stepId?:string};
export function canonicalContext(c:ContextRef):Record<string,unknown> {
  return {projectId:c.projectId,itemId:c.itemId??null,workflowId:c.workflowId??null,stepId:c.stepId??null,specRevision:c.specRevision??null,mapRevision:c.mapRevision};
}
export const sameContext=(a:ContextRef,b:ContextRef):boolean=>JSON.stringify(canonicalContext(a))===JSON.stringify(canonicalContext(b));
export const matches=(c:Pick<ContextRef,'projectId'|'itemId'|'workflowId'|'stepId'>,f:ContextFilter):boolean=>(!f.projectId||c.projectId===f.projectId)&&(!f.itemId||c.itemId===f.itemId)&&(!f.workflowId||c.workflowId===f.workflowId)&&(!f.stepId||c.stepId===f.stepId);

const authoritySchema=z.object({repositoryId:identity,baseCommit:z.string().regex(/^[a-f0-9]{40}$/),sourceRevision:identity,
  specDigest:digest,specReceiptId:identity,acceptanceDigest:digest,
  acceptanceSnapshot:z.array(z.object({id:identity,description:z.string().min(1).max(2000)}).strict()).min(1).max(100),manifestDigest:digest,
  manifest:z.object({workflowId:identity,specRevision:revision,specDigest:digest,specReceiptId:identity,repositoryId:identity,baseCommit:z.string().regex(/^[a-f0-9]{40}$/),
    allowedFiles:z.tuple([z.literal('calculator.mjs')]),acceptanceSuite:z.literal('calculator-v1'),acceptanceDigest:digest,maxSeconds:z.literal(600)}).strict()}).strict();

/** Common private-store primitives; all authority reads are synchronous and constructor-only. */
export class ExperienceContext {
  reconcile:()=>void=()=>{};
  private reading=false;
  readonly now:()=>number;
  constructor(readonly db:Database.Database,readonly registry:ProjectStore,readonly work:WorkStore,
    readonly workflow:(id:string)=>Workflow|null,private readonly options:ExperienceStoreOptions={}) {
    this.now=options.now??(()=>Date.now());
  }
  time():string{return new Date(this.now()).toISOString();}
  read<T>(fn:()=>T):T {
    if(this.reading)return fn();
    return this.db.transaction(()=>{this.reading=true;try{this.reconcile();return fn();}finally{this.reading=false;}}).immediate();
  }
  refresh():void{this.read(()=>undefined);}
  rawWork(id:string):WorkItem {
    const row=this.db.prepare('SELECT payload FROM work_items WHERE id=?').get(id) as {payload:string}|undefined;
    if(!row)throw new ProjectError(404,'Work not found');return JSON.parse(row.payload) as WorkItem;
  }
  annotation(id:string):Annotation {
    const row=this.db.prepare('SELECT payload FROM annotations WHERE id=?').get(id) as {payload:string}|undefined;
    if(!row)throw new ProjectError(404,'Annotation not found');return JSON.parse(row.payload) as Annotation;
  }
  audit(projectId:string,kind:string,detail:string,context?:ContextRef):void {
    this.db.prepare('INSERT INTO project_audit_events(project_id,kind,time,payload) VALUES (?,?,?,?)').run(projectId,kind,this.time(),JSON.stringify({summaryVersion:1,detail,context}));
  }
  event(w:WorkItem,kind:string,detail:string):void {
    this.db.prepare('INSERT INTO work_events(work_id,kind,time,detail) VALUES (?,?,?,?)').run(w.id,kind,this.time(),detail);
    this.audit(w.projectId,kind,detail,w.context);
  }
  change(w:WorkItem,state:WorkState,kind:string,detail:string):WorkItem {
    const next={...w,state,version:w.version+1,blockers:state==='blocked'?[detail]:[],updatedAt:this.time()};
    this.db.prepare('UPDATE work_items SET state=?,version=?,payload=? WHERE id=?').run(state,next.version,JSON.stringify(next),w.id);
    this.event(next,kind,detail);return next;
  }
  revokeOutbox(workId:string):void {
    this.db.prepare("UPDATE work_outbox SET state='revoked',fence=fence+1,expires_at=NULL WHERE work_id=? AND state IN ('pending','claimed')").run(workId);
  }
  requireSource(w:WorkItem):void {
    const source=this.registry.classifyWorkSource(w.context);
    const a=this.annotation(w.annotationId);
    if(source.scope==='future'||source.scope==='unknown'||a.intent==='future_plan')throw new ProjectError(403,'Future or unresolved work cannot receive runtime authority.');
  }
  material(w:WorkItem):Annotation {
    const a=this.annotation(w.annotationId),receipt=a.consentReceipt;
    const row=this.db.prepare('SELECT material_json,material_digest FROM annotations WHERE id=?').get(a.id) as {material_json:string;material_digest:string};
    const stored=this.db.prepare('SELECT payload FROM annotation_consent_receipts WHERE annotation_id=?').get(a.id) as {payload:string}|undefined;
    const current=this.work.prepare(a);
    if(!sameContext(a.context,w.context)||a.dispatch.mode!=='connected'||!a.dispatch.consent||!receipt||!stored||stored.payload!==JSON.stringify(receipt)||
      receipt.annotationId!==a.id||receipt.annotationRevision!==a.revision||receipt.contextDigest!==hash(a.materialJSON)||
      receipt.contextDigest!==a.dispatch.contextDigest||row.material_json!==a.materialJSON||row.material_digest!==receipt.contextDigest||
      current.materialJSON!==a.materialJSON||current.grantRevision!==receipt.grantRevision)throw new ProjectError(409,'Connected consent or selected material changed.');
    return a;
  }
  runtime(w:WorkItem):RuntimeAuthority {
    this.registry.requireExecution(w.context.workflowId??'');this.requireSource(w);this.material(w);
    if(!w.interpretation||w.interpretation.kind!=='implementation'||!['instruction','rule'].includes(this.annotation(w.annotationId).intent))throw new ProjectError(403,'Implementation interpretation is required.');
    const supplied=this.options.authority?.current(w);if(!supplied)throw new ProjectError(403,'Runtime authority is unavailable.');
    const a=authoritySchema.parse(supplied),m=a.manifest,workflow=this.workflow(w.context.workflowId??'');
    const receipt=this.db.prepare("SELECT specification_json FROM audit_events WHERE id=? AND workflow_id=? AND resulting_revision=? AND action='approve'").get(a.specReceiptId,w.context.workflowId,w.context.specRevision) as {specification_json:string}|undefined;
    if(!workflow||hash(workflow)!==a.specDigest||!receipt||hash(receipt.specification_json)!==a.specDigest||
      m.workflowId!==workflow.id||m.specRevision!==workflow.revision||m.specDigest!==a.specDigest||m.specReceiptId!==a.specReceiptId||
      m.repositoryId!==a.repositoryId||m.baseCommit!==a.baseCommit||m.acceptanceDigest!==a.acceptanceDigest||hash(m)!==a.manifestDigest||
      JSON.stringify(a.acceptanceSnapshot)!==JSON.stringify(w.interpretation.acceptance)||new Set(a.acceptanceSnapshot.map(x=>x.id)).size!==a.acceptanceSnapshot.length)throw new ProjectError(409,'Current runtime authority does not match the reviewed specification.');
    return a;
  }
  requireSession(s:LocalActionSession):void {
    const row=this.db.prepare('SELECT expires_at FROM local_sessions WHERE id=?').get(s.id) as {expires_at:string}|undefined;
    if(s.source!=='local-owner-session'||!row||row.expires_at!==s.expiresAt||Date.parse(row.expires_at)<=this.now())throw new ProjectError(403,'A current local action session is required.');
  }
  validateFilter(f:ContextFilter):void {
    if(f.projectId)this.registry.project(f.projectId);
    if(f.workflowId){const w=this.registry.workflow(f.workflowId);if(f.projectId&&w.projectId!==f.projectId)throw new ProjectError(404,'Workflow not found');}
    if(f.stepId&&(!f.workflowId||!this.registry.workflow(f.workflowId).steps.some(s=>s.id===f.stepId)))throw new ProjectError(404,'Step not found');
    if(f.itemId){const row=this.db.prepare('SELECT payload FROM project_items WHERE id=?').get(f.itemId) as {payload:string}|undefined;
      const i=row?JSON.parse(row.payload):null;if(!i||f.projectId&&i.projectId!==f.projectId)throw new ProjectError(404,'Item not found');
      const p=this.registry.project(i.projectId),w=f.workflowId?this.registry.workflow(f.workflowId):null;
      this.registry.resolveContext({projectId:p.id,itemId:f.itemId,mapRevision:p.mapRevision,
        ...(w?{workflowId:w.id,specRevision:w.revision}:{}),...(f.stepId?{stepId:f.stepId}:{})});}
  }
}
