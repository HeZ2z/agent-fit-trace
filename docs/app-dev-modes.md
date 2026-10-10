# App development modes

The app talks to workouts through a `FitTraceClient`, and the transport is
selected at startup from `VITE_FIT_TRACE_MODE` (`app/src/api/createFitTraceClient.ts`).
Both modes run the same deterministic core and satisfy the same client
contract; they differ only in where records live.

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

## HTTP mode (authenticated)

Selection: `VITE_FIT_TRACE_MODE=http`.

- The app uses `HttpFitTraceClient` at same-origin `/api/v1` with the session
  token attached per request (`Authorization: Bearer`), plus an invite-only
  login UI (`/login`, `/forgot-password`, `/reset-password`, `/auth/callback`).
  There is no public sign-up path.
- The app bootstraps the Supabase URL + publishable key at runtime from
  `GET /api/v1/public-config` (no `VITE_*` secret copies). The session lives
  under `pi-fit-trace:auth:v1:session`; logout or account change clears all
  cached workout/analysis state. A `401` surfaces (writes are never retried);
  reads refresh the session once via explicit reload.
- Locally, the Vite dev server proxies `/api` to the loopback dev API at
  `127.0.0.1:5199` (override the port with `FIT_TRACE_DEV_API_PORT`).
- The proxy target is derived from the SAME `FIT_TRACE_DEV_API_PORT`
  setting the dev API honors, so pass the variable to BOTH processes when
  overriding, e.g.:
  ```
  FIT_TRACE_DEV_API_PORT=6000 pnpm dev:api
  FIT_TRACE_DEV_API_PORT=6000 VITE_FIT_TRACE_MODE=http pnpm --filter @pi-fit-trace/app dev
  ```
- The dev API owns the data in an in-memory append-only store —
  **restarting it clears all records**.

Run it in two terminals:

```
pnpm dev:api
VITE_FIT_TRACE_MODE=http pnpm --filter @pi-fit-trace/app dev
```

## Storage ownership / no migration

The two modes do not share data: local records stay in the browser,
HTTP-mode records stay on the dev server. This milestone performs NO
automatic upload or migration of local records; existing local records
remain available in local mode.

## Coverage

HTTP-mode app coverage runs against the real loopback API
(`app/src/App.httpLoopback.test.tsx`, via env-based client selection) and a
Vite proxy smoke check (`app/src/api/viteProxy.test.ts`, which boots the
committed proxy config against the real dev API), while the root
`tests/httpApi.test.ts` covers the server itself over real sockets.

## Next milestone

Account/Postgres foundation is implemented (Supabase Auth + RLS workouts +
Vercel functions; see `docs/supabase-setup.md`); cloud pi integration stays
behind the future coaching module.
