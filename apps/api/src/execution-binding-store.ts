import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ExecutionBinding,Lease,StepVerification,WorkItem} from '@renvarel/architect-core';
import {ProjectError} from './project-store.js';
import {ExperienceContext,revision,type RuntimeAuthority} from './experience-context.js';
import type {DecisionStore} from './decision-store.js';
export type {RuntimeAuthority,TrustedAuthorityReader,ExperienceStoreOptions} from './experience-context.js';

export type FreezeExecutionInput={workId:string;expectedVersion:number;decisionId:string};
export type RuntimeHandle=Readonly<{executionBindingId:string;attemptId:string;leaseFence:number}>;
export type RuntimeCompletion={handle:RuntimeHandle;outcome:'completed'|'failed'};
export type ControllerLease={execution_binding_id:string;work_id:string;outbox_id:string;fence:number;expected_work_version:number;expires_at:string;
  state:'active'|'completed'|'revoked';completion:'completed'|'failed'|null;completion_at:string|null;revoked_at:string|null;revocation_reason:string|null};
const handleSchema=z.object({executionBindingId:z.string().uuid(),attemptId:z.string().uuid(),leaseFence:revision}).strict();
const freezeSchema=z.object({workId:z.string().uuid(),expectedVersion:revision,decisionId:z.string().uuid()}).strict();

export class ExecutionBindingStore {
  coverage:(binding:ExecutionBinding,lease:ControllerLease)=>StepVerification=()=>{throw new Error('Coverage reader is not initialized');};
  constructor(private readonly c:ExperienceContext,private readonly decisions:DecisionStore){}
  raw(id:string):ExecutionBinding|null {
    const row=this.c.db.prepare('SELECT payload FROM execution_bindings WHERE id=?').get(id) as {payload:string}|undefined;
    return row?JSON.parse(row.payload) as ExecutionBinding:null;
  }
  lease(id:string):ControllerLease|null{return this.c.db.prepare('SELECT * FROM controller_leases WHERE execution_binding_id=?').get(id) as ControllerLease??null;}
  private bindingRow(id:string):{decision_id:string;authority_json:string}|undefined {
    return this.c.db.prepare('SELECT decision_id,authority_json FROM execution_bindings WHERE id=?').get(id) as {decision_id:string;authority_json:string}|undefined;
  }
  private authorityMatches(b:ExecutionBinding,l:ControllerLease):void {
    const row=this.bindingRow(b.id)!,d=this.decisions.raw(row.decision_id),w=this.c.rawWork(b.workId),a=this.c.runtime(w);
    if(w.version!==l.expected_work_version||w.annotationId!==b.annotationId||l.fence!==b.leaseFence||d.status!=='approved'||!d.receipt||
      JSON.stringify(a)!==row.authority_json||w.projectId!==b.projectId||JSON.stringify(w.context)!==JSON.stringify(b.context)||
      this.c.registry.project(b.projectId).grantRevision!==b.grantRevision)throw new ProjectError(409,'Runtime binding is no longer current.');
    const receipt=this.c.db.prepare('SELECT payload FROM decision_receipts WHERE decision_id=?').get(d.id) as {payload:string}|undefined;
    if(!receipt||receipt.payload!==JSON.stringify(d.receipt))throw new ProjectError(409,'Owner decision receipt changed.');
    const success=l.state==='completed'&&l.completion==='completed'&&l.completion_at!==null&&Date.parse(l.completion_at)<Date.parse(d.binding.expiresAt);
    if(!success&&(Date.parse(d.binding.expiresAt)<=this.c.now()||l.state==='active'&&Date.parse(l.expires_at)<=this.c.now()))throw new ProjectError(409,'Runtime lease or decision expired.');
  }
  private revoke(b:ExecutionBinding,l:ControllerLease,reason:string):void {
    if(l.state==='revoked')return;
    this.c.db.prepare("UPDATE controller_leases SET state='revoked',revoked_at=?,revocation_reason=? WHERE execution_binding_id=?").run(this.c.time(),reason,b.id);
    this.c.revokeOutbox(b.workId);const w=this.c.rawWork(b.workId);
    if(['done','working','checking'].includes(w.state))this.c.change(w,'blocked','runtime_revoked',reason);
    this.c.audit(b.projectId,'runtime_revoked',reason,b.context);
    const d=this.decisions.raw(this.bindingRow(b.id)!.decision_id);
    const completedBeforeExpiry=l.state==='completed'&&l.completion==='completed'&&l.completion_at!==null&&Date.parse(l.completion_at)<Date.parse(d.binding.expiresAt);
    this.decisions.invalidate(d.id,!completedBeforeExpiry&&Date.parse(d.binding.expiresAt)<=this.c.now()?'expired':'superseded');
  }
  reconcileCurrent(projectIds?:readonly string[]):void {
    const rows=this.c.db.prepare("SELECT b.payload,l.* FROM execution_bindings b JOIN controller_leases l ON l.execution_binding_id=b.id WHERE l.state!='revoked'").all() as (ControllerLease&{payload:string})[];
    for(const row of rows){const b=JSON.parse(row.payload) as ExecutionBinding;if(projectIds&&!projectIds.includes(b.projectId))continue;
      try{this.authorityMatches(b,row);}catch{this.revoke(b,row,'Runtime authority, context or lease changed. Fresh review is required.');}}
  }
  revokeProject(projectId:string):void {
    const rows=this.c.db.prepare("SELECT b.payload,l.* FROM execution_bindings b JOIN controller_leases l ON l.execution_binding_id=b.id JOIN work_items w ON w.id=b.work_id WHERE l.state!='revoked' AND w.project_id=?").all(projectId) as (ControllerLease&{payload:string})[];
    for(const row of rows)this.revoke(JSON.parse(row.payload) as ExecutionBinding,row,'Project authority changed. Fresh review is required.');
  }
  interruptActive():void {
    const rows=this.c.db.prepare("SELECT execution_binding_id FROM controller_leases WHERE state='active'").all() as {execution_binding_id:string}[];
    for(const r of rows){const b=this.raw(r.execution_binding_id)!;this.revoke(b,this.lease(b.id)!,'The previous runtime was interrupted; it will not resume automatically.');}
  }
  private captured(handle:RuntimeHandle):{binding:ExecutionBinding;lease:ControllerLease} {
    const h=handleSchema.parse(handle),b=this.raw(h.executionBindingId),l=b?this.lease(b.id):null;
    if(!b||!l||b.attemptId!==h.attemptId||b.leaseFence!==h.leaseFence)throw new ProjectError(409,'Unknown or mismatched runtime attempt.');
    return {binding:b,lease:l};
  }
  freeze(input:FreezeExecutionInput):{binding:ExecutionBinding;handle:RuntimeHandle} {
    this.c.registry.validateContent(input);const v=freezeSchema.parse(input);this.c.refresh();
    return this.c.db.transaction(()=>{
      const w=this.c.rawWork(v.workId);this.c.registry.project(w.projectId);this.c.requireSource(w);
      const d=this.decisions.raw(v.decisionId),row=this.c.db.prepare('SELECT frozen_json,resolution_version FROM decisions WHERE id=?').get(d.id) as {frozen_json:string;resolution_version:number};
      const a=this.c.runtime(w),frozen=JSON.parse(row.frozen_json) as {runtimeAuthority:RuntimeAuthority|null};
      if(w.version!==v.expectedVersion||w.version!==row.resolution_version||d.workId!==w.id||d.projectId!==w.projectId||d.status!=='approved'||d.receipt?.action!=='approve'||
        Date.parse(d.binding.expiresAt)<=this.c.now()||['done','cancelled','superseded'].includes(w.state)||
        d.binding.action!=='synthetic_execute'||JSON.stringify(d.binding.permissionScope)!=='["synthetic_execute"]'||JSON.stringify(a)!==JSON.stringify(frozen.runtimeAuthority))throw new ProjectError(409,'A current unused owner approval is required.');
      const receipt=this.c.db.prepare('SELECT payload FROM decision_receipts WHERE decision_id=?').get(d.id) as {payload:string}|undefined;
      if(!receipt||receipt.payload!==JSON.stringify(d.receipt)||this.c.db.prepare('SELECT id FROM execution_bindings WHERE decision_id=?').get(d.id))throw new ProjectError(409,'This owner approval is unavailable or already consumed.');
      if(this.c.db.prepare("SELECT execution_binding_id FROM controller_leases WHERE state='active'").get())throw new ProjectError(409,'Another implementation is already active.');
      const outbox=this.c.db.prepare('SELECT id,fence FROM work_outbox WHERE work_id=?').get(w.id) as {id:string;fence:number}|undefined;
      if(!outbox)throw new ProjectError(409,'Connected dispatch is required.');
      const old=this.c.db.prepare("SELECT execution_binding_id FROM controller_leases WHERE work_id=? AND state!='revoked'").get(w.id) as {execution_binding_id:string}|undefined;
      if(old)this.revoke(this.raw(old.execution_binding_id)!,this.lease(old.execution_binding_id)!,'A fresh reviewed attempt replaced this binding.');
      const fence=outbox.fence+1,next=this.c.change(w,'working','runtime_frozen','The trusted synthetic attempt was bound. No native process was launched.'),annotation=this.c.annotation(w.annotationId);
      const binding:ExecutionBinding={id:randomUUID(),attemptId:randomUUID(),workId:w.id,workVersion:next.version,annotationId:w.annotationId,annotationRevision:annotation.revision,
        projectId:w.projectId,context:structuredClone(w.context),grantRevision:this.c.registry.project(w.projectId).grantRevision,
        repositoryId:a.repositoryId,baseCommit:a.baseCommit,sourceRevision:a.sourceRevision,specDigest:a.specDigest,specReceiptId:a.specReceiptId,
        acceptanceDigest:a.acceptanceDigest,acceptanceSnapshot:structuredClone(a.acceptanceSnapshot),manifestDigest:a.manifestDigest,leaseFence:fence,createdAt:this.c.time()};
      const expires=new Date(this.c.now()+20_000).toISOString();
      this.c.db.prepare('INSERT INTO execution_bindings(id,attempt_id,work_id,decision_id,payload,authority_json,consumed_at) VALUES (?,?,?,?,?,?,?)').run(binding.id,binding.attemptId,w.id,d.id,JSON.stringify(binding),JSON.stringify(a),this.c.time());
      this.c.db.prepare("UPDATE work_outbox SET phase='runtime',state='claimed',fence=?,expires_at=?,actual_target=? WHERE id=?").run(fence,expires,annotation.target==='automatic'?'codex':annotation.target,outbox.id);
      this.c.db.prepare("INSERT INTO controller_leases(execution_binding_id,work_id,outbox_id,fence,expected_work_version,expires_at,state) VALUES (?,?,?,?,?,?,'active')").run(binding.id,w.id,outbox.id,fence,next.version,expires);
      return {binding,handle:{executionBindingId:binding.id,attemptId:binding.attemptId,leaseFence:fence}};
    }).immediate();
  }
  heartbeat(handle:RuntimeHandle):Lease {
    this.c.refresh();return this.c.db.transaction(()=>{const {binding:b,lease:l}=this.captured(handle);
      if(l.state!=='active')throw new ProjectError(409,'Runtime is not active.');this.authorityMatches(b,l);
      const expiresAt=new Date(this.c.now()+20_000).toISOString();this.c.db.prepare('UPDATE controller_leases SET expires_at=? WHERE execution_binding_id=?').run(expiresAt,b.id);
      this.c.db.prepare('UPDATE work_outbox SET expires_at=? WHERE id=?').run(expiresAt,l.outbox_id);
      return {workId:b.workId,outboxId:l.outbox_id,fence:l.fence,expiresAt};}).immediate();
  }
  complete(input:RuntimeCompletion):WorkItem {
    this.c.registry.validateContent(input);const v=z.object({handle:handleSchema,outcome:z.enum(['completed','failed'])}).strict().parse(input);this.c.refresh();
    return this.c.db.transaction(()=>{const {binding:b,lease:l}=this.captured(v.handle);
      if(l.state!=='active')throw new ProjectError(409,'Runtime is no longer active.');this.authorityMatches(b,l);
      this.c.db.prepare("UPDATE controller_leases SET state='completed',completion=?,completion_at=? WHERE execution_binding_id=?").run(v.outcome,this.c.time(),b.id);
      this.c.db.prepare("UPDATE work_outbox SET state='completed' WHERE id=?").run(l.outbox_id);
      return this.updateCoverage(b,this.lease(b.id)!,true);
    }).immediate();
  }
  updateCoverage(b:ExecutionBinding,l:ControllerLease,completion=false):WorkItem {
    const w=this.c.rawWork(b.workId);if(l.state!=='completed')return w;
    if(w.version!==l.expected_work_version||['cancelled','superseded'].includes(w.state)){
      this.revoke(b,l,'The runtime Work version chain changed. Fresh review is required.');return this.c.rawWork(b.workId);
    }
    const p=this.coverage(b,l),state=l.completion==='failed'||p.verification==='failed'?'blocked':p.verification==='verified'?'done':'checking';
    if(!completion&&w.state===state)return w;
    const next=this.c.change(w,state,completion?'runtime_completed':'coverage_changed',state==='done'?'Current acceptance passed after successful runtime completion.':state==='blocked'?'Runtime or acceptance failed.':'Runtime completed; acceptance evidence is incomplete.');
    this.c.db.prepare('UPDATE controller_leases SET expected_work_version=? WHERE execution_binding_id=?').run(next.version,b.id);return next;
  }
  current(workId:string):ExecutionBinding|null {
    return this.c.read(()=>{const row=this.c.db.prepare("SELECT execution_binding_id FROM controller_leases WHERE work_id=? AND state!='revoked'").get(workId) as {execution_binding_id:string}|undefined;return row?this.raw(row.execution_binding_id):null;});
  }
  capturedEvidence(handle:RuntimeHandle):{binding:ExecutionBinding;lease:ControllerLease}{return this.captured(handle);}
}
