import type {EvidenceView, StepVerification} from '@renvarel/architect-core';

export type StepVerificationInput = {
  stepId: string; requirementsKnown: boolean;
  requiredAcceptanceIds: readonly string[]; evidence: readonly EvidenceView[];
  runtimeCompletion?: 'unknown'|'active'|'completed_success'|'completed_failure';
  bindingFreshness?: 'current'|'historical'|'unknown';
};

/** The caller resolves immutable binding freshness; client status is never coverage. */
export function projectStepVerification(input: StepVerificationInput): StepVerification {
  const base: StepVerification = {stepId: input.stepId, verification: 'not_checked', freshness: 'unknown',
    lastCheckedAt: null, evidenceIds: [], reason: 'Acceptance evidence is not available yet.',pendingDecisionCount:0};
  const eligible = input.evidence.filter(row => (row.context.stepId??'') === input.stepId && row.sourceClass === 'test_runtime' &&
    row.executionBindingId !== null && row.acceptanceId !== null && input.requiredAcceptanceIds.includes(row.acceptanceId) &&
    Number.isFinite(Date.parse(row.checkedAt)));
  if(input.bindingFreshness==='historical')return {...base,verification:'stale',freshness:'stale',evidenceIds:eligible.map(row=>row.id),
    lastCheckedAt:eligible.map(row=>row.checkedAt).sort().at(-1)??null,reason:'Acceptance evidence belongs to a previous binding.'};
  if (!input.requirementsKnown || input.requiredAcceptanceIds.length === 0) return base;
  const current = eligible.filter(row => row.freshness === 'current');
  if(input.runtimeCompletion==='completed_failure')return {...base,verification:'failed',freshness:input.bindingFreshness==='current'?'current':'unknown',
    evidenceIds:current.map(row=>row.id),lastCheckedAt:current.map(row=>row.checkedAt).sort().at(-1)??null,reason:'The runtime did not complete successfully.'};
  if (current.length === 0) {
    if (eligible.length === 0) return base;
    return {...base, verification: 'stale', freshness: 'stale', evidenceIds: eligible.map(row => row.id),
      lastCheckedAt: eligible.map(row => row.checkedAt).sort().at(-1)!, reason: 'Acceptance evidence belongs to a previous binding.'};
  }
  const failed = current.some(row => row.outcome === 'failed');
  const complete = input.requiredAcceptanceIds.every(id => current.some(row => row.acceptanceId === id && row.outcome === 'passed'));
  const succeeded=input.runtimeCompletion==='completed_success'&&input.bindingFreshness==='current';
  return {...base, verification: failed ? 'failed' : complete&&succeeded ? 'verified' : 'checking', freshness: 'current',
    lastCheckedAt: current.map(row => row.checkedAt).sort().at(-1)!, evidenceIds: current.map(row => row.id),
    reason: failed ? 'Current acceptance evidence includes a failure.' : complete ? succeeded?'Current runtime evidence covers every required acceptance.':'Runtime completion has not been confirmed.' : 'Current runtime acceptance coverage is incomplete.'};
}

export function aggregateVerification(stepId:string,rows:readonly StepVerification[]):StepVerification {
  const base=projectStepVerification({stepId,requirementsKnown:false,requiredAcceptanceIds:[],evidence:[]});
  if(rows.length===0)return base;
  const order=['failed','checking','stale','not_checked','verified'] as const;
  const verification=order.find(v=>rows.some(r=>r.verification===v))!;
  const freshness=rows.some(r=>r.freshness==='stale')?'stale':rows.every(r=>r.freshness==='current')?'current':'unknown';
  return {...base,verification,freshness,evidenceIds:[...new Set(rows.flatMap(r=>r.evidenceIds))],
    lastCheckedAt:rows.flatMap(r=>r.lastCheckedAt?[r.lastCheckedAt]:[]).sort().at(-1)??null,
    reason:rows.find(r=>r.verification===verification)!.reason};
}
