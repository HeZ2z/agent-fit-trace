# ADR 0001: Agent execution backends, capability discovery, and cloud provider shape

- **Status:** Accepted for slice A/B (contracts, registry seam, launcher selection, fail-closed cloud gate).
- **Date:** 2026-10-17
- **Scope:** issue #7. This ADR records the shape that is implemented now and the
  constraints any later adapter must satisfy. It is not a claim that Codex,
  OpenCode, or hosted cloud coaching is shipped.
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
| `local-codex` | `codex` | `local` | Declared, never advertised available |
| `local-opencode` | `opencode` | `local` | Declared, never advertised available |
| `cloud-default` | `hosted-sdk` | `cloud` | Declared, never advertised available |

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

Capability flags are conservative facts, not intentions. `productReplay` is
false everywhere until a durable local journal exists: the service only has
in-process replay, which must not be advertised as restart-durable. A local
backend's data destination is `cli-provider`, because the CLI sends prompts and
snapshot-derived context to its configured model provider even though execution
is local. `nativeContinuation` and `cancelConfirmation: "process-exit"` are
advertised only for an adapter that actually implements them. Unimplemented
engines report `nativeContinuation: false` and `cancelConfirmation:
"unsupported"` even while their backend id exists.

Every known backend appears in the response. An unavailable backend MUST carry a
server-derived reason; an available backend MUST NOT carry one. The reason codes
distinguish `cli-not-installed`, `cli-auth-required`,
`cli-version-unsupported`, `adapter-not-implemented`, `provider-unconfigured`,
`identity-unverified`, `guest-cloud-forbidden`, `quota-not-configured`,
`quota-exhausted`, and `policy-not-configured`. A planned adapter is never
advertised available merely because its backend id exists.

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

**Codex (planned, not available)**

- Documented non-interactive surface: `codex exec` with `--json` JSONL events,
  default read-only sandbox, and `codex exec resume <session-id>`.
- A coached adapter must pin `--sandbox read-only` and an approval policy that
  cannot escalate (for example `--ask-for-approval never`) and must not use
  `--full-auto`, `workspace-write`, or `danger-full-access`. It must verify
  that the exposed tool surface is actually restricted before advertising
  availability. `--json` event shapes and cancel semantics must be verified
  against the installed version in a spike; a similar flag name is not proof of
  compatible behavior.

**OpenCode (planned, not available)**

- Documented non-interactive surface: `opencode run --format json`, or a
  loopback `opencode serve` HTTP server with `OPENCODE_SERVER_PASSWORD` basic
  auth. Permission configuration is deny-by-default in the agent definition
  (`--permissions`/`--tools`: anything omitted is denied).
- `--auto` auto-approves permissions that are not explicitly denied and must
  not be used for coached runs. Headless JSON permission prompts are a known
  risk area and must be verified; if a permission request cannot be surfaced
  and denied safely, the adapter stays unavailable.
- Tool names and permission events are not assumed to match pi or Codex. The
  adapter needs its own spike and contract tests before `local-opencode` can
  be advertised.

No adapter is added by this slice. Until a real CLI spike and QA pass, the
backend stays `adapter-not-implemented`.

### 7. Hosted cloud shape: OpenRouter over native `fetch`

The configured cloud runtime is a bounded tool loop calling an
OpenAI-compatible chat-completions endpoint with the built-in `fetch`. No
provider SDK is added. The existing placeholders in
`docs/deployment.md` are the configuration surface:

```dotenv
FIT_TRACE_OPENROUTER_BASE_URL=
FIT_TRACE_OPENROUTER_API_KEY=
FIT_TRACE_OPENROUTER_MODEL=
```

Proposed request shape (to be fixed by the adapter slice):

```http
POST {FIT_TRACE_OPENROUTER_BASE_URL}/chat/completions
Authorization: Bearer {FIT_TRACE_OPENROUTER_API_KEY}
Content-Type: application/json

{
  "model": "{FIT_TRACE_OPENROUTER_MODEL}",
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "tools": [{ "type": "function", "function": { "name": "get_training_history", "parameters": { "...": "..." } } }],
  "tool_choice": "auto",
  "stream": true
}
```

Constraints:

- The base URL, key, model, region, and budgets are server-side worker secrets.
  They are never sent to the browser, returned by discovery, or logged. A
  missing value fails closed.
- Only the two read-only coached tools are offered. Every tool call is bound to
  the run's pinned snapshot and validated server-side; unknown tools, shell,
  file, network, SQL, and plan-confirmation calls are rejected.
- The final assistant output must parse as a domain analysis result. Model text
  is never wrapped as a trusted analysis.
- Step, token, time, and event budgets are enforced by the worker, not by model
  cooperation.
- Streaming responses include usage in the final chunk; non-streaming responses
  include usage directly. OpenRouter also exposes
  `GET {base}/generation?id=<generation-id>` for request/usage metadata. A
   generation id observed in a response is the reconciliation handle.
- **No cancellation endpoint is documented.** The OpenAPI document exposes
  `GET /generation` and `GET /generation/content`, not a cancel/abort/delete
  operation. Aborting the HTTP read stops local consumption, not necessarily
  provider billing. Until a provider proves termination, a cloud run must not
  claim `cancelled`; it stays `cancelling`/unconfirmed, keeps its quota
  reservation, and never auto-retries.
- No provider idempotency key is documented. A crash before acceptance
  evidence is `execution-unconfirmed`: do not resubmit, do not release the
  reservation, and surface a reconciliation state. A recorded generation id
  permits post-hoc usage/cost lookup but is not proof of task cancellation.
- Cloud capacity release uses provider-side termination evidence, mapped to the
  shared "execution confirmed stopped" condition; local capacity release keeps
  the existing `processExitConfirmed` meaning.

### 8. What this slice does not implement

- No Codex or OpenCode process adapter, probe, or CLI QA.
- No hosted worker, provider call, quota ledger, or cloud persistence.
- No App backend selector or resume v2; the existing launcher-gated Coach UI is
  unchanged.
- No hosted deployment. `local-pi` remains the only executable backend, and
  discovery reports the others as unavailable with reasons.

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
- Discovery can describe planned engines truthfully without pretending they
  work, and the registry refuses mismatched or duplicate wiring at startup.
- Cloud eligibility is a single fail-closed function shared by discovery and
  submission, with no client-controlled entitlement input.
- The provider shape is implementable with the existing runtime and no new
  dependency; cancellation and idempotency limits are stated before any paid
  traffic exists.

**Negative / open work**

- Discovery is currently more informative than the product: only `local-pi`
  can run, and the App does not yet render backend selection or reasons.
- Codex/OpenCode behavior, permissions, cancel proof, and native continuation
  still need real CLI spikes and QA before those backends are available.
- Cloud cancellation and exactly-once acceptance remain unproven with
  OpenRouter. The adapter must expose unconfirmed states honestly and must not
  release budget on an unproven stop.
- The launcher's pi-missing path keeps its legacy fail-clear behavior so
  existing callers still receive `PI_UNAVAILABLE`; discovery separately reports
  `local-pi` unavailable. A later UX slice should align submission with
  discovery without changing the terminal error contract.
