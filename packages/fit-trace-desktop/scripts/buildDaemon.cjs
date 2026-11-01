"use strict";

/**
 * `build:daemon` — bundle the daemon into `staging/daemon.mjs`.
 *
 * Why a bundle at all: the packaged app has no repo checkout and no
 * `node_modules` tree. `packages/fit-trace-cli/src/cli.ts` pulls in the shared
 * server graph (`server/coaching/*`, `server/auth/*`,
 * `server/sqlitePrincipalStores.ts`) plus the `@agent-fit-trace/*` workspace
 * packages; a single esbuild file is what makes `ELECTRON_RUN_AS_NODE=1
 * <app binary> daemon.mjs` work at all.
 *
 * Verified shape (esbuild 0.28.1): ~476 KB, format ESM, target node24, with
 * `@earendil-works/*` externalized. The current daemon graph resolves no pi
 * SDK import at all — the coaching path talks to the `pi` CLI over RPC and
 * only `server/cloud/*` (worker entrypoint, not in this graph) imports the
 * SDK. `inspectDaemonBundle` in buildSupport.cjs fails the build if the bundle
 * ever gains a bare import we did not plan for.
 *
 * Run from the package: `node scripts/buildDaemon.cjs`.
 * Or via `pnpm --filter @agent-fit-trace/desktop run build:daemon`.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const {
  CLI_ENTRY,
  STAGED_DAEMON,
  STAGING_DIR,
  esbuildDaemonArgs,
  fail,
  inspectDaemonBundle,
  resolveEsbuildPath,
} = require("./buildSupport.cjs");

const esbuild = resolveEsbuildPath();
if (esbuild === null) {
  fail(
    "build:daemon",
    "esbuild not resolvable from the root workspace — it is a root devDependency. " +
      "Run `pnpm install` at the repo root first.",
  );
}
if (!fs.existsSync(CLI_ENTRY)) {
  fail("build:daemon", `CLI entry not found: ${CLI_ENTRY}`);
}

fs.mkdirSync(STAGING_DIR, { recursive: true });
// Always rebuild: a stale bundle from a previous revision is worse than a
// slow build, because nothing downstream can tell it is stale.
fs.rmSync(STAGED_DAEMON, { force: true });

const args = esbuildDaemonArgs(CLI_ENTRY, STAGED_DAEMON);
console.log(`[desktop:build:daemon] ${process.execPath} ${esbuild} ${args.join(" ")}`);
// Launch esbuild through this Node binary instead of executing its `.bin` shim:
// that shim is a POSIX shell script / Windows `.cmd`, and `spawnSync` can run
// neither without a shell (see resolveEsbuildPath for why a shell is avoided).
const result = spawnSync(process.execPath, [esbuild, ...args], { stdio: "inherit", env: process.env });
if (result.error !== undefined) {
  fail("build:daemon", `could not run esbuild: ${result.error.message}`);
}
if (result.status !== 0) {
  fail("build:daemon", `esbuild exited with code ${result.status}`);
}

const report = inspectDaemonBundle(STAGED_DAEMON);
if (!report.ok) {
  fail(
    "build:daemon",
    `bundle failed self-containment check: ${STAGED_DAEMON}\n` +
      (report.sizeBytes === 0
        ? "  the bundle is empty\n"
        : `  unexpected bare imports (would be ERR_MODULE_NOT_FOUND at runtime): ` +
          `${report.bareImports.join(", ")}\n` +
          "  either inline them (remove from --external) or ship them as extraResources\n"),
  );
}

console.log(
  `[desktop:build:daemon] ok — ${STAGED_DAEMON} (${(report.sizeBytes / 1024).toFixed(1)} KB)`,
);
