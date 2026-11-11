# Sovrad project state

Local source status reviewed 2026-11-11 (package 0.1.0, schema 5).
This record distinguishes source capability from executed verification.

## Current product scope

The interface includes registered-project management, paginated overviews,
React Flow/list workflow views, linked child navigation, proposal review and the
local AI budget panel. Project, workflow and stage annotations, including nested
child stages, are available with Work & results history, amendment and stop.
Specification approval updates requirements only.

The backend includes private project registration, planning items,
creation-only workflow/child maps, independent layout overlays and paginated
overviews with full matching totals. Opt-in management summaries list only
explicitly registered choices. Candidate paths remain private pending metadata;
registration does not discover projects or import source. All project data and
candidate paths belong outside public source.

Schema 5 adds immutable annotations, selected material JSON, consent receipts,
work records/events, idempotent requests and an outbox. Local notes need no AI
configuration and create no outbox entry. Connected intake requires fresh consent
and saves blocked work because no adapter is wired; interpretation remains null
and acceptance unknown. Local notes never dispatch on reconnect or restart.
Amendment supersedes the old work and revokes its dispatch; cancellation retains
the annotation and history. Detail resolves the exact referenced annotation,
independently of the bounded discovery list.

Project access guards cover the new work routes as well as legacy surfaces.
Grant changes over HTTP return 503 until real local action sessions exist.
Legacy implementation create/approve/start additionally require the fixed
synthetic calculator's execution grant; reads and cancellation enforce project
visibility. Native coding and HTTP source import remain blocked. Current
verification projections remain `not_checked` with unknown freshness. Decision,
owner-session and runtime-evidence controllers remain unavailable.

## Verification record

- Current local unit/API/runner/scanner suites, API/runner/web typechecks and the
  production web build passed. Browser journeys passed for annotations, exact
  work detail, fresh-consent amendments, restart persistence, project management
  and workflow navigation, including the mobile stage list. These are local,
  synthetic-data checks.
- The public-content scan passed before this documentation update; repeat it
  against the final publication file set.
- Scoped chief and cybersecurity review cleared the annotation/work source. These reviews
  do not authorize execution, import or publication.
- Tests use synthetic content and in-process interpreter seams. They do not
  establish a live agent connection, provider billing or native isolation.
- The public foundation was previously merged into
  [Renvarel-Solutions/Sovrad](https://github.com/Renvarel-Solutions/Sovrad).
  The newer local project UI and annotation changes have not been published;
  local verification does not establish a hosted CI result for them.
- No dedicated key was loaded, no live provider call was made, and no private
  project source was imported. Native coding remains disabled.

## Remaining gates

Decision actions, owner sessions, trusted runtime-evidence integration and
native/app-host agent connections still need implementation and verification.
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
