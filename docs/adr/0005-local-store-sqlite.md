# ADR 0005: SQLite backend for the local workout store

- **Status:** Accepted. `SqliteWorkoutStore` and per-identity store resolution
  are implemented in `@agent-fit-trace/store` and covered by the shared store
  contract suite. The server side of #38 has landed as well: per-principal
  `FitTraceClient`s over these databases
  (`server/sqlitePrincipalStores.ts`). Wiring the `daemon` command, the MCP
  server, and pi to the resolved stores is issue #38/#40 work and is
  intentionally out of scope here.
- **Date:** 2026-10-24
- **Scope:** issue #37. This ADR records the engine choice, the multi-process
  posture, and the per-identity file layout for the local workout store. It is
  not a claim that any consumer other than the test suite opens the SQLite
  store in production yet.
- **Related:** [`0001-agent-execution-backends.md`](0001-agent-execution-backends.md),
  [`../mcp.md`](../mcp.md), parent epic #42, store resolution precedence #40.

## Context

The shared workout store is a single JSON file (`JsonFileStorage` +
`WorkoutStore`): atomic writes via temp-file rename, but serialization of
read-modify-write cycles only through an in-process promise queue. There is no
cross-process locking, and `docs/mcp.md` documents that two concurrent writers
can lose records.

The agreed local architecture (parent epic #42) runs the daemon, the MCP
server, and directly-launched pi against **one dataset**. Those are separate OS
processes that cannot share a promise queue, so the store needs a
multi-process-safe backend while keeping its observable contract identical:
import idempotency by `id` (identical re-import is a no-op, changed content is
`CONFLICT`), read-time re-validation (`CORRUPT_STORE` with the failing record
index), and the Promise-based `all()`/`import()`/`query()` surface.

This is the cheapest moment to switch the default local backend: no production
store file exists yet, so there is no migration to design.

## Decision

### 1. Engine: `node:sqlite` with WAL and `busy_timeout`

`SqliteWorkoutStore` (`packages/fit-trace-store/src/sqlite.ts`) wraps
`node:sqlite`'s `DatabaseSync` — built into Node >= 24, so the change adds **no
new dependency**. On open it sets, in order:

1. `PRAGMA busy_timeout = 5000` — first, so every later statement (including
   the WAL switch in a concurrently opening process) waits on a locked database
   instead of failing fast with `SQLITE_BUSY`;
2. `PRAGMA journal_mode = WAL` — multi-process readers and one writer at a
   time, directly against the same file;
3. `PRAGMA synchronous = NORMAL` and `PRAGMA foreign_keys = ON`;
4. idempotent schema creation (`CREATE TABLE IF NOT EXISTS workouts(id TEXT
   PRIMARY KEY, date TEXT NOT NULL, canonical TEXT NOT NULL, record TEXT NOT
   NULL)` plus a `date` index).

`DatabaseSync` is synchronous, so each `BEGIN IMMEDIATE`..`COMMIT` window runs
to completion inside one tick and cannot interleave in-process; cross-process
serialization is SQLite's job. `SQLITE_CONSTRAINT` on insert maps to the same
`ConflictError` as the JSON backend; remaining `SQLITE_BUSY` is left to
`busy_timeout` to absorb.

### 2. Per-identity database files

Databases live under `~/.fit-trace/data/<principal>.db` (override with
`FIT_TRACE_DATA_DIR`). Principals are restricted to `[A-Za-z0-9._-]+` so the
filename cannot escape the data directory. `identity.json` (shape
`{ schema_version: 1, active_principal: string }`) names the active principal.
Store resolution precedence (`packages/fit-trace-store/src/identity.ts`, pinned
by #40):

1. explicit absolute `--store` path — bypasses principal handling entirely;
2. explicit `--principal` argument or `FIT_TRACE_PRINCIPAL` — the named db is
   used and may be created on first run;
3. `identity.json`'s `active_principal` — its db file **must already exist**; a
   recorded principal with a missing db raises `StaleIdentityError` (naming the
   identity file, the missing db, and all three overrides) instead of silently
   falling back to guest;
4. no `identity.json` (first run) — the `guest.db` store.

### 3. Semantics are preserved, not reimplemented

The `id` PRIMARY KEY plus a canonical-JSON comparison column
(`stableStringify(record)`, the same function the JSON backend compares with)
keeps the duplicate no-op vs `CONFLICT` contract identical. Rows are
re-validated through `@agent-fit-trace/core` on every read; a corrupt row
surfaces as `CORRUPT_STORE` with its row index. Query filtering
(dates/exercise/pagination) lives in one shared pure function
(`filterRecordsPage`) that both backends call, so the two backends cannot drift.
The JSON backend (`JsonFileStorage` + `WorkoutStore`) is retained unchanged for
tests and per-run coaching snapshots.

### 4. Rejected alternatives

- **`better-sqlite3`** — a native dependency with a build matrix for every
  contributor and CI runner, for the same API shape `node:sqlite` already
  provides. Recorded as the **fallback**: if `node:sqlite`'s experimental
  status bites in a way flags cannot paper over, it swaps in behind the same
  store surface.
- **Single-writer JSON** — the cross-process lock problem is permanent by
  construction; advisory file locks would re-implement SQLite's locking badly.
- **Daemon as single owner + HTTP for everyone** — would serialize access
  correctly but sacrifices the MCP server's standalone stdio operation
  (`packages/fit-trace-mcp`) and makes pi depend on a daemon being up.

### 5. Risks and mitigations

- **`node:sqlite` is experimental.** It emits an `ExperimentalWarning` on some
  Node 24 minors. The warning goes to **stderr**, so MCP stdio and daemon logs
  stay protocol-safe; it is suppressed with
  `--disable-warning=ExperimentalWarning` at the entrypoints (daemon/MCP spawn
  flags, #40/#38) and in the root `test:extension` script. Library code applies
  no global suppression. The `better-sqlite3` fallback above bounds the worst
  case.
- **Concurrent schema creation.** Two processes racing `CREATE TABLE IF NOT
  EXISTS` on a fresh file serialize through `busy_timeout`, which is why it is
  set before the WAL switch.
- **No migration needed.** The decision lands before any production store file
  exists; there is no data to convert.

## Evidence

- Engine and flag verified on this machine during issue #37 work: Node
  **v24.21.0** exposes `node:sqlite` (`DatabaseSync`), and
  `--disable-warning=ExperimentalWarning` suppresses the `node:sqlite`
  experimental warning on that runtime (recorded in issue #37).
- Type surface checked against the repo-pinned `@types/node@24.13.4`
  (`node_modules/@types/node/sqlite.d.ts`).
- Backend parity is enforced by `tests/store.contract.ts` (10 shared cases run
  against both backends), `tests/sqliteStore.test.ts` (two-connection and
  corrupt-row cases), and `tests/sqliteMultiprocess.test.ts` (two spawned
  processes concurrently importing 25 records each plus shared identical
  content; no lost or duplicated rows).

## Consequences

**Positive**

- Daemon, MCP, and pi can share one dataset per identity without a coordinator
  process, with no new dependency.
- The observable store contract (idempotency, `CONFLICT`, `CORRUPT_STORE`,
  query semantics) is provably identical across backends via the shared suite.
- Store selection precedence is explicit, fails loudly on a stale identity, and
  never silently falls back to guest.

**Negative / open work**

- `node:sqlite` is still experimental upstream; entrypoints must keep carrying
  the warning-suppression flag until it stabilizes.
- WAL sidecar files (`-wal`/`-shm`) exist while a connection is open; anything
  that snapshots or syncs the data directory must account for them.
- Per-identity files mean there is no cross-principal query surface; a user
  with several principals runs several databases.
- Production consumers (daemon, MCP, pi) still resolve the JSON store; wiring
  `resolveActiveStore` into them is #40/#38 and must land before this backend
  is anything more than tested code.
