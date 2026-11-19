# Security and privacy

This is a local preview, not an authenticated multi-user or remotely exposed
service. Bind only to loopback. Do not forward its ports or attach production
credentials. Local OS users are trusted.

## Report a vulnerability

Do not post credentials, customer information or exploitable private details in
public issues. Use private vulnerability reporting at https://github.com/Renvarel-Solutions/Sovrad/security/advisories/new.

## Boundaries

- Public source contains application code and synthetic examples only.
- User projects, records, exports, private checkouts and backups stay outside source.
- SQLite storage is local plaintext; the OS account protects access.
- API keys and Codex credentials must never reach the browser or Git history.
- Host/origin/fetch-site checks, a local-action header and a 16 KiB body limit
  protect the loopback API. No remote authentication is implemented.
- Local owner actions use a 30-minute HttpOnly, SameSite=Strict cookie scoped to
  `/api`; only its hash is stored. GET `/api/local-session` can create or renew it;
  HEAD never creates a session or cookie. Grant changes, decision actions and
  connection actions require a current cookie. This identifies a local action
  session, not a person or provider account, and retains the local OS trust model.
- Decision receipts bind the reviewed proposal and revisions. Approval records a
  bounded outcome; it supplies no native execution, source-editing or deployment
  authority. Changed or expired authority requires fresh review.
- Codex and ChatGPT connections remain unavailable with no capabilities. Connect
  cannot sign in or enable an adapter; Disconnect revokes dependent local pending
  dispatch. Production supplies no interpreter adapter or trusted runtime authority.
- AI needs backend opt-in and explicit request consent, has a durable request
  quota and a durable conservative $5 lifetime budget, validates output, rechecks
  revision and can create drafts only. Pending/unknown charges pause new calls.
- Credential-pattern filtering is heuristic and cannot identify every secret or PII.
  Review the selected material before granting AI consent.
- store:false is a request setting; it does not establish zero retention under
  every provider policy.
- Implementation task routes exist, but start is blocked by the native-isolation
  gate. Import submission is blocked before source is read. Neither approval can
  enable coding, merge or deployment.
- A genuine Git worktree separates checkouts; it does not establish native
  isolation from credentials, unrelated files, the control API or the network.
- The diagnostic protocol probe initializes an empty configuration only. It does
  not prove sign-in, model access or a secure coding sandbox.
- Public contribution tests must never receive maintainer or production secrets.

The publication scanner is a guardrail, not a confidentiality classifier.
Review the complete file set and staged content before any public push.

Use `scripts/start-private-ai.ps1` for hidden key entry after confirming the
dedicated provider project's enforced hard limit. Never place a key literal in
commands, environment files or browser settings. The local budget estimates
spending; provider billing controls remain an independent requirement.
