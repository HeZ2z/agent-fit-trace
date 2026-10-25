# MCP server (`agent-fit-trace-mcp`)

Source-run stdio MCP server (`packages/fit-trace-mcp/`). It exposes the same
four domain tools as the pi extension's normal mode — import, history,
analysis, and draft planning — plus two read-only resources and the
`training-coach` prompt, so any MCP host (Claude Desktop, Cursor, …) can drive
fit-trace without the pi extension or the launcher.

## Positioning

- The server is a standalone integration surface, equivalent to the pi
  extension's normal (non-coached) mode. It is **not** a coaching execution
  backend: it never spawns or drives a model, and it is not registered in the
  coaching runtime registry (`server/coaching/runtimeRegistry.ts`). ADR 0001
  keeps coached runs to the two analysis tools and explicitly excludes MCP
  servers from the coached tool surface; this server lives entirely outside
  that pipeline (see
  [`adr/0001-agent-execution-backends.md`](adr/0001-agent-execution-backends.md)).
- Transport is stdio only today (`src/main.ts`). The server factory itself is
  transport-agnostic; other transports are unwired.
- stdout carries only the MCP protocol; every diagnostic goes to stderr.
  `--help`/`--version` print to stdout before any transport exists.

## Run

```sh
node packages/fit-trace-mcp/src/main.ts [--store PATH] [--principal NAME] [--skill PATH]
```

Requires Node >= 24. Node 24 runs TypeScript entrypoints with type stripping
by default, so no `--experimental-strip-types` flag is needed. `--help` prints
usage (including the store-resolution precedence); `--version` prints
`agent-fit-trace-mcp 0.1.0`.

## Storage

By default the server opens the **shared per-identity SQLite database** — the
same file the daemon, the desktop app, and the pi extension's normal mode use —
via `@agent-fit-trace/store`'s `resolveActiveStore`
(`packages/fit-trace-store/src/identity.ts`). Databases live under the data
directory (`$FIT_TRACE_DATA_DIR`, default `~/.fit-trace/data`) as
`<principal>.db`. Principal resolution, in order:

| Level | Source |
| --- | --- |
| 1 | `--store PATH` — an explicit absolute path, used as-is (bypasses principal handling entirely) |
| 2 | `--principal NAME` flag / `FIT_TRACE_PRINCIPAL` env (flag wins) — `<dataDir>/<NAME>.db`, created on first run |
| 3 | `identity.json`'s `active_principal` — used **only when the record exists and its database file exists** |
| 4 | no `identity.json` (first run) — the `guest.db` store |

A `identity.json` naming a principal whose database file is missing fails
startup loudly with `STALE_IDENTITY` (naming the identity file, the missing db,
and both override methods) instead of silently falling back to guest — a silent
fallback would fragment the dataset.

**JSON compatibility escape hatch (kept for one release):** a JSON store file
is still selectable with `--store <path>.json` or the legacy
`PI_FIT_TRACE_STORE=<path>.json` env, which sits between `--store` and
principal resolution as an explicit file choice. An explicit `.json` path keeps
the JSON backend; any other explicit path opens as SQLite. A blank flag or env
value counts as unset.

Because followers resolve `identity.json` at startup, the desktop app's active
principal propagates to independently launched MCP sessions: switching identity
in the app (recorded by the daemon into `identity.json`) is picked up by the
next MCP server start with no extra arguments. Today the daemon records
`guest` at startup (`docs/local-daemon.md`), so all local surfaces share
`guest.db`; the resolution seam above is what makes a later principal switch
follow automatically.

Multi-process sharing is safe by construction: the SQLite backend opens the
database in WAL mode with a 5 s `busy_timeout`, so the daemon, MCP servers, and
pi sessions read and write the same file concurrently (multiple readers, one
writer at a time; lock waits instead of lost records). The same rules apply to
whichever backend is opened: records are re-validated on load
(`CORRUPT_STORE`), and re-importing an id with changed content is a `CONFLICT`,
never an overwrite.

## Prompt and skill file

The `training-coach` prompt serves the body of
`.pi/skills/training-coach/SKILL.md` (YAML frontmatter stripped), resolved
from this repo checkout. Override with `--skill PATH` or
`FIT_TRACE_SKILL_PATH`. There is no inline fallback: a missing or unreadable
skill file fails startup with exit code 2 and a message naming the attempted
path and both override methods.

## Surfaces

| Kind | Name | Notes |
| --- | --- | --- |
| Tool | `import_workout` | Validate and store one session; idempotent by `id` (`idempotentHint: true`, `destructiveHint: false`) |
| Tool | `get_training_history` | Date-range/exercise query with pagination (`readOnlyHint: true`) |
| Tool | `analyze_progress` | Deterministic metrics, per-exercise trends, safety flags (`readOnlyHint: true`) |
| Tool | `generate_next_plan` | Draft plan; requires user confirmation, never writes (`readOnlyHint: true`) |
| Resource | `fit-trace://workouts/recent` | The 10 most recent records, `application/json`, live read |
| Resource | `fit-trace://analysis/summary` | `analyze_progress` defaults over all records, `application/json`, live read |
| Prompt | `training-coach` | The skill body as one user message |

Tool results mirror the pi extension's text and structured payloads. A domain
failure (`VALIDATION_ERROR`, `CONFLICT`, `CORRUPT_STORE`) is returned as an
`isError` result whose text is `CODE: message`; the process stays up.
Malformed tool arguments fail the SDK's input-schema validation and come back
as an `isError` result (the SDK's `InvalidParams` text) before any handler
runs. Any other unexpected failure returns a fixed `INTERNAL_ERROR` text
without a stack.

## Host configuration

GUI hosts do not inherit your shell `PATH` (a macOS GUI app cannot see an
nvm/volta-managed `node`), so use absolute paths for both the node binary and
the entrypoint. Find the node path with `command -v node`.

Claude Desktop (`claude_desktop_config.json`, Developer → Edit Config):

```json
{
  "mcpServers": {
    "fit-trace": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-fit-trace/packages/fit-trace-mcp/src/main.ts"]
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`) — with no extra configuration the server follows
`identity.json` and shares the daemon's per-identity database. To pin an
explicit store instead, pass the JSON escape hatch as an env var:

```json
{
  "mcpServers": {
    "fit-trace": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-fit-trace/packages/fit-trace-mcp/src/main.ts"],
      "env": { "PI_FIT_TRACE_STORE": "/absolute/path/to/workouts.json" }
    }
  }
}
```

`--store PATH` / `--principal NAME` / `--skill PATH` can be passed as extra
`args` entries instead of env vars.

## Verify

```sh
npx @modelcontextprotocol/inspector --cli node "$PWD/packages/fit-trace-mcp/src/main.ts" --method tools/list
```

This lists the four tools with their annotations. Verified 2026-10-24 against
this repo with a 3-record fixture store via `--store`: `tools/list` advertises
all four tools with full JSON Schemas and annotations
(`import_workout {destructiveHint:false, idempotentHint:true}`; the other
three `{readOnlyHint:true}`), `tools/call` for `analyze_progress`
(3 sessions, 8325 kg) and `generate_next_plan --tool-arg goal=strength`
(draft with `requires_confirmation`) returns text plus `structuredContent`,
`resources/read` serves both URIs as `application/json`, and
`prompts/get --prompt-name training-coach` returns the skill body with the
YAML frontmatter stripped. Drop `--cli` for the interactive inspector UI.

To verify the shared per-identity store across surfaces, point a scratch data
directory at both the daemon and the MCP server and confirm one import is
visible from both sides:

```sh
FIT_TRACE_DATA_DIR=/tmp/fit-trace-shared pnpm daemon &
sleep 1
curl -s -X POST -H "Authorization: Bearer fit-trace-local-daemon" \
  -H "Content-Type: application/json" \
  -d @fixtures/valid-strength.json \
  http://127.0.0.1:5199/api/v1/workouts > /dev/null
npx @modelcontextprotocol/inspector --cli node "$PWD/packages/fit-trace-mcp/src/main.ts" \
  --method tools/call --tool-name analyze_progress
# The default-resolution startup line on stderr names the same
# /tmp/fit-trace-shared/guest.db the daemon wrote, and the analysis counts
# the record the daemon imported.
```

The same check runs the other direction (`tests/mcpSharedStore.test.ts` /
`tests/piSharedStore.test.ts` cover it in-process): records imported through a
plain `SqliteWorkoutStore` connection are visible to MCP `analyze_progress` and
to the pi extension's normal-mode tools against the same `guest.db`.

## Limitations

- stdio only; no HTTP/SSE transport is wired.
- No packaged `npx` distribution; the server runs from source like the
  launcher.
- The server is unauthenticated and local-first: it reads and writes whatever
  store the resolution lands on — by default the per-identity database shared
  with the daemon, app, and pi. Point `--store` at a file you intend the host
  agent to modify.
- Real-host QA (Claude Desktop, Cursor) is outstanding; verification today is
  the MCP inspector CLI and the `node:test` suite (`tests/mcpServer.test.ts`,
  `tests/mcpSharedStore.test.ts`).
