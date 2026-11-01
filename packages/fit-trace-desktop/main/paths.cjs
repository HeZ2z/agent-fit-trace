"use strict";

/**
 * Launch-path resolution for the desktop shell, split out as a pure module
 * (issue: unsigned internal packaging).
 *
 * Why this exists: in dev the shell is started from the repo checkout, so
 * `node packages/fit-trace-cli/src/cli.ts` and the daemon's own default
 * `<repo>/app/dist` are correct by construction. A packaged app has neither a
 * checkout nor a `node` binary: the CLI source is replaced by a single
 * esbuild bundle and the app shell by an `extraResources` copy, both placed
 * under `process.resourcesPath`. This module is the one place that knows
 * both layouts, so `main.cjs` never strings paths together itself and the
 * resolution is unit-testable without electron (see
 * `tests/desktopPaths.test.ts`).
 *
 * Plain Node, no electron import — same constraint as `daemonChild.cjs`.
 */

const path = require("node:path");

/** Staged daemon bundle inside the packaged app's resources directory. */
const PACKAGED_DAEMON_FILE = "daemon.mjs";
/** Staged `app/dist` copy inside the packaged app's resources directory. */
const PACKAGED_DIST_DIR = "app-dist";
/**
 * Minimum Node major the daemon bundle needs: `node:sqlite` (`DatabaseSync`)
 * and the `.ts`-extension/source features the CLI graph relies on. Must match
 * `packages/fit-trace-cli/src/config.ts` `checkNodeRuntime`.
 */
const MIN_NODE_MAJOR = 24;

/**
 * Resolve where the daemon lives and how to launch it.
 *
 * Packaged mode (strategy A, `ELECTRON_RUN_AS_NODE=1`):
 *   nodePath  = `process.execPath` — the app's OWN binary, re-entered as Node
 *   daemonPath = `<resourcesPath>/daemon.mjs` (the esbuild bundle)
 *   distDir    = `<resourcesPath>/app-dist` (passed to the daemon as `--dist`)
 *   env        = caller env + `ELECTRON_RUN_AS_NODE=1`
 *
 * Dev mode is deliberately byte-for-byte the previous behaviour:
 *   nodePath  = `$FIT_TRACE_DESKTOP_NODE` or bare `node`
 *   daemonPath = `<repo>/packages/fit-trace-cli/src/cli.ts`
 *   distDir    = undefined, so the daemon keeps resolving `<repo>/app/dist`
 *                with its own `import.meta.url` default.
 *
 * The `distDir` omission in dev is intentional, not an oversight: passing an
 * explicit path would change which default wins if the daemon's own
 * resolution ever changes, and dev is specified to stay unchanged.
 *
 * @param {object} options
 * @param {boolean} options.packaged `app.isPackaged`
 * @param {string} options.resourcesPath `process.resourcesPath`
 * @param {string} options.devRepoRoot repo root (dev only; ignored when packaged)
 * @param {string} options.execPath `process.execPath` (the Electron binary)
 * @param {NodeJS.ProcessEnv} options.env caller environment
 * @returns {{
 *   mode: "packaged" | "dev",
 *   nodePath: string,
 *   daemonPath: string,
 *   distDir: string | undefined,
 *   env: NodeJS.ProcessEnv,
 * }}
 */
function resolveLaunchPlan({ packaged, resourcesPath, devRepoRoot, execPath, env }) {
  if (packaged) {
    return {
      mode: "packaged",
      nodePath: execPath,
      daemonPath: path.join(resourcesPath, PACKAGED_DAEMON_FILE),
      distDir: path.join(resourcesPath, PACKAGED_DIST_DIR),
      // Electron's binary runs as plain Node only when this flag is set for
      // the child. Verified on this repo: electron 45 / Node 24.22.0 loads
      // `node:sqlite` in this mode (see docs/adr/0006-*).
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const fromEnv = env.FIT_TRACE_DESKTOP_NODE;
  return {
    mode: "dev",
    nodePath: typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : "node",
    daemonPath: path.join(devRepoRoot, "packages", "fit-trace-cli", "src", "cli.ts"),
    distDir: undefined,
    // Dev passes the caller environment through untouched (dev.cjs hands the
    // shell the node that started it via FIT_TRACE_DESKTOP_NODE).
    env: { ...env },
  };
}

/**
 * Major version of a `process.versions.node`-shaped string, or NaN.
 * Pure so the version gate below can be tested without a runtime.
 *
 * @param {string} version
 * @returns {number}
 */
function nodeMajor(version) {
  const major = Number(String(version ?? "").split(".")[0]);
  return Number.isSafeInteger(major) && major > 0 ? major : Number.NaN;
}

/**
 * Whether this Node major can run the daemon bundle. Electron's bundled Node
 * is what makes strategy A viable at all, so the shell checks it explicitly
 * instead of letting the child fail with an obscure `node:sqlite` error.
 *
 * @param {string} version `process.versions.node`
 * @returns {boolean}
 */
function isSupportedNodeVersion(version) {
  return nodeMajor(version) >= MIN_NODE_MAJOR;
}

/**
 * One-line launch description for the shell's stdout. Logged once at startup
 * so a packaged run is diagnosable from a user's log excerpt.
 *
 * @param {ReturnType<typeof resolveLaunchPlan>} plan
 * @returns {string}
 */
function describeLaunchPlan(plan) {
  const parts = [`mode=${plan.mode}`, `node=${plan.nodePath}`, `daemon=${plan.daemonPath}`];
  if (plan.distDir !== undefined) {
    parts.push(`dist=${plan.distDir}`);
  }
  return `[desktop] ${parts.join(" ")}`;
}

module.exports = {
  PACKAGED_DAEMON_FILE,
  PACKAGED_DIST_DIR,
  MIN_NODE_MAJOR,
  resolveLaunchPlan,
  nodeMajor,
  isSupportedNodeVersion,
  describeLaunchPlan,
};
