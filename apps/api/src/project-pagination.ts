import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {OverviewFilter} from '@renvarel/architect-core';

const processKey = randomBytes(32);
const staleMessage = 'This list changed. Refresh to continue.';
export type ProjectCursorBinding = {
  namespace: 'overview' | 'management'; projectId: string | null;
  mapRevision: number | null; grantRevision: number | null; filter: string; viewDigest: string;
};
export class ProjectPaginationError extends Error {
  readonly code?: 'STALE_CURSOR';
  constructor(readonly status: 400 | 409) {
    super(status === 409 ? staleMessage : 'Invalid list cursor');
    if (status === 409) this.code = 'STALE_CURSOR';
  }
}

export function canonicalOverviewFilter(projectId: string, input: OverviewFilter): string {
  return JSON.stringify({projectId,development:input.development ?? null,q:input.q ?? '',itemId:input.itemId ?? null,
    workflowId:input.workflowId ?? null,stepId:input.stepId ?? null,limit:input.limit ?? 50});
}
export function projectViewDigest(view: unknown): string {
  const json = JSON.stringify(view);
  if (json === undefined) throw new ProjectPaginationError(400);
  return createHash('sha256').update(json,'utf8').digest('hex');
}
function canonicalBinding(binding: ProjectCursorBinding): ProjectCursorBinding {
  return {namespace:binding.namespace,projectId:binding.projectId,mapRevision:binding.mapRevision,
    grantRevision:binding.grantRevision,filter:binding.filter,viewDigest:binding.viewDigest};
}
function wireBinding(binding: ProjectCursorBinding): ProjectCursorBinding {
  // Bind every canonical filter byte without expanding user text in the bounded token.
  return {...canonicalBinding(binding),filter:projectViewDigest(binding.filter)};
}
function validBinding(value: unknown): value is ProjectCursorBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string,unknown>;
  return Object.keys(row).length === 6 && ['overview','management'].includes(row.namespace as string) &&
    (typeof row.projectId === 'string' || row.projectId === null) &&
    [row.mapRevision,row.grantRevision].every(revision => revision === null || (Number.isSafeInteger(revision) && (revision as number) >= 1)) &&
    typeof row.filter === 'string' && typeof row.viewDigest === 'string' && /^[a-f0-9]{64}$/.test(row.viewDigest);
}

/** Server-only continuation, never permission. Default instances share one process key. */
export class ProjectPagination {
  readonly #key: Buffer;
  constructor(key: Uint8Array = processKey) {
    if (key.byteLength !== 32) throw new Error('Cursor signing requires a 32-byte server key');
    this.#key = Buffer.from(key);
  }
  encode(binding: ProjectCursorBinding, offset: number): string {
    if (!validBinding(binding) || !Number.isSafeInteger(offset) || offset < 0) throw new ProjectPaginationError(400);
    const payload = Buffer.from(JSON.stringify({version:1,binding:wireBinding(binding),offset}),'utf8').toString('base64url');
    const signature = createHmac('sha256',this.#key).update(payload).digest('base64url');
    const cursor = payload + '.' + signature;
    if (cursor.length > 2048) throw new ProjectPaginationError(400);
    return cursor;
  }
  decode(cursor: string, expected: ProjectCursorBinding): number {
    if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw new ProjectPaginationError(400);
    const [payload,signature] = cursor.split('.');
    const signatureBytes = Buffer.from(signature,'base64url');
    if (signatureBytes.length !== 32 || signatureBytes.toString('base64url') !== signature) throw new ProjectPaginationError(400);
    let parsed: unknown;
    try {
      const bytes = Buffer.from(payload,'base64url');
      if (bytes.toString('base64url') !== payload) throw new Error('Noncanonical cursor');
      parsed = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    } catch { throw new ProjectPaginationError(400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProjectPaginationError(400);
    const row = parsed as Record<string,unknown>;
    if (Object.keys(row).length !== 3 || row.version !== 1 || !validBinding(row.binding) || !Number.isSafeInteger(row.offset) || (row.offset as number) < 0) throw new ProjectPaginationError(400);
    const actual = createHmac('sha256',this.#key).update(payload).digest();
    if (!timingSafeEqual(signatureBytes,actual)) throw new ProjectPaginationError(409);
    if (JSON.stringify(canonicalBinding(row.binding)) !== JSON.stringify(wireBinding(expected))) throw new ProjectPaginationError(409);
    return row.offset as number;
  }
}
