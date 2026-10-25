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

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkgDir = path.join(__dirname, "..");
const repoRoot = path.join(pkgDir, "..", "..");
const appDist = path.join(repoRoot, "app", "dist");

function fail(message) {
  console.error(`[desktop:dev] ${message}`);
  process.exit(1);
}

/** Resolve the electron package dir through this package's node_modules. */
function resolveElectronDir() {
  try {
    return path.dirname(require.resolve("electron/package.json", { paths: [pkgDir] }));
  } catch {
    fail('electron is not installed — run "pnpm install" at the repo root first.');
  }
}

/**
 * Path of the electron binary IF the postinstall has run, else null.
 *
 * Deliberately filesystem-based: `require("electron")` must NOT be used here —
 * in electron >= 45 the package's index.js triggers a synchronous binary
 * download as a side effect of being required when the binary is missing,
 * which would hide a slow network fetch inside a "check".
 */
function electronBinaryPath(electronDir) {
  const pathFile = path.join(electronDir, "path.txt");
  if (!fs.existsSync(pathFile)) {
    return null;
  }
  const relative = fs.readFileSync(pathFile, "utf-8").trim();
  if (relative === "") {
    return null;
  }
  const fullPath = path.join(electronDir, "dist", relative);
  return fs.existsSync(fullPath) ? fullPath : null;
}

/** Step 1: the binary (not just the npm package) must be present. */
function ensureElectronBinary(electronDir) {
  let binaryPath = electronBinaryPath(electronDir);
  if (binaryPath !== null) {
    return binaryPath;
  }
  console.log(
    "[desktop:dev] electron binary missing (pnpm 10 skips unapproved postinstall scripts; " +
      "this is expected after a plain `pnpm install`). Running electron's install.js once…",
  );
  const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    fail("electron binary download failed — check your network or set ELECTRON_MIRROR, then rerun.");
  }
  binaryPath = electronBinaryPath(electronDir);
  if (binaryPath === null) {
    fail("electron binary still missing after install.js — please report this.");
  }
  return binaryPath;
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

const electronDir = resolveElectronDir();
const electronBinary = ensureElectronBinary(electronDir);
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
