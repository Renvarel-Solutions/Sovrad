# Sovrad architecture

Developer reference for the local source, reviewed 2026-11-16 (package 0.1.0).
The browser provides registered-project views, workflow navigation, contextual
annotations, work history, decision review, evidence and connection status, plus
the original calculator proposal/budget controls. These changes remain local and
unpublished beyond the public foundation.

React/Vite defaults to 127.0.0.1:5173 and proxies `/api` to Fastify on
127.0.0.1:4317. `WEB_PORT` and `API_PORT` configure these together.
`server.ts` enforces host, browser-origin, fetch-site and local-action-header
checks with a 16 KiB body cap. This loopback boundary provides no remote-user
authentication; local OS users are trusted. Do not expose or forward the ports.

## Storage and revisions

`Storage` uses Better-SQLite3 for projects, workflows, proposals, revision
snapshots, audit events, daily AI attempts, spending reservations, implementation
tasks/events and import snapshots/quarantine metadata. `data-directory.ts`
validates private locations outside source, including existing junction ancestors.
SQLite data and backups are plaintext protected by the local OS account.

`migrate` checks `user_version` before startup writes. Older existing databases
receive a consistent SQLite backup under the private `backups` directory before
migration, WAL setup, bootstrap or seeding. Schema versions newer than supported
are rejected, and initialization errors close the database handle. Existing
daily attempts, history and spending are preserved through supported upgrades.
Backups contain private data and must stay outside the public source tree.

Schema 4 adds private registry, item/dependency, candidate, access, evidence and
layout overlays without rewriting approved calculator snapshots or spending.
`ProjectStore` in `project-store.ts` creates planning-only projects and items,
creates workflow/child maps and stores layout revisions separately from semantic
revisions. Item edits cannot reparent or relink existing maps. Shared child graphs
have cycle, depth and total-work limits. The fictional navigation sample is
separate from the calculator's original specification/history.

Schema 5 added immutable annotations and their canonical material JSON/digests,
consent receipts, versioned work records, ordered events, idempotency results and
an outbox. `WorkStore` in `work-store.ts` owns these records; user content remains
in the private SQLite directory outside public source.

Schema 6 adds decisions and immutable resolution receipts, hashed local owner
sessions, connections, frozen execution bindings and controller leases. It adds
ordered evidence sequences and distinguishes interpretation/runtime outbox phases.
These additive records preserve existing annotations, history and spending;
`migrate` uses a consistent snapshot including committed WAL data for the
pre-upgrade backup. See [migrations.ts](../apps/api/src/migrations.ts) and its
historical-schema fixtures in [migrations.test.mjs](../apps/api/src/migrations.test.mjs).

## Registry API and authority

`project-routes.ts`, `work-routes.ts` and legacy routes preserve project access
boundaries. Accessible project/workflow reads and their
HEAD variants enforce selection and archival boundaries. Access selection never
widens grants. Grant-bearing HTTP settings requests require a current local owner
cookie; metadata-only settings retain their separate access checks. Only the
fixed sample calculator workflow with `synthetic_execute` can create, approve or
start legacy implementation tasks. In `server.ts`, the `preHandler` resolves the
task's workflow and applies project visibility to task reads, events and cancel;
it adds `requireExecution` for implementation POSTs except cancel. Native start
remains blocked. Authority/map changes audit and revoke
retained task approvals transactionally. Archive restoration is limited to a
selected existing project's exact current-revision restore request.

`overview` returns bounded item and workflow pages with page-scoped counters and
full matching `totals`. Follow `page.nextCursor` to exhaust both collections;
one collection may finish before the other. Default limit is 50, maximum 100.
`project-pagination.ts` signs cursors with a server-process key and binds them to
the namespace, project, authority/map revisions, filters and matching view.
Cursors grant no access. Relevant changes or server restart require refreshing:
409 `STALE_CURSOR` returns no partial page. Layout-only changes preserve cursors.
Pages and totals use one SQLite read snapshot.

`GET /api/workspace?management=true` adds paginated registered-project summaries
with exactly `id`, `name`, `archived`, `selected`, `grantRevision`, including
registered archived/unselected choices for selection/restoration. It returns no
paths, maps or source and performs no desktop-project discovery. Normal workspace
visibility stays unchanged. Repository candidates remain inert private pending
metadata; their paths are omitted from responses and no source is inspected.
The wire value `all_connected` means all registered Sovrad projects; selection
can narrow that set. Neither mode discovers Codex Desktop projects.

Shared experience DTOs live in `packages/core/src/experience.ts`.
`annotation-material.ts` defines canonical selected-material serialization and
WebCrypto hashing shared by the annotation composer and API.
`verification-projection.ts` distinguishes current bound runtime evidence from
historical/unbound evidence. Ordinary production work has no trusted runtime
authority and remains `not_checked`/`unknown`; synthetic fixtures exercise the
bound evidence states described below.

Approval uses one immediate transaction for revision validation, the new
snapshot, current workflow, proposal status and audit event. Stale or resolved
proposals cannot overwrite a newer workflow. Rejection records an audit event
without advancing the revision. Workflow GET includes revision history.

## Annotation and work intake

`work-routes.ts` registers strict GET/POST `/api/annotations`, GET `/api/work`,
GET `/api/work/:id`, POST `/api/work/:id/amend`, POST `/api/work/:id/cancel` and
GET `/api/work/:id/events`. Lists are bounded, defaulting to 50 and capped at 100;
the events route supports `afterSequence`. Detail returns
`WorkDetailResponse.annotation` directly from `work.annotationId`, not from a
bounded annotation list. The detail also returns related evidence, decisions and
the current verification projection.

`WorkController.submitAnnotation` and `amendWork` build and hash selected material
asynchronously. An immediate transaction rechecks context, authority and material
before storing the exact `materialJSON`, receipt, work, event, request result and
applicable outbox entry. An identical request key replays the original result;
changed content under that key returns 409. Amendments create a new annotation
revision, supersede old work and revoke its outbox entry. Cancellation is versioned
and idempotent, retaining history. Authority/semantic changes revoke pending work.

Material v1 selects only the annotation's declared context/text/target/intent,
promotion request and selected project/item/workflow/stage fields. The shared
builder and serializer are the field/order contract. No sibling graph, source,
path or evidence body is included. `dispatch.contextDigest` is the SHA-256 of
those UTF-8 JSON bytes. Connected consent binds that exact immutable revision;
dispatch rechecks stored receipts and current authority before passing only the
stored JSON to an interpreter.

Local notes create no receipt or outbox and work with AI off. Connected intake
requires fresh consent and saves blocked work with null interpretation because
`registerWork` constructs no adapter. The constructor-only interpreter seam has
no HTTP/config enablement and supplies no execution or acceptance authority.
There is no automatic reconnect, local-note promotion or future-note promotion.
In-process claims use a fence and a 20-second expiry: late callbacks discard the
result and block/revoke the claim; startup also revokes interrupted claims without
retry. This recovery mechanism does not establish native isolation or execution
lease safety.

The React composer supports project, workflow and stage context, including linked
child stages with their parent item. `work-items/WorkDetail.tsx` displays the exact
referenced annotation and passes it into amendment. Explicit stale-work refresh
fetches the latest work version and context while preserving edited fields and
resetting consent. Polling preserves drafts; semantic/payload changes invalidate
consent while layout-only changes do not. The public `work-items/` source folder
is distinct from the ignored private `work/` directory.

## Local decisions, sessions and evidence

[registerConnections](../apps/api/src/connection-routes.ts) exposes GET
`/api/local-session`. `LocalSessionStore.bootstrap` reuses a current cookie or
creates a 30-minute replacement with HttpOnly, SameSite=Strict and Path=/api.
Only the token hash is stored in SQLite; the raw token is carried and stored in
the HttpOnly browser cookie and is not exposed to browser JavaScript, Web Storage,
JSON responses or logs. The generated HEAD handler returns without minting a session.
This is a loopback local-owner action boundary, not an identity provider or
remote-user authentication. Decision, connection and grant mutations require it;
invalid or expired cookies return 403 `LOCAL_SESSION_REQUIRED`.

[registerDecisions](../apps/api/src/decision-routes.ts) exposes GET
`/api/decisions`, POST `/api/decisions/:id/action`, GET `/api/evidence` and GET
`/api/activity`. Lists are scoped to accessible projects and support bounded
sequence pagination. The decision list includes a view digest so the browser can
refresh a changed list rather than join incompatible pages. No public route
creates a decision, installs runtime authority or records runtime evidence.

`DecisionStore.create` freezes the proposal digest, context, specification/map/
grant revisions, permission scope, expiry, cost cap and applicable work/material
identity. `resolve` rechecks the frozen request and current session in an immediate
transaction. Approve, reject and request-revision actions retain an immutable
receipt with the local session, action and reason. An exact idempotent action replay
returns the current reconciled Decision status/version with the original immutable
receipt and no second action effect; reusing the key with different content is
rejected. Changes or expiry supersede or
expire authority. Resolving a work decision leaves that work blocked and revokes
pending dispatch; approval launches nothing.

`DecisionDetail` presents the action and reason for escalation, expected result,
direct and indirect effects, uncertainties, one-time/ongoing cost and payer,
failure/interruption/detection, recovery/backup/irreversibility, alternatives,
recommendation, scope and expiry. `DecisionCenter` and `useDecisions` keep review
and pagination bound to the current selection. Changed requests require refresh;
expired sessions require renewal and another action choice, not automatic replay.
These components use real stores with synthetic fixtures. Production has no
supported adapter to create new agent requests.

`ConnectionStore` retains Codex and ChatGPT inventory entries as `unavailable`
with empty capabilities. With a valid local session, Connect returns 503
`CONNECTION_UNAVAILABLE`; Disconnect returns 200 and revokes dependent pending or
claimed dispatch. Neither performs provider login or establishes readiness, and
reconnecting does not restore revoked permission.

`ExperienceContext.runtime` requires a constructor-supplied trusted authority
reader, exact connected consent, approved specification receipt, synthetic
execution grant and matching manifest/acceptance snapshot. Normal `Storage`
supplies no reader. `ExecutionBindingStore` exercises frozen one-use bindings,
attempt/fence checks, bounded leases and interruption revocation in synthetic
tests; those mechanisms do not establish a native execution sandbox. There is no
HTTP/config switch for this authority or the interpreter adapter.

`EvidenceStore` retains source class/revision, environment, check time, acceptance
identity and binding provenance. Only current bound `test_runtime` coverage for
every frozen acceptance, together with successful runtime completion, can project
`verified`. Knowledge, plans and observed code cannot supply acceptance coverage;
revoked bindings retain historical evidence. `EvidencePanel` displays provenance,
freshness and the absence of observed deployment. No live runtime is connected.

The canonical surface contract in
[endpoint-security.test.mjs](../apps/api/src/endpoint-security.test.mjs) checks
every literal route and generated HEAD variant against valid synthetic fixtures,
including local boundaries and session prerequisites. Use it as the route
inventory instead of maintaining a second route count here.

## AI boundary

The original calculator proposal path in `ai.ts` is separate from annotation
intake. It requires backend configuration and per-request consent. Only the selected
step title, purpose, rules and correction are sent. `createPrivateAIClient`
restricts transport to the OpenAI Responses and input-token-count POST endpoints,
rebuilds outgoing headers, refuses redirects and disables SDK logs/retries.
Provider exceptions are neither logged nor returned. The transport override is
an in-process test seam, not an HTTP option.

`ai-budget.ts` is the policy source for the pinned model, token caps and local
$5 lifetime budget. Accounting uses conservative input/output rates rather than
an exact invoice. Daily attempts are reserved before provider access; spending
is reserved before drafting and settled from validated usage. Pending or unknown
charges retain their reservation and pause further drafts across restarts.
Provider project hard-limit confirmation is also required; the flag records
operator confirmation and does not verify the provider's configuration.

Structured output is validated, checked for credential-like content and bound
to the still-current revision before saving a draft. Manual proposals and
synthetic snapshot capture also use private-content filtering. The heuristic
cannot catch every secret or PII; users must review selected content.

## Implementation and import boundaries

`implementation-routes.ts` exposes task status, create/list/get, events,
exact-manifest approval, start and cancel. `ImplementationStore` permits only
an approved current synthetic calculator specification. Creation prepares a
private Git fixture and trusted acceptance file. Its manifest binds specification
digest/receipt, repository identity, base commit, allowed files and test digest.
Approval/start recheck those bindings. Start always returns blocked because
`isolationPreflight` is deliberately false; no coding process is launched.
Restart marks stored running tasks interrupted and revokes their approval.

The runner package includes a verified-worktree helper and a protocol client
whose callable methods are limited to initialization and permission-profile
listing. It declines approval requests. Its diagnostic probe uses an empty
configuration and does not sign in or start a coding turn. Worktree identity
checks do not supply native filesystem, credential or network isolation.

`import-routes.ts` exposes status/list/get and a submission route that returns
blocked before reading source. `ImportStore.capture` is an internal helper for
bounded, explicitly selected committed regular UTF-8 files in synthetic tests.
It records source commit/blob/hash provenance and read-only, non-executable
snapshots. Credential-like blobs retain quarantine metadata without their content.
This helper is not an enabled private-project import workflow.

## Publication and verification

Only app source and fictional examples belong in the public repository.
Runtime records, source snapshots, backups, logs, screenshots and exports stay
outside the publication file set. The public scanner checks disk and staged
content; manual review is still required. Browser tests run on separate scratch
ports 5175/4319 with a temporary synthetic database and no live AI credentials.
See [PROJECT-STATE.md](PROJECT-STATE.md) for dated evidence and
[RUNNER-PLAN.md](RUNNER-PLAN.md) for the remaining execution gates.
