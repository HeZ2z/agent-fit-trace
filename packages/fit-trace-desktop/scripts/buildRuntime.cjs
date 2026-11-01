"use strict";

/**
 * `build:runtime` — stage everything the packaged app ships as resources.
 *
 *   1. require the daemon bundle (`build:daemon`'s output) to exist — a
 *      packaged app with no daemon is a window that never loads, so this fails
 *      early rather than at launch;
 *   2. stage `app/dist` → `staging/app-dist/` because the web shell is served
 *      by the DAEMON, not loaded from the asar: `main/paths.cjs` passes it as
 *      `--dist`, so the daemon's own `import.meta.url`-relative default (which
 *      points at the bundle, not at a repo root) never decides where the shell
 *      lives.
 *
 * COACHING IS NOT SHIPPED, ON PURPOSE. This is the honest state, not an
 * oversight:
 *
 *   - The daemon resolves its pi extension from `import.meta.url`
 *     (`packages/fit-trace-cli/src/daemonServer.ts` `defaultExtensionPath()`),
 *     i.e. `<bundleDir>/../../../.pi/extensions/fit-trace/index.ts`. In a
 *     packaged app that lands OUTSIDE the app bundle (next to the .app /
 *     above `resources/`) and is not writable or meaningful.
 *   - `packages/fit-trace-cli` exposes no `--extension` override, and that
 *     package is outside this change's scope — so a packaged build cannot
 *     point the daemon at a shipped copy.
 *   - Copying `.pi/extensions/fit-trace/index.ts` in as data would NOT fix it
 *     anyway: the extension imports `@agent-fit-trace/{core,api-contracts,store}`
 *     and the pi SDK, none of which exist inside the packaged app. Shipping it
 *     would look like working coaching and fail at run time — worse than not
 *     shipping it.
 *
 * So a packaged build reports coaching as unavailable, which the daemon
 * already does out loud: `cli.ts` probes `pi --version` and prints "pi CLI not
 * found on PATH — workout tracking works; coaching runs report unconfigured
 * until pi is installed", and a launched coaching run fails as
 * `PI_UNAVAILABLE` instead of hanging. Workout tracking, the app shell, and
 * the whole `/api/v1` data plane are unaffected. See docs/local-daemon.md
 * ("Desktop shell") and docs/adr/0006.
 *
 * Nothing here builds the app shell: that is `pnpm build` at the repo root (a
 * full Vite build must not be hidden inside a desktop command — same
 * reasoning as `scripts/dev.cjs`).
 *
 * Run from the package: `node scripts/buildRuntime.cjs`.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  APP_DIST,
  PACKAGED_DAEMON_FILE,
  STAGED_DAEMON,
  STAGED_DIST,
  STAGING_DIR,
  appDistReady,
  copyDirSync,
  fail,
} = require("./buildSupport.cjs");

const SCRIPT = "build:runtime";

if (!fs.existsSync(STAGED_DAEMON)) {
  fail(
    SCRIPT,
    "staging/daemon.mjs is missing — run build:daemon first " +
      "(pnpm --filter @agent-fit-trace/desktop run build:daemon).",
  );
}
if (!appDistReady(APP_DIST)) {
  fail(
    SCRIPT,
    `the app shell is not built: ${APP_DIST}/index.html is missing.\n` +
      "Build it first (deliberately not automatic — it is a full Vite build):\n\n" +
      "    pnpm build\n\n" +
      "then rerun pnpm --filter @agent-fit-trace/desktop run build:runtime.",
  );
}

copyDirSync(APP_DIST, STAGED_DIST);
const assetsDir = path.join(STAGED_DIST, "assets");
const assetCount = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).length : 0;
console.log(`[desktop:${SCRIPT}] staged app shell → ${STAGED_DIST} (${assetCount} asset(s))`);

// Record exactly what the package contains so a release log (or a bug report)
// states the coaching posture without unpacking the artifact.
fs.writeFileSync(
  path.join(STAGING_DIR, "resources.json"),
  `${JSON.stringify(
    {
      daemon: PACKAGED_DAEMON_FILE,
      appDist: "app-dist",
      piExtension: null,
      coachingIncluded: false,
      coachingNote:
        "Packaged builds do not ship the pi extension: the daemon resolves it from import.meta.url " +
        "and has no --extension override, so it would not resolve inside the app. Coaching runs " +
        "report unavailable (PI_UNAVAILABLE); workout tracking and the app shell are unaffected.",
    },
    null,
    2,
  )}\n`,
);

console.log(
  `[desktop:${SCRIPT}] ok — daemon + app shell staged ` +
    "(coaching not shipped: reported unavailable at run time)",
);
