import type {EvidenceView, StepVerification} from '@renvarel/architect-core';

export type StepVerificationInput = {
  stepId: string; requirementsKnown: boolean;
  requiredAcceptanceIds: readonly string[]; evidence: readonly EvidenceView[];
};

/** The caller resolves immutable binding freshness; client status is never coverage. */
export function projectStepVerification(input: StepVerificationInput): StepVerification {
  const base: StepVerification = {stepId: input.stepId, verification: 'not_checked', freshness: 'unknown',
    lastCheckedAt: null, evidenceIds: [], reason: 'Acceptance evidence is not available yet.'};
  if (!input.requirementsKnown || input.requiredAcceptanceIds.length === 0) return base;
  const eligible = input.evidence.filter(row => row.context.stepId === input.stepId && row.sourceClass === 'test_runtime' &&
    row.executionBindingId !== null && row.acceptanceId !== null && input.requiredAcceptanceIds.includes(row.acceptanceId) &&
    Number.isFinite(Date.parse(row.checkedAt)));
  const current = eligible.filter(row => row.freshness === 'current');
  if (current.length === 0) {
    if (eligible.length === 0) return base;
    return {...base, verification: 'stale', freshness: 'stale', evidenceIds: eligible.map(row => row.id),
      lastCheckedAt: eligible.map(row => row.checkedAt).sort().at(-1)!, reason: 'Acceptance evidence belongs to a previous binding.'};
  }
  const failed = current.some(row => row.outcome === 'failed');
  const complete = input.requiredAcceptanceIds.every(id => current.some(row => row.acceptanceId === id && row.outcome === 'passed'));
  return {...base, verification: failed ? 'failed' : complete ? 'verified' : 'checking', freshness: 'current',
    lastCheckedAt: current.map(row => row.checkedAt).sort().at(-1)!, evidenceIds: current.map(row => row.id),
    reason: failed ? 'Current acceptance evidence includes a failure.' : complete ? 'Current runtime evidence covers every required acceptance.' : 'Current runtime acceptance coverage is incomplete.'};
}
