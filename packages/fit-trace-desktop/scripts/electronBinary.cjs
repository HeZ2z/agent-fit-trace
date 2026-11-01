"use strict";

/**
 * One place that finds the Electron binary, for both `scripts/dev.cjs`
 * (interactive dev) and `scripts/prepareRuntime.cjs` (build/CI).
 *
 * Deliberately filesystem-based: `require("electron")` must NOT be used —
 * in electron >= 45 the package's index.js triggers a synchronous binary
 * download as a side effect of being required when the binary is missing,
 * which would hide a slow network fetch inside a "check".
 *
 * pnpm 10 skips unapproved postinstall scripts, so a fresh `pnpm install`
 * does NOT download Electron. Both callers therefore run `electron/install.js`
 * once when the binary is absent; the download stays explicit and out of the
 * plain install path (CI that never builds the desktop app never pays for it).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Path of the electron binary IF the postinstall has run, else null.
 *
 * @param {string} pkgDir package root whose node_modules to resolve through
 * @returns {string | null}
 */
function electronBinaryPath(pkgDir) {
  let electronDir;
  try {
    electronDir = path.dirname(require.resolve("electron/package.json", { paths: [pkgDir] }));
  } catch {
    return null;
  }
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

/**
 * Resolve the electron package directory (throws when not installed at all —
 * that is a missing dependency, not a missing download).
 *
 * @param {string} pkgDir
 * @returns {string}
 */
function resolveElectronDir(pkgDir) {
  return path.dirname(require.resolve("electron/package.json", { paths: [pkgDir] }));
}

/**
 * Ensure the Electron binary exists, downloading it once via
 * `electron/install.js` when it does not.
 *
 * @param {object} options
 * @param {string} options.pkgDir package root whose node_modules to resolve through
 * @param {(message: string) => void} options.onDownloadStart called before the download
 * @param {(message: string) => never} options.onFailure called with a user-facing message
 * @returns {string} absolute path to the electron binary
 */
function ensureElectronBinaryForBuild({ pkgDir, onDownloadStart, onFailure }) {
  const existing = electronBinaryPath(pkgDir);
  if (existing !== null) {
    return existing;
  }
  let electronDir;
  try {
    electronDir = resolveElectronDir(pkgDir);
  } catch {
    onFailure('electron is not installed — run "pnpm install" at the repo root first.');
  }
  onDownloadStart();
  const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    onFailure("electron binary download failed — check your network or set ELECTRON_MIRROR, then rerun.");
  }
  const binaryPath = electronBinaryPath(pkgDir);
  if (binaryPath === null) {
    onFailure(
      "electron binary still missing after install.js. If the cache/download is blocked, " +
        "set ELECTRON_OVERRIDE_DIST_PATH to an unpacked electron dist, then rerun.",
    );
  }
  return binaryPath;
}

module.exports = {
  electronBinaryPath,
  resolveElectronDir,
  ensureElectronBinaryForBuild,
};
