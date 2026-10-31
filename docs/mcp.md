# MCP server (`agent-fit-trace-mcp`)

Source-run stdio MCP server (`packages/fit-trace-mcp/`). It exposes the same
four domain tools as the pi extension's normal mode — import, history,
analysis, and draft planning — plus two read-only resources and the
`training-coach` prompt, so any MCP host (Claude Desktop, Cursor, …) can drive
fit-trace without the pi extension or the launcher.

## Positioning

- The server is a standalone integration surface, equivalent to the pi
  extension's normal (non-coached) mode. It is **not** a coaching execution
  backend: it never spawns or drives a model, and it is not registered in the
  coaching runtime registry (`server/coaching/runtimeRegistry.ts`). ADR 0001
  keeps coached runs to the two analysis tools and explicitly excludes MCP
  servers from the coached tool surface; this server lives entirely outside
  that pipeline (see
  [`adr/0001-agent-execution-backends.md`](adr/0001-agent-execution-backends.md)).
- Two transports: local stdio (`src/main.ts`, this section) and a stateless
  HTTP endpoint for cloud data (`/api/mcp`, see "Remote MCP (HTTP)" below). They
  share the same server factory, tools, and resources; they differ only in
  transport and in where records come from.
- stdout carries only the MCP protocol; every diagnostic goes to stderr.
  `--help`/`--version` print to stdout before any transport exists.

## Run

```sh
node packages/fit-trace-mcp/src/main.ts [--store PATH] [--principal NAME] [--skill PATH]
```

Requires Node >= 24. Node 24 runs TypeScript entrypoints with type stripping
by default, so no `--experimental-strip-types` flag is needed. `--help` prints
usage (including the store-resolution precedence); `--version` prints
`agent-fit-trace-mcp 0.1.0`.

## Storage

By default the server opens the **shared per-identity SQLite database** — the
same file the daemon, the desktop app, and the pi extension's normal mode use —
via `@agent-fit-trace/store`'s `resolveActiveStore`
(`packages/fit-trace-store/src/identity.ts`). Databases live under the data
directory (`$FIT_TRACE_DATA_DIR`, default `~/.fit-trace/data`) as
`<principal>.db`. Principal resolution, in order:

| Level | Source |
| --- | --- |
| 1 | `--store PATH` — an explicit absolute path, used as-is (bypasses principal handling entirely) |
| 2 | `--principal NAME` flag / `FIT_TRACE_PRINCIPAL` env (flag wins) — `<dataDir>/<NAME>.db`, created on first run |
| 3 | `identity.json`'s `active_principal` — used **only when the record exists and its database file exists** |
| 4 | no `identity.json` (first run) — the `guest.db` store |

A `identity.json` naming a principal whose database file is missing fails
startup loudly with `STALE_IDENTITY` (naming the identity file, the missing db,
and both override methods) instead of silently falling back to guest — a silent
fallback would fragment the dataset.

**JSON compatibility escape hatch (kept for one release):** a JSON store file
is still selectable with `--store <path>.json` or the legacy
`PI_FIT_TRACE_STORE=<path>.json` env, which sits between `--store` and
principal resolution as an explicit file choice. An explicit `.json` path keeps
the JSON backend; any other explicit path opens as SQLite. A blank flag or env
value counts as unset.

Because followers resolve `identity.json` at startup, the desktop app's active
principal propagates to independently launched MCP sessions: switching identity
in the app (recorded by the daemon into `identity.json`) is picked up by the
next MCP server start with no extra arguments. Today the daemon records
`guest` at startup (`docs/local-daemon.md`), so all local surfaces share
`guest.db`; the resolution seam above is what makes a later principal switch
follow automatically.

Multi-process sharing is safe by construction: the SQLite backend opens the
database in WAL mode with a 5 s `busy_timeout`, so the daemon, MCP servers, and
pi sessions read and write the same file concurrently (multiple readers, one
writer at a time; lock waits instead of lost records). The same rules apply to
whichever backend is opened: records are re-validated on load
(`CORRUPT_STORE`), and re-importing an id with changed content is a `CONFLICT`,
never an overwrite.

## Prompt and skill file

The `training-coach` prompt serves the body of
`.pi/skills/training-coach/SKILL.md` (YAML frontmatter stripped), resolved
from this repo checkout. Override with `--skill PATH` or
`FIT_TRACE_SKILL_PATH`. There is no inline fallback: a missing or unreadable
skill file fails startup with exit code 2 and a message naming the attempted
path and both override methods.

## Surfaces

| Kind | Name | Notes |
| --- | --- | --- |
| Tool | `import_workout` | Validate and store one session; idempotent by `id` (`idempotentHint: true`, `destructiveHint: false`) |
| Tool | `get_training_history` | Date-range/exercise query with pagination (`readOnlyHint: true`) |
| Tool | `analyze_progress` | Deterministic metrics, per-exercise trends, safety flags (`readOnlyHint: true`) |
| Tool | `generate_next_plan` | Draft plan; requires user confirmation, never writes (`readOnlyHint: true`) |
| Resource | `fit-trace://workouts/recent` | The 10 most recent records, `application/json`, live read |
| Resource | `fit-trace://analysis/summary` | `analyze_progress` defaults over all records, `application/json`, live read |
| Prompt | `training-coach` | The skill body as one user message |

Tool results mirror the pi extension's text and structured payloads. A domain
failure (`VALIDATION_ERROR`, `CONFLICT`, `CORRUPT_STORE`) is returned as an
`isError` result whose text is `CODE: message`; the process stays up.
Malformed tool arguments fail the SDK's input-schema validation and come back
as an `isError` result (the SDK's `InvalidParams` text) before any handler
runs. Any other unexpected failure returns a fixed `INTERNAL_ERROR` text
without a stack.

## Host configuration

GUI hosts do not inherit your shell `PATH` (a macOS GUI app cannot see an
nvm/volta-managed `node`), so use absolute paths for both the node binary and
the entrypoint. Find the node path with `command -v node`.

Claude Desktop (`claude_desktop_config.json`, Developer → Edit Config):

```json
{
  "mcpServers": {
    "fit-trace": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-fit-trace/packages/fit-trace-mcp/src/main.ts"]
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`) — with no extra configuration the server follows
`identity.json` and shares the daemon's per-identity database. To pin an
explicit store instead, pass the JSON escape hatch as an env var:

```json
{
  "mcpServers": {
    "fit-trace": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-fit-trace/packages/fit-trace-mcp/src/main.ts"],
      "env": { "PI_FIT_TRACE_STORE": "/absolute/path/to/workouts.json" }
    }
  }
}
```

`--store PATH` / `--principal NAME` / `--skill PATH` can be passed as extra
`args` entries instead of env vars.

## Verify

```sh
npx @modelcontextprotocol/inspector --cli node "$PWD/packages/fit-trace-mcp/src/main.ts" --method tools/list
```

This lists the four tools with their annotations. Verified 2026-10-24 against
this repo with a 3-record fixture store via `--store`: `tools/list` advertises
all four tools with full JSON Schemas and annotations
(`import_workout {destructiveHint:false, idempotentHint:true}`; the other
three `{readOnlyHint:true}`), `tools/call` for `analyze_progress`
(3 sessions, 8325 kg) and `generate_next_plan --tool-arg goal=strength`
(draft with `requires_confirmation`) returns text plus `structuredContent`,
`resources/read` serves both URIs as `application/json`, and
`prompts/get --prompt-name training-coach` returns the skill body with the
YAML frontmatter stripped. Drop `--cli` for the interactive inspector UI.

To verify the shared per-identity store across surfaces, point a scratch data
directory at both the daemon and the MCP server and confirm one import is
visible from both sides:

```sh
FIT_TRACE_DATA_DIR=/tmp/fit-trace-shared pnpm daemon &
sleep 1
curl -s -X POST -H "Authorization: Bearer fit-trace-local-daemon" \
  -H "Content-Type: application/json" \
  -d @fixtures/valid-strength.json \
  http://127.0.0.1:5199/api/v1/workouts > /dev/null
npx @modelcontextprotocol/inspector --cli node "$PWD/packages/fit-trace-mcp/src/main.ts" \
  -e FIT_TRACE_DATA_DIR=/tmp/fit-trace-shared \
  --method tools/call --tool-name analyze_progress
# The inspector does not inherit shell environment variables, so the data dir
# must be passed to the MCP child process with `-e` (as above). The
# default-resolution startup line on stderr then names the same
# /tmp/fit-trace-shared/guest.db the daemon wrote, and the analysis counts
# the record the daemon imported.
```

The same check runs the other direction (`tests/mcpSharedStore.test.ts` /
`tests/piSharedStore.test.ts` cover it in-process): records imported through a
plain `SqliteWorkoutStore` connection are visible to MCP `analyze_progress` and
to the pi extension's normal-mode tools against the same `guest.db`.

## Remote MCP (HTTP)

A second, separate surface: the same four tools, two resources, and prompt
served over Streamable HTTP at the app origin, so a hosted MCP client can reach
a user's cloud data without a local Node process. The stdio server above is
unchanged and still the local-first path.

**Status: code complete; verified end-to-end on a real local stack
(GoTrue v2.197.0 + PostgREST v16.4) both by a scripted client and by a real MCP
SDK client — 30/30 stack-contract and 18/18 client assertions; NOT yet applied
to the hosted project.** The pieces are `server/mcp/auth.ts` + `env.ts` (token
verification and fail-closed config), `server/mcp/httpHandler.ts` +
`resourceMetadata.ts` (the request handler and Protected Resource Metadata), the
Vercel entry `api/mcp.mjs`, `packages/fit-trace-mcp/src/cloudStore.ts` (the
Supabase-backed store), the `app/` consent screen, and the Supabase hook
migration below. This section deliberately separates what was actually proven
from what was only reasoned about — see
[Verification status](#verification-status). Do not describe remote MCP as
production-ready on the strength of this document: the hosted project still
needs the migration applied and the hook enabled, and no shipping desktop MCP
client has completed its browser leg against it.

### Resource URL and endpoints

| Surface | URL |
| --- | --- |
| MCP endpoint | `https://agent-fit-trace.vercel.app/api/mcp` |
| Protected Resource Metadata (RFC 9728) | `https://agent-fit-trace.vercel.app/.well-known/oauth-protected-resource/api/mcp` |
| OAuth authorization server (issuer) | `https://<ref>.supabase.co/auth/v1` |
| Discovery | `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` |
| Consent screen (this app) | `https://agent-fit-trace.vercel.app/oauth/consent` |

The MCP resource URL is configuration, not a guess: it must equal
`FIT_TRACE_MCP_RESOURCE` exactly (no trailing slash, no query, no fragment) and
must equal the claim the hook stamps. Verification compares all three for exact
equality, so a mismatch rejects every token rather than degrading.

### Identity: the token, never a session id

The endpoint is **stateless**. Every request must carry
`Authorization: Bearer <access token>`; there is no session cookie, no session
header, and no server-side session table. Concretely:

- A new `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator:
  undefined })` and a **new** MCP server instance and store are built **per
  request**. Reusing a stateless transport across requests throws
  ("Stateless transport cannot be reused across requests"), and it would be a
  cross-user identity leak, so it is forbidden by construction and covered by a
  concurrency test.
- The caller's identity is `sub` as confirmed by `GET /auth/v1/user`, called
  with the publishable key and the caller's own bearer — the same shape as the
  rest of the server (`server/auth/supabaseVerifier.ts`). The decoded JWT
  payload is never the source of identity; it only gates whether the Auth call
  happens.
- Every downstream data read/write carries that same caller token, so PostgREST
  RLS (`auth.uid() = owner_id`) applies. The **service-role key is never
  present on this path** — not in the route, not in the handler, not as a
  fallback. Adding it would turn one bug into full-database access.
- A missing/malformed/expired/unbound token is `401` with
  `WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource/api/mcp"`;
  an Auth outage is `503`, never a silent downgrade.

### The resource claim and the hook

Why not `aud`: these access tokens are shared with Supabase Auth and PostgREST,
both of which expect `aud: authenticated`. Rewriting `aud` to encode "MCP" would
put the caller's own RLS-scoped token at risk, so **`aud` is left untouched**.
The verifier separately *requires* `aud` to contain `authenticated`, so a future
audience change fails closed instead of silently widening access.

Instead Supabase's **custom access token hook** adds one claim:

```jsonc
{ "aud": "authenticated", "client_id": "<oauth client uuid>", "fit_trace_mcp_resource": "https://agent-fit-trace.vercel.app/api/mcp" }
```

- Claim name: `fit_trace_mcp_resource` (`MCP_RESOURCE_CLAIM` in
  `server/mcp/contracts.ts` — the constant is authoritative).
- The hook is `public.hook_stamp_mcp_resource(event jsonb)` in
  [`20261029000000_mcp_oauth_resource.sql`](../supabase/migrations/20261029000000_mcp_oauth_resource.sql),
  enabled through `[auth.hook.custom_access_token]` in
  [`supabase/config.toml`](../supabase/config.toml).
- It stamps the claim **only** when the token's `client_id` matches an enabled
  row in `public.mcp_oauth_client_resources`. The value comes from that
  server-maintained table — never from user metadata, never from the request,
  never from the client.
- Every other token (browser password/OTP/anonymous sign-in, unlisted OAuth
  clients) carries no claim and is rejected by the endpoint. That is precisely
  what stops a first-party browser session token from being replayed as an MCP
  credential.
- It never raises: any miss or error returns the event unchanged, so the claim
  is simply absent. Fail-closed for MCP, no impact on the user's ordinary login
  or refresh.
- It returns the **whole** `event` object with `claims` replaced, because
  Supabase Auth unmarshals the return value into a structure that requires a
  `claims` key; returning a bare claims map would fail every token issuance.
  This is noted in the migration so it is not "simplified" away later.

The mapping table holds `client_id` as text (canonical lowercase UUID), not a
foreign key to `auth.oauth_clients`: that Auth table is GoTrue-version
dependent and owned by `supabase_auth_admin`, so a `public.`-side FK would make
the migration fail to apply on an older stack. Consequence: no database-level
referential integrity, and a stale row simply never matches (claim absent →
rejected). See the migration header for the full rationale.

### Configuration

| Variable | Purpose | Fail-closed behavior |
| --- | --- | --- |
| `FIT_TRACE_MCP_RESOURCE` | Exact resource URL this deployment serves | Must be an absolute `http(s)` URL; blank ⇒ endpoint returns `503` |
| `FIT_TRACE_MCP_CLIENT_IDS` | Comma-separated OAuth `client_id` allow-list | Blank/whitespace entries dropped; empty list ⇒ `503` |
| `SUPABASE_URL` | Project URL | Reused from the data API; missing/unsafe ⇒ `503` |
| `SUPABASE_PUBLISHABLE_KEY` | Public key used as `apikey` | Missing or service-role-looking ⇒ `503` |

`readMcpAuthConfig` (`server/mcp/env.ts`) returns `null` on any of the above, and
the handler then refuses to serve. There is no "accept anything" configuration
and no implicit default resource. Two lists must agree: the dashboard/DB side
(`public.mcp_oauth_client_resources`, read by the hook) and the server side
(`FIT_TRACE_MCP_CLIENT_IDS`, checked by the verifier). Populate both when
onboarding a client.

### Registering a client (dynamic registration is OFF)

Verified 2026-10-29 against the production project: the discovery document has
**no** `registration_endpoint`, so an MCP client cannot self-register. A client
must be created in the Supabase dashboard (Authentication → OAuth Server), and
its `client_id` then added to both places above. `token_endpoint_auth_methods_supported`
does include `none`, so a public client using PKCE is supported.

The authorization path must be set to `/oauth/consent` on the app origin; this
app serves that screen (`app/src/screens/OAuthConsentScreen.tsx`), which loads
the pending request, shows the client name/URI and requested scope, and posts
the approve/deny decision. The only redirect the browser follows is the
`redirect_url` returned by Supabase — the app never builds one.

### Revoking access

A user revokes a client's grant with their own token:

```sh
curl -X DELETE "$SUPABASE_URL/auth/v1/user/oauth/grants?client_id=<uuid>" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer <user access token>"
```

`GET` on the same path lists active grants. Revocation deletes the OAuth
sessions for that client, which invalidates the associated refresh tokens.
Operators can stop *new* stamping without touching any user's grants by setting
`enabled = false` on the client's row (or deleting it) — the claim then stops
being issued at the next token mint, and existing tokens are rejected once
their resource claim no longer matches a configured resource.

### Verification status

Three rounds, and they prove different things.

**Round 1 — hosted project (`zwmutsmqqormgtkjolgi`), 2026-10-29, HTTP probes only.**

| Claim | Status |
| --- | --- |
| Discovery returns issuer `https://<ref>.supabase.co/auth/v1` | **Verified** (probe of `.well-known/oauth-authorization-server/auth/v1`) |
| `token_endpoint_auth_methods_supported` includes `none` | **Verified** (same probe) |
| No `registration_endpoint` — dynamic client registration is OFF | **Verified** (same probe: the field is absent) |
| `GET /auth/v1/oauth/authorizations/{id}` exists and requires a bearer | **Verified** (401 without a token) |
| `POST /auth/v1/oauth/authorizations/{id}/consent` exists and requires a bearer | **Verified** (401 without a token) |
| `/auth/v1/oauth/authorize` validates an RFC 8707 `resource` param (absolute URI, no fragment/query) and compares it at code exchange | **Verified** (probe), **and** the parameter does not become `aud` |
| The mapping table exists on the hosted project | **Verified ABSENT** — `GET /rest/v1/mcp_oauth_client_resources` returns `PGRST205` (no such table), i.e. this migration has not been applied there |

**Round 2 — real stack, 2026-10-29: PostgreSQL 15 + GoTrue v2.197.0 +
PostgREST v16.4, the repo's migrations applied in order (including
`20261029000000_mcp_oauth_resource.sql`), the hook enabled, and the **built**
Vercel bundle (`build/server/vercel.mjs`) driven through its real
`handleVercelApi` entry. 30/30 assertions passed.**

| Claim | Status |
| --- | --- |
| The migration applies cleanly (table, hook function, grants) | **Verified** — all seven repo migrations applied to a fresh database, no errors |
| The hook stamps `fit_trace_mcp_resource` with the exact resource URL for an allow-listed client | **Verified** — observed in the issued token and in GoTrue's `run_hook` success log on `/oauth/token` |
| `aud` stays `authenticated` after stamping | **Verified** — decoded from the issued token |
| A stamped token still authenticates against `GET /auth/v1/user` | **Verified** — 200 |
| A stamped token still works against PostgREST (the reason `aud` is not rewritten) | **Verified** — 200 |
| A browser session token (no `client_id`, no claim) is rejected by `/api/mcp` | **Verified** — 401 |
| Two accounts cannot read each other's rows through the endpoint | **Verified** — real RLS: A sees 1 row, B sees 0, concurrently |
| A second account cannot read another user's authorization request | **Verified** — `GET …/authorizations/{id}` cross-account returns 404, never the other user's data |
| PKCE + consent + code exchange + a working `/api/mcp` session | **Verified** — authorize → consent → token → initialize/tools/resources/prompt |
| `import_workout` conflict vs. idempotent replay over the real database | **Verified** — `CONFLICT` on changed content, no-op on identical replay |
| `generate_next_plan` writes nothing | **Verified** — row count unchanged |

**Round 3 — real MCP client, 2026-10-29: the MCP TypeScript SDK's `Client` +
`StreamableHTTPClientTransport` + `OAuthClientProvider`, against the same live
stack. 18/18 assertions passed.** This is the code path a conforming client
runs, not a hand-rolled JSON-RPC loop.

| Claim | Status |
| --- | --- |
| The client refuses to connect without authorization and surfaces the MCP OAuth flow | **Verified** — no session opens on the unauthenticated attempt |
| The client discovers this resource from the 401 challenge and builds a PKCE authorization URL | **Verified** — fetched the Protected Resource Metadata, then the AS metadata |
| The client binds the authorization request to this resource (RFC 8707 `resource`) | **Verified** — `resource` equals the configured MCP URL |
| A real PKCE exchange yields a token carrying the hook's claim, with `aud` intact | **Verified** |
| An authenticated session, then all four tools, both resources, and the prompt over the real client | **Verified** |
| `import_workout` write, identical replay, analysis, draft plan, and `CONFLICT` through the real client | **Verified** |
| A shipping desktop MCP client (Claude Desktop, Cursor, …) completing its browser leg | **UNVERIFIED** — Claude Code 2.1.114 was exercised: it detects the endpoint, reads the Protected Resource Metadata and the AS metadata, honours the pre-registered `client_id`, and reports `Needs authentication` rather than failing — but it only starts the OAuth browser leg in an interactive session, so no shipping client completed the redirect in this environment |
| The hosted Supabase project with the migration applied + hook enabled | **UNVERIFIED** — round 2/3 used a local stack; the hosted project has not had the migration applied (round 1 confirms the table is absent there) |
| Vercel Preview serving `/api/mcp` and the metadata route | **UNVERIFIED** — the preview is behind Vercel Deployment Protection and no bypass credential was available |

Rounds 2 and 3 change what the code can claim, not what has been deployed: the
hosted project still needs the migration applied and the hook enabled, which is
an operator step (see [`deployment.md`](deployment.md)). Do not upgrade the
three UNVERIFIED rows above without running them.

### Operational findings from the live rounds

Things that only showed up when the flow was actually executed:

- **Consent needs the details GET first.** `POST …/consent` requires the
  authorization row to already belong to the caller; `GET …/authorizations/{id}`
  is what associates the signed-in user with it. A client that posts consent
  without loading details first gets `404 oauth_authorization_not_found`. The
  app's consent screen already loads details before rendering the buttons
  (`app/src/screens/OAuthConsentScreen.tsx`), so the UI is correct — but any
  new surface must preserve that order.
- **Do not request the `openid` scope on a symmetrically-signed project.** With
  HS256 keys, a token exchange that includes `openid` fails with
  `500 "HS256 is not supported for ID token signing"` before any MCP request
  happens. This resource therefore advertises only `email`
  (`MCP_SUPPORTED_SCOPES`); supporting `openid` needs asymmetric signing keys
  (Supabase recommends those for OAuth anyway).
- **Local hosts are the only plain-HTTP redirect targets.** GoTrue rejected
  `http://client.local/callback` at client registration
  (`invalid redirect_uri … HTTP scheme only allowed for localhost`), which is
  correct behavior and worth knowing before debugging a preview deployment.
- **Bare GoTrue serves the AS metadata at the origin root, not under the
  issuer path.** `GET /.well-known/oauth-authorization-server` answers 200 while
  `/.well-known/oauth-authorization-server/auth/v1` is a 404. Hosted Supabase
  hides this because its gateway fronts the project origin and serves the
  issuer-suffixed URL that clients actually request. Anyone standing up a local
  stack or a proxy must reproduce that aliasing, or client discovery fails with
  a bare 404 that looks unrelated to the endpoint.
- **The client's `clientInformation()` is validated strictly.** The MCP SDK's
  `OAuthClientInformationMixed` accepts `client_id` plus the optional
  `client_secret`/`id_issued_at` fields only; adding `token_endpoint_auth_method`
  there (a natural mistake, since the *client metadata* does carry it) fails
  schema validation with a `ZodError` that names no field. Keep the two shapes
  distinct.


## Limitations

- The stdio server has no HTTP/SSE transport; the remote surface is the separate
  `/api/mcp` endpoint described above, and it is a stateless request/response
  transport (no SSE stream, no server-initiated messages).
- No packaged `npx` distribution; the server runs from source like the
  launcher.
- The **stdio** server is unauthenticated and local-first: it reads and writes
  whatever store the resolution lands on — by default the per-identity database
  shared with the daemon, app, and pi. Point `--store` at a file you intend the
  host agent to modify. The HTTP endpoint is the opposite: it is authenticated
  per request and only ever touches the caller's own cloud rows.
- Real-host QA (Claude Desktop, Cursor) is outstanding for stdio; verification
  today is the MCP inspector CLI and the `node:test` suite
  (`tests/mcpServer.test.ts`, `tests/mcpSharedStore.test.ts`). Remote MCP has a
  real-SDK-client pass (round 3) but still no shipping desktop client
  completing its browser leg.
- Remote MCP has been verified end-to-end on a **real local stack**
  (PostgreSQL 15 + GoTrue v2.197.0 + PostgREST v16.4): the hook, RLS isolation
  between two accounts, and the built `/api/mcp` bundle, driven by both a
  scripted client and the MCP SDK client. It has **not** been applied to or
  exercised on the hosted Supabase project — round 1 confirms the mapping table
  is absent there — and no Vercel Preview deployment has served it (the preview
  sits behind Deployment Protection). Those remain operator steps with their
  own verification checklist.
