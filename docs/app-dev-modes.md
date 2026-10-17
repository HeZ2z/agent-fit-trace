# App development modes

The app talks to workouts through a `FitTraceClient`, and the transport is
selected at startup from `VITE_FIT_TRACE_MODE` (`app/src/api/createFitTraceClient.ts`).
All modes run the same deterministic core and satisfy the same client
contract; they differ only in where records live. There are three separate
development/testing modes — pick exactly one:

1. **Local browser storage** (development default): `localStorage` is the
   storage backend only. The app still requires `GET /api/v1/public-config`
   and a verified Supabase session.
2. **Memory HTTP** (development/tests legacy opt-in): unauthenticated
   loopback dev API + `VITE_FIT_TRACE_LEGACY_LOOPBACK=1`.
3. **Authenticated Supabase HTTP**: local Supabase stack +
   `FIT_TRACE_DEV_API_MODE=supabase` dev API, app in plain HTTP mode
   (no legacy flag).

Production requires an effective **HTTP** mode. A launcher may inject
`window.__FIT_TRACE_RUNTIME = { mode: "http" }`; otherwise
`VITE_FIT_TRACE_MODE=http` must be built in. Missing, `local`, unknown, or
malformed explicit runtime values fail closed with a configuration error
**before** `AuthProvider` or any protected provider mounts. Only the explicit
development bypass below skips that gate.

## Local browser storage (development default, still authenticated)

Selection: `VITE_FIT_TRACE_MODE` unset, or any value other than `"http"`, in a
development build.

- This is a storage choice, **not** an auth bypass. The app still bootstraps
  Supabase URL + publishable key from `GET /api/v1/public-config` and requires
  a verified session. Run the dev API with valid server Supabase env (see
  below) and sign in; local mode then uses `LocalFitTraceClient` over browser
  `localStorage`.
- Records live under owner-scoped v2 keys:
  `pi-fit-trace:workout:v2:owner:<encoded-user-id>:<record-id>`. The browser
  owns this data; it persists across reloads.
- Legacy unowned `pi-fit-trace:workout:v1:<id>` keys are preserved on disk but
  hidden from owner-scoped clients. They are **not** automatically attributed
  to the signed-in user and are **not** migrated or deleted.
- Unknown build mode values keep the development local fallback; they still
  go through the auth gate.

Run it from the repo root with the authenticated dev API serving
`/api/v1/public-config`:

```sh
# Terminal 1 — server env in repo-root .env.local
FIT_TRACE_DEV_API_MODE=supabase node --env-file=.env.local server/devApiServer.ts

# Terminal 2 — leave VITE_FIT_TRACE_MODE unset/local
pnpm --filter @pi-fit-trace/app dev
```

Sign in before using the app. Workout reads/writes stay in this browser; only
public configuration and authentication leave the browser.

## HTTP mode with memory loopback (development/tests legacy opt-in)

Selection: app in `VITE_FIT_TRACE_MODE=http` **plus**
`VITE_FIT_TRACE_LEGACY_LOOPBACK=1`.

- The app uses `HttpFitTraceClient` at same-origin `/api/v1`, but the
  `legacyLoopback` opt-in bypasses the session gate so the
  unauthenticated loopback dev API (`pnpm dev:api`, default
  `FIT_TRACE_DEV_API_MODE=memory`) can serve workouts without login.
- The bypass uses the fixed local owner namespace `dev-loopback-bypass`
  (`LOCAL_DEV_BYPASS_OWNER`). That is not a verified identity and has **no
  per-user isolation**: every bypass user of the same browser profile sees the
  same records. Use a throwaway profile and synthetic data only.
- The dev API owns the data in an in-memory append-only store —
  **restarting it clears all records**, including imported snapshots,
  selections, and plan adoption.
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
  repo-root `.env.local` (see `.env.example` and `docs/supabase-setup.md`). Missing
  server configuration fails closed (`500 API_ERROR`) — the server never
  falls back to memory.
- This is the account/cloud persistence path: workouts, immutable imported
  snapshots, per-owner selections, and explicit plan adoption are stored in
  Postgres and survive reloads/dev-server restarts. There is no service-role
  data path; the server forwards the caller's token and the publishable key.
  Snapshots are append-only — the API has no update or delete operation for
  them.
- `FIT_TRACE_DEV_API_MODE` also accepts `memory` (default, unauthenticated
  loopback) and `authenticated` (local test verifier); the two supported
  local dev flows are the memory legacy flow above and this Supabase flow.

Node does NOT auto-read repo-root `.env.local` — pass it explicitly from the
repo root. Vite runs from `app/` with no `envDir` override
(`app/vite.config.ts`), so it reads `app/.env.local` — NOT repo-root
`.env.local` — for `VITE_*` vars; the app side needs only `VITE_*` there:

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

| Mode | Workouts | Imported snapshots/selections/adoption | Lifetime |
| --- | --- | --- | --- |
| Local browser | owner-namespaced `localStorage` | owner-namespaced `localStorage` | this browser/device only |
| Memory HTTP | dev API process memory | dev API process memory | lost on API restart |
| Authenticated Supabase | Postgres, RLS per owner | Postgres, RLS per owner | account/cloud persistence |

Legacy unowned `pi-fit-trace:workout:v1:<id>` keys are preserved but invisible
to owner-scoped clients. They are not attributed to the current account, not
migrated, and not deleted. Switching modes never uploads or copies records;
existing v2 records remain available when you return to local mode.

Imported analysis/plan snapshots are external, unverified evidence: they are
stored and displayed as imported, not recomputed by the deterministic core,
and saving one never changes current analysis or plan calculations.

An anonymous guest is also a real per-owner storage identity, but its data is
still local to that guest/browser until the **same UID** is upgraded to a
permanent account. Signing in to a different account is an explicit identity
switch with no merge. There is no cloud trial, hosted coach entitlement, or
automatic guest-to-account upload in these modes.

Known limitation: local browser mode has no cross-tab or cross-client write
serialization or locking. Two tabs/clients writing the same browser storage
can race; the append-only/idempotent id rules prevent silent overwrites when a
conflict reaches a client, but concurrent local writers are not solved by a
transaction or storage lock.

### Explicit developer JSON export/import

There is no automatic upload, background migration, or bulk import button.

**History exports only the current verified owner's v2 records.** Hidden
unowned legacy `pi-fit-trace:workout:v1:<id>` records cannot be exported
through History and are never attributed automatically. For manual legacy
recovery, a developer may inspect only keys with the exact
`pi-fit-trace:workout:v1:` prefix in browser devtools and copy only those JSON
values into a separate offline workout file. Leave the original localStorage
keys and values untouched. Because v1 is unowned, the app cannot prove who a
record belongs to: review ownership and provenance of every record before any
explicit replay.

1. Sign in to the source store and choose **History → Export workouts (JSON)**.
   This downloads restorable backup files with
   `{ "schema_version": ..., "records": [...] }`. A history within the restore
   limits is `workout.json`; larger histories are split into numbered
   `workout-01-of-NN.json` files so every file stays within 1 MiB and 1000
   records, and every record fits one restore request. Restore or replay every
   file.
2. To move records into an authenticated store, replay each exported record
   explicitly through the normal create endpoint; validate and reconcile IDs
   rather than copying raw storage keys:

   ```sh
   for file in workout*.json; do
     jq -c '.records[]' "$file" | while read -r record; do
       curl -fsS -X POST "$FIT_TRACE_API_BASE_URL/workouts" \
         -H "Authorization: Bearer $ACCESS_TOKEN" \
         -H 'Content-Type: application/json' \
         --data "{\"record\":$record}"
     done
   done
   ```

Use a short-lived bearer token from your signed-in session; do not commit or
log it. The API applies normal validation, idempotent-by-id behavior, conflict
detection, and RLS ownership. The browser-local store has no bulk-import UI:
use the app's normal create flow for the signed-in owner. Never edit v1 keys in
place or treat a mode switch as permission to upload them.

## Coverage

HTTP-mode app coverage runs against the real loopback API
(`app/src/App.httpLoopback.test.tsx`, via env-based client selection) and a
Vite proxy smoke check (`app/src/api/viteProxy.test.ts`, which boots the
committed proxy config against the real dev API), while the root
`tests/httpApi.test.ts` covers the server itself over real sockets.

## Next milestone

Account/Postgres foundation is implemented (Supabase Auth + RLS workouts +
immutable imported snapshots/selections/adoption + Vercel functions; see
`docs/supabase-setup.md`). The coaching module now
includes the local loopback server, gated local Codex/OpenCode adapters, and the
hosted cloud routes/worker; cloud stays fail-closed and off by default until a
formal account, quota, provider resources, and a deployed worker are present.
Production HTTP mode requires the authenticated API; the dev-only legacy flag
cannot bypass its login gate.
