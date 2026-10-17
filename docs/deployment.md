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
- Run long-lived agent work in a separate service. Vercel API functions
  authorize and enqueue durable cloud runs; they must not rely on process
  memory or a permanently running worker surviving between requests. The
  durable cloud worker is a separate process, not a Vercel Function.

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

## Durable cloud coaching (server-side slice)

The durable cloud path is opt-in and currently unverified against a real
migrated Supabase project or the real OpenRouter service. The code in
`server/cloud/` and `supabase/migrations/20261017000200_coaching_cloud.sql`
exists, but do not advertise hosted coaching as production-ready until the
verification steps below have actually been run.

### 1. Apply the migration

Apply `supabase/migrations/20261017000200_coaching_cloud.sql` through the
normal Supabase migration tooling for the target project. It is additive and
ordered after the workout/profile migrations (`20261010000000`,
`20261011000000`, `20261017000000`, `20261017000100`). Do not reset a
long-running local stack just to apply it; coordinate with its owner.

The migration creates ownership/RLS tables (`coaching_sessions`,
`coaching_snapshots`, `coaching_runs`, `coaching_run_events`,
`coaching_quota`, `coaching_usage_ledger`, `coaching_outbox`) and the
request/worker RPCs. Snapshot contents are derived inside SQL from the caller's
own `public.workouts` rows under `auth.uid()`; direct callers cannot supply
records. TTLs and per-account session/snapshot counts are clamped and
serialized. Submission reserves against a server-configured formal-account
quota (20 concurrent by default).

### 2. Request-path environment (Vercel)

Set these on the Vercel project that serves `/api/v1/coaching/cloud/*`:

```dotenv
FIT_TRACE_CLOUD_ENABLED=1
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key>
FIT_TRACE_OPENROUTER_API_KEY=<provider key>
FIT_TRACE_OPENROUTER_MODEL=<provider model id>
# Optional: blank or exactly https://openrouter.ai/api/v1
FIT_TRACE_OPENROUTER_BASE_URL=
```

`FIT_TRACE_CLOUD_ENABLED` must be exactly `1`. A missing provider key/model
makes submission return `PROVIDER_UNCONFIGURED`; it never selects a paid model
implicitly. The request path uses the caller's own Supabase access token and the
publishable key only. It never receives `SUPABASE_SERVICE_ROLE_KEY`.

All cloud routes are under `/api/v1/coaching/cloud`; the Vercel catch-all is
`api/v1/coaching/cloud/[...path].mjs`. SSE is replay-only and bounded: the
function polls stored events for at most about 15 seconds and returns the
frames collected, so it does not hold a serverless process open indefinitely.

### 3. Worker process (separate host)

The outbox worker is a long-running process and must not be deployed as a
Vercel Function. Run it in a container, VM, or equivalent process host:

```sh
FIT_TRACE_CLOUD_ENABLED=1 \
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_PUBLISHABLE_KEY=<publishable key> \
SUPABASE_SERVICE_ROLE_KEY=<service-role key> \
FIT_TRACE_OPENROUTER_API_KEY=<provider key> \
FIT_TRACE_OPENROUTER_MODEL=<provider model id> \
node server/cloud/workerEntrypoint.ts
```

`SUPABASE_SERVICE_ROLE_KEY` is worker-only and is rejected if it equals the
publishable key or looks like a publishable key. The worker process claims one
job per tick and then sleeps; it never spawns child processes or serverless
functions.

Safe defaults (all bounded; values are clamped in `server/cloud/config.ts`):

| Variable | Default | Bound |
| --- | --- | --- |
| `FIT_TRACE_OPENROUTER_MAX_STEPS` | `4` | `1..8` |
| `FIT_TRACE_OPENROUTER_MAX_TOKENS` | `2048` | `128..8192` |
| `FIT_TRACE_OPENROUTER_MAX_TOKENS_PER_STEP` | `512` | `64..4096` |
| `FIT_TRACE_OPENROUTER_MAX_INPUT_BYTES` | `262144` | `16384..1048576` |
| `FIT_TRACE_OPENROUTER_TIMEOUT_MS` | `60000` | `5000..120000` |
| `FIT_TRACE_CLOUD_WORKER_LEASE_MS` | `300000` | `15000..300000` |
| `FIT_TRACE_CLOUD_WORKER_POLL_MS` | `1000` | `250..30000` |
| `FIT_TRACE_CLOUD_WORKER_BATCH` | `4` | `1..10` |

The batch value is accepted for configuration compatibility, but the worker
claims one job per tick by design: sequential batch processing could let later
leases expire. Keep the lease comfortably above the configured provider loop
(`maxSteps × timeoutMs` plus overhead); the default loop is 4 × 60 seconds
inside a 5-minute lease.

### 4. Accounting and cancellation caveats

- Provider usage is settled once, only if the provider returned usable usage
  and only under the current unexpired lease generation. Missing usage remains
  explicitly accounting-pending; it is never written as a zero-dollar or
  zero-token charge.
- Budget reservations are coarse concurrency/token controls, not a strict USD
  guarantee. OpenRouter pricing/model limits remain a deployment concern.
- There is no documented provider cancellation endpoint. Aborting the HTTP read
  does not prove the provider stopped billing. The server therefore reports
  `cancelling`/`unconfirmed`, retains the reservation, and never automatically
  redispatches. A real OpenRouter QA run must confirm this behavior before the
  feature is described as complete.

### 5. Verification

Before enabling the path in a public environment, run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

The default suite covers the provider request/tool mapping, unknown-tool
refusal, response/input bounds, missing usage, worker generation/cancellation/
unconfirmed states, HTTP guest/unknown/forged-body denial, replay after snapshot
expiry, and the 20-concurrency reservation cap against in-memory fakes.

Real database integration tests are opt-in and require a migrated isolated
local stack (never reset a shared one):

```sh
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_PUBLISHABLE_KEY=<local key> \
SUPABASE_SERVICE_ROLE_KEY=<local service key> \
FIT_TRACE_SUPABASE_INTEGRATION=1 node --test tests/supabaseIntegration.test.ts
```

Those tests cover direct-RPC snapshot forgery rejection/authoritative records,
malicious TTL clamping, serialized session caps, concurrent idempotent submits,
and the 20-reservation concurrency limit. They do not prove a real OpenRouter
call. Before claiming cloud coaching is complete, run a separately authorized
real-provider smoke test (with explicit spend approval) and confirm usage,
generation-id reconciliation, cancellation/unconfirmed behavior, and worker
restart recovery.

User-owned Codex/OpenCode/pi agents run on the user's computer and require
a locally started, paired connector. Local agent credentials remain local;
cloud connection credentials are encrypted and revocable. The connector
uses outbound connections; its relay and the default pi runtime require a
separately verified hosting path rather than a permanent Vercel Function.

Coaching conversations have user-selected retention and deletion controls.
Expiry cleanup must be implemented and verified before claiming retention
settings are enforced.
