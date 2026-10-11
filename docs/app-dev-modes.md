# App development modes

The app talks to workouts through a `FitTraceClient`, and the transport is
selected at startup from `VITE_FIT_TRACE_MODE` (`app/src/api/createFitTraceClient.ts`).
All modes run the same deterministic core and satisfy the same client
contract; they differ only in where records live. There are three
separate modes — pick exactly one:

1. **Local browser** (default): `localStorage`, no server.
2. **Memory HTTP** (development/tests legacy opt-in): unauthenticated
   loopback dev API + `VITE_FIT_TRACE_LEGACY_LOOPBACK=1`.
3. **Authenticated Supabase HTTP**: local Supabase stack +
   `FIT_TRACE_DEV_API_MODE=supabase` dev API, app in plain HTTP mode
   (no legacy flag).

## Local mode (default)

Selection: `VITE_FIT_TRACE_MODE` unset, or any value other than `"http"`.

- The app uses `LocalFitTraceClient` over browser `localStorage`.
- Records live under per-record keys `pi-fit-trace:workout:v1:<id>`.
- The browser owns the data; it persists across reloads.
- Unknown mode values fall back to local and must not break the app.

Run it:

```
pnpm --filter @pi-fit-trace/app dev
```

## HTTP mode with memory loopback (development/tests legacy opt-in)

Selection: app in `VITE_FIT_TRACE_MODE=http` **plus**
`VITE_FIT_TRACE_LEGACY_LOOPBACK=1`.

- The app uses `HttpFitTraceClient` at same-origin `/api/v1`, but the
  `legacyLoopback` opt-in bypasses the session gate so the
  unauthenticated loopback dev API (`pnpm dev:api`, default
  `FIT_TRACE_DEV_API_MODE=memory`) can serve workouts without login.
- The dev API owns the data in an in-memory append-only store —
  **restarting it clears all records**.
- `VITE_FIT_TRACE_LEGACY_LOOPBACK` is development-only: `App.tsx`
  `isLegacyLoopbackAllowed()` returns `false` in production builds
  (`import.meta.env.DEV` is false), even when the prop or env is set.
  Production HTTP mode stays gated on a validated session, and a
  missing/failed `GET /api/v1/public-config` fails closed (never the
  protected content).

Run it in two terminals:

```
pnpm dev:api
VITE_FIT_TRACE_MODE=http VITE_FIT_TRACE_LEGACY_LOOPBACK=1 pnpm --filter @pi-fit-trace/app dev
```

Then open the app and log a workout: the History screen lists the
server-stored record (empty state shows "no workouts yet" first).

Custom-port example — the loopback dev API (`server/devApiServer.ts`)
and the Vite `/api` proxy (`app/vite.config.ts`) both read the SAME
`FIT_TRACE_DEV_API_PORT` (default `5199`), so pass it to BOTH processes
and keep the legacy flag on the app:

```
FIT_TRACE_DEV_API_PORT=6000 pnpm dev:api
FIT_TRACE_DEV_API_PORT=6000 VITE_FIT_TRACE_MODE=http VITE_FIT_TRACE_LEGACY_LOOPBACK=1 pnpm --filter @pi-fit-trace/app dev
```

Recovery-token fallback limit (authenticated mode): the
invite/recovery handoff keeps an in-page JS-memory copy so a valid link
still works for router-internal navigation when tab storage is disabled.
A full page reload drops the memory copy — only `sessionStorage`
survives a reload — and the token is never copied to `localStorage`,
the URL query, or logs. No secrets are shown here.

## HTTP mode with authenticated Supabase (local stack)

Selection: app in `VITE_FIT_TRACE_MODE=http` **without** the legacy flag;
server in `FIT_TRACE_DEV_API_MODE=supabase`.

- The app uses `HttpFitTraceClient` at same-origin `/api/v1` with the session
  token attached per request (`Authorization: Bearer`), plus an invite-only
  login UI (`/login`, `/forgot-password`, `/reset-password`, `/auth/callback`).
  There is no public sign-up path.
- The app bootstraps the Supabase URL + publishable key at runtime from
  `GET /api/v1/public-config` (no `VITE_*` secret copies). The session lives
  under `pi-fit-trace:auth:v1:session`; logout or account change clears all
  cached workout/analysis state. A `401` surfaces (writes are never retried);
  credential refresh retries transient failures automatically; failed
  business requests are not replayed.
- The dev API runs the real authenticated handler against the local
  Supabase stack (RLS applies; `owner_id` comes from `auth.uid()`). It needs
  `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) from
  `.env.local` (see `.env.example` and `docs/supabase-setup.md`). Missing
  server configuration fails closed (`500 API_ERROR`) — the server never
  falls back to memory.
- `FIT_TRACE_DEV_API_MODE` also accepts `memory` (default, unauthenticated
  loopback) and `authenticated` (local test verifier); the two supported
  local dev flows are the memory legacy flow above and this Supabase flow.

Node does NOT auto-read `.env.local` — pass it explicitly. Vite DOES read
`.env.local` for `VITE_*` vars, so the app side needs only `VITE_*`:

```sh
# Terminal 1 — Supabase-backed dev API (local stack must be up; see docs/supabase-setup.md):
# Inline FIT_TRACE_DEV_API_MODE=supabase wins over both the file and any
# externally exported value (a --env-file entry never overrides an
# already-set variable).
FIT_TRACE_DEV_API_MODE=supabase node --env-file=.env.local server/devApiServer.ts

# Terminal 2 — app in plain HTTP mode (no legacy flag):
VITE_FIT_TRACE_MODE=http pnpm --filter @pi-fit-trace/app dev
```

With a custom API port, again pass `FIT_TRACE_DEV_API_PORT` to BOTH:

```sh
FIT_TRACE_DEV_API_PORT=6000 FIT_TRACE_DEV_API_MODE=supabase node --env-file=.env.local server/devApiServer.ts
FIT_TRACE_DEV_API_PORT=6000 VITE_FIT_TRACE_MODE=http pnpm --filter @pi-fit-trace/app dev
```

Verify at least `GET /api/v1/public-config` returns the local Supabase URL
plus publishable key, and that unauthenticated workout reads are gated
(`401 UNAUTHENTICATED`). Never write test data to cloud; the integration
suite refuses non-loopback URLs.

## Storage ownership / no migration

The three modes do not share data and there is NO automatic migration:

- Local browser: records live in `localStorage` and persist across reloads.
- Memory HTTP: records live in the dev API process and are lost on restart.
- Authenticated Supabase: records persist in Postgres (RLS-isolated per user).

Switching modes never uploads or copies records; existing local records
remain available when you return to local mode.

## Coverage

HTTP-mode app coverage runs against the real loopback API
(`app/src/App.httpLoopback.test.tsx`, via env-based client selection) and a
Vite proxy smoke check (`app/src/api/viteProxy.test.ts`, which boots the
committed proxy config against the real dev API), while the root
`tests/httpApi.test.ts` covers the server itself over real sockets.

## Next milestone

Account/Postgres foundation is implemented (Supabase Auth + RLS workouts +
Vercel functions; see `docs/supabase-setup.md`); cloud pi integration stays
behind the future coaching module. Production HTTP mode requires the
authenticated API; the dev-only legacy flag cannot bypass its login gate.
