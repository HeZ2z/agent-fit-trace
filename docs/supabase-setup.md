# Supabase setup (authenticated Postgres slice)

This slice adds Supabase Auth (invite-only email/password) and a Supabase
Postgres `workouts` table behind RLS. Coaching, agent providers, and OpenRouter
configuration are **not** part of this slice.

## 1. Local Supabase (CLI + Docker)

`supabase/config.toml` is committed — do NOT run `supabase init` over it on
a fresh checkout; use the existing tracked invite-only configuration.
Start the already-configured local stack:

```sh
supabase start         # Docker; API http://127.0.0.1:54321, DB port 54322
supabase db reset      # apply supabase/migrations/* to a clean local DB
```

Keep the stack running while you develop. When you are done for the day,
shut it down separately with `supabase stop`.

- Local Auth is invite-only by config: `supabase/config.toml` sets the global
  `[auth] enable_signup = false` (public registration denied — verified by the
  signup-denied integration test). `[auth.email] enable_signup` stays `true`:
  Supabase CLI v2.120.0 maps it to `GOTRUE_EXTERNAL_EMAIL_ENABLED`, so `false`
  would disable email login entirely despite `[auth.email] enabled = true`.
  There is no public sign-up path in the app either — only sign-in,
  forgot/reset password, and the invite explanation.
- Get the local publishable key with `supabase status -o env` and export it
  as `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) with
  `SUPABASE_URL=http://127.0.0.1:54321` in repo-root `.env.local` (see `.env.example`).
  Never commit `.env.local` files (repo-root or `app/.env.local`).

- Serve the authenticated API from the local stack (stack must be up first):

  ```sh
  # Node does NOT auto-read repo-root `.env.local` — pass it with `--env-file`
  # from the repo root.
  # The inline FIT_TRACE_DEV_API_MODE=supabase wins over both the file and
  # any externally exported value (a --env-file entry never overrides an
  # already-set variable).
  FIT_TRACE_DEV_API_MODE=supabase node --env-file=.env.local server/devApiServer.ts
  ```

  In a second terminal, run the app in plain HTTP mode (no
  `VITE_FIT_TRACE_LEGACY_LOOPBACK` — that flag is only for the memory
  loopback flow in `docs/app-dev-modes.md`; Vite runs from `app/` with no
  `envDir` override (`app/vite.config.ts`), so it reads `app/.env.local` —
  NOT repo-root `.env.local` — for `VITE_*` vars):

  ```sh
  VITE_FIT_TRACE_MODE=http pnpm --filter @pi-fit-trace/app dev
  ```

  With a custom API port, pass the shared `FIT_TRACE_DEV_API_PORT` to BOTH
  processes:

  ```sh
  FIT_TRACE_DEV_API_PORT=6000 FIT_TRACE_DEV_API_MODE=supabase node --env-file=.env.local server/devApiServer.ts
  FIT_TRACE_DEV_API_PORT=6000 VITE_FIT_TRACE_MODE=http pnpm --filter @pi-fit-trace/app dev
  ```

  Smoke-check at least `GET /api/v1/public-config` (local Supabase URL +
  publishable key) and the unauthenticated gate (workout reads without a
  token get `401 UNAUTHENTICATED`).

## 2. Migrations

- `supabase/migrations/20261010000000_workouts.sql` creates
  `public.workouts` (`PRIMARY KEY (owner_id, id)`, `owner_id → auth.users(id)`),
  an `(owner_id, date)` index, `CHECK`s binding the row id/date to the
  payload's id/date (direct inserts included), RLS + select/insert-own
  policies (no update/delete — append-only; `REVOKE ALL` first because fresh
  projects can grant more), and the atomic `create_workout` RPC
  (`SECURITY INVOKER`, owner from `auth.uid()`, identical-payload duplicate
  vs content-conflict via `WORKOUT_CONFLICT`).
- Apply with `supabase db reset` (local) or `supabase db push` (linked
  project). Never reset the shared cloud project; use forward migrations.
- Re-running the migration is idempotent (`IF NOT EXISTS` / `DROP POLICY IF
  EXISTS` / `CREATE OR REPLACE FUNCTION`).
- `supabase/migrations/20261011000000_workouts_pagination.sql` adds the
  keyset pagination RPC `list_workouts_page(p_after_date, p_after_id,
  p_limit)` (`SECURITY INVOKER`, owner from `auth.uid()`, strict
  `(date, id) > cursor` row-value filter, `(owner_id, date, id)` index,
  `EXECUTE` granted to `authenticated` only) plus an additive forward-only
  delivery: it never rewrites the earlier migration. Cursor arguments travel
  as JSON RPC parameters so arbitrary business ids round-trip byte-exact
  with no URL-filter quoting or injection surface.
- Read-consistency boundary: a multi-page history read is **not** a single
  MVCC snapshot. A row inserted strictly before the cursor while paging
  appears on the next reload instead — it is still never returned twice in
  the same read. Products needing a strict snapshot must read in a single
  transaction; keyset pagination does not claim that.

## 3. Production dashboard (invite-only)

Local config does not change the cloud project. Before releasing auth:

1. Supabase dashboard → Authentication → Sign In / Sign Up → **"Allow new
   users to sign up" OFF**.
2. Enable **Confirm email**; set Site URL + Redirect URLs to the deployed app
   origin(s), including `/auth/callback`.
3. Create users via Dashboard → Authentication → Users → **Invite user** (or
   the Admin API). No self-registration exists.
4. Vercel env: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or
   `SUPABASE_ANON_KEY`) for Development/Preview/Production. Never add the
   service-role key to the browser or `VITE_*`.

## 4. API and app behavior

- `GET /api/v1/public-config` (public) serves only the Supabase URL +
  publishable key so the app can start a login. Everything else requires
  `Authorization: Bearer <user access token>`, verified via
  `GET /auth/v1/user` with the publishable key; missing/invalid tokens get
  `401 UNAUTHENTICATED` + `WWW-Authenticate: Bearer`. Missing server
  configuration fails closed (`500 API_ERROR`) — Vercel never falls back to
  memory.
- The server forwards the caller's token to PostgREST/RPC so RLS applies;
  `owner_id` always comes from `auth.uid()`. Records are validated through
  core on write and re-validated on read (`CORRUPT_STORE` on history rot).
  Draft plans never write.
- The app stores the session under `pi-fit-trace:auth:v1:session`, attaches
  the token per request, refreshes expired sessions, and clears all cached
  workout/analysis state on logout or account change. Writes are never
  retried after a 401. Credential refresh retries transient failures; failed
  business requests are not automatically replayed.
- Local mode (`VITE_FIT_TRACE_MODE` unset) and the unauthenticated memory
  loopback dev API (`pnpm dev:api`, i.e. default
  `FIT_TRACE_DEV_API_MODE=memory` with the app's development-only
  `VITE_FIT_TRACE_LEGACY_LOOPBACK=1` opt-in) are unchanged for local
  development/tests. The legacy flag never applies to production: production
  builds reject it and stay gated on a validated session. No
  automatic upload of local records.
- Default invite/recovery links land on `/` (the Supabase Site URL is the app
  origin): the app detects an invite/recovery URL hash at the root route and
  serves the auth-callback screen ahead of the sign-in gate — even with an
  existing session — so invited users set their first password without
  editing the address. The hash is consumed into the tab-scoped token
  handoff and stripped from the URL before routing to `/reset-password`;
  ordinary fragment hashes and local mode never enter this path.

## 5. Integration tests

```sh
# Unit + mocked-DB suites (always run):
pnpm test
# Real local-Supabase suite (requires `supabase start` + env):
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<local-key> \
  SUPABASE_SERVICE_ROLE_KEY=<local-test-service-key> \
  FIT_TRACE_SUPABASE_INTEGRATION=1 node --test tests/supabaseIntegration.test.ts
```

The integration suite validates migrations, RLS isolation (A/B), CHECK
rejection of mismatched direct inserts, denied public signup, and concurrent
idempotent creates against the local stack. It skips explicitly only when the
suite is not enabled; when enabled (`FIT_TRACE_SUPABASE_INTEGRATION=1`) it
fails — never skips — on missing keys, non-loopback URLs, or an unavailable
stack. It refuses non-loopback URLs and never writes to cloud. Mocked tests
never claim to prove database isolation — only the local-stack run does.

Auth endpoint shapes are tested through unit tests and the local stack.
Official references: [Auth API specification](https://github.com/supabase/auth/blob/master/openapi.yaml),
[CLI configuration](https://supabase.com/docs/guides/local-development/cli/config),
and [row level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

The Vercel entrypoints are small `.mjs` wrappers. `pnpm build:server` bundles
the shared TypeScript core and server with the existing Vite toolchain into
`build/server/vercel.mjs`, then Vercel packages it with each Function. This
avoids leaving `.ts` imports in emitted `.js` files. Verify the packaged
handler loads after `vercel build`; a successful build exit alone is not
proof of runtime compatibility.
