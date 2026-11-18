import {
  digestSelectedAnnotationMaterial,
  type Annotation, type AnnotationInput, type AmendWorkInput, type Interpretation, type WorkItem,
  type Decision,type DecisionAction,type LocalActionSession,type Evidence,type EvidenceInput,
} from '@renvarel/architect-core';
import type {WorkStore} from './work-store.js';

// Constructor-only test seam. No HTTP/config flag can supply an adapter or make
// a connection ready. This interface interprets text; it cannot execute tools.
export type AnnotationInterpreter = {
  target:'codex'|'chatgpt';
  interpret(materialJSON:string):Promise<unknown>;
};

export class WorkController {
  constructor(private readonly store:WorkStore, private readonly interpreter?:AnnotationInterpreter) {}

  async submitAnnotation(input:AnnotationInput):Promise<{annotation:Annotation;work:WorkItem}> {
    const value = this.store.parseInput(input);
    const existing = this.store.replay('annotation:create',value);
    if (existing) return existing;
    const prepared = this.store.prepare(value);
    const digest = await digestSelectedAnnotationMaterial(prepared.material);
    return this.store.commit(prepared,digest);
  }
  async amendWork(workId:string, input:AmendWorkInput):Promise<{annotation:Annotation;work:WorkItem}> {
    const value = this.store.parseAmendment(input);
    this.store.get(workId);
    const existing = this.store.replay(`work:amend:${workId}`,value);
    if (existing) return existing;
    const prepared = this.store.prepare(this.store.annotationInput(value));
    const digest = await digestSelectedAnnotationMaterial(prepared.material);
    return this.store.commit(prepared,digest,{workId,input:value});
  }
  applyInterpretation(workId:string, expectedVersion:number, result:Interpretation):WorkItem {
    return this.store.applyInterpretation(workId,expectedVersion,result);
  }
  resolveDecision(id:string,input:DecisionAction,session:LocalActionSession):Decision{return this.store.resolveDecision(id,input,session);}
  recordEvidence(input:EvidenceInput):Evidence{return this.store.recordEvidence(input);}
  async dispatchPending(workId?:string):Promise<void> {
    if (!this.interpreter) return;
    for (const id of workId ? [workId] : this.store.pendingIds()) {
      const claim = this.store.claim(id,this.interpreter.target);
      if (!claim) continue;
      try { this.store.finish(claim,await this.interpreter.interpret(claim.materialJSON)); }
      catch { this.store.fail(claim); }
    }
  }
}
