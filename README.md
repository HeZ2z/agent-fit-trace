# agent-fit-trace

An Agent-powered workout tracking and coaching application that turns training logs into evidence-based progress analysis and draft training plans.

[English](README.md) | [简体中文](README.zh-CN.md)

## Status

The current implementation includes a web App, deterministic shared core, local and authenticated HTTP data access, and a pi integration with Extension tools and a `training-coach` Skill.

Planned Agent support: a hosted cloud coach requiring no local Agent installation, plus local coaching through the user's Codex, pi, or OpenCode CLI. These execution paths are not yet implemented.

## How it works

App JSON → `import_workout` → deterministic analysis → `generate_next_plan` draft → user confirmation.

- **App** — `app/`: workout collection, history, analysis, and plan draft display.
- **Shared core** — `packages/fit-trace-core/`: deterministic validation, metrics, progress analysis, and draft plans.
- **Data API** — `packages/fit-trace-api-contracts/` and `server/`: shared client contracts and authenticated HTTP data access.
- **Current pi integration** — `.pi/extensions/fit-trace/` and `.pi/skills/training-coach/SKILL.md`: tool registration, local JSON persistence, and coaching instructions.

## Development

Requires Node >= 24 and pnpm.

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Docs

- [MVP design](docs/mvp-design.md)
- [pi integration spec](docs/extension-skill-spec.md)
