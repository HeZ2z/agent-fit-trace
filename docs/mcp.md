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
node packages/fit-trace-mcp/src/main.ts [--store PATH] [--skill PATH]
```

Requires Node >= 24. Node 24 runs TypeScript entrypoints with type stripping
by default, so no `--experimental-strip-types` flag is needed. `--help` prints
usage; `--version` prints `agent-fit-trace-mcp 0.1.0`.

## Storage

| Precedence | Source |
| --- | --- |
| 1 | `--store PATH` flag |
| 2 | `PI_FIT_TRACE_STORE` environment variable |
| 3 | `$HOME/.fit-trace/workouts.json` (default) |

Blank flag/env values count as unset. The pi extension keeps its own default
(`<cwd>/.pi/fit-trace/workouts.json`); the MCP server default is independent
of it. To point both clients at one dataset, either export the same
`PI_FIT_TRACE_STORE` for both processes, or pass
`--store <repo>/.pi/fit-trace/workouts.json` to the MCP server. The store is
one JSON file written atomically (temp file + rename) with no cross-process
lock, so two concurrent writers can lose records; shared use should stay
light. The same rules apply to whichever file is opened: records are
re-validated on load (`CORRUPT_STORE`), and re-importing an id with changed
content is a `CONFLICT`, never an overwrite.

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

Cursor (`~/.cursor/mcp.json`), here with a shared store override:

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

`--store PATH` / `--skill PATH` can be passed as extra `args` entries instead
of env vars.

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

## Limitations

- stdio only; no HTTP/SSE transport is wired.
- No packaged `npx` distribution; the server runs from source like the
  launcher.
- The server is unauthenticated and local-first: it reads and writes whatever
  file the store resolution lands on. Point `--store` at a file you intend the
  host agent to modify.
- Real-host QA (Claude Desktop, Cursor) is outstanding; verification today is
  the MCP inspector CLI and the `node:test` suite (`tests/mcpServer.test.ts`).
