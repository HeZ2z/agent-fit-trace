"use strict";

/**
 * `build` — one command that produces a packageable desktop app.
 *
 *   pnpm --filter @agent-fit-trace/desktop run build
 *
 * Steps (each runs as its own child process so a failure names the stage):
 *   1. `build:daemon`      esbuild → staging/daemon.mjs (self-containment checked)
 *   2. `build:extension`   esbuild → staging/pi-extension.mjs (the pi extension a
 *                          coached run loads; external list differs from the daemon)
 *   3. `prepare:runtime`   download Electron if absent, then PROVE the app's own
 *                          runtime can open `node:sqlite` (strategy A)
 *   4. the app shell       `pnpm build` at the repo root, ONLY when
 *                          `app/dist/index.html` is missing
 *   5. `build:runtime`     stage app-dist → staging/app-dist
 *
 * Step 3 is the one judgement call. Unlike `desktop:dev` (interactive: it
 * refuses to build behind your back and prints `pnpm build`), a command whose
 * name is literally `build` is expected to produce its inputs — and a CI
 * matrix job that has to remember a fourth step is a footgun. So it builds the
 * shell when missing and SAYS SO loudly; when `app/dist` already exists it is
 * left completely untouched (no surprise rebuilds of a directory someone else
 * just produced).
 *
 * This is the script the root `desktop:build` wrapper calls.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { APP_DIST, PKG_DIR, REPO_ROOT, appDistReady, fail } = require("./buildSupport.cjs");

const SCRIPT = "build";

/**
 * Run one stage as a child process. `inherit` stdio keeps the stage's own
 * [desktop:<stage>] lines interleaved in the CI log in real order.
 *
 * @param {string} label
 * @param {string} scriptPath absolute path to a .cjs script
 */
function stage(label, scriptPath) {
  console.log(`\n[desktop:${SCRIPT}] ── ${label} ─────────────────────────────────────`);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: PKG_DIR,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error !== undefined) {
    fail(SCRIPT, `${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(SCRIPT, `${label} failed with exit code ${result.status}`);
  }
}

stage("build:public-config", path.join(__dirname, "buildPublicConfig.cjs"));
stage("build:daemon", path.join(__dirname, "buildDaemon.cjs"));
stage("build:extension", path.join(__dirname, "buildExtension.cjs"));
stage("prepare:runtime", path.join(__dirname, "prepareRuntime.cjs"));

// Step 3: only when actually missing.
if (appDistReady(APP_DIST)) {
  console.log(
    `\n[desktop:${SCRIPT}] app shell already built at ${APP_DIST} — leaving it untouched ` +
      "(rebuild with `pnpm build` if it is stale)",
  );
} else {
  console.log(
    `\n[desktop:${SCRIPT}] app shell missing at ${APP_DIST}\n` +
      `[desktop:${SCRIPT}] running \`pnpm build\` at the repo root (${REPO_ROOT}) — this is a full ` +
      "Vite build and may take a minute",
  );
  const result = spawnSync("pnpm", ["build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
    // pnpm is a .cmd shim on Windows; a shell is required there. The argv is
    // fully fixed (no user input), so this is not an injection surface.
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    fail(SCRIPT, `could not run \`pnpm build\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      SCRIPT,
      `\`pnpm build\` failed with exit code ${result.status} — the daemon needs app/dist to serve the shell.`,
    );
  }
  if (!appDistReady(APP_DIST)) {
    fail(SCRIPT, `\`pnpm build\` succeeded but ${APP_DIST}/index.html is still missing.`);
  }
}

stage("build:runtime", path.join(__dirname, "buildRuntime.cjs"));

// Say plainly what was produced and what it is not.
const resourceFiles = ["daemon.mjs", "pi-extension.mjs", "app-dist", "runtime.json", "resources.json"].filter(
  (name) => fs.existsSync(path.join(PKG_DIR, "staging", name)),
);
console.log(
  `\n[desktop:${SCRIPT}] ok — staged: ${resourceFiles.join(", ")}\n` +
    `[desktop:${SCRIPT}] next: \`pnpm --filter @agent-fit-trace/desktop run package\` ` +
    "(UNSIGNED internal build; no signing, no notarization, no auto-update)",
);
