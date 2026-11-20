# Connection and handoff boundaries

Developer reference for external host handoff and diagnostic integration.
Reviewed 2026-11-19 (package 0.1.0); source behavior is separate from runtime proof.

## External desktop host handoff

[`HostHandoff`](../apps/web/src/annotations/HostHandoff.tsx) detects the optional
`document.oai.annotation.request` API through
[`BrowserHostAnnotationBridge`](../apps/web/src/annotations/host-bridge.ts).
Ordinary browsers show it as unavailable. This action is separate from Keep in
Sovrad and Send for help; the in-app annotation/material/consent queue is authoritative.

The dedicated visible light-DOM preview contains exactly the reference fields
`projectId`, `itemId`, `workflowId`, `stepId`, `specRevision` and `mapRevision`,
plus a separately entered short comment. Missing optional references are `null`.
Canonical material JSON, annotation text, descriptions, rules, neighboring nodes,
buttons and disclosure copy stay outside that target. The bridge rejects strings
over 256 UTF-16 units, metadata over 2,048 UTF-8 bytes and comments over 240 UTF-16
units rather than truncating them. The shared privacy heuristic screens the
reference and comment; it cannot identify every secret or private value.

The checkbox binds temporary approval to the current material, context and short
comment. Changes invalidate it. On the activating click, the bridge rechecks API
availability, target visibility, attachment and exact preview content before a
synchronous request with `omitScreenshot:true`. It clears approval after the
attempt; there is no automatic retry or durable host-handoff queue.

The host's `accepted:true` acknowledges a request; it does not confirm that the
editor opened or an annotation was saved or sent. Sovrad cannot select or observe
the final conversation or delivery. The host can add context and allow edits, so
the user must review its editor. Omitting the automatic screenshot does not
constrain those later host actions. This interpretation follows the official
[Annotations Extensibility contract](https://learn.chatgpt.com/docs/annotations-extensibility).

Handoff creates no Sovrad annotation, consent receipt, work event, dispatch,
decision, evidence or connection capability. Use the ordinary in-app save to keep
the canonical record. Neither handoff preparation nor local saving needs an API key.

## Agent inventory and native boundary

[`ConnectionStore`](../apps/api/src/connection-store.ts) retains Codex and ChatGPT
as unavailable with empty capabilities. Connect returns unavailable; Disconnect
revokes dependent pending dispatch. Neither performs provider authentication,
reuses desktop authentication or establishes adapter readiness. Normal storage
supplies no trusted runtime authority.

[`isolationPreflight`](../apps/runner/src/index.ts) remains false. A worktree,
protocol handshake or permission-profile listing does not prove credential,
filesystem, network or control-API isolation. Native coding, HTTP source import
and remote access remain unavailable. Optional paid drafting retains its separate
backend key, provider controls and request consent; operator confirmation flags
do not verify a provider hard limit.

## Diagnostic contract and verification

The [protocol client](../apps/runner/src/protocol.ts) permits initialization and
permission-profile listing only and grants no command, file or permission
approval. It provides no account, authentication, model, thread or turn methods.
The official [App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes a JSON-RPC handshake and CLI-generated schemas tied to the CLI version;
those mechanisms alone confer no execution authority.

The source contract is pinned by `CODEX_VERSION` to `0.169.0-alpha.11.1` and
checked against that version's generated schema. The transport-only
[`diagnoseConnection`](../apps/runner/src/connection.ts) helper sends fixed
initialization parameters, then `initialized`, then bounded profile-list requests.
It validates the expected Windows configuration identity and returns only
profile `id`, `allowed` and optional/nullable `description`, without selecting a
profile. It retains `ready:false` and `codingEnabled:false`. Discovery is limited
to 50 records per page, ten pages, 500 records and 30 seconds, with a five-second
request timeout. Invalid or incomplete discovery closes the transport without
returning partial results. The helper does not launch the native probe.

Version/help queries and schema generation were observed on 2026-11-19. They are
metadata checks, not a current initialization RPC or sign-in/model/isolation
receipt. Current native response identity remains unverified; earlier-version
initialization evidence is historical only.

Synthetic browser tests use a fake host to exercise the local request contract.
They do not prove a real desktop editor or delivery. A separate manual check must
use fictional references and a short synthetic comment, review the actual host
editor and record only the outcome observed. Actual Submit is a separate user
action; automated tests do not perform or verify it. No existing desktop account
or authentication reuse is established by these checks.
