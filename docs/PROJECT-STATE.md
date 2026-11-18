# Sovrad project state

Local source status reviewed 2026-11-16 (package 0.1.0, schema 6).
This record distinguishes source capability from executed verification.

## Current product scope

The interface includes registered-project management, paginated overviews,
React Flow/list workflow views, linked child navigation, proposal review and the
local AI budget panel. Project, workflow and stage annotations, including nested
child stages, are available with Work & results history, amendment and stop.
Needs your decision provides scoped review, approve/reject/request-revision
actions and retained owner receipts. Evidence views retain provenance and show
current versus historical status. Specification approval updates requirements only.

The backend includes private project registration, planning items,
creation-only workflow/child maps, independent layout overlays and paginated
overviews with full matching totals. Opt-in management summaries list only
explicitly registered choices. Candidate paths remain private pending metadata;
registration does not discover projects or import source. All project data and
candidate paths belong outside public source.

Schema 5 added immutable annotations, selected material JSON, consent receipts,
work records/events, idempotent requests and an outbox. Local notes need no AI
configuration and create no outbox entry. Connected intake requires fresh consent
and saves blocked work because no adapter is wired; interpretation remains null
and acceptance unknown. Local notes never dispatch on reconnect or restart.
Amendment supersedes the old work and revokes its dispatch; cancellation retains
the annotation and history. Detail resolves the exact referenced annotation,
independently of the bounded discovery list.

Schema 6 adds decisions/receipts, hashed local sessions, connection records and
execution-binding/lease records, plus evidence ordering and an outbox phase.
Upgrades are additive and back up an existing older database, including committed
WAL data, before startup writes. Decision review binds the exact proposal,
context and revisions; changed or expired authority invalidates the request.
Production has no interpreter adapter or trusted runtime-authority reader, so
these records do not enable connected execution. Synthetic fixtures exercise the
real stores and UI; no actual agent creates requests yet.

Project access guards cover the new work routes as well as legacy surfaces.
Grant changes, decision actions and connection actions require a current local
owner cookie. It is a short-lived local action boundary, not a provider identity.
Legacy implementation create/approve/start additionally require the fixed
synthetic calculator's execution grant; reads and cancellation enforce project
visibility. Native coding and HTTP source import remain blocked. Verification
requires complete current bound acceptance evidence and successful runtime
completion; ordinary production work remains `not_checked` without that authority.
Codex and ChatGPT inventories are unavailable with empty capabilities. Connect
returns 503; Disconnect returns 200 and revokes dependent pending dispatch without
sign-in or readiness.

## Verification record

- Local source checks passed for the decision/session/evidence changes, including
  focused API security contracts, typechecks and the web build. Scoped browser
  checks passed for the new decision views and recovery behavior. These are local
  synthetic-data checks; they do not establish the final complete browser run.
- Repeat `npm test`, `npm run check`, `npm run public-check` and
  `npm run test:e2e` against the final candidate. A scan or check before this
  documentation update does not validate the final publication file set.
- Scoped source and security review cleared the implementation changes. These
  reviews do not authorize execution, import or publication.
- Tests use synthetic content and in-process interpreter seams. They do not
  establish a live agent connection, provider billing or native isolation.
- The public foundation was previously merged into
  [Renvarel-Solutions/Sovrad](https://github.com/Renvarel-Solutions/Sovrad).
  The newer local project UI, annotation and decision changes have not been published;
  local verification does not establish a hosted CI result for them.
- No dedicated key was loaded, no paid provider call was made, and no real private
  project source, data or environment was touched. No pilot has run. Native coding
  remains disabled.

## Remaining gates

Supported agent adapters, trusted live runtime-evidence integration and
native/app-host agent connections remain gates. Local decision review and owner
receipts do not satisfy them.
The in-process interpretation claim expires after 20 seconds; its late-callback
recovery is not native isolation or a proof of secure execution leases. Registry
metadata never supplies source-read authority. No native coding or deployment
has been performed. Source review, coding, merge and deployment remain separate
permissions.

Live drafting requires a dedicated backend key, confirmed enforced provider
project hard limit and per-request consent. The durable $5 local lifetime budget
uses conservative accounting; pending/unknown charges pause further calls across
restarts. It does not establish exact provider billing. Secret/PII filtering is
heuristic; SQLite is local plaintext under OS-account trust. See
[ARCHITECTURE.md](ARCHITECTURE.md), [RUNNER-PLAN.md](RUNNER-PLAN.md) and
[SECURITY.md](../SECURITY.md).
