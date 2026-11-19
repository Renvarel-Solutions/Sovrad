import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ContextRef,Decision,DecisionAction,DecisionBinding,DecisionExplanation,DecisionQuery,DecisionsResponse,LocalActionSession,WorkItem} from '@renvarel/architect-core';
import {ProjectError} from './project-store.js';
import {canonicalContext,contextFields,contextSchema,digest,ExperienceContext,hash,identity,matches,pagingFields,revision,sameContext,timestamp,type RuntimeAuthority} from './experience-context.js';

const prose=z.string().max(2000),nonempty=prose.min(1),money=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bindingSchema=z.object({specRevision:revision.nullable(),mapRevision:revision,grantRevision:revision,repositoryId:identity.nullable(),baseCommit:z.string().max(100).nullable(),
  action:identity,permissionScope:z.array(identity).max(20),expiresAt:timestamp,costCapMicros:money}).strict();
const explanationSchema=z.object({action:nonempty,reasonOutsideGrant:nonempty,expectedResult:nonempty,directEffects:z.array(nonempty).max(100),indirectEffects:z.array(nonempty).max(100),
  uncertainties:z.array(nonempty).max(100),cost:z.object({oneTimeMicros:money.nullable(),ongoingMicros:money.nullable(),capMicros:money,payer:nonempty}).strict(),
  failure:nonempty,interruption:nonempty,detection:nonempty,recovery:nonempty,backup:nonempty,irreversibility:nonempty,alternatives:z.array(nonempty).max(100),recommendation:nonempty}).strict();
const createSchema=z.object({clientRequestId:z.string().uuid(),projectId:identity,workId:z.string().uuid().nullable(),expectedWorkVersion:revision.nullable(),context:contextSchema,
  binding:bindingSchema,explanation:explanationSchema}).strict()
  .refine(value=>value.binding.costCapMicros===value.explanation.cost.capMicros,{message:'Cost caps must match.',path:['explanation','cost','capMicros']});
export const decisionActionSchema=z.object({clientRequestId:z.string().uuid(),expectedVersion:revision,proposalDigest:digest,action:z.enum(['approve','reject','request_revision']),reason:prose}).strict();
const querySchema=z.object({...contextFields,state:z.enum(['pending','approved','rejected','revision_requested','expired','superseded']).optional(),...pagingFields}).strict();
export type CreateDecisionInput={clientRequestId:string;projectId:string;workId:string|null;expectedWorkVersion:number|null;context:ContextRef;binding:DecisionBinding;explanation:DecisionExplanation};
type FrozenWork={workVersion:number;annotationId:string;annotationRevision:number;contextDigest:string;runtimeAuthority:RuntimeAuthority|null};
type Row={sequence:number;id:string;payload:string;frozen_json:string;digest_json:string;resolution_version:number|null};

export class DecisionStore {
  constructor(private readonly c:ExperienceContext){}
  raw(id:string):Decision {
    const row=this.c.db.prepare('SELECT payload FROM decisions WHERE id=?').get(id) as {payload:string}|undefined;
    if(!row)throw new ProjectError(404,'Decision not found');return JSON.parse(row.payload) as Decision;
  }
  private row(id:string):Row{return this.c.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) as Row;}
  private persist(d:Decision):void{this.c.db.prepare('UPDATE decisions SET status=?,payload=? WHERE id=?').run(d.status,JSON.stringify(d),d.id);}
  private replay(scope:string,key:string,input:unknown):string|null {
    const r=this.c.db.prepare('SELECT input_json,result_json FROM work_requests WHERE scope=? AND request_id=?').get(scope,key) as {input_json:string;result_json:string}|undefined;
    if(!r)return null;if(r.input_json!==JSON.stringify(input))throw new ProjectError(409,'Request key already used with different content.');
    return (JSON.parse(r.result_json) as {decisionId:string}).decisionId;
  }
  private remember(scope:string,key:string,input:unknown,id:string):void {
    this.c.db.prepare('INSERT INTO work_requests(scope,request_id,input_json,result_json) VALUES (?,?,?,?)').run(scope,key,JSON.stringify(input),JSON.stringify({decisionId:id}));
  }
  private validateContext(d:Pick<Decision,'projectId'|'context'|'binding'>):void {
    const p=this.c.registry.resolveContext(d.context).project,b=d.binding;
    if(p.id!==d.projectId)throw new ProjectError(404,'Project not found');
    if(p.grantRevision!==b.grantRevision||p.mapRevision!==b.mapRevision||(d.context.specRevision??null)!==b.specRevision)throw new ProjectError(409,'Decision context or grant changed.');
    if(b.action!=='synthetic_execute'&&(b.repositoryId!==null||b.baseCommit!==null))throw new ProjectError(400,'Non-runtime decisions cannot bind a repository.');
  }
  private runtime(w:WorkItem,b:DecisionBinding):RuntimeAuthority {
    const a=this.c.runtime(w);
    if(b.action!=='synthetic_execute'||JSON.stringify(b.permissionScope)!=='["synthetic_execute"]'||b.repositoryId!==a.repositoryId||b.baseCommit!==a.baseCommit)throw new ProjectError(409,'Decision runtime scope does not match current authority.');
    return a;
  }
  create(input:CreateDecisionInput):Decision {
    this.c.registry.validateContent(input);const v=createSchema.parse(input);this.c.refresh();
    return this.c.db.transaction(()=>{
      this.c.registry.project(v.projectId);
      const old=this.replay('decision:create',v.clientRequestId,v);if(old)return this.raw(old);
      if((v.workId===null)!==(v.expectedWorkVersion===null))throw new ProjectError(400,'Work and expected version must be supplied together.');
      let w=v.workId?this.c.rawWork(v.workId):null;
      if(w&&(w.projectId!==v.projectId||!sameContext(w.context,v.context)))throw new ProjectError(404,'Work context not found');
      if(w&&w.version!==v.expectedWorkVersion)throw new ProjectError(409,'Work changed. Refresh before requesting a decision.');
      if(w&&this.c.db.prepare("SELECT id FROM decisions WHERE work_id=? AND status='pending'").get(w.id))throw new ProjectError(409,'This work already has a pending decision.');
      this.validateContext(v);
      if(Date.parse(v.binding.expiresAt)<=this.c.now())throw new ProjectError(409,'Decision expired.');
      if(!w&&v.binding.action==='synthetic_execute')throw new ProjectError(403,'Runtime decisions require connected work.');
      const a=w&&v.binding.action==='synthetic_execute'?this.runtime(w,v.binding):null;
      if(w&&['cancelled','superseded','done'].includes(w.state))throw new ProjectError(409,'Terminal work cannot request a decision.');
      if(w)w=this.c.change(w,'needs_decision','decision_requested','An exact bounded decision is required.');
      const annotation=w?this.c.annotation(w.annotationId):null;
      const frozenWork:FrozenWork|null=w&&annotation?{workVersion:w.version,annotationId:annotation.id,annotationRevision:annotation.revision,contextDigest:annotation.dispatch.contextDigest,runtimeAuthority:a}:null;
      const bytes=JSON.stringify({projectId:v.projectId,workId:v.workId,context:canonicalContext(v.context),binding:v.binding,explanation:v.explanation,frozenWork});
      const d:Decision={id:randomUUID(),projectId:v.projectId,workId:v.workId,context:v.context,version:1,status:'pending',proposalDigest:hash(bytes),binding:v.binding,explanation:v.explanation,sequence:0,receipt:null};
      const result=this.c.db.prepare('INSERT INTO decisions(id,project_id,work_id,status,payload,frozen_json,digest_json) VALUES (?,?,?,?,?,?,?)').run(d.id,d.projectId,d.workId,d.status,JSON.stringify(d),JSON.stringify(frozenWork),bytes);
      d.sequence=Number(result.lastInsertRowid);this.persist(d);this.remember('decision:create',v.clientRequestId,v,d.id);
      this.c.audit(d.projectId,'decision_created','A bounded decision was requested.',d.context);return d;
    }).immediate();
  }
  private frozenValid(d:Decision):void {
    this.validateContext(d);if(!d.workId)return;
    const row=this.row(d.id),f=JSON.parse(row.frozen_json) as FrozenWork,w=this.c.rawWork(d.workId),a=this.c.annotation(w.annotationId);
    const expected=d.status==='pending'?f.workVersion:row.resolution_version;
    if(w.version!==expected||w.annotationId!==f.annotationId||a.revision!==f.annotationRevision||a.dispatch.contextDigest!==f.contextDigest||!sameContext(w.context,d.context))throw new ProjectError(409,'Decision work changed.');
    if(f.runtimeAuthority&&JSON.stringify(this.runtime(w,d.binding))!==JSON.stringify(f.runtimeAuthority))throw new ProjectError(409,'Runtime authority changed.');
  }
  resolve(id:string,input:DecisionAction,session:LocalActionSession):Decision {
    this.c.registry.validateContent(input);const v=decisionActionSchema.parse(input);
    const before=this.raw(id);this.c.registry.project(before.projectId);this.c.requireSession(session);
    if(before.status==='pending'&&v.expectedVersion===before.version&&v.proposalDigest===before.proposalDigest&&v.action==='approve'&&before.binding.action==='synthetic_execute'&&before.workId)this.c.requireSource(this.c.rawWork(before.workId));
    this.c.refresh();
    return this.c.db.transaction(()=>{
      const d=this.raw(id);this.c.registry.project(d.projectId);this.c.requireSession(session);
      const replay=this.replay(`decision:action:${id}`,v.clientRequestId,v);if(replay)return this.raw(replay);
      if(v.expectedVersion!==d.version||v.proposalDigest!==d.proposalDigest||d.status!=='pending'||Date.parse(d.binding.expiresAt)<=this.c.now())throw new ProjectError(409,'Decision changed or expired. Refresh before acting.');
      this.frozenValid(d);
      const next:Decision={...d,version:d.version+1,status:{approve:'approved',reject:'rejected',request_revision:'revision_requested'}[v.action] as Decision['status'],
        receipt:{id:randomUUID(),decisionId:d.id,decisionVersion:d.version+1,clientRequestId:v.clientRequestId,action:v.action,reason:v.reason,
          actor:'local-owner-session',sessionId:session.id,proposalDigest:d.proposalDigest,resolvedAt:this.c.time()}};
      this.persist(next);this.c.db.prepare('INSERT INTO decision_receipts(id,decision_id,session_id,payload) VALUES (?,?,?,?)').run(next.receipt!.id,id,session.id,JSON.stringify(next.receipt));
      if(d.workId){const w=this.c.rawWork(d.workId);this.c.revokeOutbox(w.id);
        const reason={approve:'Execution is unavailable; this approval does not launch work.',reject:'The request was rejected.',request_revision:'Revise and resubmit this request.'}[v.action];
        const updated=this.c.change(w,'blocked',`decision_${v.action}`,reason);
        this.c.db.prepare('UPDATE decisions SET resolution_version=? WHERE id=?').run(updated.version,id);}
      this.c.audit(d.projectId,`decision_${v.action}`,'A local owner session resolved this bounded request.',d.context);
      this.remember(`decision:action:${id}`,v.clientRequestId,v,id);return next;
    }).immediate();
  }
  invalidate(id:string,status:'expired'|'superseded'):void {
    const d=this.raw(id);if(!['pending','approved'].includes(d.status))return;
    this.persist({...d,status,version:d.version+1});this.c.audit(d.projectId,`decision_${status}`,'Decision authority is no longer current.',d.context);
    if(d.workId){const w=this.c.rawWork(d.workId);this.c.revokeOutbox(w.id);
      if(w.state==='needs_decision')this.c.change(w,'blocked',`decision_${status}`,'Decision authority changed. Review a fresh request.');}
  }
  reconcile():void {
    const rows=this.c.db.prepare("SELECT payload FROM decisions WHERE status IN ('pending','approved') ORDER BY sequence").all() as {payload:string}[];
    for(const row of rows){const d=JSON.parse(row.payload) as Decision;
      const consumed=this.c.db.prepare('SELECT l.state,l.completion,l.completion_at FROM execution_bindings b JOIN controller_leases l ON l.execution_binding_id=b.id WHERE b.decision_id=?').get(d.id) as {state:string;completion:string;completion_at:string}|undefined;
      if(consumed){if(consumed.state==='revoked')this.invalidate(d.id,Date.parse(d.binding.expiresAt)<=this.c.now()?'expired':'superseded');continue;}
      if(Date.parse(d.binding.expiresAt)<=this.c.now()){this.invalidate(d.id,'expired');continue;}
      try{this.frozenValid(d);}catch{this.invalidate(d.id,'superseded');}
    }
  }
  all():Decision[]{return (this.c.db.prepare('SELECT payload FROM decisions ORDER BY sequence').all() as {payload:string}[]).map(r=>JSON.parse(r.payload) as Decision);}
  permitted(filter:DecisionQuery={}):Decision[]{
    this.c.validateFilter(filter);const ids=new Set(this.c.registry.list().map(p=>p.id));
    return this.all().filter(d=>ids.has(d.projectId)&&matches(d.context,filter)&&(!filter.state||d.status===filter.state));
  }
  list(input:unknown):DecisionsResponse {
    this.c.registry.validateContent(input);const q=querySchema.parse(input);
    return this.c.read(()=>{const all=this.permitted(q),limit=q.limit??50,after=q.afterSequence??0,remaining=all.filter(d=>d.sequence>after),decisions=remaining.slice(0,limit);
      const filter={projectId:q.projectId??null,itemId:q.itemId??null,workflowId:q.workflowId??null,stepId:q.stepId??null,state:q.state??null,limit};
      return {decisions,total:all.length,page:{limit,hasMore:remaining.length>limit,nextAfterSequence:decisions.at(-1)?.sequence??after,
        viewDigest:hash({filter,rows:all.map(({id,sequence,version,status})=>({id,sequence,version,status}))})}};});
  }
  pending(filter:DecisionQuery={}):Decision[]{return this.permitted({...filter,state:'pending'});}
}
