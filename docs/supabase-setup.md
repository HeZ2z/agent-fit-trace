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

# RESET ONLY a fresh, disposable, synthetic local project:
# supabase db reset
```

`supabase db reset` deletes the local database. Do **not** use it on an
existing local project with user data. For an existing DB, apply the additive
migration first (`supabase migration up`, or your normal forward-migration
process), verify it succeeded, and only then restart the stack so the committed
Auth profile takes effect (`supabase stop && supabase start`). Back up the DB
before either step. The partial rollback notes in section 6 retain users and
workouts; reset does not.

Keep the stack running while you develop. When you are done for the day,
shut it down separately with `supabase stop`.

- Local Auth is invite-only by database gate: `supabase/config.toml` keeps
  global signup enabled because GoTrue requires it for anonymous guest sign-in,
  while the `before_user_created` hook rejects uninvited formal signup (verified
  by the signup-denied integration test). `[auth.email] enable_signup` stays
  `true`: Supabase CLI v2.120.0 maps it to `GOTRUE_EXTERNAL_EMAIL_ENABLED`, so
  `false` would disable email login entirely despite `[auth.email] enabled =
  true`. There is no public sign-up form in the app — only invite-only sign-in,
  forgot/reset password, and guest entry when explicitly enabled.
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
- Apply with `supabase db reset` **only on a fresh disposable synthetic local
  project**, `supabase migration up` for an existing local DB that must keep
  its users/workouts, or `supabase db push` for a linked project. Never reset
  the shared cloud project or a local DB with data; use forward migrations.
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
- `supabase/migrations/20261017000000_imported_artifacts.sql` adds the
  imported-snapshot slice (additive; it does not modify either workout
  migration or existing workout rows/data):
  - `public.imported_artifacts` is append-only and content-addressed
    (`id = kind || ':v1:' || content_digest`, `content_digest` is lowercase
    hex SHA-256). CHECKs bind id, kind, source refs, payload shape, and the
    unconfirmed-draft invariant for plans. API roles have `SELECT` only; there
    is no INSERT/UPDATE/DELETE/TRUNCATE grant, so snapshots cannot be edited
    or deleted through the API.
  - `public.artifact_preferences` stores one per-owner/per-kind "currently
    viewing" selection (null clears it). `public.plan_adoptions` stores the
    separate explicit plan confirmation and its confirmed digest; revoking
    adoption deletes only this metadata row.
  - `public.save_imported_artifact(...)` is **SECURITY DEFINER** and the only
    snapshot write path because `authenticated` has no INSERT grant. It takes
    **no owner argument**: `owner_id` is read from `auth.uid()` inside the
    RPC, and it re-checks kind/id/digest/version/shape/source-ref/draft
    invariants before insert. An identical canonical payload is a duplicate
    no-op; the same id with different content raises `IMPORT_CONFLICT`.
  - the read/selection/adoption RPCs
    (`list_imported_artifacts_page`, `get_imported_artifact`,
    `get_artifact_selection`, `set_artifact_selection`,
    `get_plan_adoption`, `set_plan_adoption`) are **SECURITY INVOKER** and
    rely on RLS plus explicit `auth.uid()` predicates. Every RPC pins
    `search_path = ''`, schema-qualifies relations, and grants `EXECUTE` to
    `authenticated` only (`anon`/`public` denied).
  - reads return `owner_id`; the TypeScript client re-verifies it against the
    bearer principal and re-parses every row as defense in depth.
  - two independent payload bounds: the shared TypeScript contract rejects a
    normalized import request over **40 KiB** compact JSON, while the SQL
    RPC/table keeps a defensive **64 KiB** `octet_length(payload::text)` guard.
    jsonb text adds one space after every comma/colon (worst case +50%), so a
    request at the 40-KiB limit is at most 60 KiB as jsonb text and never
    passes preview only to fail the database check.
  - digest verification stays in TypeScript on both save and read:
    `sha256(stableStringify(payload))` cannot be reproduced reliably by
    Postgres because `jsonb::text` orders keys differently. SQL enforces the
    id/kind/source/draft structure and read-only tables; a direct RPC caller
    can only create a self-owned, internally inconsistent row, which every
    TypeScript read rejects as `CORRUPT_STORE`.

### Rollback

Rollback the app/API deployment only; preserve the database tables and all
user data. The imported-artifacts migration is additive and forward-only, and
the earlier `workouts`/pagination migrations are untouched by it. Rolling back
the app or API therefore leaves `imported_artifacts`,
`artifact_preferences`, `plan_adoptions`, invites, workouts, and history in
place for a forward re-deploy. Do not drop these tables, do not run a
destructive reset on the shared project, and do not edit the old workout
migration to compensate. If the guest signup gate must be disabled, the
documented partial rollback remains the narrow `DROP TRIGGER`/function path;
retain `signup_invites` and all user/workout data.

## 3. Production dashboard (invite-only)

Local config does not change the cloud project. Before releasing auth:

1. Supabase dashboard → Authentication → Sign In / Sign Up → **"Allow new
   users to sign up" OFF**.
2. Enable **Confirm email**; set Site URL + Redirect URLs to the deployed app
   origin(s), including `/auth/callback`.
3. Create users via Dashboard → Authentication → Users → **Invite user** (or
   the Admin API). No self-registration exists.
4. Vercel env: `VITE_FIT_TRACE_MODE=http`, `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) for Preview and
   Production (add Development too when using `vercel dev`). Never add the
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
  Draft plans never write. This data path uses the user's access token and the
  publishable key only — there is **no service-role path** in request
  handling. The service-role key is used only by opt-in test setup/cleanup.
- Imported analysis/plan artifacts are saved as immutable, content-addressed
  snapshots (`analysis:v1:<digest>` / `plan:v1:<digest>`). Saving never
  selects or adopts; selection and plan adoption are separate explicit calls.
  The API exposes no snapshot update or delete route. Imported artifacts are
  external, unverified evidence: their stored payloads are displayed as
  imported, and the deterministic analysis/plan computations are unchanged.
- Workout backup restore is sequential per record, not a batch and not
  atomic. The app reports a per-file-index receipt (`created`, `duplicate`,
  `conflict`, `failed`, `unknown`, `not_attempted`); a failure can leave
  earlier records committed. Existing ids are never overwritten, and an
  ambiguous write is read back instead of being called created.
- Persistence is backend-specific: browser-local mode stays in that browser's
  `localStorage`; the memory loopback API clears on restart; authenticated
  Supabase mode persists per-owner rows in Postgres. There is no automatic
  upload or migration between them. An anonymous guest's data can be reached
  from another device only after the same UID is upgraded to a real account;
  signing in as a different account is a switch with no merge. This is not a
  cloud trial or a hosted coaching entitlement.
- The app stores the session under `pi-fit-trace:auth:v1:session`, attaches
  the token per request, refreshes expired sessions, and clears all cached
  workout/analysis state on logout or account change. Writes are never
  retried after a 401. Credential refresh retries transient failures; failed
  business requests are not automatically replayed.
- Local browser storage (`VITE_FIT_TRACE_MODE` unset) changes only where
  workouts live. In DEV it still requires `GET /api/v1/public-config` and a
  verified Supabase session; owner-scoped v2 keys isolate users on the same
  browser, while legacy unowned v1 keys stay hidden and unattributed. The
  unauthenticated memory loopback (`pnpm dev:api`, default
  `FIT_TRACE_DEV_API_MODE=memory`, with the app's development-only
  `VITE_FIT_TRACE_LEGACY_LOOPBACK=1` opt-in) bypasses auth with the fixed
  `dev-loopback-bypass` namespace, which is not per-user isolated. The legacy
  flag never applies to production: production builds reject it, require an
  effective HTTP runtime, and stay gated on a validated session. No automatic
  upload or migration of local records.
- Default invite/recovery links land on `/` (the Supabase Site URL is the app
  origin): the app detects an invite/recovery URL hash at the root route and
  serves the auth-callback screen ahead of the sign-in gate — even with an
  existing session — so invited users set their first password without
  editing the address. The hash is consumed into the tab-scoped token
  handoff and stripped from the URL before routing to `/reset-password`.
  This callback path is independent of workout storage mode, so it also works
  in DEV local browser storage; ordinary non-auth fragment hashes never enter
  it.

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
rejection of mismatched direct inserts, denied public signup, concurrent
idempotent creates, and the imported-artifact boundary against the local
stack: anonymous callers cannot execute import RPCs or read the table;
owners are isolated; direct INSERT/UPDATE/DELETE/TRUNCATE is denied; selections
and adoption are owner/kind/digest bound; and invalid drafts/forged refs are
rejected. It skips explicitly only when the suite is not enabled; when enabled
(`FIT_TRACE_SUPABASE_INTEGRATION=1`) it fails — never skips — on missing keys,
non-loopback URLs, or an unavailable stack. It refuses non-loopback URLs and
never writes to cloud. Mocked tests never claim to prove database isolation —
only the local-stack run does. The automated app suite covers the Me/header
integration behavior, but this docs pass did not run browser/manual UI
acceptance, so no visual or cross-browser verification is claimed.

Auth endpoint shapes are tested through unit tests and the local stack.
The separate anonymous-guest compatibility suite (section 6) is opt-in with
`FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1`:

```sh
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<local-key> \
  SUPABASE_SERVICE_ROLE_KEY=<local-test-service-key> \
  FIT_TRACE_SUPABASE_AUTH_INTEGRATION=1 node --test tests/supabaseAuthIntegration.test.ts
```

Official references: [Auth API specification](https://github.com/supabase/auth/blob/master/openapi.yaml),
[CLI configuration](https://supabase.com/docs/guides/local-development/cli/config),
and [row level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## 6. Anonymous guests + invite-only compatibility (spike, 2026-10-17)

Status: **code and committed target profile; live acceptance is owned by the
supervisor.** The committed `supabase/config.toml` enables anonymous sign-ins,
global signup (required by that endpoint), manual linking, and the creation hook;
`20261017000100_signup_gate.sql` supplies both invite gates. Live checks run
outside this workspace against a distinct local project
(`agent-fit-trace-issues-test55321`) and never against an existing stack. The
supervisor's tracked Auth integration passed 5/5 with no skips, including the
actual-Mailpit same-UID upgrade and artifact checks. Production SMTP, a
CAPTCHA provider, and browser QA remain unverified.

### 6.1 What the official docs/source establish

| Question | Evidence | Consequence |
| --- | --- | --- |
| What is an anonymous user? | [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous): `signInAnonymously()` creates a permanent-shaped user; JWTs carry `is_anonymous`; the user assumes the `authenticated` Postgres role, not the `anon` API-key role. | A guest has a real Supabase UUID usable as `owner_id`; RLS differs from an unauthenticated request. |
| Where is the trusted classification? | Same doc: the `is_anonymous` claim/JWT field and the `auth.users.is_anonymous` column. At GoTrue v2.197.0 the observed database columns (`email`, `email_confirmed_at`, `email_change`, `email_change_confirm_status`, `is_anonymous`) are ordinary columns, not generated columns. `GET /auth/v1/user` returns the user record with `is_anonymous`. | `AuthPrincipal.isAnonymous` / `SupabaseAuthUser.isAnonymous` may only be populated from the verified `/auth/v1/user` response. Missing values stay `undefined`; cached classification never authorizes. |
| Can global invite-only and anonymous sign-in coexist natively? | [CLI config](https://supabase.com/docs/guides/local-development/cli/config): `auth.enable_anonymous_sign_ins` (default `false`) and `auth.enable_signup` (default `true`). GoTrue `internal/api/anonymous.go` (read from `supabase/auth@ce9a8eee0cc042be8c7a42981a7ddae631e41d91`) rejects anonymous sign-in when `DisableSignup` is set. | The committed profile keeps `enable_signup = true` and adds the creation hook, because `enable_signup = false` also blocks anonymous sign-in. Native config alone cannot express "guests yes, public email signup no". |
| Can a creation hook restore invite-only? | [Before User Created Hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook): runs before a new user is created, receives `user.is_anonymous`, and may reject with `{ "error": { "message", "http_code" } }`. GoTrue source shows it is called by anonymous signup, email signup, and Admin invite; it is **not** called by Admin `/admin/users` creation or by user updates. | The hook allows anonymous users and rejects uninvited email signup. It cannot qualify a same-UID guest upgrade, so the committed migration adds an `auth.users` update trigger as the second DB gate. |
| How does an anonymous user become permanent? | [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous): link an email/phone identity with `updateUser()`, verify it, then set a password; conversion requires **manual linking** enabled. [Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking): manual linking is beta and requires `enable_manual_linking`/`GOTRUE_SECURITY_MANUAL_LINKING_ENABLED=true`. | The committed profile enables manual linking only together with the narrow database trigger. Without the trigger, a direct Auth guest upgrade would bypass the invite gate. |
| Abuse controls | Anonymous doc: IP rate limit 30 requests/hour (dashboard-configurable); invisible CAPTCHA/Turnstile strongly recommended; automatic anonymous-user cleanup is **not** available (manual SQL deletes `auth.users`, which cascades). | Guest launch remains blocked on deployment rate-limit/CAPTCHA values and a retention decision. These are not implemented by this spike. |

### 6.2 Safe guest/upgrade profile (committed)

`supabase/config.toml` commits this profile, which keeps public email
signup denied through DB gates while allowing invited same-UID upgrades:

```toml
[auth]
enable_signup = true                 # required for the anonymous endpoint (DISABLE_SIGNUP otherwise blocks it)
enable_anonymous_sign_ins = true
enable_manual_linking = true         # only safe with the upgrade trigger below
minimum_password_length = 8

[auth.email]
enabled = true
enable_signup = true                 # provider stays usable for invited logins
enable_confirmations = true

[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_allow_anonymous_or_invited"
```

`supabase/migrations/20261017000100_signup_gate.sql` adds
`public.signup_invites`, the creation hook, and the narrow
`auth.users` update trigger:

- anonymous creation (`is_anonymous = true`) is allowed;
- formal email creation is allowed only when a service-role-inserted invite
  row exists for the normalized email, and that row is consumed by a single
  `UPDATE ... WHERE consumed_at IS NULL` (no `EXISTS`-then-`UPDATE` race); the
  hook uses `v_email` / `v_is_anonymous` variables so PL/pgSQL cannot resolve a
  bare name as a table column;
- a currently anonymous row may initiate an email change only for an
  unconsumed invite; the initiation check does **not** consume it;
- the anonymous -> account transition consumes the invite atomically inside
  GoTrue's verification transaction (rollback restores it), deriving the target
  from `NEW.email_change`/`OLD.email_change` while `NEW.email` is still empty;
- `OLD.is_anonymous = false` rows (invited accounts, recovery, refresh,
  post-upgrade updates) are untouched;
- the normalized unique index (`lower(email)`) gives the hook and trigger one
  claim per email, including case variants;
- everything else is rejected with HTTP 403 / SQLSTATE 42501.

The hook runs *before* GoTrue's user-creation transaction, so a later creation
failure can burn an invite; re-inserting the row is an explicit admin action.
That fail-closed cost is accepted for the invite path. The anonymous path has no
invite row and is unaffected.

Apply the migration **before** starting Auth with this profile. The hook is
inert until `[auth.hook.before_user_created]` is enabled; enabling global signup
without the hook, or manual linking without the update trigger, opens a public
signup or upgrade bypass. The migration is forward-only: the documented partial
rollback is `DROP TRIGGER` (and then the function) only, retaining
`public.signup_invites` and all user/workout data.

An invited account is provisioned by inserting the allowlist row with the
service role and then using the Admin invite flow. Admin `/admin/users` creation
bypasses the hook and is a trusted service-role action, not a public path.
Deployment capability flags remain independent and default off until the
target deployment's live suite passes. For local synthetic-stack validation,
put these in repo-root `.env.local` **after** the migration is applied and the
committed Auth profile is active (never commit the file):

```sh
FIT_TRACE_GUEST_SIGN_IN=1
FIT_TRACE_GUEST_UPGRADE=1
FIT_TRACE_GUEST_CAPTCHA_REQUIRED=0  # local stack without CAPTCHA only
```

Start the dev API with `SUPABASE_*` set so `GET /api/v1/public-config` exposes
the enabled capabilities. `0`/missing values stay fail-closed. Setting
`FIT_TRACE_GUEST_CAPTCHA_REQUIRED=1` does **not** implement CAPTCHA: this client
has no widget and disables guest entry instead.

**Agent execution boundary:** anonymous guests may use only **local Agents**
(for example the user's local CLI). They must **never** be granted hosted or
cloud Agent execution. A formal, email-verified non-anonymous account is
required before a hosted/cloud path is considered, and verification alone does
not grant capacity: the server must still enforce an explicit quota or
entitlement. This slice neither implements hosted/cloud Agent execution nor
those server quotas.

Provision an invited address through the trusted server-side allowlist only
(service-role SQL/psql or back office; there is no app RPC and no client read
or write access):

```sql
insert into public.signup_invites (email) values ('qa@example.com');
-- After the synthetic test, remove the row before reusing the address:
delete from public.signup_invites where lower(email) = 'qa@example.com';
```

Then use the Admin invite flow for a normal account, or let an invited guest
start the same-UID upgrade in the app. Never populate `signup_invites` from the
browser, public-config, or a user token. Local email lands in Mailpit; this
guide does not claim production SMTP delivery or CAPTCHA-provider validation.

### 6.3 Same-UID upgrades

The creation hook does not run on `PUT /auth/v1/user` email linking or on email
verification, so it cannot enforce invite qualification for an upgrade. The
migration's narrow trigger supplies that boundary in the same Auth database
transaction:

1. `beginGuestUpgrade(email)` calls `PUT /auth/v1/user` on the current verified
   guest. The trigger checks that an unconsumed normalized invite exists but
   does not consume it.
2. The user opens the emailed confirmation link. GoTrue v2.197.0's
   `emailChangeVerify` transaction first sets `is_anonymous = false`
   (`UpdateOnly(user, "is_anonymous")`) and then calls
   `ConfirmEmailChange(...)`. The trigger consumes the invite atomically on the
   first update, while the target can still be read from `email_change`; a
   later failure rolls the transaction and invite consumption back.
3. The app callback accepts a **tab-scoped pending upgrade** only when the
   callback token's verified `GET /auth/v1/user` reports the same UUID,
   `is_anonymous === false`, the pending normalized email, and
   `email_confirmed_at`. A wrong-UID callback never replaces the current
   session; a still-anonymous response is reported as pending, not success.
   If the email link opens in a new tab, that tab fails closed (no shared
   pending marker); the original tab has an explicit **Check verification**
   action that re-fetches the authoritative user and promotes the pending
   marker only for the same UUID, target email, confirmed email, and
   `is_anonymous === false`.
4. Only after verification does `/reset-password` set the password, using the
   verified session. After the async password response, the client re-fetches
   `/auth/v1/user` and requires the same expected UUID and pending confirmed
   email before clearing the marker or navigating. A switch/logout during the
   request leaves B untouched and keeps the pending marker; a
   verified-but-passwordless account is never presented as finished.
5. The same UUID keeps the existing `owner_id`; this is an in-place upgrade.
   Signing in to an existing account is an explicit switch with **no data
   merge**, and a failed account login preserves the guest session.

The UI exposes the full upgrade/switch/sign-out actions through the reusable
`GuestAccountControls` component on `/me`; the compact header keeps only a
badge, an account link, and the safe two-step sign-out. The
verified-but-passwordless notice renders outside that guest-only control but
in the same Me account section. `guestUpgradeEnabled` is a public
capability, default false, and is enabled only by an explicit server env flag
after real-stack tests. `updateUser` has no CAPTCHA field in GoTrue v2.197.0;
this endpoint therefore does not pretend to enforce CAPTCHA. The anonymous
signup transport retains the official optional `gotrue_meta_security.captcha_token`
field. If a deployment enables CAPTCHA for anonymous sign-in, it must set
`FIT_TRACE_GUEST_CAPTCHA_REQUIRED=1`; this client has no CAPTCHA widget yet and
therefore fails closed (guest entry disabled) instead of sending a request that
cannot pass. Deployment-level rate/abuse controls remain external.

`FIT_TRACE_SUPABASE_UPGRADE_INTEGRATION=1` gates the executable same-UID
integration check. It consumes a real Mailpit inbox link/token (not an Admin
`email_confirm` shortcut) and verifies same-UID RLS ownership for workouts and
imported artifacts, verified email, password login, other-guest isolation,
uninvited/forged-metadata denial, consumed-invite denial, and recovery.

### 6.4 Executable tests and current evidence

The transport is `signInAnonymously` in `app/src/auth/supabaseAuth.ts`: it posts
the official anonymous signup body (`data: {}`) to `/auth/v1/signup` (GoTrue
routes email/phone-less signup to `SignupAnonymously`) and then classifies the session **only** through
`fetchAuthUser` (`GET /auth/v1/user`). When a host-page CAPTCHA token is
available it is sent in the official `gotrue_meta_security.captcha_token` body;
this client does not solve CAPTCHAs and does not claim a deployment has them
enabled. A missing or malformed `is_anonymous` stays `undefined`; token-grant
responses and cached sessions never classify. An unverified candidate session
is retained separately and reused for verification retries/reloads, so a
transient `/user` outage does not create a second anonymous user. AuthContext
now exposes `signInAsGuest`, `beginGuestUpgrade`, `completeGuestUpgrade`, and
`refreshVerifiedUser`; the last two require the tab-scoped pending marker and
the verified same-UID response.

`tests/supabaseAuthIntegration.test.ts` is isolated, loopback-only, opt-in, and
uses the service key only for throwaway-user setup/cleanup. Mailpit
(`MAILPIT_URL`, default `http://127.0.0.1:55324`) supplies the real inbox link;
tokens are consumed without being printed. It asserts:

- anonymous sign-in returns a real guest JWT, `/auth/v1/user` reports
  `is_anonymous = true`, and the token can create/read its own workout through
  RLS;
- public email signup is denied while a hook-qualified invited account can log
  in and reports `is_anonymous = false`;
- a valid invited email change stays authoritative pending
  (`is_anonymous = true`) and leaves the invite unconsumed;
- with the upgrade flag, the real inbox confirmation link flips the same UUID
  to `is_anonymous = false` with `email_confirmed_at`, preserves the
  pre-upgrade workout and issue6 imported artifact under the same `owner_id`,
  and allows password setup/login;
- another guest cannot read those rows;
- uninvited targets, consumed invites, and metadata-only updates are denied or
  do not authorize an upgrade; account recovery still succeeds.

Current verification status:

- Automated coverage in this checkout: `app/src/auth/supabaseAuth.test.ts`
  covers the anonymous transport and verified classification;
  `tests/supabaseRepository.test.ts` covers server-side verifier parsing;
  `app/src/auth/AuthContext.test.tsx` covers pending upgrade initiation,
  same-UID verification, wrong-UID rejection (callback and refresh),
  still-anonymous rejection, external-verification resume, concurrent/stale
  initiation (serialized mutation), explicit-only resend, password-finish
  identity guards, CAPTCHA fail-closed behavior, and cleanup on sign-out.
  `app/src/screens/MeScreen.test.tsx` covers the full guest upgrade/switch
  entry on Me and same-guest sign-out with coach teardown; the App guest-gate
  suite covers the compact header and the Me route. These are component/route
  tests, not browser UI acceptance.
- **Live results are owned by the supervisor**, who runs this suite against the
  distinct `agent-fit-trace-issues-test55321` project with Supabase CLI 2.120.0
  (which bundles GoTrue v2.197.0). The tracked Auth integration passed **5/5
  with 0 skips** against the tested guest/manual-linking/hook-on profile. It
  proved the actual-Mailpit same-UID upgrade, password login, workout and
  imported-artifact preservation (exact `analysis:v1:<64hex>` identity),
  pending-email non-consumption, uninvited/forged-metadata/consumed-invite
  boundaries, and recovery. A separate supervisor SQL acceptance forced a
  failed conversion (invite stayed unused, guest stayed anonymous) and ran two
  concurrent synthetic conversions (one invite, exactly one success), then
  cleaned all synthetic rows. The baseline local suite passed 6/6. This
  document does not claim production SMTP delivery, CAPTCHA-provider
  verification, rate-limit settings, or browser QA.
- Pinned research inputs: GoTrue `supabase/auth@ce9a8eee0cc042be8c7a42981a7ddae631e41d91`
  (2026-09-22; local CLI 2.120.0 bundles v2.197.0) and the docs pages linked
  above, read 2026-10-17.

The Vercel entrypoints are small `.mjs` wrappers. `pnpm build:server` bundles
the shared TypeScript core and server with the existing Vite toolchain into
`build/server/vercel.mjs`, then Vercel packages it with each Function. This
avoids leaving `.ts` imports in emitted `.js` files. Verify the packaged
handler loads after `vercel build`; a successful build exit alone is not
proof of runtime compatibility.
