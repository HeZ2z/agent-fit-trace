# agent-fit-trace API contract (`@pi-fit-trace/api-contracts`)

Source of truth: `packages/fit-trace-api-contracts/src/`.

## 1. Purpose and scope

`@pi-fit-trace/api-contracts` is a browser-safe, shape-only package shared by
the app and any HTTP-shaped backend. It owns the *shape* of the boundary —
client surface, JSON envelopes, errors, strict response guards, and
deterministic ids — while all domain computation stays in `@pi-fit-trace/core`
(`analyzeProgress`, `generateNextPlan`, `validateWorkoutRecord`,
`stableStringify`).

- Computations stay in `@pi-fit-trace/core`; nothing in this package decides
  values, only shapes (`src/types.ts`, `src/index.ts`).
- Transport concerns stay out of core: envelopes, endpoint/status mapping, and
  error codes live here, not in core.
- Like core, everything exported here is pure TypeScript with no Node
  built-ins, so it runs in both the app (browser) and any Node transport
  (`src/index.ts`).

Public surface (`src/index.ts`):

```ts
export * from "./types.ts";
export * from "./errors.ts";
export * from "./deriveWorkoutId.ts";
export * from "./validators.ts";
```

Test support is a separate entrypoint
(`@pi-fit-trace/api-contracts/testing`, `src/testing/index.ts`):

```ts
export * from "./memoryHandler.ts";
export * from "./contractSuite.ts";
```

## 2. Client surface

`FitTraceClient` (`src/types.ts`) is the four domain operations expressed as
async calls. Implementations may hit a real HTTP server or an in-memory
handler; either way they resolve with unwrapped domain values (the envelope is
stripped by the transport, not by callers):

```ts
export interface FitTraceClient {
  listWorkouts(): Promise<WorkoutRecord[]>;
  createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult>;
  analyze(filter?: AnalysisFilter): Promise<AnalysisResult>;
  createPlanDraft(input?: PlanConstraints): Promise<PlanDraft>;
}
```

`CreateWorkoutResult` reports the idempotent-create outcome:

```ts
export interface CreateWorkoutResult {
  record: WorkoutRecord;
  /** True when an identical record with this id was already present (no-op). */
  duplicate: boolean;
  warnings: ValidationWarning[];
}
```

All domain types (`WorkoutRecord`, `AnalysisFilter`, `AnalysisResult`,
`PlanConstraints`, `PlanDraft`, `ValidationWarning`) are imported from
`@pi-fit-trace/core`.

## 3. Wire envelopes

Success wraps the payload in `{ data: T }`; failure wraps a structured error
in `{ error: { code, message, details? } }` (`src/types.ts`):

```ts
export interface OkEnvelope<T> {
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  error: ApiErrorBody;
}
```

`createMemoryHandler` (`src/testing/memoryHandler.ts`) is the reference
encoding: `ok()` sends `{ status, body: JSON.stringify({ data }) }` and
`error()` sends `{ status, body: JSON.stringify({ error: body }) }`, omitting
`details` when it is `undefined`.

## 4. Endpoints and status mapping

`FIT_TRACE_API_VERSION = "v1"` and `API_ENDPOINTS`
(`src/types.ts`) hold the resource paths:

```ts
export const API_ENDPOINTS = {
  workouts: "/workouts",
  analysis: "/analysis",
  planDrafts: "/plans/drafts",
  publicConfig: "/public-config",
} as const;
```

Combined with the `/api/v1` base, the endpoints are:

| Method | Path | Request | Success status |
| ------ | ---- | ------- | -------------- |
| `GET` | `/api/v1/workouts` | — | `200` list |
| `POST` | `/api/v1/workouts` | body `{ record }` | `201` new record, `200` identical retry (`duplicate`) |
| `GET` | `/api/v1/analysis` | query `from` / `to` / `exercises` (comma-separated) | `200` |
| `POST` | `/api/v1/plans/drafts` | optional `PlanConstraints` body | `200` |
| `GET` | `/api/v1/public-config` | — (public, no token) | `200` Supabase URL + publishable key |

Status semantics (`HTTP_STATUS`, `src/types.ts`):

```ts
export const HTTP_STATUS = {
  created: 201,
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  serverError: 500,
} as const;
```

- `POST /workouts` → `201` on a new record, `200` on an identical retry
  (`duplicate: true`), `400` on invalid input, `409` when the id already
  exists with different content.
- `GET /workouts` → `200` list.
- `GET /analysis` (optional `from`/`to`/`exercises` query) → `200`.
- `POST /plans/drafts` (optional `PlanConstraints` body) → `200`.
- Authenticated deployments verify `Authorization: Bearer <token>` on all
  four workout/analysis/plan endpoints and reject missing/invalid tokens with
  `401 UNAUTHENTICATED` plus a `WWW-Authenticate: Bearer` header;
  out-of-scope callers get `403 FORBIDDEN`. `GET /public-config` stays public
  so the app can bootstrap login. Missing server configuration fails closed
  (`500 API_ERROR`) — production never falls back to memory.
- Any unexpected failure → `500` with an `ErrorEnvelope`.

Optional plan constraints are validated server-side — `goal` is a string,
`days_available` is an integer from 1 to 7, and `equipment`/`constraints`
are string arrays — and invalid values are rejected with `400
VALIDATION_ERROR`.

`createMemoryHandler` maps `ApiError` codes to these statuses
(`statusForError`): an explicit `status` on the error wins, otherwise
`VALIDATION_ERROR` → `400`, `CONFLICT` → `409`, and anything else → `500`.
A missing `{ record }` field on `POST /workouts`, unparseable JSON bodies, and
unknown routes are rejected as `VALIDATION_ERROR` / `API_ERROR` respectively
(see `src/testing/memoryHandler.ts` and `tests/apiContracts.test.ts`).

## 5. Error codes

`API_ERROR_CODES` (`src/errors.ts`) are stable strings so the transport can
map them to HTTP statuses and the app can branch on them:

```ts
export const API_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  CONFLICT: "CONFLICT",
  CORRUPT_STORE: "CORRUPT_STORE",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NETWORK_ERROR: "NETWORK_ERROR",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  API_ERROR: "API_ERROR",
} as const;
```

- `VALIDATION_ERROR` — invalid record or filter (including an inverted date
  range, a missing `{ record }` field, or unparseable JSON). Maps to `400`.
  Oversized request bodies (over 64 KiB) are also `400`.
- `CONFLICT` — the id already exists with different content. Maps to `409`.
- `CORRUPT_STORE` / `STORAGE_UNAVAILABLE` — store-layer failures; surfaced with
  their codes and mapped to `500` by the memory handler's default branch.
  `STORAGE_UNAVAILABLE` (with a `503` status) is also the transient
  auth-service signal: both the server verifier and the app auth client use it
  for network errors and 429/5xx so callers retry instead of signing out.
- `UNAUTHENTICATED` — missing/invalid/expired bearer token on an authenticated
  deployment. Maps to `401` with a `WWW-Authenticate: Bearer` header.
- `FORBIDDEN` — authenticated but out-of-scope caller. Maps to `403`.
- `NETWORK_ERROR` — reserved for the fetch transport itself failing (offline,
  DNS, connection reset); see `NetworkError` below.
- `MALFORMED_RESPONSE` — a response that cannot be trusted; carried by
  `MalformedResponseError` (section 7).
- `API_ERROR` — anything unexpected, including unknown routes. Maps to `500`.

Error classes (`src/errors.ts`):

```ts
export class ApiError extends Error {
  code: string;
  details?: unknown;
  status?: number;
  constructor(body: ApiErrorBody & { status?: number }) { /* ... */ }
}

export class NetworkError extends Error {
  constructor(message = "Network request failed.", options?: { cause?: unknown }) { /* ... */ }
}

export class MalformedResponseError extends Error {
  code = "MALFORMED_RESPONSE";
  field: string;
  constructor(field: string, reason: string) { /* ... */ }
}
```

`ApiError` carries the server's `code` plus optional `details` and `status`.
`NetworkError` signals the fetch itself failed; writes are never retried or
silently fallen back on this error — the caller decides whether to surface or
re-issue, so an ambiguous submit cannot double-apply. `MalformedResponseError`
is intentionally identical in shape and message to the app's guard, so the app
re-exports it from one place instead of keeping a duplicate
(`app/src/api/contracts.ts`):

```ts
export { MalformedResponseError } from "@pi-fit-trace/api-contracts";
```

## 6. Workout IDs and idempotency

`deriveWorkoutId` (`src/deriveWorkoutId.ts`) derives the id purely from record
content: no clock, no randomness, no counter. `id` and `schema_version` are
excluded before hashing, since both are assigned by the store rather than
authored by the user:

```ts
function canonicalContent(input: WorkoutRecord): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...input };
  delete clone.id;
  delete clone.schema_version;
  return clone;
}

export function deriveWorkoutId(input: WorkoutRecord): string {
  const hash = fnv1aHash(stableStringify(canonicalContent(input)));
  return `wkt_${input.date}_${input.session_type}_${hash}`;
}
```

The hash is FNV-1a (32-bit) over the canonical (`stableStringify`) content
form, rendered as `wkt_<date>_<session_type>_<hash>` with an 8-hex-digit hash
( asserted in `tests/apiContracts.test.ts` as
`/^wkt_2026-09-01_strength_[0-9a-f]{8}$/`). Changing any content field changes
the id; changing only `id`/`schema_version` does not.

Idempotency flow (asserted by the contract suite and the memory-handler test):

- The caller prepares the id before dispatch (deriving it from content when
  the draft has none, and normalizing `schema_version`), so retries send the
  same record.
- A server preserves the supplied id: an identical re-import is a no-op that
  returns the stored record with `duplicate: true` and leaves history
  unchanged; the memory handler answers the retry with `200` instead of `201`.
- The same id with different content is rejected with `CONFLICT` (`409`) and
  never overwrites the original record.

The async client boundary makes id preparation the caller's job: both the
local and HTTP clients derive the id from content only when the draft has
none, and otherwise send the supplied id unchanged. A server preserves the
caller-supplied id — it validates and normalizes the record but never
re-derives the id. A server requires the caller to supply the id and rejects
a missing/blank id with `400 VALIDATION_ERROR` (it never derives ids
itself), and malformed request bodies (e.g. `{ record: null }`) are also
`400`. This contrasts with the legacy in-browser store, which
derived ids from content internally. Preserving the caller's id is what makes
retries idempotent across the wire, and the local client behaves the same
way so both transports share one rule.

The app's stable import path re-exports the shared implementation
(`app/src/contracts/ids.ts`):

```ts
export { deriveWorkoutId } from "@pi-fit-trace/api-contracts";
```

## 7. Response validation

Strict guards (`src/validators.ts`: `parseWorkoutList`,
`parseCreateWorkoutResult`, `parseAnalysisResult`, `parsePlanDraft`) run on the
unwrapped `data` value of each endpoint before the app trusts it. Every
failure throws a `MalformedResponseError` naming the offending field:

```ts
throw new MalformedResponseError(field, reason);
// message: "Malformed response: `<field>` <reason>."
```

Checked shapes include the list index (`(root)[1]`), nested metric fields
(`metrics.sessions`, `metrics.volume_kg`, including non-finite `NaN`),
vocabulary fields (`trends[i].direction` must be `up`/`down`/`flat`,
`trends[i].metric` must be `"est_1rm_kg"`, `flags[i].severity` must be
`info`/`warning`/`critical`), the non-object root (`(root)`), and the draft
gate (`is_draft` and `requires_confirmation` must both be `true` — a
non-draft is always rejected). Record payloads defer hard rules to core's
`validateWorkoutRecord`. Unknown extra keys are ignored (matching the
tolerant-store contract) while every required field is checked. Round-trips of
real core outputs (`analyzeProgress`, `generateNextPlan`) pass unchanged
(`tests/apiContracts.test.ts`).

## 8. Contract conformance suite

`runFitTraceClientContractSuite` (`src/testing/contractSuite.ts`) plus
`createMemoryHandler` (`src/testing/memoryHandler.ts`) are runner-agnostic:
no test-runner or `node:` imports. The host passes its own `test` registrar,
and `factory` must hand out a fresh, isolated client per call so tests never
share state:

```ts
export type ContractTestRegistrar = (name: string, fn: () => Promise<void>) => void;
export type ContractClientFactory = () => FitTraceClient | Promise<FitTraceClient>;
export type ContractReset = () => void | Promise<void>;

export function runFitTraceClientContractSuite(
  name: string,
  test: ContractTestRegistrar,
  factory: ContractClientFactory,
  reset?: ContractReset,
): void;
```

The suite asserts the behaviors local and HTTP clients must share: empty
history, deterministic ascending list order for out-of-order seeds, create
returns the saved record plus warnings (a draft without `id`/`schema_version`
gets a derived id, normalized version, and a `MISSING_SCHEMA_VERSION`
warning), identical re-create is a `duplicate` no-op, same-id/different-content
conflicts (`CONFLICT`), invalid records and inverted date filters
(`VALIDATION_ERROR`), filtered `analyze`, confirmation-gated plan drafts
(`is_draft` and `requires_confirmation` both `true`), and repeat-list
stability.

Hosts register it with their own runner. With `node:test`:

```ts
import { test } from "node:test";
import { runFitTraceClientContractSuite } from "@pi-fit-trace/api-contracts/testing";

runFitTraceClientContractSuite("local", test, () => makeClient());
```

With vitest:

```ts
import { test } from "vitest";
import { runFitTraceClientContractSuite } from "@pi-fit-trace/api-contracts/testing";

runFitTraceClientContractSuite("http", test, () => makeClient());
```

`createMemoryHandler` takes any `FitTraceClient` and returns a
`(input: string, init?: HandlerInit) => Promise<HandlerResponse>` route
function over the four endpoints. It types the request/response structurally
(`HandlerInit`/`HandlerResponse`) rather than relying on `Request`/`Response`
globals, so it runs identically under root `tsc` and jsdom. `MemoryHandlerOptions.fetchImpl`
is reserved for a future fetch-backed transport and unused by the memory
routes.

## 9. Non-goals

This contract covers shapes only. Runtime mode selection and development
modes are covered in later work, not here.

### 9.1 Authenticated deployments

`AuthPrincipal` (`src/types.ts`) is the stable caller identity the HTTP
boundary injects after verifying the bearer token (`id` = provider `sub`,
e.g. the Supabase `auth.users` id; optional `email`). Only the app's auth
layer (`app/src/auth/`, which stores the session and attaches the token per
request) and the HTTP transport ever see tokens; the domain core and the
workout stores receive only resolved principals and validated records.
`PublicApiConfig` is the public bootstrap shape served by
`GET /public-config` (Supabase URL + publishable key only — never secrets).

### 9.2 Loopback development API

`server/devApiServer.ts` is a loopback-bound `node:http` development API for
exercising the contract over real HTTP. It reuses `createMemoryHandler` over
an in-memory append-only store (`server/inMemoryWorkoutStore.ts`) that runs
the deterministic core directly and serializes imports, so concurrent
same-id submits resolve to exactly one stored record plus duplicates. It is
bound to loopback and clears its records on restart. The runtime modes
(local vs HTTP), proxy, scripts, and storage ownership are documented in
`docs/app-dev-modes.md`.

Coaching runs over a separate loopback server: see [`coaching-api.md`](coaching-api.md).
