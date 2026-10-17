# ADR 0001: Agent execution backends, capability discovery, and cloud provider shape

- **Status:** Accepted. Local pi, gated Codex/OpenCode adapters, the hosted
  cloud code path, backend-aware App selection, and the durable local journal
  are implemented. Real CLI/provider/deployment QA is not complete.
- **Date:** 2026-10-17
- **Scope:** issue #7. This ADR records the shape that is implemented now and the
  constraints any later adapter must satisfy. It is not a claim that Codex or
  OpenCode local coaching is safe on every install, or that the hosted path has
  passed real Supabase/OpenRouter QA.
- **Related:** [`../coaching-api.md`](../coaching-api.md),
  [`../deployment.md`](../deployment.md), [`../local-launcher.md`](../local-launcher.md).

## Context

Coaching runs currently execute through one local `pi --mode rpc` process. The
event-line protocol is v1 and the only accepted `runtimeId` was `pi`. Issue #7
requires two execution paths: the user's own local CLI (pi, then Codex and
OpenCode) and a hosted cloud coach that needs no local installation.

Three facts constrain the design:

1. **Execution location is not an engine.** A runtime id such as `pi` says
   which CLI protocol is spoken, not where it runs or who pays. Encoding
   "local/cloud" as a runtime id would make the matrix unextendable and would
   make accidental cloud fallback easy.
2. **Discovery is a security boundary.** Availability depends on CLI presence,
   CLI authentication, CLI version, configured adapters, provider
   configuration, the caller's server-verified account classification, and
   quota. None of that may be asserted by the browser.
3. **v1 clients exist.** A request that omits the new selection fields must keep
   running local pi. It must never be reinterpreted as a paid cloud request.

## Decision

### 1. Separate backend, runtime, and location

The contract in `packages/fit-trace-api-contracts/src/coaching.ts` fixes one
backend/runtime/location matrix:

| `backendId` | `runtimeId` | `executionLocation` | State in this slice |
| --- | --- | --- | --- |
| `local-pi` | `pi` | `local` | Implemented, legacy default |
| `local-codex` | `codex` | `local` | Adapter + fail-closed capability; unavailable until built-in isolation is proven |
| `local-opencode` | `opencode` | `local` | Adapter + isolation probe; available only with positive evidence |
| `cloud-default` | `hosted-sdk` | `cloud` | Server routes + worker + App selector; off by default; real deployment QA pending |

`hosted-sdk` names the hosted execution slot, not a vendor or model. Vendor,
model, region, and worker configuration are server-side deployment decisions;
they are not permanent backend ids.

A runtime id maps to exactly one backend. Naming both a backend and a runtime is
valid only when they match. The registry validates the same matrix at wiring
time, so a mismatch fails startup rather than one request at a time.

### 2. v1 compatibility is explicit

`resolveCoachingBackendSelection` implements the compatibility rule:

- both fields omitted → `local-pi` / `pi` / `local`;
- only `runtimeId` named → that runtime's one backend;
- only `backendId` named → its fixed runtime;
- both named → they must agree.

There is no branch that maps an omitted selection to `cloud-default`. Legacy
runs stored without `backendId` are treated as `local-pi` for replay and
cancel routing.

### 3. Discovery is versioned and truthful

`GET /coaching/capabilities` returns `CoachingCapabilityDiscovery`:

- `discoveryVersion` versions this payload;
- `protocolVersion` keeps constraining the event-line format;
- `capabilityVersion` versions each backend's capability shape.

Capability flags are conservative facts, not intentions. `productReplay` stays
false in the local discovery payload: the launcher keeps a durable local journal
for restart and idempotency safety, but the contract advertises only in-process
replay and does not yet promise restart durability. The separate cloud API has
durable stored-event replay; it is not folded into the local launcher's
discovery payload. A local backend's data destination is `cli-provider`,
because the CLI sends prompts and
snapshot-derived context to its configured model provider even though execution
is local. `nativeContinuation` and `cancelConfirmation: "process-exit"` are
advertised only for an adapter that actually implements them. Adapters that
have not proven their native handle or isolation semantics report
`nativeContinuation: false` and `cancelConfirmation: "unsupported"` even while
their backend id exists.

Every known backend appears in the response. An unavailable backend MUST carry a
server-derived reason; an available backend MUST NOT carry one. The reason codes
distinguish `cli-not-installed`, `cli-auth-required`,
`cli-version-unsupported`, `adapter-not-implemented`, `provider-unconfigured`,
`identity-unverified`, `guest-cloud-forbidden`, `quota-not-configured`,
`quota-exhausted`, and `policy-not-configured`. An adapter is never advertised
available merely because its backend id exists.

### 4. Cloud qualification fails closed on the server

`qualifyCloudBackend` accepts only trusted inputs:

```ts
{ identity: { accountId, isAnonymous }, quota: { configured, remaining }, providerConfigured }
```

The order is deliberate:

1. missing/invalid identity → `identity-unverified`;
2. `isAnonymous: true` → `guest-cloud-forbidden`;
3. provider not configured → `provider-unconfigured`;
4. quota absent or `configured: false` → `quota-not-configured`;
5. `remaining < 1` → `quota-exhausted`;
6. otherwise eligible.

`identity` MUST come from the verified identity layer (#5), never from a request
body, guest flag, local storage, or UI state. Guests may use their own local
agent only; there is no guest cloud trial in this scope. A formal account still
needs both configured quota and a configured provider. Missing configuration is
never treated as unlimited.

The same gate is used by discovery and by run submission, and the run path
evaluates it only after an idempotent replay has been resolved. Quota or
provider configuration changes therefore cannot break replay of an already
accepted run; they only affect new runs and the advertised state.

### 5. Registry seam: metadata plus an optional factory

`server/coaching/runtimeRegistry.ts` is the only seam between the service and an
execution engine. A registration is:

```ts
{ backendId, runtimeId, executionLocation, displayName, available,
  unavailableReason?, version?, factory? }
```

- duplicates, unknown backends, and matrix mismatches throw at wiring time;
- only an available registration with a factory can launch a run;
- discovery-only registrations omit the factory;
- the legacy `runtimeFactory` option continues to back `local-pi` only and
  never backs Codex, OpenCode, or cloud.

The launcher registers `local-pi` from its configured factory. `--runtime` /
`FIT_TRACE_RUNTIME` may select `pi`, `codex`, or `opencode`; the launcher
rejects `hosted-sdk` because a local launcher cannot provide a cloud execution
location. A configured Codex/OpenCode runtime is registered as unavailable with
`adapter-not-implemented`. It never silently falls back to pi under that backend
id, and a v1 request still maps to `local-pi`.

### 6. Local CLI protocol strategy

All local adapters share these requirements. They are security and correctness
constraints, not implementation details.

**Transport and process handling**

- Spawn with an argv array; never compose a shell command.
- Keep the coached tool allowlist to `get_training_history` and
  `analyze_progress`. Never expose `bash`, file writes, network tools, MCP
  servers, or unrestricted coding tools to a coached run.
- Use a controlled working directory and a per-product-session native session
  directory separate from snapshot storage.
- Sanitize the child environment: no Supabase/service tokens, no inherited
  session/extension markers. Local CLI auth may come from the user's normal
  config directory; it is never copied into the app or logs.
- Bound input, event count, event bytes, and wall-clock time. Parse only the
  documented event stream; malformed or oversized frames fail the run.
- One terminal state. Report success only after the documented completion
  signal. Report cancellation only after the engine has actually stopped, and
  release capacity only then.
- Native continuation is allowed only for the same account, backend, engine
  version, and controlled session directory. Native session files/thread ids
  are never passed across engines.
- A CLI process is not a security sandbox unless the engine provides one.
  Working-directory confinement and flags are documented as isolation, not as
  an OS boundary.

**pi (implemented)**

- `pi --mode rpc` with strict LF-delimited JSONL framing.
- The existing adapter uses `--tools <allowlist>`, `--no-extensions` (plus an
  explicit `-e` for the Fit Trace extension), `--no-skills`,
  `--no-context-files`, `--no-prompt-templates`, `--no-themes`, a replacement
  `--system-prompt`, a controlled `--session-dir`, and `--session` only for a
  same-session resume.
- Cancel sends `clear_queue` + `abort`, then SIGKILL after a grace period; the
  run settles only after confirmed process exit.
- pi documents that it has no built-in sandbox and that its working folder does
  not restrict filesystem access. The adapter therefore claims bounded
  transport and flag isolation only.

**Codex (adapter implemented; fail-closed)**

- The adapter targets the documented `codex exec` app-server surface with
  `--json` JSONL events, a read-only sandbox, and a non-escalating approval
  policy; `codex exec resume` is used only for a same-backend/session handle.
- `dynamicTools` only adds client tools; it does not prove that built-in
  shell/file/network/MCP/hook/plugin tools are excluded. The adapter therefore
  stays unavailable with `builtin-isolation-unproven` until an exact, verifiable
  builtin-exclusion mechanism is found. A similar flag name is not proof.
- Real CLI version/event/cancel QA and positive isolation evidence are still
  outstanding; no install is advertised as safe merely because the binary exists.

**OpenCode (adapter implemented; isolation-probed)**

- The adapter targets the documented non-interactive `opencode run` surface and
  generates a temporary isolated config/data root with a wildcard-deny,
  exact-domain-tool-allow permission surface. User plugins, MCP servers, hooks,
  and context files are not loaded.
- `--auto` is used only alongside that explicit wildcard-deny definition: it
  suppresses interactive prompts for the two allowlisted custom tools, not as a
  blanket approval. The isolation probe rejects any `ask` rule, and a real CLI
  run still has to verify the deny is enforced before availability.
- Availability requires positive `isolationVerified` evidence from the bounded
  probe (or an explicitly supplied fixture/operator proof). Without that
  evidence the backend reports `plugin-isolation-unproven` and stays unavailable.
- Real CLI version/permission/cancel/native-continuation QA is still outstanding.

Both adapters are registered by the launcher, but registration is not
availability: the capability probe must pass every time, and no supported
runtime is advertised merely because its backend id exists.

### 7. Hosted cloud shape: OpenRouter over native `fetch`

The cloud runtime is a bounded tool loop calling the fixed official
`https://openrouter.ai/api/v1/chat/completions` endpoint with the built-in
`fetch`. No provider SDK is added. `FIT_TRACE_OPENROUTER_API_KEY` and
`FIT_TRACE_OPENROUTER_MODEL` are required; a non-empty
`FIT_TRACE_OPENROUTER_BASE_URL` must equal the official base or the provider is
unconfigured. `FIT_TRACE_CLOUD_ENABLED=1` is the global kill switch.

Implemented request shape (non-streaming, one tool call at a time):

```http
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer {FIT_TRACE_OPENROUTER_API_KEY}
Content-Type: application/json

{
  "model": "{FIT_TRACE_OPENROUTER_MODEL}",
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "tools": [{ "type": "function", "function": { "name": "analyze_progress", "parameters": { "...": "..." } } }],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "max_tokens": 512,
  "stream": false
}
```

Constraints:

- The key, model, endpoint, and budgets are server-only worker configuration.
  They are never sent to the browser, returned by discovery, or logged. A
  missing value fails closed.
- Only `get_training_history` and `analyze_progress` are offered. Every tool call
  is bound to the run's pinned, database-derived snapshot and validated
  server-side; unknown tools, shell, file, network, SQL, and plan-confirmation
  calls are rejected. Model text becomes a `text_delta` only. An
  `analysis_result` can come only from the deterministic tool result and is
  re-validated before it is stored.
- Step, total/per-step token, request-byte, response-byte, and wall-clock
  budgets are enforced by the worker and rechecked by the database before every
  fetch. Multibyte input is bounded by UTF-8 bytes, not by a chars/4 estimate.
  Local token estimates are stopping bounds, not billing truth. Token/request
  reservations are finite accounting controls, not a strict USD guarantee;
  provider/model pricing remains an operator concern.
- Provider responses are read through a metered stream with a hard byte cap;
  `Content-Length` alone is not trusted. There is no automatic provider retry.
- Non-streaming responses may carry `usage`; OpenRouter also exposes
  `GET {base}/generation?id=<generation-id>` for request/usage metadata. A
  generation id is the reconciliation handle.
- Missing provider usage leaves accounting explicitly unknown. It is never
  settled as a fabricated zero charge. Only provider-returned usage is settled,
  at most once, under the current unexpired lease generation. A partial usage
  block charges the known tokens and retains the unknown remainder of the
  reservation instead of refunding it.
- **No cancellation endpoint is documented.** Aborting the HTTP read stops
  local consumption, not necessarily provider billing. Until termination is
  proven, a cancelled cloud run stays `cancelling` or becomes `unconfirmed`,
  keeps its quota reservation, and is never auto-retried.
- No provider idempotency key is documented. A crash after the pre-fetch
  marker is `execution-unconfirmed`: do not resubmit, do not release the
  reservation, and surface a reconciliation state. A recorded generation id
  permits post-hoc usage/cost lookup but is not proof of task cancellation.

**Durable persistence and quotas.** `supabase/migrations/20261017000200_coaching_cloud.sql`
adds ownership/RLS tables for sessions, snapshots, runs, dense events, quota,
usage ledger, and the outbox. Request-path RPCs use the caller's token and
`auth.uid()`; only the worker RPCs require `auth.role() = 'service_role'`.
Snapshot RPCs derive records from the caller's own `public.workouts` rows
instead of accepting caller-supplied records, and clamp TTLs and per-account
counts. Submission is one atomic RPC: it hashes the canonical request, resolves
an existing idempotency record before requiring a live snapshot, returns
`409 IDEMPOTENCY_CONFLICT` for a changed request, and serializes reservation
against a 20-concurrent global/per-account cap. A run retains its own snapshot
copy so a dispatched worker never depends on snapshot TTL.

`supabase/migrations/20261017000300_cloud_execution_guards.sql` is an additive
correction to that applied base migration (never rewrite the base). It fixes the
worker authorization RPC to read the real `coaching_quota.configured` column,
adds finite per-run token and request reservations plus a per-step ceiling,
adds a database-owned global provider kill switch that defaults to OFF, bounds
direct-RPC text/payloads by bytes, validates dates by a real calendar cast,
derives canonical identity inside SQL from normalized arguments while rejecting
unknown keys, and settles known usage exactly once while retaining unknown
remainder. There is deliberately no nullable "unlimited" budget: a quota row
without finite token, per-run, per-step, and request limits fails closed.
Operators must explicitly enable the global switch and configure a quota before
any paid call is authorized.

**Worker lifecycle.** `server/cloud/outboxWorker.ts` claims one outbox job per
tick (sequential batch claims would let later leases expire), writes a
pre-fetch marker, and calls a database authorization RPC immediately before
every provider request. That RPC rechecks the global switch, lease generation,
expiry, cancellation, formal-account status, per-step ceiling, per-run token and
request budgets, and quota. Every event, settlement, and terminal write is
generation-fenced. Expired leases with a fetch marker become
`unconfirmed` and are never redispatched; expired pre-fetch leases return to
`queued`/`cancelling`. A terminal event is written once. `unconfirmed` is a run
status; the shared terminal event uses `failed` with an explicit reason because
the shared event contract has no `unconfirmed` terminal status.

### 8. What is still unverified or not implemented

- Real Codex/OpenCode CLI QA is outstanding. Codex needs a verifiable
  builtin-tool exclusion mechanism before it can be available; OpenCode needs
  positive wildcard-deny/plugin-only isolation evidence from the installed
  version. Neither is advertised merely because the binary exists.
- The App selector, cloud replay, and restart-safe local journal are
  implemented, but real-browser acceptance (including the cloud tail across
  proxies) is still outstanding. Cloud remains off by default.
- No hosted deployment and no real Supabase migration application or
  OpenRouter call in this checkpoint. The durable schema, fake-repository and
  real-RPC-adapter worker tests, and opt-in integration tests exist, but
  production behavior after a real migration/worker/provider run is unverified.
  The worker RPC tests use a fake `fetch` that speaks the real RPC names and
  argument shapes; they catch schema/type drift only when run against a live
  migrated database.
- No provider cancellation proof. OpenRouter may continue billing after the
  HTTP read aborts; the implementation therefore reports unconfirmed states
  rather than claiming a clean stop.
- A local run that was active when the launcher process died is marked
  execution-unconfirmed and keeps its capacity slot. There is no HTTP
  recovery/acknowledgement action yet; clearing it is an operator action on the
  journal after confirming no child process is running.

## Evidence

Fetched 2026-10-17. pi facts were checked against both the repo-pinned package
(`@earendil-works/pi-coding-agent@0.85.1`, `node_modules/.../docs`) and the CLI
on `PATH` (`pi 1.0.3`). Codex/OpenCode were not installed for this slice; their
statements below are documentation-only and are not runtime QA.

| Fact used | Source |
| --- | --- |
| pi RPC is LF-delimited JSONL over stdin/stdout; `--mode rpc`; `--session-dir`; `abort` command | Repo-pinned `docs/rpc.md` (0.85.1); `pi 1.0.3` on PATH; <https://pi.dev/docs/latest/rpc> |
| pi has no built-in sandbox; working folder does not restrict access; isolation requires OS/container boundary | Repo-pinned `docs/security.md` (0.85.1) |
| pi `--tools` replaces the tool selection; `--no-extensions`, `--no-skills`, `--system-prompt`, `--session-dir` | Repo `README.md`/`docs` (0.85.1); `pi --help` (1.0.3) |
| Codex `exec` defaults to a read-only sandbox; `--json` emits JSONL; `codex exec resume` continues a session | <https://developers.openai.com/codex/noninteractive>; <https://developers.openai.com/codex/cli/reference> |
| Codex sandbox modes and approvals (`--sandbox read-only`, `--ask-for-approval never`, `--full-auto` = workspace-write) | <https://github.com/openai/codex/blob/main/docs/sandbox.md> |
| OpenCode `run --format json`; `serve` headless HTTP API; `OPENCODE_SERVER_PASSWORD` basic auth; `--auto` auto-approves | <https://opencode.ai/docs/cli/> |
| OpenCode permissions are allow-by-exception; omitted permissions are denied | <https://opencode.ai/docs/permissions> |
| OpenRouter chat completions are OpenAI-compatible; bearer auth; streaming usage in final chunk | <https://openrouter.ai/docs/api/reference/overview>; <https://openrouter.ai/docs/api-reference/chat-completion> |
| OpenRouter generation metadata is `GET /generation?id=`; public OpenAPI has no cancel/abort/delete path | <https://openrouter.ai/openapi.json> (`paths` contains `/generation`, `/generation/content`, `/generation/feedback` only) |

## Consequences

**Positive**

- A request cannot drift from local pi to paid cloud by omitting a field.
- Discovery can describe gated engines truthfully without pretending they
  work, and the registry refuses mismatched or duplicate wiring at startup.
- Cloud eligibility is fail-closed at the per-request principal, the
  authoritative `auth.users.is_anonymous` row, and the database quota RPC, with
  no client-controlled entitlement input.
- Persistence, idempotent replay, lease fencing, event replay, and quota
  accounting are implemented without a new dependency. Cancellation and
  exactly-once provider acceptance remain explicitly unproven.

**Negative / open work**

- The App selector and cloud resume UI are implemented, but real-browser
  acceptance remains outstanding; cloud availability is still server-derived and
  off by default.
- Codex/OpenCode behavior, permissions, cancel proof, native continuation, and
  positive isolation evidence still need real CLI QA before those backends are
  advertised as safe on an arbitrary install.
- Cloud cancellation and exactly-once acceptance remain unproven with
  OpenRouter. The adapter exposes unconfirmed states and does not release budget
  on an unproven stop. Real-provider QA must verify these states against live
  behavior before the cloud path is advertised as complete.
- The migration has not been applied to the long-running local Supabase stack;
  that must be coordinated rather than resetting the stack. Opt-in integration
  tests require a migrated isolated local stack.
- The launcher still returns the legacy `PI_UNAVAILABLE` error for callers that
  omit a backend when pi is absent; discovery and the App separately offer other
  available backends. A later cleanup can retire that legacy error without
  changing the terminal contract.
