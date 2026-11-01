"use strict";

/**
 * Dev entry for the fit-trace desktop shell (issue #41). Run with plain node:
 *
 *   pnpm desktop:dev   →   pnpm --filter @agent-fit-trace/desktop run dev
 *
 * Steps:
 *   1. ensure the electron binary exists (pnpm 10 does not run unapproved
 *      postinstall scripts, so a fresh `pnpm install` does NOT download it —
 *      this is expected and keeps CI free of the ~100MB binary; the first
 *      `pnpm desktop:dev` runs `electron/install.js` once instead);
 *   2. ensure `app/dist` exists — the daemon serves the App shell only from a
 *      build, and we refuse to build automatically (a full Vite build is slow
 *      and silently hiding it behind this command is worse than printing it);
 *   3. spawn electron with `main/main.cjs` as the entry. The environment is
 *      inherited, so `FIT_TRACE_DATA_DIR` passes through to the daemon
 *      untouched; `ELECTRON_DISABLE_SECURITY_WARNINGS` is deliberately NOT set.
 *   4. nothing to clean up after electron exits — the daemon child is owned
 *      by the main process and stops with it.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ensureElectronBinaryForBuild } = require("./electronBinary.cjs");

const pkgDir = path.join(__dirname, "..");
const repoRoot = path.join(pkgDir, "..", "..");
const appDist = path.join(repoRoot, "app", "dist");

function fail(message) {
  console.error(`[desktop:dev] ${message}`);
  process.exit(1);
}

/**
 * Step 1: the binary (not just the npm package) must be present. The lookup
 * and the one-shot `install.js` download live in `electronBinary.cjs` so the
 * dev entry and the build (`scripts/prepareRuntime.cjs`) cannot disagree.
 */
function ensureElectronBinary() {
  return ensureElectronBinaryForBuild({
    pkgDir,
    onDownloadStart: () => {
      console.log(
        "[desktop:dev] electron binary missing (pnpm 10 skips unapproved postinstall scripts; " +
          "this is expected after a plain `pnpm install`). Running electron's install.js once…",
      );
    },
    onFailure: (message) => fail(message),
  });
}

/** Step 2: app/dist must already be built. */
function ensureAppDist() {
  if (fs.existsSync(path.join(appDist, "index.html"))) {
    return;
  }
  fail(
    "app/dist is missing — the daemon serves the App shell only from a build.\n" +
      "Build it first (not done automatically on purpose):\n\n" +
      "    pnpm build\n\n" +
      "then rerun pnpm desktop:dev.",
  );
}

const electronBinary = ensureElectronBinary();
ensureAppDist();

console.log(`[desktop:dev] electron ${electronBinary}`);
const child = spawn(electronBinary, ["."], {
  cwd: pkgDir,
  stdio: "inherit",
  // Environment is inherited wholesale: FIT_TRACE_DATA_DIR (and any Supabase
  // config the daemon reads) flows to the main process and its daemon child.
  env: process.env,
});
child.on("exit", (code, signal) => {
  // Step 4: no daemon cleanup here — main.cjs owns the daemon child and stops
  // it (SIGTERM → SIGKILL) when the shell quits.
  process.exitCode = code !== null && code !== 0 ? code : signal !== null ? 1 : 0;
});

// A terminal Ctrl+C delivers SIGINT to the whole foreground group, but a
// targeted signal to THIS wrapper must not orphan the Electron tree: forward
// the signal so the shell quits and main.cjs stops its daemon child.
let forwarded = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!forwarded) {
      forwarded = true;
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  });
}
