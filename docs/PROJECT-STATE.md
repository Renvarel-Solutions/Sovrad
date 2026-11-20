# Sovrad project state

Source status reviewed 2026-11-19 (package 0.1.0, schema 6).
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

The annotation composer also offers a separate external desktop-host handoff.
Its temporary consent covers a bounded reference preview and short comment,
with no automatic screenshot requested. Host acknowledgment supplies no delivery
receipt and changes no canonical work, outbox or capability state. Local saving
and connected-consent intake retain their existing authority. See
[CONNECTIONS.md](CONNECTIONS.md) for source and verification boundaries.

## Verification record

- Merged [PR 3](https://github.com/Renvarel-Solutions/Sovrad/pull/3) records the
  project UI, annotation and decision baseline's local unit/integration tests,
  typechecks, build, publication scan and complete browser suite with synthetic
  data. Baseline receipts do not validate subsequent source changes or establish
  a hosted CI result for them.
- Repeat `npm test`, `npm run check`, `npm run public-check` and
  `npm run test:e2e` against the final candidate. A scan or check before this
  documentation update does not validate the final publication file set.
- Scoped source and security reviews cleared the PR 3 baseline changes;
  subsequent changes require their own review. Reviews do not authorize
  execution, import or publication.
- Tests use synthetic content and in-process interpreter seams. They do not
  establish a live agent connection, provider billing or native isolation.
- Diagnostic metadata operations observed on 2026-11-19 were version/help queries
  and schema generation. These establish a versioned contract, not a current
  initialization RPC, provider sign-in, model entitlement or native-isolation
  proof. Historical initialization evidence is not current-version evidence.
- No dedicated key was loaded, no paid provider call was made, and no real private
  project source, data or environment was touched. No pilot has run. Native coding
  remains disabled.

## Remaining gates

Supported execution adapters, trusted live runtime-evidence integration and
native agent connections remain gates. Local decision review, owner receipts
and external host handoff do not satisfy them. Mobile layout provides no remote
access; no remote-access service is implemented.
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
