# ADR 0006: Packageable desktop app for unsigned internal builds

- **Status:** Accepted and implemented for macOS/arm64 end-to-end on a
  maintainer machine. The Windows and Linux targets are configured and
  exercised only by CI (`release-ci`); they have **not** been run locally, and
  nothing is signed, notarized, or auto-updated. This ADR records a deliberately
  narrow distribution posture, not a shippable release.
- **Date:** 2026-11-01
- **Scope:** `packages/fit-trace-desktop`. Turns the dev-only Electron shell
  (`docs/local-daemon.md`, "Desktop shell") into an app that can be built into
  unsigned installers on all three desktop platforms.
- **Related:** [`0005-local-store-sqlite.md`](0005-local-store-sqlite.md) (the
  `node:sqlite` data plane this decision has to carry into a packaged app),
  [`../local-daemon.md`](../local-daemon.md), issue #41 (the shell itself).

## Context

`packages/fit-trace-desktop` was dev-only by explicit decision: a thin Electron
carrier that spawns `node packages/fit-trace-cli/src/cli.ts daemon` from the
checkout, loads the daemon's loopback URL, and owns the daemon's lifecycle.
`tests/desktopPackageIsolation.test.ts` guarded that shape — `private: true`,
one `dev` script, no packaging config.

Three properties of that shape make a packaged app impossible, and each needs a
decision rather than a workaround:

1. **Repo-layout paths.** `main/main.cjs` derived the CLI path from
   `path.join(__dirname, "..", "..", "..")`. Inside an `app.asar` that is not a
   repo root. Likewise the daemon resolves `app/dist` and its pi extension from
   `import.meta.url` (`packages/fit-trace-cli/src/daemonServer.ts`
   `defaultDistDir()` / `defaultExtensionPath()`), which in a bundle points at
   the bundle.
2. **No runtime.** The shell spawned `node` from `PATH` (or
   `FIT_TRACE_DESKTOP_NODE`). End users do not have Node 24 installed, and the
   daemon's data plane needs `node:sqlite` (ADR 0005), so the app must carry a
   runtime that provides it.
3. **Nothing to execute.** The daemon is a TypeScript ESM graph over
   `server/*` plus the `@agent-fit-trace/*` workspace packages. It cannot run
   from source inside an asar, and `node_modules` cannot be shipped sensibly
   because the workspace packages are linked.

The user-approved decision for this round: package **unsigned internal builds**
for macOS, Windows, and Linux. No code signing, no notarization, no
auto-update. The app must not be described as a signed or shippable installer.

An earlier experiment (recorded on the issue) established that esbuild can
bundle the daemon: `--bundle --platform=node --format=esm --target=node24
--external:@earendil-works/*` produces a ~476 KB self-contained `.mjs` that
boots and serves. Notably `--packages=external` does **not** work — the
workspace packages must be inlined.

## Decision

### 1. The daemon ships as one esbuild bundle, not as source

`scripts/buildDaemon.cjs` bundles `packages/fit-trace-cli/src/cli.ts` into
`staging/daemon.mjs` (ESM, `--platform=node`, `--target=node24`,
`--external:@earendil-works/*`). The bundle is the only generated artifact in
this package; the shell stays plain `.cjs` with no build chain.

The external list is a **pin against drift, not a present requirement**: the
current daemon graph contains zero bare `@earendil-works/*` imports. The pi SDK
is reached only by `server/cloud/*` (the worker entrypoint), which the daemon
does not import; the local coaching path talks to the `pi` CLI over RPC. So the
bundle is fully self-contained today. `inspectDaemonBundle()` re-checks this on
every build and fails if the bundle gains a bare import that is not on the
external list — the exact failure mode (a workspace package left external)
type-checks fine and then throws `ERR_MODULE_NOT_FOUND` in the packaged app.

`app/dist` is **not** bundled: it is a static shell read from disk, so it ships
as an extraResource (`staging/app-dist`) and the shell passes it as `--dist`.
That keeps one copy of the web build and lets it be replaced without rebundling
the daemon.

### 2. Runtime strategy: the app's own Electron binary as Node (no pinned Node)

**Chosen: strategy A — `ELECTRON_RUN_AS_NODE=1` + `process.execPath` + the
bundled `daemon.mjs`.** Zero extra runtime to download, patch, or license; one
runtime per app; the binary the user launched *is* the runtime.

The risk is that Electron's bundled Node might not expose `node:sqlite`. It
does. Verified on this machine with Electron 45.0.0:

```
$ ELECTRON_RUN_AS_NODE=1 Electron.app/Contents/MacOS/Electron \
    -p "process.versions.node + ' electron=' + process.versions.electron"
24.22.0 electron=45.0.0

$ ELECTRON_RUN_AS_NODE=1 Electron.app/Contents/MacOS/Electron -e \
    "const s=require('node:sqlite');const db=new s.DatabaseSync('/tmp/probe.db');\
     db.exec('PRAGMA busy_timeout=5000');\
     const m=db.prepare('PRAGMA journal_mode=WAL').get();\
     db.exec('CREATE TABLE t(a)');db.prepare('INSERT INTO t VALUES (?)').run(1);\
     console.log(JSON.stringify(db.prepare('SELECT * FROM t').all()), Object.values(m)[0])"
[{"a":1}] wal
```

`scripts/prepareRuntime.cjs` re-runs this probe at build time against the exact
binary that will ship, and fails the build if a future Electron regresses it.
One detail matters: the probe uses a **file-backed** database, not `:memory:`
— `PRAGMA journal_mode = WAL` is impossible in memory (SQLite answers
`memory`), so an in-memory probe reports a false failure. The first version of
this script made exactly that mistake and was corrected by its own check.

**Strategy B (ship a pinned Node 24 as an extraResource) was rejected**, not
because it is wrong but because it is strictly more machinery: a second ~50 MB
binary per platform, a second CVE surface and update cadence, a second thing
that can be missing at runtime — for a capability the app already carries. It
remains the documented fallback if a future Electron ever drops `node:sqlite`;
the build probe makes that regression loud instead of silent.

### 3. Packaged vs. dev path resolution is one pure, tested module

`main/paths.cjs` resolves the whole launch plan from `app.isPackaged`:

| | dev | packaged |
|---|---|---|
| node | `$FIT_TRACE_DESKTOP_NODE` or `node` | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` |
| daemon | `<repo>/packages/fit-trace-cli/src/cli.ts` | `<resources>/daemon.mjs` |
| dist | *(unset — daemon resolves its own `<repo>/app/dist`)* | `<resources>/app-dist` (explicit `--dist`) |
| env | caller's, copied untouched | caller's + `ELECTRON_RUN_AS_NODE=1` |

Dev behaviour is byte-for-byte unchanged, including the deliberate omission of
`--dist` (so the daemon keeps choosing its own default). The env is a copy, not
a mutation: setting `ELECTRON_RUN_AS_NODE` on `process.env` would make the
shell itself refuse to start as a GUI app.

`daemonChild.cjs` gained one additive option (`distDir` → `--dist`). It stays
electron-free and its existing tests stay green.

### 4. Coaching is **not** shipped, and says so

The daemon resolves its pi extension from `import.meta.url`
(`defaultExtensionPath()`), and `packages/fit-trace-cli` exposes no
`--extension` override. Shipping `.pi/extensions/fit-trace/index.ts` as data
would **not** work anyway: the extension imports
`@agent-fit-trace/{core,api-contracts,store}` and the pi SDK, none of which
exist inside the packaged app. Shipping it would look like working coaching and
fail at run time — worse than not shipping it.

So packaged builds report coaching unavailable, which the daemon already does
honestly: `cli.ts` prints "pi CLI not found on PATH — workout tracking works;
coaching runs report unconfigured until pi is installed", and a launched
coaching run fails as `PI_UNAVAILABLE` rather than hanging. Workout tracking,
the app shell, and the whole `/api/v1` data plane are unaffected. The staging
step records this posture in `staging/resources.json` and the docs state it;
`server/vercel.ts` and `SKILL.md` are not in the daemon bundle graph, so there
is no half-wired skill path in the packaged app.

**What packaged coaching would need (future design, not attempted here).**
The blocker is structural, not a missing file. Three things must all be true,
and each one is a separate change:

1. **An extension-path override in `packages/fit-trace-cli`.** The daemon
   needs a `--extension <path>` flag (or a documented env override) instead of
   deriving `defaultExtensionPath()` from `import.meta.url`. That package is
   outside this change's scope.
2. **A bundled or self-contained extension.** `.pi/extensions/fit-trace/index.ts`
   is TypeScript importing `@agent-fit-trace/{core,api-contracts,store}` and the
   pi SDK. Shipping it as source inside the app does not run — the pi host
   would have to resolve those specifiers. The realistic options are (a) bundle
   the extension with esbuild too, externalizing only the pi SDK and relying on
   the user's `pi` install for that, or (b) keep coaching out of the packaged
   app entirely and point users at `pnpm daemon` + their own pi.
3. **A `pi` runtime on the user's machine.** The coaching path spawns the
   user's `pi` CLI over RPC; the app does not and should not bundle a model
   runtime or credentials. So even with (1) and (2), packaged coaching would be
   "works if pi is installed", exactly like the source-run daemon today.

Until (1) and (2) land, shipping the extension file would convert a *clear*
"coaching unavailable" into an *unclear* run-time failure, which is why the
exclusion is deliberate rather than deferred.

### 5. Unsigned distribution, stated plainly

`scripts/package.cjs` runs electron-builder with `CSC_IDENTITY_AUTO_DISCOVERY=false`
and the config pins `mac.identity: null` and `notarize: false`, so a signing
identity in a maintainer's keychain is never picked up by accident. There is no
`publish:` block and no updater dependency: **no auto-update channel exists**.

The package **reuses the already-installed Electron** via
`--config.electronDist` rather than letting electron-builder download its own
copy. This is both a sandboxing fix and a correctness fix.

**Why this workaround exists (it will bite the next person).**
electron-builder's default Electron cache is `~/Library/Caches/electron`
(via `@electron/get` + `env-paths`), and that path is **not configurable
through the documented env vars** in this version — `ELECTRON_CACHE` does not
reach it, because app-builder-lib calls `@electron/get` with its own
`cacheRoot`. On any build where `$HOME` is unwritable (sandboxed CI runner,
locked-down container, this repo's own agent sandbox) the build dies with:

```text
EPERM: operation not permitted, mkdir '/Users/<user>/Library/Caches/electron/<sha>'
```

`--config.electronDist <installed electron>/dist` sidesteps the download
entirely and guarantees the packaged runtime is exactly the one
`prepare:runtime` verified. **Pass the directory that CONTAINS the platform
payload** — `<electron>/dist` (holding `Electron.app/`, `electron.exe`, or
`electron`). Passing the executable's own directory instead produces the
opaque `corrupted Electron dist` error, which names neither the cause nor the
fix.

**`ELECTRON_RUN_AS_NODE=1` is set on a COPY of the environment, for the child
only.** `paths.cjs` returns `{ ...env, ELECTRON_RUN_AS_NODE: "1" }` and
`main.cjs` never touches `process.env`. This is load-bearing: a global flag
makes the Electron MAIN process itself behave as Node, so the app exits
instead of opening a window. Tooling that exports it session-wide (this
repo's agent harness does) will therefore refuse to launch the app until the
variable is unset — `tests/desktopPaths.test.ts` has a case pinning that the
caller's env object is never mutated.

Artifacts land in `packages/fit-trace-desktop/release/` (gitignored): macOS
dmg + zip, Windows NSIS + portable, Linux AppImage.

### 6. Rejected alternatives

- **Run the daemon from source in the packaged app** — needs Node plus the
  workspace `node_modules`; the pnpm link farm does not survive an asar.
- **`--packages=external` for the bundle** — disproved by experiment: the
  workspace packages are unresolvable from the packaged app.
- **Embed the web shell in the asar and serve it from `file://`** — the shell is
  served by the daemon over HTTP by design (zero custom IPC, one web build for
  browser/Vercel/desktop). Moving it would fork that contract.
- **Sign "just the mac build"** — needs an Apple Developer identity and, for a
  non-notarized app, does not actually remove the Gatekeeper prompt; partial
  signing invites the false claim this ADR exists to prevent.

## Evidence

Recorded from this machine (`darwin/arm64`, Node v24.22.1, Electron 45.0.0,
electron-builder 26.18.0):

- `scripts/buildDaemon.cjs` → `ok — staging/daemon.mjs (476.2 KB)`.
- `scripts/prepareRuntime.cjs` → `ok — electron 45.0.0 / node 24.22.0,
  node:sqlite + WAL verified (strategy A: no separate node binary)`.
- `scripts/package.cjs --dir` → `skipped macOS code signing reason=identity
  explicitly is set to null`, then `ok — unpacked app under release`.
- Packaged daemon boot from the app's own resources:
  `listening at http://127.0.0.1:<port>`, `GET /api/v1/public-config` →
  `{"data":{"daemon":true,"auth_configured":false}}`, `GET /` → 200 (real
  `index.html`), `GET /api/v1/workouts` → 401 without a bearer / 200 with the
  guest bearer.
- Full packaged GUI launch of `release/mac-arm64/fit-trace.app`: the log shows
  `mode=packaged` with the resolved resources paths, the daemon announces its
  URL, and the app creates `guest.db` + `guest.db-wal` + `identity.json` (so
  `node:sqlite` really ran in the packaged child). A CDP query against the
  renderer returned a page titled `agent-fit-trace` at the daemon URL — the
  window genuinely loaded the shell.

Unit coverage (root `node:test` suite): `tests/desktopPaths.test.ts` (both
launch layouts, env isolation, version gate),
`tests/desktopBuildScripts.test.ts` (layout constants, esbuild args, bundle
self-containment, staging copy, input gate, manifest script set),
`tests/desktopPackageIsolation.test.ts` (electron/electron-builder confinement,
unsigned posture, no committed signing material), plus the pre-existing
`tests/desktopDaemonChild.test.ts`.

## Consequences

**Positive**

- The desktop app can be built and distributed internally on all three
  platforms from one command per stage, with no new runtime dependency.
- The packaged app runs the *same* daemon code path as `pnpm daemon`; the only
  differences are the entry file and where the shell lives, both stated in one
  tested module.
- A regression in the runtime (`node:sqlite` gone) or the bundle (unplanned
  bare import) fails the BUILD, not the user's first launch.

**Negative / open work**

- **Unsigned builds trigger OS warnings.** macOS Gatekeeper blocks the first
  launch until the user right-clicks → Open (or clears quarantine); Windows
  SmartScreen shows "unrecognized app". This is inherent to the approved scope
  and must be stated wherever the artifacts are handed out.
- **No auto-update.** Every build is a fresh manual install; there is no
  channel, no metadata, and `dmg.writeUpdateInfo` is off.
- **Windows and Linux are unverified locally.** They are configured and built
  by CI only; no one has launched a Windows or Linux artifact.
- **Packaged coaching is unavailable** until `packages/fit-trace-cli` grows an
  extension-path override (or the extension is bundled), which is out of scope
  here. Tracked as follow-up, not hidden.
- **The daemon bundle can go stale** relative to `packages/fit-trace-cli`; the
  build always rebuilds it, but a checked-in artifact is not a thing — the
  bundle is gitignored and must be produced for every package run.
- macOS artifacts are host-native (no cross-build); a universal binary would
  need both arch payloads and has not been attempted.
