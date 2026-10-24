# Local daemon (`pnpm daemon`)

Source-run resident service only (`agent-fit-trace daemon`, issue #38's
local data plane). The daemon is the standalone counterpart to the
launcher: ONE loopback listener that **owns the data itself** — the same
`/api/v1` contract the app's HTTP client speaks, backed by per-principal
SQLite stores — plus the same reviewed loopback coaching server and an
optional same-origin App shell. It runs headless (no Electron, no
browser) and survives client disconnects.

`agent-fit-trace start` is unchanged in this slice: it keeps its current
meaning (fixed upstream authenticated API proxy + foreground composite,
see [`local-launcher.md`](local-launcher.md)) so the documented launcher
contract is not broken. The two coexist during the transition; once guest
mode ships and the cloud path migrates, `start` is reduced to a
foreground alias of the daemon (spawn + open browser), with the upstream
proxy behavior remaining selectable by flag until then.

## Command

```sh
pnpm daemon
# explicit form (same thing):
node packages/fit-trace-cli/src/cli.ts daemon [--port N] [--data PATH] [--dist PATH]
```

Behavior:

- Binds loopback only (`http://127.0.0.1:<port>`, default preferred port
  `5199`, falls forward while busy). There is no browser open; the daemon
  is a resident service.
- `--data PATH` selects the data directory (default
  `resolveDataDir(env)`: `$FIT_TRACE_DATA_DIR` or `~/.fit-trace/data`).
  Each verified principal gets its own SQLite database
  (`<dataDir>/<principal>.db`, WAL); the guest plane lives in
  `<dataDir>/guest.db`.
- `--dist PATH` points at a built App shell (default `<repo>/app/dist`).
  The shell is served only when an `index.html` exists there — a missing
  build is **not an error**: the shell routes 404 and the headless data
  plane keeps working.
- Startup writes `<dataDir>/identity.json` with
  `active_principal: "guest"` (idempotent, atomic temp-file + rename) so
  followers can resolve the same active principal (see #40 below).
- Coaching state persists to `<dataDir>/coaching-journal.json` under the
  same process lock the launcher uses.
- Startup checks Node >= 24 and reports `pi --version` presence. Missing
  pi never blocks serving — workout tracking works; coaching runs report
  pi-unavailable instead of a generic spawn error.
- `SIGINT`/`SIGTERM` close the listener, the coaching service, and every
  open SQLite connection; a second signal forces exit.

## Environment

| Variable | Meaning |
| --- | --- |
| `FIT_TRACE_DATA_DIR` | Data directory override (default `~/.fit-trace/data`). |
| `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) | Optional. When both are set (and the URL is http(s), the key is not a secret/service-role key), any bearer other than the local daemon token is verified against that Supabase project. Unset/invalid → the daemon serves the pure guest plane and login attempts fail closed. |

Flags `--port`, `--data`, and `--dist` override the corresponding values.

## Auth model

The daemon is loopback-only and trusts the local machine for exactly one
credential: the fixed bearer `fit-trace-local-daemon`, which resolves to
the stable guest principal (`guest`). Everything else fails closed with
401 `UNAUTHENTICATED`.

Optional Supabase login goes through the same verifier seam
(`server/auth/`): with a project configured in the environment, a real
Supabase access token is verified (`GET /auth/v1/user` with the
publishable key only) and the whole `/api/v1` contract is scoped to that
Supabase principal's own database file. The composite verifier
(`createDaemonVerifier`) tries the guest token first, then delegates to
the Supabase verifier; with no project configured, every other token is
rejected. Coached runs always read the verified caller's store, so a
login flow scopes snapshots and coaching to the same principal.

## Endpoints

- `GET /api/v1/public-config` — public bootstrap. The daemon payload adds
  the additive marker fields: `daemon: true` always, and
  `auth_configured` (`true` only when a Supabase project is configured).
  The Supabase `supabaseUrl`/`supabasePublishableKey` fields (and the
  guest sign-in capability flags) are carried **only when configured**.
  App-side strict parsing of these fields lands with issue #39; until
  then the fields are additive and ignored by current clients.
- `/api/v1` data plane (the shared `FitTraceClient` contract, served by
  the authenticated handler over SQLite):
  `GET|POST /workouts`, `GET /analysis`, `POST /plans/drafts`,
  `GET|POST /imports`, `GET /imports/:id`,
  `GET|PUT /import-selections/:kind`, `GET|PUT /plan-adoption`.
  Missing/invalid bearers are 401 `UNAUTHENTICATED` (with a
  `WWW-Authenticate: Bearer` header); identical re-imports stay no-ops;
  same-id different-content stays `CONFLICT`.
- `/coaching/*` — the same loopback coaching service as the launcher
  (see [`coaching-api.md`](coaching-api.md)): bootstrap + short-TTL
  capability, sessions, snapshots, runs, SSE events, cancel. Snapshots
  derive from the active principal's SQLite store (never an upstream
  API); each run still gets its own fresh per-run JSON snapshot file, and
  the coached pi child's `PI_FIT_TRACE_STORE` still points at that
  snapshot — never at the principal database.
- App shell (only with a built dist): static files, SPA fallback for app
  routes, and the `/fit-trace-runtime.js` same-origin bootstrap
  (`mode: "http"`, `coaching: "same-origin"`, `piAvailable`). `/api/*`
  and `/assets/*` are never the shell; `/api/*` paths outside `/api/v1`
  are 404. All routes require an exact `Host: 127.0.0.1:<port>` and an
  exact same-origin `Origin` when one is sent; nothing credential-bearing
  is logged.

## Headless usage

Without a built app (or with `--dist` pointing nowhere), the daemon is a
pure local data + coaching service:

```sh
pnpm daemon --data ~/.fit-trace/data   # shell routes 404; /api/v1 works
curl -H "Authorization: Bearer fit-trace-local-daemon" \
  http://127.0.0.1:5199/api/v1/workouts
```

The default `pnpm daemon` still serves the shell whenever
`<repo>/app/dist` has been built (`pnpm build`), same-origin.

## Relationships to #39 and #40

- **#39 (app-side guest mode):** the daemon serves the valid local
  payload today (`daemon: true`, `auth_configured`, Supabase fields only
  when configured). The app's strict parsing that switches cloud surfaces
  off and gates login on `auth_configured` lands in #39; until then the
  app treats the extra fields as unknown and ignores them.
- **#40 (MCP/pi followers):** `identity.json` names the active principal
  the daemon serves; `@agent-fit-trace/store`'s
  `resolveActiveStore`/`principalDbPath` read the same file and db layout,
  so MCP and pi followers can resolve the guest database without their own
  state. Whether `start` aliases the daemon, and how followers signal
  principal switches, is decided in #40 — nothing in this slice reads
  identity back or supports switching yet.

## Limitations (current slice)

- Guest login upgrading, per-principal switching through the daemon, and
  cross-process principal negotiation are not implemented (#40).
- The daemon registers only the local pi coaching backend; the launcher's
  experimental Codex/OpenCode gates are not wired here.
- Cloud coaching stays unqualified for every principal (no trusted
  identity/quota/provider is configured locally).
- `start` still owns the documented same-origin proxy contract; the two
  commands do not share a journal or a port, and running both at once is
  supported only on different ports (each scans forward independently).
