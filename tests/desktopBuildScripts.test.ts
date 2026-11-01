import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * Tests for the desktop packaging build scripts
 * (packages/fit-trace-desktop/scripts/*.cjs — plain Node, no electron, no
 * electron-builder). Only the PURE helpers are exercised here: they encode the
 * packaged layout, the bundle self-containment check, and the
 * "refuse to package half-staged inputs" gate. The actual electron-builder run
 * is a manual/CI step (documented in docs/local-daemon.md), never part of this
 * suite — it downloads and unpacks ~120MB.
 */

const require = createRequire(import.meta.url);
const PACKAGE_DIR = join(import.meta.dirname, "..", "packages", "fit-trace-desktop");
const support = require("../packages/fit-trace-desktop/scripts/buildSupport.cjs") as {
  PKG_DIR: string;
  REPO_ROOT: string;
  STAGING_DIR: string;
  STAGED_DAEMON: string;
  STAGED_DIST: string;
  RELEASE_DIR: string;
  APP_DIST: string;
  CLI_ENTRY: string;
  EXTERNAL_PACKAGES: string[];
  PACKAGED_DAEMON_FILE: string;
  PACKAGED_DIST_DIR: string;
  FORBIDDEN_PACKAGED_PATTERNS: string[];
  MIN_NODE_MAJOR: number;
  readDesktopManifest: () => {
    name: string;
    version: string;
    productName?: string;
    scripts?: Record<string, string>;
  };
  isSupportedBuildHost: (platform: string) => boolean;
  resolveEsbuildPath: (repoRoot?: string) => string | null;
  esbuildDaemonArgs: (entry: string, outfile: string) => string[];
  inspectDaemonBundle: (bundlePath: string) => {
    ok: boolean;
    sizeBytes: number;
    bareImports: string[];
  };
  globMatch: (pattern: string, value: string) => boolean;
  copyDirSync: (from: string, to: string) => void;
  appDistReady: (appDist?: string) => boolean;
  packagingInputProblems: (override?: {
    stagedDaemon?: string;
    stagedDist?: string;
    electronBinary?: string | null;
  }) => string[];
};

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("packaging paths point at this package, never the repo root or home", () => {
  assert.equal(support.PKG_DIR, PACKAGE_DIR);
  // `release/` is where CI uploads from — a contract with .github/workflows.
  assert.equal(support.RELEASE_DIR, join(PACKAGE_DIR, "release"));
  assert.equal(support.STAGING_DIR, join(PACKAGE_DIR, "staging"));
  // The daemon bundle and staged shell are what extraResources copies.
  assert.equal(support.STAGED_DAEMON, join(PACKAGE_DIR, "staging", "daemon.mjs"));
  assert.equal(support.STAGED_DIST, join(PACKAGE_DIR, "staging", "app-dist"));
  // Inputs come from the monorepo (read-only), outputs stay in the package.
  assert.equal(support.APP_DIST, join(support.REPO_ROOT, "app", "dist"));
  assert.ok(support.CLI_ENTRY.endsWith(join("packages", "fit-trace-cli", "src", "cli.ts")));
});

test("the staged resource names are the contract with electron-builder.yml", () => {
  const config = readFileSync(join(PACKAGE_DIR, "electron-builder.yml"), "utf8");
  assert.equal(support.PACKAGED_DAEMON_FILE, "daemon.mjs");
  assert.equal(support.PACKAGED_DIST_DIR, "app-dist");
  // extraResources must stage exactly what main/paths.cjs resolves at runtime.
  assert.match(config, /from:\s*staging\/daemon\.mjs\s*\n\s*to:\s*daemon\.mjs/);
  assert.match(config, /from:\s*staging\/app-dist\s*\n\s*to:\s*app-dist/);
  assert.match(config, /output:\s*release/);
});

test("electron-builder.yml is unsigned and has no auto-update channel", () => {
  const config = readFileSync(join(PACKAGE_DIR, "electron-builder.yml"), "utf8");
  // Unsigned, explicitly: `identity: null` (not merely absent) so a keychain
  // identity can never be picked up by accident.
  assert.match(config, /identity:\s*null/);
  assert.match(config, /notarize:\s*false/);
  // No publish/updater provider anywhere: this round ships no update channel.
  assert.doesNotMatch(config, /^\s*publish:/m);
  assert.doesNotMatch(config, /autoUpdater|electron-updater/);
  // The three platforms the user-approved decision names.
  for (const target of ["dmg", "zip", "nsis", "portable", "AppImage"]) {
    assert.match(config, new RegExp(`target:\\s*${target}`), `missing ${target} target`);
  }
});

test("build:daemon args bundle for the packaged runtime and externalize only the pi SDK", () => {
  const args = support.esbuildDaemonArgs("/repo/cli.ts", "/out/daemon.mjs");
  assert.equal(args[0], "/repo/cli.ts");
  assert.ok(args.includes("--bundle"));
  assert.ok(args.includes("--platform=node"));
  // ESM + node24: the daemon graph is ESM and the runtime floor is Node 24.
  assert.ok(args.includes("--format=esm"));
  assert.ok(args.includes("--target=node24"));
  assert.ok(args.includes("--outfile=/out/daemon.mjs"));
  // Workspace packages must be INLINED; only the pi SDK is external.
  assert.ok(args.includes("--external:@earendil-works/*"));
  assert.ok(!args.some((arg) => arg.includes("@agent-fit-trace")), "workspace packages must be bundled");
  assert.ok(!args.some((arg) => arg.includes("packages=external")));
  assert.deepEqual(support.EXTERNAL_PACKAGES, ["@earendil-works/*"]);
});

test("inspectDaemonBundle accepts a self-contained bundle", async () => {
  const dir = await tempDir("fit-trace-bundle-ok-");
  const bundle = join(dir, "daemon.mjs");
  await writeFile(
    bundle,
    [
      'import { createServer } from "node:http";',
      'import { readFile } from "node:fs/promises";',
      'import { thing } from "@earendil-works/pi-ai";',
      "export const x = createServer ?? readFile ?? thing;",
      "",
    ].join("\n"),
  );
  const report = support.inspectDaemonBundle(bundle);
  assert.equal(report.bareImports.length, 0);
  assert.ok(report.sizeBytes > 0);
  assert.equal(report.ok, true);
});

test("inspectDaemonBundle rejects a bundle with an unplanned bare import", async () => {
  // The exact failure mode this guards: a workspace package left external
  // type-checks fine but throws ERR_MODULE_NOT_FOUND in the packaged app.
  const dir = await tempDir("fit-trace-bundle-bad-");
  const bundle = join(dir, "daemon.mjs");
  await writeFile(
    bundle,
    ['import { store } from "@agent-fit-trace/store";', "export const y = store;", ""].join("\n"),
  );
  const report = support.inspectDaemonBundle(bundle);
  assert.equal(report.ok, false);
  assert.deepEqual(report.bareImports, ["@agent-fit-trace/store"]);
});

test("inspectDaemonBundle rejects a missing or empty bundle", async () => {
  assert.deepEqual(support.inspectDaemonBundle("/nonexistent/daemon.mjs"), {
    ok: false,
    sizeBytes: 0,
    bareImports: [],
  });
  const dir = await tempDir("fit-trace-bundle-empty-");
  const bundle = join(dir, "daemon.mjs");
  await writeFile(bundle, "");
  assert.equal(support.inspectDaemonBundle(bundle).ok, false);
});

test("globMatch handles the scoped external pattern", () => {
  assert.equal(support.globMatch("@earendil-works/*", "@earendil-works/pi-ai"), true);
  assert.equal(support.globMatch("@earendil-works/*", "@earendil-works/pi-agent-core"), true);
  // Must not over-match a different scope or a nested path.
  assert.equal(support.globMatch("@earendil-works/*", "@agent-fit-trace/store"), false);
  assert.equal(support.globMatch("@earendil-works/*", "@earendil-works/pi-ai/deep"), false);
  // Dots in the pattern are literal, not regex wildcards.
  assert.equal(support.globMatch("a.b", "axb"), false);
  assert.equal(support.globMatch("a.b", "a.b"), true);
});

test("copyDirSync replaces the destination and materializes nested files", async () => {
  const from = await tempDir("fit-trace-copy-from-");
  const to = await tempDir("fit-trace-copy-to-");
  await mkdir(join(from, "assets"), { recursive: true });
  await writeFile(join(from, "index.html"), "<html>shell</html>");
  await writeFile(join(from, "assets", "app.js"), "console.log(1)");
  // A stale file in the destination must not survive: the staged shell is an
  // exact copy, never a merge.
  await writeFile(join(to, "stale.txt"), "old");

  support.copyDirSync(from, to);

  assert.equal(existsSync(join(to, "stale.txt")), false);
  assert.equal(readFileSync(join(to, "index.html"), "utf8"), "<html>shell</html>");
  assert.equal(readFileSync(join(to, "assets", "app.js"), "utf8"), "console.log(1)");
});

test("appDistReady requires a real index.html, not just the directory", async () => {
  const dir = await tempDir("fit-trace-appdist-");
  await mkdir(join(dir, "app-dist"), { recursive: true });
  assert.equal(support.appDistReady(join(dir, "app-dist")), false);
  await writeFile(join(dir, "app-dist", "index.html"), "<html></html>");
  assert.equal(support.appDistReady(join(dir, "app-dist")), true);
  assert.equal(support.appDistReady(join(dir, "nope")), false);
});

test("packagingInputProblems reports each missing input separately", async () => {
  // Empty directories stand in for a clean checkout, so this asserts the guard
  // itself rather than whether this particular workspace happens to be built.
  const empty = await tempDir("fit-trace-noinputs-");
  const problems = support.packagingInputProblems({
    stagedDaemon: join(empty, "daemon.mjs"),
    stagedDist: join(empty, "app-dist"),
    electronBinary: null,
  });
  assert.equal(problems.length, 3, `expected three problems, got: ${problems.join(" | ")}`);
  const joined = problems.join("\n");
  assert.match(joined, /electron binary is missing/);
  assert.match(joined, /staging\/daemon\.mjs is missing/);
  assert.match(joined, /staging\/app-dist\/index\.html is missing/);
  // Every message names the exact command to run — never an opaque failure.
  assert.match(joined, /build:daemon/);
  assert.match(joined, /build:runtime/);
  assert.match(joined, /install\.js/);
  for (const problem of problems) {
    assert.ok(problem.length > 20, `unhelpful problem message: ${problem}`);
  }
});

test("packagingInputProblems is silent once every input exists", async () => {
  const ready = await tempDir("fit-trace-inputs-ready-");
  await writeFile(join(ready, "daemon.mjs"), "export {};\n");
  await mkdir(join(ready, "app-dist"), { recursive: true });
  await writeFile(join(ready, "app-dist", "index.html"), "<html></html>");
  const problems = support.packagingInputProblems({
    stagedDaemon: join(ready, "daemon.mjs"),
    stagedDist: join(ready, "app-dist"),
    electronBinary: "/fake/electron",
  });
  assert.deepEqual(problems, []);
});

test("the desktop manifest declares the packaging script set", () => {
  const manifest = support.readDesktopManifest();
  assert.equal(manifest.name, "@agent-fit-trace/desktop");
  assert.equal(manifest.productName, "fit-trace");
  // Names are a contract with release-ci's workflow and the root wrappers.
  assert.deepEqual(Object.keys(manifest.scripts ?? {}).sort(), [
    "build",
    "build:daemon",
    "build:runtime",
    "dev",
    "package",
    "package:dir",
    "prepare:runtime",
  ]);
  for (const script of ["build:daemon", "prepare:runtime", "build:runtime", "package"]) {
    const command = manifest.scripts?.[script] ?? "";
    assert.match(command, /^node scripts\/\w+\.cjs/, `${script} must be a plain node .cjs entry`);
    assert.ok(
      existsSync(join(PACKAGE_DIR, command.replace(/^node /, "").split(" ")[0] ?? "")),
      `${script} points at a missing script file: ${command}`,
    );
  }
});

test("only the three supported build hosts are accepted", () => {
  assert.equal(support.isSupportedBuildHost("darwin"), true);
  assert.equal(support.isSupportedBuildHost("win32"), true);
  assert.equal(support.isSupportedBuildHost("linux"), true);
  assert.equal(support.isSupportedBuildHost("freebsd"), false);
  assert.equal(support.isSupportedBuildHost("aix"), false);
});

test("esbuild is resolved from the ROOT workspace as a Node entry point", () => {
  // It is a root devDependency (a monorepo build tool), so the desktop package
  // must not grow its own copy.
  const esbuild = support.resolveEsbuildPath();
  assert.notEqual(esbuild, null);
  // Must be esbuild's JavaScript entry, not the `.bin` shim: the shim is a
  // POSIX script / Windows `.cmd`, which spawnSync cannot execute without a
  // shell. The build runs `process.execPath <entry> …` instead.
  assert.match(String(esbuild), /[\\/]esbuild[\\/]bin[\\/]esbuild$/);
  assert.doesNotMatch(String(esbuild), /[\\/]\.bin[\\/]/);
  assert.ok(existsSync(String(esbuild)), "the resolved esbuild entry must exist");
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.devDependencies?.esbuild, undefined);
  assert.equal(manifest.dependencies?.esbuild, undefined);
});

test("signing material and local databases are on the never-ship list", () => {
  // Guard the intent, not the exact list: a future config edit may add
  // patterns, but these must never quietly disappear.
  const joined = support.FORBIDDEN_PACKAGED_PATTERNS.join(" ");
  for (const must of ["*.p12", "*.mobileprovision", "*.db"]) {
    assert.ok(joined.includes(must), `FORBIDDEN_PACKAGED_PATTERNS lost ${must}`);
  }
  const config = readFileSync(join(PACKAGE_DIR, "electron-builder.yml"), "utf8");
  // The asar file list repeats the exclusion (belt and braces).
  assert.match(config, /!\*\*\/\*\.p12/);
});

test("the app runtime floor matches what the shell enforces", () => {
  // paths.cjs gates the shell at startup; the build probe gates the artifact.
  // If these drift, a build could pass and the app refuse to launch.
  const pathsSource = readFileSync(join(PACKAGE_DIR, "main", "paths.cjs"), "utf8");
  assert.equal(support.MIN_NODE_MAJOR, 24);
  assert.match(pathsSource, /MIN_NODE_MAJOR = 24/);
  // The daemon needs `node:sqlite`, which lands in Node 24. Check the declared
  // Electron range rather than resolving electron/package.json: that package is
  // a devDependency of the desktop package only, so it is not resolvable from
  // the root test process (and asserting it exists here would couple the unit
  // suite to an optional ~120MB download).
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.match(manifest.devDependencies?.electron ?? "", /^\^?4[5-9]|^\^?[5-9]\d/);
  // Strategy A depends on this pairing: electron >= 45 bundles Node >= 24.
  assert.match(pathsSource, /ELECTRON_RUN_AS_NODE/);
});
