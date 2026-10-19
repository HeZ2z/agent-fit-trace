# ADR 0002: Hosted cloud coaching can run pi's agent loop in-process

- **Status:** Accepted. The runtime is implemented behind a worker-only switch and
  defaults to the existing builtin loop. No real-provider or real-database QA has
  been performed for this runtime.
- **Date:** 2026-10-19
- **Scope:** the hosted cloud coaching worker and its
  `CloudCoachingProvider` seam.
- **Related:** [`0001-agent-execution-backends.md`](0001-agent-execution-backends.md),
  [`../deployment.md`](../deployment.md), [`../../AGENTS.md`](../../AGENTS.md).

## Context

Hosted cloud coaching originally executed through one bounded in-house loop in
`server/cloud/openRouterProvider.ts`: native `fetch` to OpenRouter
chat-completions, a fixed two-tool allowlist, no provider SDK, and explicit
step/token/byte/time budgets. The outbox worker
(`server/cloud/outboxWorker.ts`) turns the provider callbacks into billing and
lease decisions:

- `beforeProviderRequest` must run immediately before every wire request. Its
  database RPC rechecks the lease generation, cancellation, account, quota,
  per-step ceiling, and finite token/request budgets, and writes
  `provider_fetch_started_at` when it authorizes the fetch.
- `onAccepted` records the first durable proof that a provider accepted work,
  before any tool executes or another request is sent.
- `onEvent` appends generation-fenced events.
- The error taxonomy (`ProviderNotAcceptedError`,
  `ProviderAcceptanceUnknownError`, `ProviderCancelledError`,
  `ProviderStepRefusedError`, `ProviderToolRefusedError`,
  `ProviderRunFailedError`, `ProviderOwnershipLostError`) decides whether a run
  is refunded, settled, retained, or left `unconfirmed`. Those decisions are
  billing semantics and must not change.

The product now also wants to exercise pi's real agent loop (turn handling,
tool execution, streaming events) for cloud runs. The installed
`@earendil-works/pi-agent-core@0.85.1` exposes `Agent`, `AgentTool`, lifecycle
events, and an injectable stream function without requiring the full
`pi-coding-agent` harness or a child `pi` process.

## Decision

### 1. Embed `pi-agent-core`, not `pi-coding-agent` and not the CLI

The alternate runtime lives in `server/cloud/piAgentProvider.ts` and implements
the existing `CloudCoachingProvider` interface unchanged. Each run constructs a
fresh `Agent` with:

- the same coaching system prompt as the builtin loop;
- the user message `input.prompt` plus the pinned-snapshot count line;
- exactly two `AgentTool`s (`get_training_history`, `analyze_progress`) backed
  by `createSnapshotDomainExecutor(input.records)`;
- `sessionId = input.runId`;
- `toolExecution: "sequential"`;
- a stream function that targets OpenRouter with the worker's explicit key.

The full `pi-coding-agent` harness is deliberately not used. It would add
builtin tools, sessions, extensions, skills, compaction, and filesystem
behavior the cloud worker does not need. The CLI path would add a child process
and a second security boundary without improving accounting.

### 2. Where the accounting gate sits

pi-ai invokes the `onPayload` hook after it assembles the exact request body and
immediately before it creates the HTTP request. That hook is the provider's
per-request gate:

1. reject when `maxSteps` requests were already authorised;
2. reject when the absolute deadline has passed;
3. estimate this request's prompt tokens and reject when the remaining total
   token budget cannot cover another step;
4. clamp the payload's output-token field to
   `min(remaining, maxTokensPerStep)`;
5. serialize the final payload and reject when it exceeds `maxInputBytes`;
6. `await input.beforeProviderRequest({tokens, requests: 1})` and map the
   decision to the existing cancelled / terminal / refused errors;
7. only then mark the request dispatched and return the clamped payload.

Putting the gate in `onPayload` rather than before calling the SDK is what makes
the byte check exact: the body that will be sent is the body that was measured.
All local refusals happen before step 6, so a refused step never writes the
fetch marker. The custom `fetch` wrapper is a second line of defence: it meters
the real request body and streams the response body through a hard byte cap
(`Content-Length` is an early hint, not trusted). A cap violation after
authorization is acceptance-unknown, never a refund.

Provider retries are disabled explicitly (`maxRetries: 0` on every stream call);
pi-ai's OpenAI/Anthropic adapters default to no retries, and the adapter does
not opt in. A transport failure after the fetch marker is never resubmitted.

### 3. Acceptance, usage, and error mapping

- **Acceptance** is marked on the first successful assistant message, after its
  usage is accumulated and before pi executes any tool call. Listener promises
  are awaited by `Agent`, so this is a real barrier. A storage failure while
  writing the marker is `ProviderAcceptanceUnknownError`.
- **Generation id** is the assistant message's `responseId`, which pi-ai reads
  from the streamed completion id (for OpenRouter, the generation id used by
  `GET /generation`). It is left undefined when the provider did not expose one.
- **Usage** maps `input + cacheRead + cacheWrite` to prompt tokens, `output` to
  completion tokens, and `totalTokens` to the total. Missing usage becomes a
  local stopping estimate flagged `known: false`; it is never settled as billed
  usage. pi-ai computes `Usage.cost` locally from catalog prices, so it is not
  treated as provider-returned cost and `costUsd` is not populated.
- **Cancellation / refusal** before a request maps to `ProviderCancelledError`
  and `ProviderStepRefusedError` with the same `dispatched` flag as the builtin
  loop.
- **HTTP 4xx** on the first request is `ProviderNotAcceptedError` with
  `accepted: false` (proven-not-accepted). A 4xx on a later request is
  `ProviderNotAcceptedError` with `accepted: true`, so the earlier generation is
  settled and the reservation is retained.
- **HTTP 429/5xx, transport failures, unreadable streams, and oversized
  responses** are `ProviderAcceptanceUnknownError`.
- **Timeouts** are checked before each request and enforced by an abort timer.
  Before dispatch they are `ProviderNotAcceptedError`; after a fetch they are
  acceptance-unknown.
- **Max steps / token / input / output budgets** after acceptance are
  `ProviderRunFailedError` codes (`MAX_STEPS`, `TOKEN_BUDGET`, `INPUT_BUDGET`,
  `OUTPUT_BUDGET`); before acceptance they are `ProviderNotAcceptedError`.
- **Unknown tools** are refused in the assistant `message_end` barrier before
  pi's tool preflight, so no tool-start event is emitted for them; the run fails
  with `ProviderToolRefusedError`. The deterministic executor remains the
  authority for tool arguments, and a deterministic tool failure stops the run
  with `TOOL_ARGUMENTS` / `TOOL_FAILED` like the builtin loop.

### 4. Event contract

Only the existing `CoachingEventPayload` frames are emitted:

- assistant text becomes bounded `text_delta` frames (split at 8 KiB, capped at
  256 KiB per run);
- pi `tool_execution_start` becomes `tool_start` with the pi call id;
- pi `tool_execution_end` becomes `tool_end`; failures use fixed safe text;
- an `analysis_result` is emitted only from the deterministic
  `analyze_progress` tool result after `parseAnalysisResult` validation, never
  from model text;
- the provider never emits `terminal` or `run_error`; the worker owns endings.

### 5. Configuration and rollout

`FIT_TRACE_CLOUD_AGENT` selects the worker runtime:

| Value | Behavior |
| --- | --- |
| absent or blank | `builtin` (unchanged default) |
| `builtin` | native-`fetch` bounded loop |
| `pi-agent-core` | embedded pi agent loop |
| anything else | worker configuration is invalid; the worker refuses to start |

The value is worker-only, case-sensitive, and read by `readCloudWorkerEnv`. An
unknown value fails closed instead of silently falling back to a runtime the
operator did not select. The request path is unaffected.

Rollout: set the variable on the worker only, redeploy, and observe completed /
failed / unconfirmed outcomes and usage settlement against the builtin worker.
Rollback: unset the variable (or set `builtin`) and redeploy. No schema or
contract change is involved.

### 6. Model selection and credentials

When the configured model id is present in the pi-ai OpenRouter catalog, that
catalog row is used as the model (API family, context window, pricing metadata).
When it is absent, an explicit `openai-completions` model entry is built with
conservative, locally derived metadata: the official OpenRouter base URL, the
configured per-step output cap, a context window derived from the enforced input
byte cap, and zero cost rates. Invalid metadata (non-finite or non-positive
window/output, unsupported API, no text input) fails provider construction
closed rather than guessing.

The API key is passed explicitly through the pi-ai `apiKey` stream option. pi-ai
never resolves credentials from `~/.pi`, an auth store, or ambient environment
variables on this path, and the key, prompts, snapshot contents, and raw
provider payloads are never logged or placed in events.

## Why the database/accounting invariants still hold

- The provider still talks to the database only through the three existing
  callbacks; the outbox worker is unchanged.
- The authorization RPC still runs immediately before every actual request, and
  the fetch marker is written by that RPC, not by pi.
- Acceptance is still a durable marker written before tool execution and before
  any further request.
- Settlement still receives only provider-returned token figures; unknown usage
  remains unknown.
- Every error the worker classifies is one of the existing classes. pi's own
  error events are translated into those classes; no new terminal or refund
  path is introduced.
- There is no automatic retry, so a dispatched failure cannot silently produce a
  second billable request.

## Security model

The tools are authored by this repository. pi's builtin read/write/bash/edit/
grep/find/ls tools, the coding harness, extensions, skills, prompt templates,
session storage, and filesystem access are not loaded. The only model-visible
operations are the two deterministic functions over an immutable, re-validated
snapshot, so no OS-level sandbox is required for this runtime as configured.

This is a property of the authored tool set, not of `pi-agent-core`. Any future
change that exposes pi builtin tools, extensions, skills, or a user-configured
tool set **requires** a real sandbox/container boundary before it can be
enabled; the current worker process must not be treated as one.

## Import-boundary exception

`AGENTS.md` tells contributors to keep pi/typebox imports confined to
`.pi/extensions/fit-trace/index.ts`. That rule targets the extension module and
the browser-safe shared core. Importing `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` inside `server/cloud/` is a deliberate, scoped
exception for this worker runtime. No pi import is added to
`packages/fit-trace-core` or `packages/fit-trace-api-contracts`, and the
deterministic core remains free of LLMs, clocks, and randomness.

## Verification gaps

- No real OpenRouter request, Supabase migration, or deployed worker has been
  exercised for this runtime. Provider tests use injected `fetch`/stream
  functions; the outbox integration test uses the in-memory fake repository.
- The streaming byte caps, timeout abort, and fetch-marker ordering are proven
  against fakes only. A real provider smoke test must confirm SSE formatting,
  usage chunks, abort behavior, and that a mid-stream provider failure produces
  the expected `unconfirmed` state.
- Generation-id reconciliation is not implemented. The id is recorded when
  pi-ai exposes it; comparing it with `GET /generation` and reconciling usage is
  still an operator/manual step.
- Cost is not settled (`costUsd` stays undefined) because pi-ai's cost figure is
  catalog-derived, not provider-returned. OpenRouter's streamed `usage.cost`
  would need an explicit extraction path before cost settlement is honest.
- The catalog may select the Anthropic-messages wire API for some model ids.
  Only the `openai-completions` path is covered by these tests; the
  Anthropic-messages path needs a real-provider smoke test.
- pi's TypeBox argument conversion can coerce values (for example a string to a
  one-element array). The deterministic executor still validates every argument
  and is the security boundary, but the exact coercion behavior should be
  rechecked when the pinned pi packages change.

## Consequences

**Positive**

- Cloud coaching can run pi's real turn/tool/streaming loop while keeping the
  existing durable accounting decisions.
- Rollout is a single worker environment variable; the builtin path remains the
  default and is untouched.
- The model-visible surface is still exactly two deterministic read-only tools.

**Negative / open work**

- The worker now depends on pi's package API surface, which must be reviewed on
  every pi upgrade.
- Real-provider behavior (usage chunks, generation ids, abort/billing) and the
  Anthropic-messages catalog path remain unverified.
- A future builtin-tool or extension path cannot reuse this security argument
  and would require sandboxing work.

## Supersedes

This ADR supersedes the statement in ADR 0001 §7 that the hosted cloud shape
uses no provider SDK. ADR 0001's durable accounting, fail-closed configuration,
and capability constraints continue to apply; the builtin native-`fetch` loop
remains the default implementation.
