# Coaching API (implemented: local loopback server)

Implemented by `server/coaching/coachingServer.ts` + `server/coaching/coachingService.ts`,
shaped by `@pi-fit-trace/api-contracts` (`src/coaching.ts`).
Loopback-only. The source-run launcher (`agent-fit-trace start`, see
[`local-launcher.md`](local-launcher.md)) serves this server on the same
origin as the App shell and data proxy, and the App's launcher-gated Coach
screen consumes it. Hosted cloud execution and Codex/OpenCode agent execution
are not shipped; this document covers only what the local server implements
today.

Related contract: [`api-contract.md`](api-contract.md) (workout/analysis/plan shapes and envelopes).

## Authentication: fresh bearer + local capability

Every `POST`/`GET` under `/coaching/*` requires BOTH credentials:

- `Authorization: Bearer <current user token>` — verified on every request.
  Expired/invalid bearers reject with `401 UNAUTHENTICATED` even with a valid
  capability; auth outages are `503 STORAGE_UNAVAILABLE`, never a forced logout.
- `x-fit-trace-capability: <short-TTL token>` — issued by bootstrap, bound to
  the same account + canonical server origin. Missing/expired/forged caps are
  `401`; account swaps are `401`; caps in the query string are `401`.

`POST /coaching/bootstrap` verifies the bearer, then issues the capability
(`{ capability, expiresInMs }`, default TTL 10 minutes). Capabilities are
bounded per account (`5`) and total (`100`): expired entries sweep first, and a
full map rejects new bootstrap with `503 STORAGE_UNAVAILABLE` instead of
evicting a valid in-use cap. `POST /coaching/logout` cancels the caller's
active runs and invalidates only that account's sessions/caps/snapshots.

Host/Origin gate on every coaching route: exact match against the canonical
server origin (`http://<bindHost>:<actualPort>` from the real listen address).
Alias hosts, other ports, prefix domains, and comma-joined `Host` values are
`403`. Only the exact validated canonical `Origin` is echoed (never `*`);
requests without `Origin` still require both credentials.

## Endpoints

| Method | Path | Request | Success |
| ------ | ---- | ------- | ------- |
| `POST` | `/coaching/bootstrap` | bearer only | `200 { capability, expiresInMs }` |
| `POST` | `/coaching/sessions` | `{ id? }` | `201 session` |
| `GET` | `/coaching/sessions/:id` | — | `200 session` |
| `POST` | `/coaching/snapshots` | `{ from?, to? }` | `201 snapshot` |
| `POST` | `/coaching/runs` | `{ sessionId, prompt, idempotencyKey, snapshot, backendId?, runtimeId? }` | `201` created / `200` replayed `{ run, lastSeq, replayed }` |
| `GET` | `/coaching/runs/:id` | — | `200 { run, lastSeq, firstSeq, expiresAt }` |
| `GET` | `/coaching/runs/:id/events?fromSeq=` | — | `200 SSE` (see below) |
| `POST` | `/coaching/runs/:id/cancel` | `{ reason? }` (`runId` stays in the path) | `200 { run, lastSeq }` |
| `POST` | `/coaching/logout` | — | `200 { loggedOut: true }` |
| `GET` | `/coaching/capabilities` | — | `200` versioned backend/capability discovery |
| `GET` | `/public-config` | public, no token | `200 { supabaseUrl, supabasePublishableKey }` (secret keys never served) |

### Backend capability discovery

`GET /coaching/capabilities` returns the versioned discovery payload defined in
`packages/fit-trace-api-contracts/src/coaching.ts`. It is authenticated like
every other coaching route, and every field is server-derived: the browser
cannot assert availability, entitlement, or quota.

- `discoveryVersion` versions this payload; `protocolVersion` still describes
  the event-line format; each backend carries its own `capabilityVersion`.
- All known backends are listed (`local-pi`, `local-codex`, `local-opencode`,
  `cloud-default`). An unavailable backend includes an
  `unavailableReason { code, message }`; an available one omits it.
- Only `local-pi` can be available today. Codex/OpenCode report
  `adapter-not-implemented` unless a registered adapter exists. A Codex
  app-server that exposes `dynamicTools` is still not enough: dynamic tools are
  additive and leave built-in shell/file/network/MCP/hook/plugin tools
  available. Until the installed version provides a verifiable way to exclude
  that entire inventory, `local-codex` stays unavailable with
  `builtin-isolation-unproven`.
- `productReplay` is `false` until a durable local journal exists. The current
  service can replay in-process runs only; it does not promise restart
  durability.
- `cloud-default` is available only when all of the following hold: the caller
  has a server-verified formal account (`isAnonymous: false`), the server has
  cloud quota configured with `remaining >= 1`, a provider is configured, and a
  cloud adapter is registered. Missing identity, a guest account, or missing
  configuration fails closed. Guests may use their own local agent only.
- Capabilities stay conservative: pi advertises `nativeContinuation: true` and
  `cancelConfirmation: "process-exit"`; unimplemented engines advertise
  `false`/`"unsupported"`.

Run selection follows the same matrix: `local-pi`/`pi`, `local-codex`/`codex`,
`local-opencode`/`opencode`, `cloud-default`/`hosted-sdk`. A v1 request that
omits both `backendId` and `runtimeId` resolves to `local-pi`; it never maps to
cloud. Naming both fields requires an exact match. The backend is pinned on the
run and is part of the idempotency comparison. The full rationale and provider
constraints are in
[`adr/0001-agent-execution-backends.md`](adr/0001-agent-execution-backends.md).

Snapshots are read-only handles: the client sends only
`{ snapshotId, source, accountId }` (`recordIds`/`recordCount` in a submit
handle reject). The server resolves record ids/counts, enforces
account/source binding, and writes each run its own fresh immutable snapshot
file. Oversized ranges reject explicitly (narrow `from`/`to` and retry);
`maxRecordsPerSnapshot` bounds one snapshot.

Empty history is an explicit completed result: a `recordCount: 0` snapshot
submits to `completed` with an empty-history reason and never invokes the
runtime.

### Idempotent submission and retained-run replay

The snapshot store keeps source records only for `snapshotTtlMs`, while a run
stays readable for `retentionMs`. Submission therefore resolves the caller's
idempotency record BEFORE it requires a live snapshot: an identical retry of an
accepted `POST /coaching/runs` keeps returning that same run (HTTP `200`,
`replayed: true`, no runtime launch) after the snapshot handle has expired, for
as long as the run itself is retained. Replay compares the incoming prompt,
runtime, and snapshot reference (`snapshotId`, `source`, `accountId`) against
the run's own canonical stored snapshot; the stored snapshot is never blindly
substituted for a changed request.

Refusals keep their existing semantics:

- a changed prompt, `snapshotId`, backend, or runtime under the same key is
  `409 IDEMPOTENCY_CONFLICT`; an unknown or mismatched selection is
  `400 VALIDATION_ERROR`, and a known but unconfigured/unavailable backend stays
  `400 VALIDATION_ERROR` with its server-derived reason (only `local-pi` is
  wired in the launcher);
- a changed `source` for the same `snapshotId`, or a snapshot reference bound to
  another account, is `403 FORBIDDEN`;
- a replay is only ever served to the owning account on the same session; a
  foreign session is `404 SESSION_NOT_FOUND`;
- a NEW key still needs an owned, live snapshot, so an expired handle is
  `404 SNAPSHOT_NOT_FOUND`, and a run removed by retention is never resurrected
  (its idempotency mapping is dropped with it).

A session referenced by a retained run survives its own idle expiry, so the
replay path stays reachable without extending the snapshot lifetime.

## Envelopes, status, and cursor semantics

Success is `{ data }`; failure is `{ error: { code, message } }` (see
`api-contract.md` for the envelope shape). Status mapping: `200/201` success,
`400 VALIDATION_ERROR` (bad input, oversized 64KB request bodies, session/
snapshot caps), `401 UNAUTHENTICATED` (+ `WWW-Authenticate: Bearer`),
`403 FORBIDDEN` (untrusted host/origin, cross-account snapshot spend, upstream
auth rejection), `404` unknown route/session/snapshot/run, `409`
`IDEMPOTENCY_CONFLICT`/`RUN_BUSY` (one active run per session, one global pi
process), `410 EXPIRED_CURSOR`, `500 API_ERROR` (never with stacks), `503`
`STORAGE_UNAVAILABLE` (source/auth outage, capability map full).

Event `seq` values are dense 0-based indexes. `lastSeq` is the last stored
seq, `-1` when the log is empty (queued, no events yet). `fromSeq` is the
first seq still needed (`last-consumed + 1`; `0` for a fresh subscribe).
`fromSeq === lastSeq + 1` returns an empty page (caught up); anything beyond
is `410 EXPIRED_CURSOR` with current run state + retention — the client
refetches from `firstSeq` (`0`, no prefix trimming) and re-folds, never
silently skips. `GET /runs/:id` returns coherent `{ run, lastSeq, firstSeq,
expiresAt }` for gap recovery. SSE replays stored events, then tails live
events; client abort detaches only (never cancels the run).

### SSE wire budgets (shared, single source)

The run service, the HTTP server, and the browser client consume ONE set of
limits from `@pi-fit-trace/api-contracts`, so an event the service accepts is
always readable by the client:

- A single SSE frame — the full `id:`/`data:` envelope measured in UTF-8
  bytes with metadata overhead — is capped at `MAX_COACHING_SSE_FRAME_BYTES`
  (1 MiB).
- One run's whole stream body is capped at `MAX_COACHING_SSE_TOTAL_BYTES`
  (4 MiB); the frame cap is always ≤ the total cap.
- The service reserves `COACHING_SSE_TERMINAL_RESERVE_BYTES` (8 KiB) of the
  total for the two frames that bypass the content cap: the cap-seal
  `run_error` and the terminal. Each is bounded to
  `COACHING_SSE_RESERVED_FRAME_BYTES` (half the reserve) by its ENCODED frame
  bytes via `boundCoachingDiagnostic`, which measures the exact wire frame —
  so JSON escaping is counted (a raw-byte bound under-counts control
  characters, `"`, and `\` by up to 6x) and a max-length escaped session id is
  included. A diagnostic that must be shortened carries an explicit
  `COACHING_TRUNCATION_MARKER` (`…[truncated]`) suffix; ordinary small reasons
  pass through unchanged. Analysis content is never truncated: an over-budget
  frame fails the run explicitly.

A runtime event whose frame would exceed the frame budget is rejected
explicitly: the run stops and fails with a readable terminal — the event is
never stored, truncated, or delivered. Tripping the per-run byte budget emits
an explicit `run_error` (`EVENT_CAP`) followed by the terminal; both still fit
the reserved headroom. Both sides size frames with the same
`encodeCoachingEventFrame`/`coachingEventFrameBytes` helper, so the framing +
size rule lives in one place.

## App client lifecycle (single account-level owner)

The Coach UI is backed by ONE account-level owner
(`app/src/coaching/useCoach.ts`, published through `CoachingProvider` and
subscribed via `useCoach()`), not by the screen. `Layout` mounts the owner, so
Coach↔History↔Coach navigation never unmounts it: one client, one session, and
one run survive route changes, and a fresh submit REUSES the existing session
instead of allocating a new one (otherwise navigation alone would exhaust the
per-account session cap). Bootstrap/session/snapshot/run/subscribe sequencing,
per-submission idempotency keys, last-consumed resume positions, and
account-switch/logout cleanup all live in the owner; `CoachScreen` only renders.

The owner is **auth/launcher gated**: every bootstrap, session, snapshot, run,
and restore side effect runs only once the account is a *verified* signed-in
user AND launcher coaching is enabled (`isCoachingEnabled()`, i.e. the launcher
served the app on its loopback origin). During auth `loading` (a restored but
unvalidated session) and in plain local/HTTP modes the owner stays inert and
never reads or clears the persisted resume. An explicitly injected client
(tests/embedding) is an explicit opt-in. The resume is stored versioned and
account-bound in `sessionStorage` (`fit-trace.coach.resume.v1`, ids only — never
tokens, transcripts, or native paths), and a stored resume for another account
is ignored and cleared.

### Stream phases and reconnect

Phases are `idle` / `preparing` / `restoring` / `streaming` / `cancelling` /
`disconnected` / `expired` / `done` / `failed` / `cancelled` / `unconfirmed`,
and every button capability is DERIVED from the phase plus the known
nonterminal run — never duplicated booleans. A known live run keeps fresh
submits blocked and stays cancellable/reconnectable in ANY phase, so no run is
silently abandoned.

A stream failure that arrives BEFORE the terminal envelope is a **disconnect**,
never a terminal: EOF before the terminal, an interrupted read, a
malformed/unparsable frame, a bad content type, and an oversized body all keep
the folded output, the run id, and the persisted resume, and offer
Reconnect/Cancel (detaching or aborting the stream never cancels the run
server-side). The one exception is `EXPIRED_CURSOR` (410), which is the distinct
`expired` phase carrying the retention start in its details so the client
refetches from `firstSeq` and re-folds without skipping. A confirmed server
terminal (success or failure) is delivered as a terminal ENVELOPE and freezes
the fold.

Reconnect re-bootstraps an expired capability (without repeating the run POST)
and resumes from `last-consumed + 1`; `EXPIRED_CURSOR` reloads from the
retention start. Neither ever resubmits. The one exception is a DEFINITIVE
structured `RUN_NOT_FOUND` on the reconnected stream (or on cancel): the run
is proven gone, so the owner releases it — run/resume/cursor/inflight ids
cleared, coherent output kept, honest unavailable error — and offers New
analysis without a reload. A generic route `NOT_FOUND`, network/auth, or
parser failure never releases: the run is retained and reconnect stays.

### Restore and cancel carry-through

A reload re-verifies the persisted session/run (`GET` session + run) and replays
events from `0` without a POST. A cancel requested while a restore is still
verifying bootstrap/session/read is carried to the ACTUAL restored run once
ownership is verified — a real server cancel plus its terminal — never a local
"cancelled" that later resumes the stream. Only a DEFINITIVE structured
missing failure (`RUN_NOT_FOUND`, or `SESSION_NOT_FOUND` on the session read)
resets the resume; a generic route `NOT_FOUND` (bare 404), network/auth, or
parser failure keeps the resume and the cancel intent and
offers an explicit Retry restore. A read that proves no run exists still
resolves to cancelled honestly.

### Bounded session renewal

An idle session is deleted server-side after its retention TTL. A new submit
that gets a DEFINITE `SESSION_NOT_FOUND` recreates the session ONCE and re-sends
the SAME `idempotencyKey` (the first POST was rejected before any run existed,
so nothing was created). A cancel landing during that awaited renewal resolves
cancelled honestly and never dispatches the renewed POST. An ambiguous network
failure during any submit is never silently re-POSTed: the stable key is kept
for an explicit user Retry, and a cancel that collides with an unresolved POST
stays `unconfirmed` (resolved through the same key) rather than claiming a false
cancellation. While that ambiguous key is held, fresh work (submit or New
analysis) is blocked and the Ask UI stays disabled; only the same-key Retry
(or its cancel resolution) is offered. Only a known pre-execution refusal for
the FIRST submit (`VALIDATION_ERROR`, `RUN_BUSY`, `FORBIDDEN`,
`SESSION_NOT_FOUND`) proves no run was created, so the pending key is cleared
and fresh work stays recoverable. An unknown/proxy `API_ERROR` 5xx, an auth
refusal, a lost ack, or a malformed success stays unknown and keeps the same
key. A same-key retry rejection normally cannot prove the ORIGINAL accepted run
is absent, so it never erases the original key — the user retries the same
request. Two structured refusals ARE definitive under the current ordering: the
server resolves the retained owned idempotency record before requiring a live
snapshot, and a session referenced by a retained run survives idle expiry, so a
same-key `SESSION_NOT_FOUND` (no retained run references that session) or
`SNAPSHOT_NOT_FOUND` (the idempotency lookup missed) proves no retained run or
saved result remains under the key. The original may have completed before the
record aged out, so that is the only claim the app makes. On either refusal it
releases the pending key, clears the stale session only for
`SESSION_NOT_FOUND` (`SNAPSHOT_NOT_FOUND` reuses the live session), allows fresh
analysis without a reload, and shows the same honest unavailable state (naming
the code) for an ordinary retry and a preserved cancel intent — never a
cancelled/completed claim, run, terminal, stream, or cancel.
`IDEMPOTENCY_CONFLICT`, auth refusals, network/parser failures, a generic route
`NOT_FOUND`, and unknown 5xx still keep the key. A cancel during a
same-key retry is carried through the retry POST and then cancels the resolved
run (or lands `unconfirmed` if the retry is still unknown) — never a local
cancelled while the original accept is unresolved.

## Capacity rule: `processExitConfirmed`

Global capacity is one live run and one active run per session; the server
never queues implicitly. Capacity and snapshot files release ONLY after the
runtime reports `onDone` with `processExitConfirmed === true`. An unconfirmed
termination withholds success (a `completed` report becomes `failed`), keeps
the handle/snapshot, and keeps capacity held (`RUN_BUSY` for new runs).
Cancel wins over late completion via a bounded grace that invokes `close()`;
shutdown and logout report failure (never silent success) while a live child
is retained, and workspaces are preserved.

## Shutdown is bounded

`CoachingServer.close()` stops accepting new connections immediately, then
cancels in-flight configured-upstream reads, ends tracked SSE responses, and
stops the run service. It waits at most `shutdownGraceMs` (default `2000` ms)
for existing sockets — unfinished request bodies, idle keep-alive sockets,
open streams — then destroys the remainder with `closeAllConnections()`, so
close never awaits a socket indefinitely. `close()` is idempotent. An
unconfirmed live child still surfaces as a rejection (capacity held, workspace
preserved): close failures are never suppressed, and the process is never
exited.

## Workout data upstream (fixed, configured)

Production reads flow through the fixed server-configured upstream base URL
only (absolute `http(s)`, no query/credentials/fragment). Each read forwards
the request's own current user bearer token ephemerally (`Authorization:
Bearer <token>`); there is no static service-role/header option. The source
accepts ONLY the fixed envelope `{ data: [...] }` validated by
`parseWorkoutList` — bare arrays and other shapes are malformed. Upstream
`401/403` surface as `403 FORBIDDEN`; redirects are refused without
following; every other outage is `503 STORAGE_UNAVAILABLE` (never `400`,
never empty history). Bodies stream with a 1MB byte cap (reader cancelled on
overflow; the fetch timeout holds through the body), so multi-byte payloads
are bounded by bytes, not characters.
