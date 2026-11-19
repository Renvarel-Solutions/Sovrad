import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Evidence,EvidenceInput,EvidenceView,ExecutionBinding,SequencePage,StepVerification,WorkItem,Workflow} from '@renvarel/architect-core';
import {ProjectError} from './project-store.js';
import {contextFields,contextSchema,ExperienceContext,identity,matches,pagingFields,revision,timestamp,type ContextFilter} from './experience-context.js';
import type {ControllerLease,ExecutionBindingStore} from './execution-binding-store.js';
import {aggregateVerification,projectStepVerification} from './verification-projection.js';
const outcome=z.enum(['passed','failed','not_checked']);
const common={environment:z.string().min(1).max(500),checkedAt:timestamp,outcome,summary:z.string().min(1).max(2000)};
const runtime=z.object({kind:z.literal('runtime'),executionBindingId:z.string().uuid(),attemptId:z.string().uuid(),leaseFence:revision,
  sourceClass:z.enum(['observed_code','test_runtime']),acceptanceId:identity.nullable(),...common}).strict();
const knowledge=z.object({kind:z.literal('knowledge'),projectId:identity,workId:z.string().uuid().nullable(),context:contextSchema,
  sourceClass:z.enum(['owner_spec','observed_code','documentation','plan','inference','unknown']),sourceRevision:z.string().max(100).nullable(),...common}).strict();
const inputSchema=z.discriminatedUnion('kind',[runtime,knowledge]);
const querySchema=z.object({...contextFields,...pagingFields,state:outcome.optional()}).strict();
type EvidenceRow={payload:string;sequence:number};
export class EvidenceStore {
  constructor(private readonly c:ExperienceContext,private readonly bindings:ExecutionBindingStore){}
  private all():EvidenceRow[]{return this.c.db.prepare('SELECT payload,sequence FROM project_evidence ORDER BY sequence').all() as EvidenceRow[];}
  private rawView(row:EvidenceRow):EvidenceView&{sequence:number} {
    const e=JSON.parse(row.payload) as Evidence;
    const l=e.executionBindingId?this.bindings.lease(e.executionBindingId):null;
    const current=!!l&&l.state!=='revoked';
    return {...e,sequence:row.sequence,freshness:current?'current':'historical',staleReason:current?null:'Evidence is unbound or belongs to a previous runtime authority.'};
  }
  view(id:string):EvidenceView {
    return this.c.read(()=>{const row=this.c.db.prepare('SELECT payload,sequence FROM project_evidence WHERE id=?').get(id) as EvidenceRow|undefined;
      if(!row)throw new ProjectError(404,'Evidence not found');const e=this.rawView(row);this.c.registry.project(e.projectId);return e;});
  }
  forWork(workId:string):EvidenceView[]{return this.c.read(()=>{const w=this.c.rawWork(workId);this.c.registry.project(w.projectId);return this.all().map(r=>this.rawView(r)).filter(e=>e.workId===workId);});}
  record(input:EvidenceInput):Evidence {
    this.c.registry.validateContent(input);const v=inputSchema.parse(input);this.c.refresh();
    return this.c.db.transaction(()=>{
      // A different writer may have committed after refresh. Reconcile again
      // under this same writer reservation before capturing or advancing a lease.
      this.c.reconcile();
      let e:Evidence,b:ExecutionBinding|null=null,l:ControllerLease|null=null;
      if(v.kind==='runtime'){
        const captured=this.bindings.capturedEvidence({executionBindingId:v.executionBindingId,attemptId:v.attemptId,leaseFence:v.leaseFence});b=captured.binding;l=captured.lease;
        this.c.registry.project(b.projectId);
        if(v.acceptanceId!==null&&!b.acceptanceSnapshot.some(a=>a.id===v.acceptanceId))throw new ProjectError(409,'Acceptance is not part of this frozen attempt.');
        e={id:randomUUID(),projectId:b.projectId,workId:b.workId,context:structuredClone(b.context),sourceClass:v.sourceClass,sourceRevision:b.sourceRevision,
          environment:v.environment,checkedAt:v.checkedAt,acceptanceId:v.acceptanceId,outcome:v.outcome,summary:v.summary,executionBindingId:b.id};
      }else{
        this.c.registry.resolveContext(v.context);if(v.context.projectId!==v.projectId)throw new ProjectError(404,'Project not found');
        if(v.workId&&this.c.rawWork(v.workId).projectId!==v.projectId)throw new ProjectError(404,'Work not found');
        e={id:randomUUID(),projectId:v.projectId,workId:v.workId,context:v.context,sourceClass:v.sourceClass,sourceRevision:v.sourceRevision,
          environment:v.environment,checkedAt:v.checkedAt,acceptanceId:null,outcome:v.outcome,summary:v.summary,executionBindingId:null};
      }
      const sequence=(this.c.db.prepare('SELECT coalesce(max(sequence),0)+1 AS next FROM project_evidence').get() as {next:number}).next;
      this.c.db.prepare('INSERT INTO project_evidence(id,project_id,work_id,execution_binding_id,payload,sequence) VALUES (?,?,?,?,?,?)').run(e.id,e.projectId,e.workId,e.executionBindingId,JSON.stringify(e),sequence);
      this.c.audit(e.projectId,'evidence_recorded','Bounded evidence was recorded.',e.context);
      if(e.workId)this.c.event(this.c.rawWork(e.workId),'evidence_recorded','Evidence was retained with its original provenance.');
      if(b&&l&&l.state!=='revoked')this.bindings.updateCoverage(b,l);
      return e;
    }).immediate();
  }
  coverage(binding:ExecutionBinding,lease:ControllerLease):StepVerification {
    const evidence=this.all().map(r=>this.rawView(r)).filter(e=>e.executionBindingId===binding.id);
    return projectStepVerification({stepId:binding.context.stepId??'',requirementsKnown:binding.acceptanceSnapshot.length>0,
      requiredAcceptanceIds:binding.acceptanceSnapshot.map(a=>a.id),evidence,
      runtimeCompletion:lease.state==='active'?'active':lease.completion==='completed'?'completed_success':lease.completion==='failed'?'completed_failure':'unknown',
      bindingFreshness:lease.state==='revoked'?'historical':'current'});
  }
  workProjection(w:WorkItem):StepVerification {
    const row=this.c.db.prepare("SELECT execution_binding_id FROM controller_leases WHERE work_id=? AND state!='revoked'").get(w.id) as {execution_binding_id:string}|undefined;
    if(row)return this.coverage(this.bindings.raw(row.execution_binding_id)!,this.bindings.lease(row.execution_binding_id)!);
    const previous=this.c.db.prepare('SELECT id FROM execution_bindings WHERE work_id=? ORDER BY rowid DESC LIMIT 1').get(w.id) as {id:string}|undefined;
    if(previous){const binding=this.bindings.raw(previous.id),lease=this.bindings.lease(previous.id);if(binding&&lease)return this.coverage(binding,lease);}
    let stale=!!previous;
    if(this.required(w)&&this.c.registry.classifyWorkSource(w.context).scope!=='unknown')try{this.c.registry.resolveContext(w.context);}catch{stale=true;}
    return projectStepVerification({stepId:w.context.stepId??'',requirementsKnown:false,requiredAcceptanceIds:[],evidence:[],bindingFreshness:stale?'historical':'unknown'});
  }
  private required(w:WorkItem):boolean {
    const a=this.c.annotation(w.annotationId);
    if(w.interpretation?.kind!=='implementation'||a.dispatch.mode!=='connected'||!a.consentReceipt||!['instruction','rule'].includes(a.intent)||['cancelled','superseded'].includes(w.state))return false;
    if(!this.c.db.prepare('SELECT annotation_id FROM annotation_consent_receipts WHERE annotation_id=?').get(a.id))return false;
    const later=this.c.db.prepare('WITH RECURSIVE descendants(id) AS (SELECT id FROM annotations WHERE supersedes_id=? UNION ALL SELECT a.id FROM annotations a JOIN descendants d ON a.supersedes_id=d.id) SELECT id FROM descendants LIMIT 1').get(a.id);
    if(later)return false;
    return this.c.registry.classifyWorkSource(w.context).scope!=='future';
  }
  stepVerification(w:Workflow):StepVerification[] {
    return this.c.read(()=>{
      const works=(this.c.db.prepare('SELECT payload FROM work_items WHERE project_id=?').all(w.projectId) as {payload:string}[]).map(r=>JSON.parse(r.payload) as WorkItem);
      return w.steps.map(s=>aggregateVerification(s.id,works.filter(x=>x.context.workflowId===w.id&&x.context.stepId===s.id&&this.required(x)).map(x=>this.workProjection(x))));
    });
  }
  list(input:unknown):{evidence:EvidenceView[];total:number;page:SequencePage} {
    this.c.registry.validateContent(input);const q=querySchema.parse(input);
    return this.c.read(()=>{this.c.validateFilter(q);const ids=new Set(this.c.registry.list().map(p=>p.id));
      const all=this.all().map(r=>this.rawView(r)).filter(e=>ids.has(e.projectId)&&matches(e.context,q)&&(!q.state||e.outcome===q.state));
      const after=q.afterSequence??0,limit=q.limit??50,remaining=all.filter(e=>e.sequence>after),evidence=remaining.slice(0,limit);
      return {evidence,total:all.length,page:{limit,hasMore:remaining.length>limit,nextAfterSequence:evidence.at(-1)?.sequence??after}};});
  }
  activity(input:unknown):{events:{sequence:number;kind:string;time:string;detail:string}[];nextAfterSequence:number} {
    this.c.registry.validateContent(input);const q=z.object({...contextFields,...pagingFields}).strict().parse(input);
    return this.c.read(()=>{this.c.validateFilter(q);const ids=new Set(this.c.registry.list().map(p=>p.id)),after=q.afterSequence??0;
      const rows=this.c.db.prepare('SELECT * FROM project_audit_events ORDER BY sequence').all() as {sequence:number;project_id:string;kind:string;time:string;payload:string}[];
      const events=rows.filter(r=>{if(!ids.has(r.project_id)||r.sequence<=after)return false;const p=JSON.parse(r.payload) as {context?:ContextFilter};
        return matches({projectId:r.project_id,...p.context},q);}).slice(0,q.limit??50).map(r=>({sequence:r.sequence,kind:r.kind,time:r.time,detail:this.safeDetail(r.payload)}));
      return {events,nextAfterSequence:events.at(-1)?.sequence??after};});
  }
  private safeDetail(payload:string):string {
    const p=JSON.parse(payload) as {summaryVersion?:number;detail?:string};
    return p.summaryVersion===1&&p.detail&&p.detail.length<=2000?p.detail:'A project change was recorded.';
  }
}
