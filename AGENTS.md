# AGENTS.md

## Pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md) when preparing commits and PRs. Use [.github/pull_request_template.md](.github/pull_request_template.md) for PR descriptions, and report actual verification results and known gaps.

PRs also receive an advisory, self-hosted AI review comment; it is not a merge gate. See [docs/ai-review.md](docs/ai-review.md) for the BYOK setup, limits, and local dry-run command.

## What this repo is

`agent-fit-trace` is an Agent-powered workout tracking and coaching application that turns training logs into evidence-based progress analysis and draft training plans. The product targets local coaching through the user's existing Codex, pi, or OpenCode CLI and a hosted cloud coach that requires no local Agent installation. Local coaching through the user's pi CLI is implemented (launcher-gated via `agent-fit-trace start`); the Codex/OpenCode and hosted cloud execution paths are planned. The current implementation includes the App, deterministic shared core, local/authenticated HTTP data access, a pi Extension + training-coach Skill integration, and the local coaching flow. The docs in `docs/` remain the product contract.

## Layout

- `.pi/extensions/fit-trace/index.ts` — the only pi-runtime module; registers the four tools. Normal mode opens the shared per-identity SQLite store (`resolveActiveStore`: `FIT_TRACE_PRINCIPAL`/`identity.json`/guest); `PI_FIT_TRACE_STORE` still selects an explicit file (coached per-run snapshots, `.json` keeps the JSON backend).
- `packages/fit-trace-store/` (`@agent-fit-trace/store`) — Node-only JSON persistence (atomic file storage + idempotent WorkoutStore), out of the shared core; shared by the pi extension and other Node adapters. A SQLite backend (`node:sqlite` · WAL · per-identity databases) coexists with the JSON backend.
- `packages/fit-trace-core/` (`@agent-fit-trace/core`) — browser-safe pure TypeScript domain logic and the shared contract (no pi/typebox/Node built-ins). Tests and the app target this.
- `packages/fit-trace-workout-session/` (`@agent-fit-trace/workout-session`) — browser-safe pure session draft/timing/build/persistence model shared by the web editor and the mobile Log screen (no pi/typebox/React/expo/Node built-ins). Rest is transient runtime state and is never persisted.
- `packages/fit-trace-api-contracts/` (`@agent-fit-trace/api-contracts`) — the shared app/pi client contract (shapes, errors, contract suite) both clients satisfy.
- `packages/fit-trace-cli/` (`@agent-fit-trace/cli`) — source-run `agent-fit-trace` bin: `start` (same-origin launcher proxying a fixed authenticated upstream; `docs/local-launcher.md`) and `daemon` (resident local data plane: loopback `/api/v1` over per-principal SQLite stores, the same coaching server, optional App shell; `docs/local-daemon.md`).
- `packages/fit-trace-desktop/` (`@agent-fit-trace/desktop`) — Electron thin shell over the daemon. `pnpm desktop:dev` runs it from the checkout; `pnpm desktop:build` + `pnpm desktop:package` produce **unsigned internal builds** (no signing/notarization/auto-update) via electron-builder, and packaged builds do not carry coaching (`docs/local-daemon.md` "Desktop shell", `docs/adr/0006-desktop-packaging.md`). Shell code is pure-JS `.cjs` with no build chain and not in tsconfig: `main/paths.cjs` (dev vs packaged launch plan), `main/daemonChild.cjs` (electron-free daemon spawn/health/restart plumbing), `main/main.cjs` (single-instance lock, window over the daemon's loopback URL, zero custom IPC), `scripts/dev.cjs` (dev entry), `scripts/{buildDaemon,prepareRuntime,buildRuntime,package}.cjs` (packaging chain; `buildDaemon.cjs` is the one generated-artifact producer, an esbuild bundle of `packages/fit-trace-cli/src/cli.ts`). Electron and electron-builder are this package's only dependencies (devDependencies only) — neither may appear in any other package.
- `packages/fit-trace-mcp/` (`@agent-fit-trace/mcp`) — standalone stdio MCP server (`@modelcontextprotocol/sdk`): the four tools, two read-only resources, and the `training-coach` prompt for any MCP host. Default store is the shared per-identity SQLite database resolved like the daemon/app/pi (`--store` > `--principal`/`FIT_TRACE_PRINCIPAL` > `identity.json` > guest); a JSON file stays selectable via `--store <path>.json` or `PI_FIT_TRACE_STORE=<path>.json` (compat escape hatch, one release); see `docs/mcp.md`.
- `app/` — React+Vite UI, fixture/client-driven; provider default client is mode-aware (`VITE_FIT_TRACE_MODE=http` → HTTP client, else local). The app also negotiates the daemon guest-local surface from `GET /api/v1/public-config` (`daemon: true` + `auth_configured: false` boots signed-in as the daemon's local guest over the fixed guest bearer, no Supabase configuration or build variables; `docs/app-dev-modes.md`).
- `server/` — loopback dev API (`pnpm dev:api`; in-memory store, clears on restart) that HTTP mode reaches via the Vite `/api` proxy. The SQLite-backed per-principal stores (`sqlitePrincipalStores.ts`) and the guest local verifier (`auth/localVerifier.ts`) are the foundation of the daemon data plane.
- `.pi/skills/training-coach/SKILL.md` — the Skill; auto-discovered by pi.
- `fixtures/` — JSON fixtures used by tests. `tests/` — `node:test` suite.

## Commands

- `pnpm install`
- `pnpm test` — extension (`node:test` over `tests/*.test.ts`) + app (`vitest`).
- `pnpm typecheck` — root `tsc --noEmit` + app typecheck.
- `pnpm dev:api` — run the loopback dev API (`127.0.0.1:5199`).
- `pnpm daemon` — run the resident local daemon (loopback `127.0.0.1:5199`, SQLite data plane; see `docs/local-daemon.md`).
- `pnpm desktop:dev` — open the desktop shell (Electron window over its own daemon child; see `docs/local-daemon.md` "Desktop shell"). Requires a built `app/dist` (`pnpm build`); the first run also prepares the electron binary once.
- `pnpm desktop:build` — stage the packaged desktop app (esbuild daemon bundle + runtime `node:sqlite` probe + a copy of `app/dist`).
- `pnpm desktop:package` — produce an **unsigned** electron-builder artifact for the current host in `packages/fit-trace-desktop/release/` (no signing, no notarization, no auto-update). Release artifacts for all platforms come from `.github/workflows/release.yml`; see `docs/release.md`.
- `node scripts/sync-versions.mjs` / `--check` — stamp / verify every package version against the root `package.json` (the single source of truth). `--check` runs in CI on every push and PR.
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
- Persistence is local JSON at `<cwd>/.pi/fit-trace/workouts.json` only when `PI_FIT_TRACE_STORE` pins it (or in coached snapshots); the pi extension's normal mode and the MCP server now default to the shared per-identity SQLite database under `FIT_TRACE_DATA_DIR` (default `~/.fit-trace/data`), resolved from `identity.json` (`guest.db` on first run).
- Electron and electron-builder are confined to `packages/fit-trace-desktop` (devDependencies only); pnpm 10 skips unapproved postinstall scripts, so a root `pnpm install` does not download the electron binary — the CI test job never fetches it, the first `pnpm desktop:dev` runs electron's `install.js` once, and the release workflow's desktop job runs it explicitly before packaging (`tests/desktopPackageIsolation.test.ts` guards the boundary).
- Tests mock `ExtensionAPI`, so the adapter is exercised without a pi runtime.

## Planned Agent integration

Local coaching through the user's pi CLI IS implemented: the launcher-gated flow runs pi locally over the loopback coaching server. The app→daemon local data loop is also live (issue #39): the app negotiates the daemon's guest-local surface from `public-config`, boots without any Supabase configuration, and drives the full `/api/v1` contract against the daemon's per-principal SQLite stores with the fixed guest bearer. The shared-store loop is closed as well (issue #40): the MCP server and the pi extension's normal mode resolve the same per-identity SQLite databases through `@agent-fit-trace/store`'s `resolveActiveStore` — following the daemon-written `identity.json` (guest today), with a one-release JSON escape hatch — so the app, coach, MCP hosts, and pi operate on one dataset per identity. Hosted cloud coaching, and local coaching through the user's Codex or OpenCode CLI, are not implemented. Agent session transport, lifecycle, and shared tool access for those remaining backends remain to be designed and verified. Existing local/HTTP data clients select storage access, not the Agent execution backend. A standalone stdio MCP server (`packages/fit-trace-mcp`, issue #27) is also implemented for any MCP host; it mirrors the pi extension's normal-mode tools, is stdio-only, and is not part of the coached pipeline or the runtime registry.
