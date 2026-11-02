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
 *   - Copying `.pi/extensions/fit-trace/index.ts` in as *data* would NOT fix
 *     that anyway: the extension imports
 *     `@agent-fit-trace/{core,api-contracts,store}` and the pi SDK, none of
 *     which resolve inside the packaged app.
 *
 * Both halves are now addressed elsewhere: `build:extension` bundles the
 * extension into `staging/pi-extension.mjs`, electron-builder ships it as an
 * extraResource, and `main/paths.cjs` passes it as `--extension` (see #67).
 * The daemon decides availability from that file's existence, so a build that
 * somehow lost it reports coaching unavailable with the real cause instead of
 * advertising a coach that cannot start.
 *
 * What is still absent is the `pi` CLI itself: a coached run executes
 * `pi --mode rpc -e <resources>/pi-extension.mjs`, so coaching works only where
 * the user has pi installed. Workout tracking, the app shell, and the whole
 * `/api/v1` data plane are unaffected either way. See docs/local-daemon.md
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
      piExtension: "pi-extension.mjs",
      coachingIncluded: true,
      coachingNote:
        "The pi extension ships as pi-extension.mjs and is passed to the daemon as --extension. " +
        "Coaching still requires the user's own pi CLI on PATH; when pi is missing the daemon " +
        "reports cli-not-installed, and when the extension file is missing it reports the real " +
        "cause instead of advertising coaching. Workout tracking and the app shell are unaffected.",
    },
    null,
    2,
  )}\n`,
);

console.log(
  `[desktop:${SCRIPT}] ok — daemon + app shell staged ` +
    "(coaching needs the user's own pi CLI; the extension itself ships)",
);
