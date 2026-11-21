# Real-app acceptance checks

Two repeatable checks cover the two ways the product actually runs:

| Command | What it runs | When to use |
| --- | --- | --- |
| `pnpm verify:app` | Built `app/dist` served by a throwaway daemon, driven in system Chrome | App/UI, daemon, HTTP-client, runtime-mode, or storage changes |
| `pnpm verify:desktop` | The real unsigned guest-only macOS `.app`, driven over CDP | Desktop shell, packaging, daemon spawn/quit, persistence across restart |

Both keep screenshots, logs, and a machine-readable manifest under
`.fit-trace/verification/`. They are the repeatable counterpart to
`tests/e2e.test.ts`: the domain suite proves the core logic; these prove the
built surface still works end to end. They do not replace `pnpm test` or
`pnpm typecheck`.

## 1. Browser scenario (`pnpm verify:app`)

### What it proves

- `pnpm build` output is served by the daemon, not a dev server: `GET /`
  returns the shell and `/fit-trace-runtime.js` selects `mode: "http"`.
- The App negotiates the guest-local surface from
  `GET /api/v1/public-config` (`daemon: true`, `auth_configured: false`).
- Three workouts can be logged through the actual Log Workout form, saved as
  records, and still appear after a full page reload.
- The history rows are the exact records that were saved: the record ids from
  the summary URLs, the history links, and `GET /api/v1/analysis`
  `source_records` are the same set, with the submitted dates.
- The Analysis screen shows the deterministic metrics for those records
  (sessions, sets, reps, volume, average RPE, source-record count), read by
  `data-metric` key, and the Analysis API agrees with every number the UI
  displays.
- The critical clicks use real CDP pointer events after a visibility and
  hit-test check; the harness does not call `element.click()` for the exercise
  choice or the save button.
- Cleanup is confirmed: only the daemon and Chrome processes this run started
  are stopped, their exit is observed, the temporary workspace is deleted, and
  every required evidence file is hashed and re-read.

### Prerequisites and command

- Node >= 24 and the repository's pinned pnpm.
- Local Chrome/Chromium. No Playwright/Puppeteer download.
- A built App shell, built in the same workspace and task as the run.

```sh
pnpm build
pnpm verify:app
```

Options:

```text
--headed             show Chrome instead of running headless
--evidence <dir>     evidence directory (default .fit-trace/verification/<UTC>)
--keep-data          keep the temp daemon/Chrome data dir (default delete)
--chrome <path>      Chrome binary (default discovery order)
--timeout <ms>       per-wait and per-CDP-command timeout (default 30000)
--help               print usage
```

Chrome discovery: `FIT_TRACE_CHROME` → macOS app bundle →
`google-chrome`/`google-chrome-stable`/`chromium`/`chromium-browser` on `PATH`
→ common Windows paths. Safari and Firefox are not supported.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every step, assertion, cleanup check, and evidence check passed. |
| `1` | A step/assertion failed, cleanup was unconfirmed, required evidence is missing, or the manifest could not be written. |
| `2` | Precondition failed (`app/dist` missing or invalid arguments). Run `pnpm build`. |
| `3` | No Chrome found. **Skipped, not a pass.** |

### Isolation and evidence

Each run creates a fresh `mkdtemp` workspace with `data/` (the daemon's
`--data`) and `chrome-profile/`. The daemon binds `--port 0`; the harness reads
its own listening line. The child environment forces `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY`, and related guest/cloud/sync
overrides to empty strings, and removes `FIT_TRACE_DATA_DIR`, so an inherited
cloud configuration cannot silently switch the run to sign-in.

The harness never kills by port and never stops a process it did not spawn.
Without `--keep-data` the temporary workspace is removed; the evidence
directory is always kept.

Default evidence: `.fit-trace/verification/<UTC-timestamp>/`.

| File | Contents |
| --- | --- |
| `01-history-empty.png` | Empty history state before logging. |
| `02-log-form.png` | First workout filled in, before submit. |
| `03-summary.png` | Saved workout summary. |
| `04-history-persisted.png` | Three rows after a full reload. |
| `05-analysis.png` | Analysis metrics used for the assertions. |
| `daemon.log` | Full daemon stdout/stderr. |
| `chrome.log` | Chrome output (best-effort diagnostic). |
| `manifest.json` | Schema `2`: scenario, provenance, steps, assertions, evidence, cleanup. |
| `failure.png` | Present only when a step failed after the page session existed. |

The five screenshots and `daemon.log` are required for a pass; `chrome.log` is
best-effort. Every recorded evidence entry carries its byte length and SHA-256,
and the harness re-reads each file from disk before declaring a pass.

## 2. Packaged desktop scenario (`pnpm verify:desktop`)

### What it proves

- The real packaged `.app` starts its own daemon from bundled resources
  (`daemon.mjs`, `app-dist`, `pi-extension.mjs`) and opens a window on the
  daemon's loopback origin. It is not a dev server or a source-run daemon.
- A guest-only build serves `{daemon: true, auth_configured: false}` with no
  Supabase configuration.
- One workout can be logged through the real UI, and its record id is visible
  after a reload.
- Quitting the app stops its daemon: the app exit is observed and the daemon
  port refuses connections.
- Reopening with the same `FIT_TRACE_DATA_DIR` but a fresh Electron profile
  finds exactly the saved record (no duplication), and
  `GET /api/v1/analysis` reports `sessions: 1`, `total_sets: 1`,
  `total_reps: 5`, `volume_kg: 400`, `avg_rpe: 7`, with that record id as the
  only source.
- Cleanup is confirmed for both launches: the app process exits, each daemon
  port is released, and the temporary workspace is deleted.

### Prerequisites and command

- macOS on the host architecture (only macOS is implemented).
- Electron 45 available locally (already a devDependency; first use may run
  its `install.js`).
- A guest-only package built in the same workspace and task as the run.
  `desktop:build` copies an existing `app/dist`; it does not rebuild it.

```sh
FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm build
FIT_TRACE_DESKTOP_CHANNEL=guest-only pnpm desktop:build
pnpm --filter @agent-fit-trace/desktop run package:dir
pnpm verify:desktop
```

`package:dir` produces the unpacked app without spending time on dmg/zip:
`packages/fit-trace-desktop/release/mac-arm64/fit-trace.app`. Use a full
`pnpm desktop:package` only when the artifact itself is under review.

Options:

```text
--app <path>         .app bundle or executable (default: the release path above)
--headed             show the Electron window instead of --headless=new
--evidence <dir>     evidence directory (default .fit-trace/verification/<UTC>)
--keep-data          keep the temp HOME/data/profiles (default delete)
--timeout <ms>       per-wait and per-CDP-command timeout (default 30000)
--help               print usage
```

Exit codes: `0` pass; `1` scenario/cleanup/evidence failure; `2` precondition
(not macOS, app missing, invalid arguments). There is no `3`: a packaged run
does not depend on an external Chrome.

### Isolation

Each launch gets a fresh `mkdtemp` root with:

- `data/` — `FIT_TRACE_DATA_DIR` for the packaged daemon (shared across the
  reopen on purpose).
- `home/` — `HOME`, so Electron's app-data lookup cannot touch the real
  profile.
- `electron-a/`, `electron-b/` — `--user-data-dir` for each launch, which holds
  the Chromium profile, `DevToolsActivePort`, and the saved desktop origin.

A fresh `--user-data-dir` per launch avoids the single-instance lock and the
saved-port reuse (`--strict-port` allows one bind attempt). The reopen shares
only `data/`, which is what the persistence assertion is about.

The launch environment deletes all `SUPABASE_*`, `FIT_TRACE_API_BASE_URL`,
`FIT_TRACE_SYNC_*`, and `FIT_TRACE_CLOUD_API_BASE_URL` variables, so ambient
configuration cannot turn a guest-only package into a release/sign-in run.

The harness connects to the renderer with `--remote-debugging-port=0`, quits
with CDP `Browser.close` (the shell's `window-all-closed` → `before-quit` path
stops the daemon), and only escalates to SIGTERM/SIGKILL if the app does not
exit. It records the daemon pid before quit and verifies the port is released;
if the port is still open it stops that recorded pid and fails the run.

### Evidence

| File | Contents |
| --- | --- |
| `01-desktop-empty.png` | Empty history in the packaged app. |
| `02-desktop-log.png` | Filled workout form before submit. |
| `03-desktop-summary.png` | Saved summary. |
| `04-desktop-reload.png` | History after a reload in the first launch. |
| `05-desktop-reopened.png` | History after quitting and reopening with the same data dir. |
| `06-desktop-analysis.png` | Analysis after reopen. |
| `app.log` | Both packaged launches, including `mode=packaged` and daemon listen lines. |
| `manifest.json` | Schema `2`, with artifact, launches, steps, assertions, evidence, cleanup. |
| `failure.png` | Present only when a step failed after a page session existed. |

All six screenshots and `app.log` are required for a pass.

## Manifest and provenance

Both scenarios write schema `2`. The browser manifest has
`provenance.artifactSha256` over `app/dist`. The desktop manifest adds an
`artifact` object and uses the same digest for the `.app` tree:

```json
{
  "schema": 2,
  "scenarioId": "desktop-app-log-reopen",
  "outcome": "passed",
  "artifact": {
    "kind": "desktop-app",
    "path": ".../fit-trace.app",
    "sha256": "...",
    "fileCount": 269,
    "bytes": 265645406,
    "version": "0.1.0",
    "bundleId": "com.agentfittrace.desktop"
  },
  "provenance": {
    "testedSha": "<sha>",
    "branch": "main",
    "dirty": true,
    "dirtyFileCount": 16,
    "artifactSha256": "<same digest>",
    "nodeVersion": "v24.x",
    "chromeVersion": null,
    "platform": "darwin",
    "arch": "arm64"
  },
  "launches": [
    { "phase": "first", "baseUrl": "http://127.0.0.1:51133", "port": 51133,
      "daemonPid": 156, "exitConfirmed": true, "portReleased": true },
    { "phase": "reopen", "baseUrl": "http://127.0.0.1:51152", "port": 51152,
      "daemonPid": 228, "exitConfirmed": true, "portReleased": true }
  ],
  "cleanup": {
    "desktopApp": { "stopped": true, "exitConfirmed": true },
    "daemonPorts": [{ "port": 51133, "released": true },
                    { "port": 51152, "released": true }],
    "tempRoot": { "kept": false, "deleted": true }
  }
}
```

`testedSha` is `git rev-parse HEAD` at run time; `dirty`/`dirtyFileCount` come
from `git status --porcelain`. A dirty tree may pass, but the tested source is
then not exactly `testedSha`. `artifactSha256` is deterministic over the
relative paths and bytes of `app/dist` or the `.app` tree (symlinks contribute
`link:<target>`).

For review-grade evidence, start from the revision under review, build in that
same checkout, run the harness, and attach the manifest. Do not reuse an
evidence directory from another workspace or branch. CI does not produce this
evidence.

Every step has a stable `id`, every assertion has `<stepId>.<slug>` plus
`required: true`, and every evidence entry has `{path, bytes, sha256}`. A pass
without a manifest whose `outcome` is `passed` is not evidence.

## What these checks do not prove

- Hosted cloud coaching, Supabase sign-in/sync, or a live provider loop.
- Local coaching runs (pi, Codex, OpenCode) or MCP host integration. For coach
  behavior, use [prompt-eval.md](prompt-eval.md).
- Multi-user authorization and data isolation; both runs use the single guest
  principal.
- Desktop signing, notarization, Gatekeeper/quarantine behavior, auto-update,
  Windows/Linux launches, or release-channel sign-in.
- CI reproducibility: both checks need a local browser or GUI-capable macOS
  host and are not part of the CI job.

## CI and pull requests

Run `pnpm verify:app` for App/UI, daemon, HTTP-client, runtime-mode, or storage
changes, and `pnpm verify:desktop` for desktop shell, packaging, spawn/quit, or
restart-persistence changes. Attach the evidence directory to the PR, or state
why it was not run. See [CONTRIBUTING.md](../CONTRIBUTING.md) and
[`.github/pull_request_template.md`](../.github/pull_request_template.md).

When reviewing evidence, check the manifest before the screenshots:
`outcome: "passed"`, `provenance.dirty`/`testedSha` match the revision under
review, the artifact digest is from the build under review, record-id and
restart assertions pass, and cleanup is confirmed.

## Relationship to other checks

- `tests/e2e.test.ts` — deterministic import → history → analyze → draft plan
  over the shared core and store.
- `tests/daemonServer.test.ts` — daemon shell, public config, guest bearer,
  and API wiring without a browser.
- `pnpm verify:app` — built App in a real browser against a throwaway daemon.
- `pnpm verify:desktop` — the same surface through the packaged `.app`,
  including spawn, quit, and reopen persistence.
- [Prompt evaluation](prompt-eval.md) — manual, fixed-fixture coach behavior.

## Extending it

Add steps to the relevant harness rather than a parallel script, give each step
and assertion a stable id, and keep expected/actual values in the manifest.
Natural next additions are a coached conversation reconnect after a daemon
restart and a release-channel signed-in desktop run. Update this document and
bump the manifest schema when fields or semantics change.
