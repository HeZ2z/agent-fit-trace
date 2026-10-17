# Deployment: Vercel + Supabase

## Project setup

Link a fresh checkout to your Vercel project:

```sh
pnpm dlx vercel link --yes --scope <team-slug> --project <project-name>
pnpm dlx vercel deploy --yes --scope <team-slug>
```

Configure the Supabase integration for the intended deployment environments.
`NEXT_PUBLIC_*` variables are not automatically exposed by Vite;
only explicitly selected public configuration may become `VITE_*` — in
practice the app bootstraps the Supabase URL + publishable key at runtime
from `GET /api/v1/public-config`, so no `VITE_*` Supabase copies are needed.
Keep generated `.vercel/` and `.env.local` files out of Git.

## Current deployable application

The React/Vite application deploys from the repository root using
`vercel.json`. Vercel installs the pnpm workspace, runs `pnpm build`, and
serves `app/dist`. SPA rewrites support direct visits to `/analysis`,
`/plan`, and workout routes. API and asset paths are excluded from rewrites.

Vercel Preview and Production deployments are both production builds: set
`VITE_FIT_TRACE_MODE=http` for both. Leaving it unset, empty, or `local` now
fails closed with the configuration screen instead of falling back to
browser-local storage. Browser-local mode is development-only (`pnpm dev`).
With `http`, the app shows the invite-only login UI and talks to the Vercel
functions under `/api/v1` (see `docs/supabase-setup.md` for the required
`SUPABASE_URL` / publishable-key env and the dashboard invite-only checklist).
The Vite loopback proxy is development-only.

To deploy via Vercel's Git integration, import this repository with the
repository root as Root Directory. Use Node 24 and the committed build
settings. Do not set Root Directory to `app`: it needs the workspace
packages.

## Target architecture

- Vercel hosts the frontend and request-scoped authenticated API functions.
- Supabase provides managed Postgres. Its project determines the supported
  Postgres version; no arbitrary major-version override is required.
- Supabase Auth supplies email/password login, email verification and
  password recovery. Registration is invite-only for the first release.
- Apply versioned migrations through Supabase tooling. Use local Supabase
  in Docker for development and isolated database integration tests.
- Enable workout ownership policies and RLS before exposing tables through
  Supabase's Data API. Keep explicit application authorization as well.
- Run long-lived pi agent sessions in a separate service. Vercel API
  functions authorize and dispatch runs; they must not rely on process
  memory or a permanently running pi process surviving between requests.

## Configuration boundaries

The Supabase project URL and publishable key may be used in the browser.
Database passwords, secret/service-role keys, and agent credentials must
remain server-only. Never put them in `VITE_*` variables.

Use the Supabase connection mode appropriate to serverless functions;
configure TLS and bounded connections. Use a separate migration connection
when required by the migration tool. Verify session/transaction semantics
before relying on RLS context through a transaction pooler.

Configure Supabase Auth redirect URLs for the deployed application before
testing login. Use separate projects or isolated environments for previews
and production, and do not run production migrations from preview builds.

## Release verification

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before deployment.
Preview deployments are production builds too: they need the same HTTP mode and
Supabase env as production, otherwise they intentionally show the configuration
error. A full release additionally requires authenticated API tests,
ownership/RLS tests, database persistence tests, login/session tests, and
default pi coaching integration tests.

## Agent configuration (planned)

The default pi agent uses a server-configured OpenRouter model.
Leave these server-side configuration placeholders empty until configured:

```dotenv
FIT_TRACE_OPENROUTER_BASE_URL=
FIT_TRACE_OPENROUTER_API_KEY=
FIT_TRACE_OPENROUTER_MODEL=
```

These are planned configuration names, not currently implemented settings.
Missing configuration must show an unconfigured agent state, never silently
use a paid model. Workout tracking and deterministic analysis remain usable.
The intended native-`fetch` request shape, the fail-closed guest/account/quota
rules, and the provider's documented cancellation limits are recorded in
[`adr/0001-agent-execution-backends.md`](adr/0001-agent-execution-backends.md);
no cloud adapter or provider call exists yet.

User-owned Codex/OpenCode/pi agents run on the user's computer and require
a locally started, paired connector. Local agent credentials remain local;
cloud connection credentials are encrypted and revocable. The connector
uses outbound connections; its relay and the default pi runtime require a
separately verified hosting path rather than a permanent Vercel Function.

Coaching conversations have user-selected retention and deletion controls.
Expiry cleanup must be implemented and verified before claiming retention
settings are enforced.
