import type {WorkDetailResponse} from '@renvarel/architect-core';
import type {ReactElement} from 'react';
import {verificationLabel} from '../workflows/WorkflowList';

export function EvidencePanel({detail}:{detail:WorkDetailResponse}):ReactElement {
  return <>
    <section aria-label="Evidence" className="evidence-panel"><h3>Evidence</h3>
      <p><span className="verification-badge">{verificationLabel(detail.verification)}</span> · Freshness: {detail.freshness}</p>
      {detail.evidence.length?<ul>{detail.evidence.map(row=><li key={row.id}>
        <p>{row.summary}</p><p>{row.sourceClass.replaceAll('_',' / ')} · {row.environment} · {row.outcome}</p>
        <p>Checked <time dateTime={row.checkedAt}>{new Date(row.checkedAt).toLocaleString()}</time> · {row.freshness}</p>
        {row.staleReason&&<p>{row.staleReason}</p>}
        <details><summary>Evidence provenance</summary><p>Source revision: {row.sourceRevision??'Unknown'}. Acceptance: {row.acceptanceId??'Not runtime acceptance'}.</p></details>
      </li>)}</ul>:<p className="helper">No evidence has been recorded. Acceptance evidence is not available yet.</p>}
    </section>
    <section aria-label="Deployment"><h3>Deployment</h3><p>Not observed</p><p className="helper">These results do not establish a release or a live deployment.</p></section>
  </>;
}
