# Local launcher (`pnpm start` / `pnpm coach:local`)

Source-run launcher only (`agent-fit-trace start`). No packaged `npx`
install is published. The launcher serves the already-built App shell
same-origin, proxies data/bootstrap reads to one fixed server-configured
authenticated API, and serves the reviewed loopback coaching server on the
same listener (same origin, same port).

## Command

```sh
pnpm start
# explicit form (same thing):
node packages/fit-trace-cli/src/cli.ts start [--port N] [--no-open] [--upstream URL] [--dist PATH]
```

Behavior:

- Serves `<repo>/app/dist` on loopback only (`http://127.0.0.1:<port>`,
  default preferred port `5198`, falls forward while busy). Missing
  `index.html` fails with the build step (`pnpm --filter @pi-fit-trace/app
  build`).
- Injects a same-origin runtime bootstrap (`/fit-trace-runtime.js`) into the
  served shell so a build with the default local `VITE_FIT_TRACE_MODE` acts
  as an HTTP client under the launcher without rebuilding. Existing plain
  local/HTTP selection is unchanged outside the launcher.
- SPA fallback serves `index.html` for app routes; `/api/*` and `/assets/*`
  are never the shell (matches `vercel.json` rewrites).
- Tries to open a browser only on interactive launches; `--no-open` covers
  tests/headless. Only exact loopback URLs are ever opened. `SIGINT`/`SIGTERM`
  close the server and destroy open sockets; a second signal forces exit.
- Startup checks Node >= 24 and reports `pi --version` presence (no model
  calls; the output is a presence signal only, never an auth claim). Missing
  pi never blocks serving — workout tracking works; the runtime bootstrap
  advertises `piAvailable: false` and coaching runs fail clearly as
  pi-unavailable instead of a generic spawn error.
- A busy preferred port falls forward to the next free loopback port (a
  failed bind holds no service timers or runtimes while scanning). `port: 0`
  binds once and reports the real address.

## Configuration (operator-side only; never from the browser)

## Configuration (operator-side only; never from the browser)

| Variable | Meaning |
| --- | --- |
| `FIT_TRACE_API_BASE_URL` (required) | Fixed authenticated API base, e.g. `https://<app>.vercel.app/api/v1`. Absolute http(s), no query/credentials/fragment. |
| `FIT_TRACE_COACH_PORT` | Preferred loopback port (default `5198`). |
| `FIT_TRACE_APP_DIST` | Built app directory (default `<repo>/app/dist`; empty counts as unset). |

Flags `--upstream`, `--port`, `--dist` override the corresponding values;
`--no-open` skips the browser attempt. The proxy allowlist is fixed:

- `GET /api/v1/public-config` (upstream bootstrap response, credentials dropped)
- `GET/POST /api/v1/workouts`, `GET /api/v1/analysis`, `POST /api/v1/plans/drafts`
  (the request's own user bearer is forwarded ephemerally as `Authorization`)

Anything else under `/api/` is `404` and never reaches the upstream (the
user bearer is forwarded only to the allowlisted endpoints that need it,
never on unknown routes or redirects). Query strings forward only for
`GET /analysis`; a `?upstream=…` on other routes is dropped, never honored.
Upstream redirects are refused (502); upstream outages are 503; unreadable
or oversize upstream payloads are 502 (bodies stream under a 1 MiB byte cap,
so multi-byte payloads are bounded by bytes, not characters). `/api/*`
requires an exact `Host: 127.0.0.1:<port>` and an exact same-origin `Origin`
when one is sent. Static files resolve symlinks and must stay inside the
canonical dist root (traversal/symlink escapes are never served). No headers
or keys are logged.

## Auth and data notes

- Login stays in the App (`AuthProvider`): at boot the launcher fetches the
  public config from the fixed upstream's own `/public-config` response
  (bounded read, shared Supabase key/URL guards — secret/service-role keys
  are rejected). There is no environment fallback to an unrelated project:
  when the upstream config is missing/unreachable/rejected, coaching stays
  unauthenticated and reports unavailability instead of serving an
  unverified key.
- Session tokens refresh in the browser, and the CLI keeps no token cache.
- Supabase Auth redirect URLs must allow the local origin
  (`http://127.0.0.1:<port>`); the launcher never bypasses login or trust.
- Changing the local port/origin never migrates data — Supabase holds the
  canonical records; browser `localStorage` is not a launcher data source.
- Supabase is the only production data path. The memory loopback dev API
  (`pnpm dev:api`) and the `VITE_FIT_TRACE_LEGACY_LOOPBACK` opt-in remain
  development/test-only and are never routed by the launcher.

## Coaching on the same origin

`/coaching/*` is served by the reviewed loopback service
(`server/coaching/`, see [`coaching-api.md`](coaching-api.md)) on the same
listener — one port for the App shell, the data proxy, and coaching. The
runtime bootstrap advertises `coaching: "same-origin"` (plus `piAvailable`
when the presence probe ran).

The App ships a Coach screen (`app/src/screens/CoachScreen.tsx`) in two
configurations: when the launcher publishes the same-origin coaching flag, or
when an authenticated HTTP deployment is active. One account-level owner drives
the session/snapshot/run lifecycle, streamed text and tool progress, explicit
cancel/reconnect, account-scoped backend selection, and a versioned
account-bound resume. Discovery and availability are server-derived: the
launcher exposes local backend descriptors, but it does not mount the cloud
routes. A stored cloud run is resumed in the cloud-enabled HTTP deployment, not
through the launcher; selecting cloud in that deployment still requires a
server-reported formal account, configured quota, and a provider. The selector
chooses only the NEXT run; replay and cancel keep the run's original backend.
Guests see local install/launch guidance and never submit to cloud. When the
launcher probe reports `piAvailable: false`, only the local pi option is
disabled; other available backends stay selectable, and workout
logging/history keep working. Plain local builds without either flag still hide
the route.

The launcher persists local coaching product state to an app-owned
`.pi/fit-trace/coaching-journal.json` (file `0600`, parent `0700`) before
acknowledging each mutation. Retained runs, events, idempotency records, and
native session ownership survive a restart. A run that was active when the
previous process exited is never adopted; it becomes failed with an
execution-unconfirmed reason, keeps its capacity slot, and no second process is
spawned. A malformed journal fails closed instead of resetting.

## Limitations (current slice)

- Local OpenCode is experimental and advertised only when the installed CLI
  provides positive isolation evidence; this build wires no production
  isolation verifier, so the CLI currently reports it unavailable. Codex
  remains unavailable until built-in tool isolation can be proven. There is no
  packaged `npx` install.
- Hosted cloud is opt-in and unverified against a real provider or deployed
  worker. It requires applied migrations, a separate outbox worker, configured
  quota/provider, and explicit operator enablement.
- A run left execution-unconfirmed after an abnormal exit keeps capacity held;
  there is no HTTP recovery/acknowledgement action yet, so recovery is an
  operator action on the local journal after confirming no child process is
  still running.
- No automatic migration between local/memory/Supabase stores.
