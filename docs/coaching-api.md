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
| `POST` | `/coaching/runs` | `{ sessionId, prompt, idempotencyKey, snapshot, runtimeId? }` | `201` created / `200` replayed `{ run, lastSeq, replayed }` |
| `GET` | `/coaching/runs/:id` | — | `200 { run, lastSeq, firstSeq, expiresAt }` |
| `GET` | `/coaching/runs/:id/events?fromSeq=` | — | `200 SSE` (see below) |
| `POST` | `/coaching/runs/:id/cancel` | `{ reason? }` (`runId` stays in the path) | `200 { run, lastSeq }` |
| `POST` | `/coaching/logout` | — | `200 { loggedOut: true }` |
| `GET` | `/public-config` | public, no token | `200 { supabaseUrl, supabasePublishableKey }` (secret keys never served) |

Snapshots are read-only handles: the client sends only
`{ snapshotId, source, accountId }` (`recordIds`/`recordCount` in a submit
handle reject). The server resolves record ids/counts, enforces
account/source binding, and writes each run its own fresh immutable snapshot
file. Oversized ranges reject explicitly (narrow `from`/`to` and retry);
`maxRecordsPerSnapshot` bounds one snapshot.

Empty history is an explicit completed result: a `recordCount: 0` snapshot
submits to `completed` with an empty-history reason and never invokes the
runtime.

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
