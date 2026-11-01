"use strict";

/**
 * `build:extension` — bundle the pi extension into `staging/pi-extension.mjs`.
 *
 * Why: the pi extension is a `.ts` source file that imports the
 * `@agent-fit-trace/*` workspace packages and the pi SDK. A packaged app has
 * neither a workspace link farm nor a `node_modules` tree, and the daemon
 * resolves the extension from `import.meta.url` — so without this bundle a
 * packaged build has no extension to load at all, and `local-pi` cannot run.
 *
 * The bundle is loaded by the user's own `pi` CLI (`pi --mode rpc -e <path>`),
 * NOT by the app. pi's extension loader supplies `@earendil-works/*` and
 * `typebox` from an in-process alias table, so those stay external and
 * everything else is inlined (see EXTENSION_EXTERNAL_PACKAGES in
 * buildSupport.cjs for why `typebox` in particular must not be inlined).
 *
 * Verified against pi 0.85.1: the bundle (~391 KB) loads with no
 * `node_modules` present, and its factory really runs — a wrong `--tools`
 * allowlist trips the extension's own `COACHED_TOOL_PROBE_FAILED`.
 *
 * Run from the package: `node scripts/buildExtension.cjs`.
 * Or via `pnpm --filter @agent-fit-trace/desktop run build:extension`.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const {
  EXTENSION_ENTRY,
  STAGED_EXTENSION,
  STAGING_DIR,
  esbuildExtensionArgs,
  fail,
  inspectExtensionBundle,
  resolveEsbuildPath,
} = require("./buildSupport.cjs");

const SCRIPT = "build:extension";

const esbuild = resolveEsbuildPath();
if (esbuild === null) {
  fail(
    SCRIPT,
    "esbuild not resolvable from the root workspace — it is a root devDependency. " +
      "Run `pnpm install` at the repo root first.",
  );
}
if (!fs.existsSync(EXTENSION_ENTRY)) {
  fail(SCRIPT, `extension entry not found: ${EXTENSION_ENTRY}`);
}

fs.mkdirSync(STAGING_DIR, { recursive: true });
// Always rebuild: the extension tracks `.pi/extensions/fit-trace`, and a stale
// bundle would silently pin the packaged app to an old tool surface.
fs.rmSync(STAGED_EXTENSION, { force: true });

const args = esbuildExtensionArgs(EXTENSION_ENTRY, STAGED_EXTENSION);
console.log(`[desktop:${SCRIPT}] ${process.execPath} ${esbuild} ${args.join(" ")}`);
// Launch through this Node binary, never the `.bin` shim: that shim is a POSIX
// script / Windows `.cmd` and cannot be spawned without a shell (see
// resolveEsbuildPath).
const result = spawnSync(process.execPath, [esbuild, ...args], { stdio: "inherit", env: process.env });
if (result.error !== undefined) {
  fail(SCRIPT, `could not run esbuild: ${result.error.message}`);
}
if (result.status !== 0) {
  fail(SCRIPT, `esbuild exited with code ${result.status}`);
}

const report = inspectExtensionBundle(STAGED_EXTENSION);
if (!report.ok) {
  const problems = [];
  if (report.sizeBytes === 0) {
    problems.push("the bundle is empty");
  }
  if (report.bareImports.length > 0) {
    problems.push(
      `unexpected bare imports (would be ERR_MODULE_NOT_FOUND when pi loads it): ` +
        report.bareImports.join(", ") +
        " — either inline them or add them to EXTENSION_EXTERNAL_PACKAGES",
    );
  }
  if (report.inlinedHostImports.length > 0) {
    problems.push(
      `host-provided packages were inlined instead of left external: ` +
        report.inlinedHostImports.join(", ") +
        " — pi supplies these; a second copy breaks tool schema interoperability",
    );
  }
  fail(SCRIPT, `extension bundle failed its self-containment check: ${STAGED_EXTENSION}\n  ` + problems.join("\n  "));
}

console.log(
  `[desktop:${SCRIPT}] ok — ${STAGED_EXTENSION} (${(report.sizeBytes / 1024).toFixed(1)} KB)`,
);
