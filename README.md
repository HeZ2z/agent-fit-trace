# agent-fit-trace

An Agent-powered workout tracking and coaching application that turns training logs into evidence-based progress analysis and draft training plans.

[English](README.md) | [简体中文](README.zh-CN.md)

## Status

The current implementation includes a web App, deterministic shared core, local and authenticated HTTP data access, a pi integration with Extension tools and a `training-coach` Skill, and a coaching flow. The `agent-fit-trace start` launcher serves the App and a loopback coaching server on one origin; authenticated HTTP deployments also show the Coach screen. One account-level owner drives sessions, streamed runs, cancel/reconnect, backend selection, and a versioned account-bound resume. Local pi is the default and legacy-compatible path; `piAvailable: false` is surfaced in the UI instead of a generic failure. Local runs persist to an app-owned journal, so retained runs, events, and idempotency survive a launcher restart. A run that was active when the previous process exited is reported as execution-unconfirmed rather than silently re-run.

Experimental Agent paths are implemented behind fail-closed gates. Local Codex is available when the installed CLI exposes the `item/tool/call` flow, under a read-only sandbox posture ([ADR 0007](docs/adr/0007-read-only-sandbox-is-not-isolation.md)): writes and network are denied, but the model can still read files the OS account can read and echo them into the transcript, so `builtinIsolationVerified` stays false. Local OpenCode stays unavailable until the installed CLI provides positive tool-isolation evidence. Hosted cloud coaching has server routes, database migrations, an outbox worker, finite quota reservation, and a bounded provider loop, but it is disabled unless a formal account, configured quota, provider, and explicit operator configuration are present. It has not been deployed or verified against a real provider in this repository.

## How it works

App JSON → `import_workout` → deterministic analysis → `generate_next_plan` draft → user confirmation.

- **App** — `app/`: workout collection, history, analysis, and plan draft display.
- **Shared core** — `packages/fit-trace-core/`: deterministic validation, metrics, progress analysis, and draft plans.
- **Data API** — `packages/fit-trace-api-contracts/` and `server/`: shared client contracts and authenticated HTTP data access.
- **Current pi integration** — `.pi/extensions/fit-trace/` and `.pi/skills/training-coach/SKILL.md`: tool registration, the shared per-identity SQLite store (JSON remains a one-release escape hatch), and coaching instructions.

## MCP server

`packages/fit-trace-mcp/` exposes the same four tools as the pi extension over the Model Context Protocol (stdio), plus two read-only resources and the `training-coach` prompt, so any MCP host can work against the same shared per-identity SQLite store. See [docs/mcp.md](docs/mcp.md) for storage, host configuration, and verification.

## Desktop shell

`pnpm desktop:dev` opens the App in an Electron window over its own local daemon — one command, one dataset, zero custom IPC. For a local-only build run `FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build && pnpm desktop:package`; release-channel builds set the public auth variables instead. This produces **unsigned internal builds** (no signing, no notarization, no auto-update). Packaged builds ship the bundled pi extension (`pi-extension.mjs`) but no agent CLI, so local coaching requires the corresponding installed CLI — `pi` for the pi backend (plus the bundled extension), `codex` for the Codex backend (ADR 0007); OpenCode stays gated on isolation evidence. Workout tracking and the app shell always work without either CLI. See [docs/local-daemon.md](docs/local-daemon.md) and [docs/release.md](docs/release.md).

## Development

Requires Node >= 24 and pnpm.

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Docs

- [Pull request guidelines](CONTRIBUTING.md)
- [MVP design](docs/mvp-design.md)
- [pi integration spec](docs/extension-skill-spec.md)
- [Local daemon & desktop shell](docs/local-daemon.md)
- [Real-app acceptance check](docs/verification.md)
- [Coaching prompt evaluation](docs/prompt-eval.md)
- [MCP server](docs/mcp.md)
