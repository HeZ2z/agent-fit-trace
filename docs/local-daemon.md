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

- **Coaching needs the user's own `pi` CLI.** The extension *is* shipped
  (`staging/pi-extension.mjs`, bundled by `build:extension`, passed to the
  daemon as `--extension`), but pi itself is not: a coached run executes
  `pi --mode rpc -e <resources>/pi-extension.mjs`, so it only works where pi is
  installed and on `PATH`. Missing CLI and missing extension produce
  **different** reasons — `cli-not-installed` versus a message naming the
  extension path — because telling someone to install a CLI they already have
  is the wrong fix. Availability is probed by file existence, which cannot
  prove the bundle *loads*: a present-but-broken extension still fails at run
  time as `EXTENSION_ERROR`. Workout tracking, the app shell, and the whole
  `/api/v1` data plane are unaffected either way.
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
- **All three local backends are registered, and "installed" is not the same as
  "usable".** The daemon reports `local-pi`, `local-codex` and `local-opencode`,
  each with its own reason when unusable.
  - **Codex** is admitted when the installed app-server exposes the
    `item/tool/call` flow, which is how the two domain tools are served. Per
    ADR 0007 this runs under a **read-only sandbox**: writes and network are
    denied, but the model can still read files the OS account can read and can
    echo what it finds into the transcript. Discovery reports
    `builtinIsolationVerified: false` so this weaker guarantee stays visible.
  - **OpenCode** stays unavailable. It demands positive evidence that the
    generated wildcard-deny config excludes the built-in inventory, and that
    evidence comes from a verifier production has not implemented — missing
    work, not an impossible requirement.
- **Probing never blocks startup.** The listener binds first; Codex/OpenCode are
  probed afterwards and the result is published by swapping the runtime
  registry, so discovery updates without a restart. Until a probe lands, those
  backends report "not probed yet" rather than "not installed" — claiming
  absence would send a user to install something they already have. A probe that
  hangs is bounded (`LOCAL_CLI_PROBE_TIMEOUT_MS`) and cannot delay the data
  plane; `close()` aborts the probe and waits only a short grace period.
- **Detection and execution share one resolved executable.** Each CLI command is
  resolved to an absolute path once, and that path is what both the capability
  probe and the coached run use. A probe that verified one binary while the run
  spawned another would advertise a capability the run does not have.
- **GUI-launched pi discovery** also searches known user toolchain directories
  after absolute inherited PATH entries, including versioned nvm installations
  in descending numeric order and Homebrew. Rescanning probes pi again. The
  reported invocation path is retained even when it is a symlink, and the
  selected executable's target and file metadata are checked again before
  launch; a change fails the run and requires a rescan. This check cannot close
  the race between the final check and process creation. Finding a Windows
  `.cmd` shim does not prove it can be spawned without a shell.
- **Discovery carries what a settings page needs** (issue #69 consumes this):
  per backend, `available`, `version`, `unavailableReason` and the additive
  optional `executablePath` — distinct fields, not a bare boolean. The path is
  the executable that was detected AND will be spawned, so the UI can never
  show one binary and run another. `executablePath` is additive and
  `discoveryVersion` stays `1`: a client that ignores it parses the payload
  exactly as before.
- `--runtime ID` names the DEFAULT backend for a new run (`pi`, `codex`,
  `opencode`). It does not filter discovery: every installed CLI is still
  reported. A cloud runtime is refused because the daemon has no cloud execution
  path yet.
- Cloud coaching stays unqualified for every principal (no trusted
  identity/quota/provider is configured locally).
- `start` still owns the documented same-origin proxy contract; the two
  commands do not share a journal or a port, and running both at once is
  supported only on different ports (each scans forward independently).

A saved local backend preference takes precedence over `--runtime`; an explicit
`--runtime` takes precedence over automatic selection. Without either, discovery
chooses the first available backend in the order pi, Codex, OpenCode, or leaves
the selection empty. Discovery reports the server choice's `defaultBackendSource`
as `runtime` or `automatic`; the app records a saved or manually chosen backend
as `preference`. The optional source field is absent for older servers and is
ignored by older clients.

### Desktop account and origin

The desktop shell stores its loopback origin in `desktop-origin.json` under
Electron's per-user `userData` directory. It selects a port on first launch and
uses that same port after restart and on later launches. If the port is occupied,
close the process using it and relaunch; the shell does not select a different
origin or connect to the occupant. Removing this file resets the origin, but
sessions stored by the renderer at the previous origin will no longer be visible.
Back up user data before taking that recovery step.

When desktop sign-in is configured, the local guest and each signed-in account
use separate local databases. Signing in does not move guest records, upload them,
or enable sync or cloud coaching. Guest import remains a separate future action.
The daemon's `identity.json` currently identifies guest to newly launched MCP/pi
followers; signing in through the desktop does not switch their active store.
Desktop session restoration depends on Electron preserving renderer storage as
well as the saved origin. Live sign-in, restart restoration, and sign-out were
checked against the intended project in a macOS arm64 package. Live token
refresh, two-account switching, and Windows/Linux packaged runs remain untested.

### Foreground workout sync (operator opt-in)

Workout sync is disabled unless the daemon receives a fixed HTTPS
`FIT_TRACE_API_BASE_URL` ending in the hosted API base (for example,
`https://example.test/api/v1`) and `FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH=1`,
and `FIT_TRACE_SYNC_PUBLIC_KEYS`, a JSON array of one or two operator-approved
public P-256 JWKs, in addition to its Supabase URL and publishable key. The
project must also have the reviewed session-ownership RPC migration deployed.
The trust flag is an
operator attestation that this Supabase project issues `session_id` only for
its own Auth sessions: custom access-token hooks, imported signing keys and
third-party signers must not be able to forge that claim. Do not enable the
setting if this cannot be established. A renderer cannot enable this setting.
Each sync authentication locally verifies the ES256 signature against an
approved key, verifies the bearer through Auth, and asks the RPC whether that
session belongs to the signed-in account. Unavailable checks fail closed.
Previously sent remote requests may have committed before a session is revoked.

In desktop coaching settings, connect sync to see its destination, then
explicitly allow account-wide workout sync and choose **Sync now**. Each run
uses the current access token in memory and transfers workout records only.
There is no background sync or delete propagation. Identical IDs are
idempotent; different records with the same ID are reported as conflicts and
neither original is overwritten. Guest workouts remain in the guest store.
The guest import preview shows copies, identical records and conflicts; the
explicit import also consents to uploading this account's workouts on a later
manual sync. It preserves guest originals and skips conflicting records.

A confirmed daemon sign-out or identity transition fences the old session.
If sign-out or a transition cannot be confirmed, retry while connected. A
request already sent may have reached the hosted service before cancellation;
retrying reconciles by record ID. A completed run does not prove a single
consistent snapshot of the hosted history. The daemon persists session
revocations across restarts. If it reports that recovery requires administrator
help, do not remove its lock or edit its databases while it is running: a
crash between the old-session revocation and the new-session commit is kept
blocked rather than silently restoring an old session. Automatic recovery from
that intermediate state is not available.

Signing in to the desktop or syncing an account does not switch MCP or pi to
that account. The daemon currently records guest as the default active
identity on startup, so default followers use the guest store. Already-running
MCP and pi processes keep the store they opened. Explicit `--principal`,
`--store`, `FIT_TRACE_PRINCIPAL`, or `PI_FIT_TRACE_STORE` overrides select
their own store. Coordinating confirmed account switches and already-running
followers remains future work; restarting alone does not select the account.
