# Local daemon (`pnpm daemon`)

Source-run resident service only (`agent-fit-trace daemon`, issue #38's
local data plane). The daemon is the standalone counterpart to the
launcher: ONE loopback listener that **owns the data itself** — the same
`/api/v1` contract the app's HTTP client speaks, backed by per-principal
SQLite stores — plus the same reviewed loopback coaching server and an
optional same-origin App shell. The daemon itself runs headless (no
browser, no window of its own) and survives client disconnects; the
Electron desktop shell below is an optional consumer that spawns and
owns it, not part of the daemon process.

`agent-fit-trace start` is unchanged in this slice: it keeps its current
meaning (fixed upstream authenticated API proxy + foreground composite,
see [`local-launcher.md`](local-launcher.md)) so the documented launcher
contract is not broken. The two coexist during the transition; with app
guest mode shipped (#39), `start` is being reduced to a foreground alias
of the daemon (spawn + open browser), with the upstream proxy behavior
remaining selectable by flag until the cloud path migrates.

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
  followers can resolve the same active principal (see #40 below). That
  purpose is now live: the MCP server and the pi extension's normal mode read
  this file at startup and open the same per-identity database.
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
  App-side strict parsing shipped with #39: the marker pair
  `daemon: true` + `auth_configured: false` boots the app into guest-local
  mode; payloads without the markers parse exactly as before.
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
`<repo>/app/dist` has been built (`pnpm build`), same-origin. With the
shell served, the app no longer needs curl: a default build (no build
variables, no Supabase configuration) negotiates guest-local from
`GET /api/v1/public-config` and drives the whole `/api/v1` contract —
workouts, imports, analysis, plan drafts — as the daemon's local guest
(see `docs/app-dev-modes.md`, "Daemon mode"). The app-shell relationship
is native app support now, not a curl-only data plane.

## Desktop shell (`pnpm desktop:dev`)

One command, one window, same daemon:

```sh
pnpm desktop:dev
```

`packages/fit-trace-desktop/` is an Electron **thin shell** over this
daemon — the desktop app is a carrier, not a second application. The
entry script (`scripts/dev.cjs`) checks that the electron binary exists
(running `electron`'s `install.js` once if not) and that `app/dist` has
been built; without a build it prints `pnpm build` and exits instead of
building behind your back. Then it spawns Electron, and the main process
(`main/main.cjs`) owns everything else:

- **The main process owns the daemon child.** It spawns
  `node packages/fit-trace-cli/src/cli.ts daemon --port 0` (plus
  `--data` when `FIT_TRACE_DATA_DIR` is set), reads the listening URL
  from the daemon's stdout, and pipes daemon output through prefixed
  `[daemon]` lines. There are **zero custom IPC channels** — on purpose:
  the renderer is the ordinary web app, no bridge, no boot injection.
- **The window is a pure web client.** `BrowserWindow` runs with
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  and loads the daemon's loopback URL; the same web build keeps serving
  the browser/Vercel deployment.
- **Health polling and restart with backoff.** The main process
  health-checks `/api/v1/public-config` every 5s; two consecutive
  failures restart the daemon (exponential 1s/2s/4s, capped at 4s) while
  the window shows a retry page, then reloads the new URL. Three failed
  restarts surface an error dialog and quit.
- **Single instance, clean shutdown.** A second launch focuses the
  existing window instead of spawning a second daemon. Closing the last
  window (or quitting) stops the daemon with SIGTERM → 3s → SIGKILL, so
  the daemon's own shutdown semantics (`SIGINT`/`SIGTERM` above) are
  preserved.

Child-process plumbing lives in `main/daemonChild.cjs` — plain Node, no
electron import — and is covered by `tests/desktopDaemonChild.test.ts`;
`tests/desktopPackageIsolation.test.ts` guards the dependency boundary.

Electron is a devDependency of `packages/fit-trace-desktop` alone;
pnpm 10 does not run unapproved postinstall scripts, so a plain root
`pnpm install` does **not** download the ~100MB electron binary (CI stays
lean) — the first `pnpm desktop:dev` prepares it automatically.

### Unsigned internal builds (`pnpm desktop:package`)

The shell can also be packaged as an app. **These are unsigned internal
builds**: no code signing, no notarization, no auto-update, no publisher.
Do not describe or hand them out as signed or shippable installers. The
decision and its consequences are recorded in
[`adr/0006-desktop-packaging.md`](adr/0006-desktop-packaging.md).

```sh
pnpm build             # builds app/dist (the web shell the daemon serves)
pnpm desktop:build     # daemon bundle + runtime check + staged resources
pnpm desktop:package   # electron-builder for THIS host, unsigned
```

`desktop:build` runs three stages inside the package, each also runnable
on its own with `pnpm --filter @agent-fit-trace/desktop run <stage>`:

| stage | what it produces |
| --- | --- |
| `build:daemon` | `staging/daemon.mjs` — esbuild bundle of `packages/fit-trace-cli/src/cli.ts` |
| `prepare:runtime` | downloads Electron if missing, then **proves** it can run `node:sqlite` + WAL |
| `build:runtime` | `staging/app-dist/` — a copy of `app/dist` |

`build` also runs `pnpm build` for you **only when** `app/dist/index.html`
is missing. Unlike `desktop:dev` (which refuses and prints `pnpm build`), a
command named `build` is expected to produce its inputs; an existing
`app/dist` is never rebuilt behind your back.

Artifacts land in `packages/fit-trace-desktop/release/` (gitignored):
macOS dmg + zip, Windows NSIS installer + portable, Linux AppImage.
Builds are host-native — no cross-compilation. `pnpm --filter
@agent-fit-trace/desktop run package:dir` produces just the unpacked app,
which is the fast way to check the packaged layout.

**How the packaged app runs the daemon (strategy A, no bundled Node).**
The app's *own* Electron binary is re-entered as Node, so nothing extra
ships or needs patching:

```text
ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/fit-trace \
  <app>/Contents/Resources/daemon.mjs daemon --port 0 --dist <app>/Contents/Resources/app-dist
```

`main/paths.cjs` resolves that layout from `app.isPackaged` and is the only
place that knows the difference; dev keeps spawning `node` on
`packages/fit-trace-cli/src/cli.ts` with the daemon's own default
`app/dist`. The daemon bundle and staged shell ship as electron-builder
`extraResources`, and `--dist` is passed explicitly because the daemon's
own default is `import.meta.url`-relative — inside a bundle that resolves
against the bundle, not a repo root.

This depends on the app runtime exposing `node:sqlite` (Node >= 24;
Electron 45 bundles Node 24.22). `prepare:runtime` verifies it against the
exact binary that will ship — including a file-backed
`PRAGMA journal_mode = WAL`, since WAL is impossible in memory — and fails
the build (non-zero) with an actionable message if it breaks. A pinned
Node extraResource is the documented fallback in the ADR; it is not built
today.

**What a packaged build cannot do**

- **Coaching is unavailable.** The pi extension is deliberately not
  shipped: the daemon resolves it from `import.meta.url` and
  `packages/fit-trace-cli` exposes no `--extension` override, and the
  extension imports `@agent-fit-trace/{core,api-contracts,store}` plus the
  pi SDK, none of which resolve inside a packaged app. Copying the file in
  would look like working coaching and fail at run time. Packaged runs
  report it out loud ("pi CLI not found on PATH — workout tracking works;
  coaching runs report unconfigured until pi is installed") and a coaching
  run fails as `PI_UNAVAILABLE`. Workout tracking, the app shell, and the
  whole `/api/v1` data plane are unaffected.
- **The OS will warn on first launch.** macOS Gatekeeper blocks an
  unsigned app until the user right-clicks → Open (or clears quarantine);
  Windows SmartScreen shows "unrecognized app". This is inherent to the
  unsigned scope, not a bug to file.
- **No auto-update.** Every build is a fresh manual install; there is no
  channel and no update metadata (`dmg.writeUpdateInfo` is off).
- **Windows and Linux artifacts are built by CI only** and have not been
  launched by anyone; macOS/arm64 is the verified configuration.

Two packaging facts that will bite the next person:

- electron-builder's default Electron cache is
  `~/Library/Caches/electron`, which fails with `EPERM: mkdir …` on a
  sandboxed/restricted-home build. `scripts/package.cjs` therefore passes
  `--config.electronDist <installed electron>/dist`, reusing the Electron
  pnpm already installed — which also guarantees the packaged runtime is
  exactly the one `prepare:runtime` verified. Pass the `dist` **directory**
  (the one containing `Electron.app`/`electron.exe`); passing the binary's
  own directory yields the opaque error `corrupted Electron dist`.
- `ELECTRON_RUN_AS_NODE=1` is applied to a **copy** of the child
  environment, never to the shell's own `process.env` — a global flag makes
  the main process itself behave as Node and refuse to open a window.
  (Some tooling exports it session-wide; unset it when launching the app
  manually.)

## Relationships to #39 and #40

- **#39 (app-side guest mode): implemented.** The app's strict public-config
  parsing accepts the daemon payload and enters guest-local on
  `daemon: true` + `auth_configured: false`: it boots signed-in as the
  stable local guest, sends the fixed guest bearer on every `/api/v1`
  request, gates cloud surfaces off for guests, and keeps the normal login
  gate (plus the advertised guest path) when a Supabase project is
  configured (`auth_configured: true`). No build variables are involved —
  the surface is negotiated from this endpoint at boot.
- **#40 (MCP/pi followers): implemented.** `identity.json` names the active
  principal the daemon serves; `@agent-fit-trace/store`'s
  `resolveActiveStore`/`principalDbPath` read the same file and db layout, and
  both followers — the MCP server (`docs/mcp.md`, Storage) and the pi
  extension's normal mode — now resolve and open that database by default
  (JSON files remain selectable as a one-release escape hatch). Since the
  daemon records `guest` at startup, all local surfaces share `guest.db`
  today; a principal switch propagates to newly launched followers only once
  the daemon starts recording a switched principal into `identity.json`.

## Limitations (current slice)

- Guest login upgrading, per-principal switching through the daemon, and
  cross-process principal negotiation are not implemented; #40 delivered the
  follower side only (MCP/pi read `identity.json`), not a switch writer.
- The daemon registers only the local pi coaching backend; the launcher's
  experimental Codex/OpenCode gates are not wired here.
- Cloud coaching stays unqualified for every principal (no trusted
  identity/quota/provider is configured locally).
- `start` still owns the documented same-origin proxy contract; the two
  commands do not share a journal or a port, and running both at once is
  supported only on different ports (each scans forward independently).
