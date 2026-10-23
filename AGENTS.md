# AGENTS.md

## Pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md) when preparing commits and PRs. Use [.github/pull_request_template.md](.github/pull_request_template.md) for PR descriptions, and report actual verification results and known gaps.

PRs also receive an advisory, self-hosted AI review comment; it is not a merge gate. See [docs/ai-review.md](docs/ai-review.md) for the BYOK setup, limits, and local dry-run command.

## What this repo is

`agent-fit-trace` is an Agent-powered workout tracking and coaching application that turns training logs into evidence-based progress analysis and draft training plans. The product targets local coaching through the user's existing Codex, pi, or OpenCode CLI and a hosted cloud coach that requires no local Agent installation. Local coaching through the user's pi CLI is implemented (launcher-gated via `agent-fit-trace start`); the Codex/OpenCode and hosted cloud execution paths are planned. The current implementation includes the App, deterministic shared core, local/authenticated HTTP data access, a pi Extension + training-coach Skill integration, and the local coaching flow. The docs in `docs/` remain the product contract.

## Layout

- `.pi/extensions/fit-trace/index.ts` — the only pi-runtime module; registers the four tools.
- `.pi/extensions/fit-trace/store.ts` — Node-only JSON persistence, out of the shared core.
- `packages/fit-trace-core/` (`@agent-fit-trace/core`) — browser-safe pure TypeScript domain logic and the shared contract (no pi/typebox/Node built-ins), including shared barbell plate-loading math in `src/plates.ts`. Tests and the app target this.
- `packages/fit-trace-workout-session/` (`@agent-fit-trace/workout-session`) — browser-safe pure session draft/timing/build/persistence model shared by the web editor and the mobile Log screen (no pi/typebox/React/expo/Node built-ins). Rest is transient runtime state and is never persisted.
- `packages/fit-trace-api-contracts/` (`@agent-fit-trace/api-contracts`) — the shared app/pi client contract (shapes, errors, contract suite) both clients satisfy.
- `app/` — React+Vite UI, fixture/client-driven; provider default client is mode-aware (`VITE_FIT_TRACE_MODE=http` → HTTP client, else local).
- `server/` — loopback dev API (`pnpm dev:api`; in-memory store, clears on restart) that HTTP mode reaches via the Vite `/api` proxy.
- `.pi/skills/training-coach/SKILL.md` — the Skill; auto-discovered by pi.
- `fixtures/` — JSON fixtures used by tests. `tests/` — `node:test` suite.

## Commands

- `pnpm install`
- `pnpm test` — extension (`node:test` over `tests/*.test.ts`) + app (`vitest`).
- `pnpm typecheck` — root `tsc --noEmit` + app typecheck.
- `pnpm dev:api` — run the loopback dev API (`127.0.0.1:5199`).
- `pnpm build` — production build of the app.

## Hard rules

- Shared core and domain tools are deterministic: no LLM, clock, or randomness in `packages/fit-trace-core/`. Agent/Skill instructions own interpretation and domain behavior; they must not read storage directly.
- pi signals tool failure by **throwing** from `execute`. Returning `{ accepted: false }` is not an error. Validation/conflict failures throw `FitTraceError` subclasses.
- Imports are idempotent by `id`: an identical re-import is a no-op; the same `id` with different content throws `CONFLICT` (never overwrite an original record).
- Stored records are re-validated on load; a malformed/outdated store throws `CORRUPT_STORE` with the failing record index. Date filters are validated and throw `VALIDATION_ERROR` (invalid or inverted ranges) instead of an opaque `RangeError`.
- `generate_next_plan` returns a draft and never writes; plans require explicit user confirmation.
- Keep pi/typebox imports confined to `index.ts`.

## Gotchas

- Requires Node >= 24 and pnpm (`packageManager: pnpm@10.34.5`).
- Core modules use `.ts` extensions in relative imports (Node type-stripping) and must stay erasable: no `enum`, no parameter properties.
- Persistence is local JSON at `<cwd>/.pi/fit-trace/workouts.json`; override with `PI_FIT_TRACE_STORE`.
- Tests mock `ExtensionAPI`, so the adapter is exercised without a pi runtime.

## Planned Agent integration

Local coaching through the user's pi CLI IS implemented: the launcher-gated flow runs pi locally over the loopback coaching server. Hosted cloud coaching, and local coaching through the user's Codex or OpenCode CLI, are not implemented. Agent session transport, lifecycle, and shared tool access for those remaining backends remain to be designed and verified. Existing local/HTTP data clients select storage access, not the Agent execution backend.
