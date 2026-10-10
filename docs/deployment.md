# Deployment: Vercel + Supabase

## Project setup

Link a fresh checkout to your Vercel project:

```sh
pnpm dlx vercel link --yes --scope <team-slug> --project <project-name>
pnpm dlx vercel deploy --yes --scope <team-slug>
```

Configure the Supabase integration for the intended deployment environments.
The current Vite application does not consume its variables yet.
`NEXT_PUBLIC_*` variables are not automatically exposed by Vite;
only explicitly selected public configuration may become `VITE_*`.
Keep generated `.vercel/` and `.env.local` files out of Git.

## Current deployable application

The React/Vite application deploys from the repository root using
`vercel.json`. Vercel installs the pnpm workspace, runs `pnpm build`, and
serves `app/dist`. SPA rewrites support direct visits to `/analysis`,
`/plan`, and workout routes. API and asset paths are excluded from rewrites.

Leave `VITE_FIT_TRACE_MODE` unset for the current preview: records live in
the browser's localStorage. Supabase persistence and authentication are
planned, not implemented. Setting HTTP mode on Vercel currently has no
deployed API to connect to: the Vite loopback proxy is development-only.

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
The current preview demonstrates browser-local behavior only. A full
release additionally requires authenticated API tests, ownership/RLS tests,
database persistence tests, login/session tests, and default pi coaching
integration tests.

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

User-owned Codex/OpenCode/pi agents run on the user's computer and require
a locally started, paired connector. Local agent credentials remain local;
cloud connection credentials are encrypted and revocable. The connector
uses outbound connections; its relay and the default pi runtime require a
separately verified hosting path rather than a permanent Vercel Function.

Coaching conversations have user-selected retention and deletion controls.
Expiry cleanup must be implemented and verified before claiming retention
settings are enforced.
