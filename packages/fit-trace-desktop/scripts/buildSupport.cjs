"use strict";

/**
 * Shared build-time helpers for the packaged desktop app.
 *
 * Plain Node (no electron, no electron-builder import) so the packaged-layout
 * contract can be unit-tested in the ordinary `node:test` suite — see
 * `tests/desktopBuildScripts.test.ts`. The scripts themselves
 * (`buildDaemon.cjs`, `prepareRuntime.cjs`, `package.cjs`, `dev.cjs`) stay
 * thin: they orchestrate, this module decides.
 *
 * Layout this module encodes (must stay in sync with `electron-builder.yml`):
 *
 *   packages/fit-trace-desktop/
 *     staging/                     generated, gitignored, wiped each build
 *       daemon.mjs                 esbuild bundle of the CLI (the daemon)
 *       app-dist/                  copy of <repo>/app/dist (the web shell)
 *     release/                     generated, gitignored: installers/artifacts
 *
 * `staging/` is what electron-builder copies into `extraResources`, so the
 * packaged app contains `<resources>/daemon.mjs` and `<resources>/app-dist/`
 * — exactly the two names `main/paths.cjs` resolves in packaged mode.
 */

const fs = require("node:fs");
const path = require("node:path");

// The runtime version floor lives in main/paths.cjs (the shell enforces it at
// startup); re-exported here so build scripts and the runtime gate cannot drift.
const { MIN_NODE_MAJOR } = require("../main/paths.cjs");

/** Package root (`packages/fit-trace-desktop`). */
const PKG_DIR = path.join(__dirname, "..");
/** Repo root: three levels up from the package (packages/<pkg>/scripts/..). */
const REPO_ROOT = path.join(PKG_DIR, "..", "..");

const STAGING_DIR = path.join(PKG_DIR, "staging");
const STAGED_DAEMON = path.join(STAGING_DIR, "daemon.mjs");
const STAGED_DIST = path.join(STAGING_DIR, "app-dist");
const RELEASE_DIR = path.join(PKG_DIR, "release");
const APP_DIST = path.join(REPO_ROOT, "app", "dist");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "fit-trace-cli", "src", "cli.ts");

/**
 * Electron packages esbuild must NOT inline. The pi SDK is a runtime
 * dependency of the coaching code path and ships as a real package in
 * `node_modules`; everything else (notably the `@agent-fit-trace/*` workspace
 * packages) must be inlined or the bundle would need a node_modules tree.
 *
 * NOTE: verified empirically — `--packages=external` breaks the build (the
 * workspace packages are not resolvable from the packaged app), and the
 * current daemon graph resolves to ZERO `@earendil-works/*` imports, so this
 * list is deliberately a pin against future drift rather than a present-day
 * requirement. `scripts/buildDaemon.cjs` fails the build if the output
 * references an external package it did not externalize.
 */
const EXTERNAL_PACKAGES = ["@earendil-works/*"];

/** Name of the app bundle's daemon entry inside `resources/`. */
const PACKAGED_DAEMON_FILE = "daemon.mjs";
/** Name of the staged web shell inside `resources/`. */
const PACKAGED_DIST_DIR = "app-dist";

function fail(script, message) {
  console.error(`[desktop:${script}] ${message}`);
  process.exit(1);
}

/**
 * Read the desktop package's own manifest. Version and product name live
 * here, so the shell, the installer, and `tests/desktopPackageIsolation` all
 * agree on one source of truth.
 *
 * @returns {{name: string, version: string, productName?: string, description?: string, author?: string|object}}
 */
function readDesktopManifest() {
  return JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
}

/**
 * Whether this platform can actually produce artifacts. Used to keep
 * `build:daemon`/`build:runtime` cross-platform (CI builds a Linux bundle on
 * a Linux runner) while `package` stays host-native — electron-builder cannot
 * cross-compile a macOS dmg from Linux and we do not pretend otherwise.
 *
 * @param {string} platform `process.platform`
 * @returns {boolean}
 */
function isSupportedBuildHost(platform) {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

/**
 * Resolve esbuild's JavaScript entry point, to be launched as
 * `process.execPath <entry> …`.
 *
 * Why the JS entry and not `node_modules/.bin/esbuild`: that path is a
 * pnpm-generated shim. On POSIX it is a `#!/usr/bin/env node` script, and on
 * Windows it is `esbuild.cmd` — neither can be handed to `spawnSync` without a
 * shell. Passing a shell would mean quoting argv ourselves and adding an
 * injection surface, so the build instead invokes Node explicitly on the bin
 * script, which is platform-independent.
 *
 * It is a ROOT devDependency (a build tool of the monorepo, not a desktop
 * runtime dep), so it resolves through the root workspace rather than this
 * package's own.
 *
 * @param {string} [repoRoot]
 * @returns {string | null} absolute path when present
 */
function resolveEsbuildPath(repoRoot = REPO_ROOT) {
  try {
    return require.resolve("esbuild/bin/esbuild", { paths: [repoRoot] });
  } catch {
    return null;
  }
}

/** Electron's `path.txt`-based binary lookup (same logic as scripts/dev.cjs). */
function resolveElectronBinary(pkgDir) {
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
 * Args for the daemon bundle. Kept in one place because the flag reasoning is
 * not obvious:
 *   - `--format=esm`: the daemon graph is ESM (`node:sqlite`, top-level await).
 *   - `--platform=node`, `--target=node24`: the bundle runs on the runtime
 *     that ships with the app (Electron 45 → Node 24.22), never older.
 *   - externals: see EXTERNAL_PACKAGES above.
 *   - no `--sourcemap`: an internal unsigned build; maps would only add MBs.
 *
 * @param {string} outfile
 * @param {string} entry
 * @returns {string[]}
 */
function esbuildDaemonArgs(entry, outfile) {
  return [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    "--log-level=warning",
    `--outfile=${outfile}`,
    ...EXTERNAL_PACKAGES.map((spec) => `--external:${spec}`),
  ];
}

/**
 * Verify the bundle really is self-contained enough to ship: it must exist,
 * be non-trivial, and must not import a bare package we did not externalize.
 * Catches the exact regression that bit us — a workspace package left
 * external, which type-checks but explodes at runtime in the packaged app
 * with `ERR_MODULE_NOT_FOUND`.
 *
 * @param {string} bundlePath
 * @returns {{ok: boolean, sizeBytes: number, bareImports: string[]}}
 */
function inspectDaemonBundle(bundlePath) {
  if (!fs.existsSync(bundlePath)) {
    return { ok: false, sizeBytes: 0, bareImports: [] };
  }
  const sizeBytes = fs.statSync(bundlePath).size;
  const text = fs.readFileSync(bundlePath, "utf8");
  const bareImports = new Set();
  const importRe = /(?:^|\n)\s*(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/g;
  let match;
  while ((match = importRe.exec(text)) !== null) {
    const spec = match[1];
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
      continue;
    }
    // A URL protocol (data:, file:) isn't a package specifier.
    if (/^[a-z]+:/i.test(spec)) {
      continue;
    }
    bareImports.add(spec);
  }
  const allowed = (spec) => EXTERNAL_PACKAGES.some((pattern) => globMatch(pattern, spec));
  const unexpected = [...bareImports].filter((spec) => !allowed(spec)).sort();
  return { ok: sizeBytes > 0 && unexpected.length === 0, sizeBytes, bareImports: unexpected };
}

/**
 * Minimal `*` glob matching for package specifiers (`@scope/*`).
 *
 * `*` deliberately does NOT cross `/` — the standard glob rule, and the one
 * that matters here: `@earendil-works/*` externalizes the packages of that
 * scope, not a deep subpath (`@earendil-works/pi-ai/deep`), which esbuild
 * would resolve against the package's own files instead.
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
function globMatch(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Copy `app/dist` into staging (replacing any previous copy). A recursive copy
 * rather than a symlink on purpose: electron-builder resolves symlinks when
 * packing `extraResources`, and a link out of the package tree would silently
 * produce an app with no shell.
 *
 * @param {import("node:fs").PathLike} from
 * @param {import("node:fs").PathLike} to
 */
function copyDirSync(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(source, target);
    } else if (entry.isSymbolicLink()) {
      // Materialize the link's target so the packaged app never depends on a
      // path outside its own resources.
      fs.copyFileSync(fs.realpathSync(source), target);
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

/**
 * The app shell must already be built. Building it here would hide a full
 * Vite build inside a desktop command (same reasoning as `scripts/dev.cjs`).
 *
 * @param {string} [appDist]
 * @returns {boolean}
 */
function appDistReady(appDist = APP_DIST) {
  return fs.existsSync(path.join(appDist, "index.html"));
}

/**
 * Assert the packaging inputs exist, with one message per missing input so a
 * CI failure names the actual fix.
 *
 * Paths are injectable so the guard itself is testable regardless of whether
 * the current checkout happens to have been built already.
 *
 * @param {object} [override]
 * @param {string} [override.stagedDaemon]
 * @param {string} [override.stagedDist]
 * @param {string | null} [override.electronBinary] null = missing
 * @returns {string[]} problems (empty = ready)
 */
function packagingInputProblems(override = {}) {
  const stagedDaemon = override.stagedDaemon ?? STAGED_DAEMON;
  const stagedDist = override.stagedDist ?? STAGED_DIST;
  const electronBinary =
    override.electronBinary === undefined ? resolveElectronBinary(PKG_DIR) : override.electronBinary;
  const problems = [];
  if (electronBinary === null) {
    problems.push(
      "electron binary is missing — pnpm 10 skips unapproved postinstall scripts. " +
        "Run: pnpm --filter @agent-fit-trace/desktop exec node node_modules/electron/install.js",
    );
  }
  if (!fs.existsSync(stagedDaemon)) {
    problems.push("staging/daemon.mjs is missing — run pnpm --filter @agent-fit-trace/desktop run build:daemon");
  }
  if (!appDistReady(stagedDist)) {
    problems.push(
      "staging/app-dist/index.html is missing — run pnpm build (at the repo root) then " +
        "pnpm --filter @agent-fit-trace/desktop run build:runtime",
    );
  }
  return problems;
}

/**
 * Files electron-builder's `files`/`extraResources` must never ship. Used by
 * the isolation test to keep signing material and local data out of the app.
 */
const FORBIDDEN_PACKAGED_PATTERNS = [
  // Signing / notarization material: this round is explicitly unsigned.
  "*.p12",
  "*.pfx",
  "*.cer",
  "*.mobileprovision",
  "*.provisionprofile",
  "*.pem",
  "*.key",
  // Coached-run snapshots and the local workout store must never be baked in.
  ".pi/fit-trace",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
];

module.exports = {
  PKG_DIR,
  REPO_ROOT,
  STAGING_DIR,
  STAGED_DAEMON,
  STAGED_DIST,
  RELEASE_DIR,
  APP_DIST,
  CLI_ENTRY,
  EXTERNAL_PACKAGES,
  PACKAGED_DAEMON_FILE,
  PACKAGED_DIST_DIR,
  FORBIDDEN_PACKAGED_PATTERNS,
  MIN_NODE_MAJOR,
  fail,
  readDesktopManifest,
  isSupportedBuildHost,
  resolveEsbuildPath,
  resolveElectronBinary,
  esbuildDaemonArgs,
  inspectDaemonBundle,
  globMatch,
  copyDirSync,
  appDistReady,
  packagingInputProblems,
};
