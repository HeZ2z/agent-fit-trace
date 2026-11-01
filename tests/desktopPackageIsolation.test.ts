import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Isolation guard for the desktop shell (issue #41, extended by the unsigned
 * packaging change).
 *
 * Two invariants, both deliberate:
 *
 * 1. ELECTRON CONFINEMENT (unchanged): electron exists only as the
 *    devDependency of packages/fit-trace-desktop — never at the root and never
 *    in any other workspace package. A stray `pnpm add electron` elsewhere
 *    fails this suite.
 *
 * 2. PACKAGING POSTURE (new): the desktop app IS buildable now, but only as an
 *    UNSIGNED INTERNAL build. This suite guards what that means concretely:
 *    packaging config exists and targets the agreed platforms, nothing
 *    signing-related is committed, no auto-update channel is configured, and
 *    the package still carries no runtime `dependencies` (the daemon is a
 *    self-contained bundle, so a runtime dep would be a packaging bug).
 *
 * What this file deliberately NO LONGER asserts: the old "no packaging in v1"
 * shape (`private: true` + only a `dev` script). That decision was superseded
 * by the user-approved unsigned-packaging decision recorded in
 * docs/adr/0006-desktop-packaging.md; the assertions were replaced, not
 * deleted, so the boundary is still defended.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP_DIR = join(REPO_ROOT, "packages", "fit-trace-desktop");

interface PackageJson {
  name?: string;
  private?: boolean;
  main?: string;
  type?: string;
  productName?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(relativePath: string): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as PackageJson;
}

function dependencySections(pkg: PackageJson): Array<[string, Record<string, string> | undefined]> {
  return [
    ["dependencies", pkg.dependencies],
    ["devDependencies", pkg.devDependencies],
    ["optionalDependencies", pkg.optionalDependencies],
    ["peerDependencies", pkg.peerDependencies],
  ];
}

test("root package.json has no electron dependency and keeps the desktop scripts", () => {
  const root = readPackageJson("package.json");
  for (const [section, deps] of dependencySections(root)) {
    assert.ok(
      deps === undefined || !Object.hasOwn(deps, "electron"),
      `root package.json must not list electron in ${section}`,
    );
    // electron-builder is the packaging tool of ONE package, never the root.
    assert.ok(
      deps === undefined || !Object.hasOwn(deps, "electron-builder"),
      `root package.json must not list electron-builder in ${section}`,
    );
  }
  assert.equal(root.scripts?.["desktop:dev"], "pnpm --filter @agent-fit-trace/desktop run dev");
});

test("root package.json exposes desktop:build and desktop:package as thin wrappers", () => {
  // release-ci's workflow calls these two names; the real work stays in the
  // desktop package so the root manifest holds no packaging logic.
  const root = readPackageJson("package.json");
  // The root wrappers are owned by the Lead. If they are not present yet this
  // assertion is the reminder — it fails loudly rather than silently shipping a
  // workflow that calls a nonexistent script.
  assert.equal(root.scripts?.["desktop:build"], "pnpm --filter @agent-fit-trace/desktop run build");
  assert.equal(root.scripts?.["desktop:package"], "pnpm --filter @agent-fit-trace/desktop run package");
});

test("no workspace package except fit-trace-desktop mentions electron at all", () => {
  // packages/ plus the two top-level workspace packages (app/, mobile/).
  const manifestPaths: string[] = ["app/package.json", "mobile/package.json"];
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      manifestPaths.push(`packages/${entry.name}/package.json`);
    }
  }

  for (const manifestPath of manifestPaths) {
    const pkg = readPackageJson(manifestPath);
    if (pkg.name === "@agent-fit-trace/desktop") {
      continue;
    }
    for (const [section, deps] of dependencySections(pkg)) {
      assert.ok(
        deps === undefined || !Object.hasOwn(deps, "electron"),
        `${manifestPath} must not list electron in ${section}`,
      );
    }
    const raw = readFileSync(join(REPO_ROOT, manifestPath), "utf8");
    assert.ok(!raw.includes("electron"), `${manifestPath} mentions "electron" outside dependencies`);
  }
});

test("electron and electron-builder exist exactly once: desktop devDependencies", () => {
  const desktop = readPackageJson("packages/fit-trace-desktop/package.json");
  assert.equal(desktop.name, "@agent-fit-trace/desktop");
  for (const tool of ["electron", "electron-builder"]) {
    assert.ok(
      desktop.devDependencies !== undefined && Object.hasOwn(desktop.devDependencies, tool),
      `${tool} must be a devDependency of @agent-fit-trace/desktop`,
    );
  }
  assert.match(desktop.devDependencies?.electron ?? "", /^\^?\d/);
  assert.match(desktop.devDependencies?.["electron-builder"] ?? "", /^\^?\d/);
  // Everything else must stay free of them.
  for (const [section, deps] of dependencySections(desktop)) {
    if (section === "devDependencies") {
      continue;
    }
    for (const tool of ["electron", "electron-builder"]) {
      assert.ok(
        deps === undefined || !Object.hasOwn(deps, tool),
        `desktop package.json must not list ${tool} in ${section}`,
      );
    }
  }
});

test("the desktop package keeps its no-build-chain shape for the shell itself", () => {
  const desktop = readPackageJson("packages/fit-trace-desktop/package.json");
  assert.equal(desktop.type, "commonjs");
  assert.equal(desktop.main, "main/main.cjs");
  assert.equal(desktop.scripts?.dev, "node scripts/dev.cjs");
  // Still private: an internal unsigned app is not an npm publication.
  assert.ok(desktop.private, "the desktop package stays private (no npm publish)");
  // No runtime dependencies: the daemon is a self-contained esbuild bundle and
  // the shell is plain .cjs. A runtime dep here means packaging is broken.
  assert.equal(desktop.dependencies, undefined, "the packaged app must not need runtime node_modules");
});

test("packaging scripts exist under the names release-ci calls", () => {
  const desktop = readPackageJson("packages/fit-trace-desktop/package.json");
  assert.equal(desktop.productName, "fit-trace");
  for (const script of ["build", "build:daemon", "prepare:runtime", "build:runtime", "package"]) {
    const command = desktop.scripts?.[script];
    assert.ok(command !== undefined, `missing desktop script: ${script}`);
    assert.match(command, /^node scripts\/[\w.]+\.cjs/, `${script} must run a plain .cjs script`);
    const scriptFile = command.replace(/^node /, "").split(" ")[0] ?? "";
    assert.ok(existsSync(join(DESKTOP_DIR, scriptFile)), `${script} points at a missing file: ${scriptFile}`);
  }
});

test("electron-builder config targets the agreed platforms and output dir", () => {
  const configPath = join(DESKTOP_DIR, "electron-builder.yml");
  assert.ok(existsSync(configPath), "electron-builder.yml must exist for a packageable app");
  const config = readFileSync(configPath, "utf8");
  // Artifact output is a contract with release-ci's upload path.
  assert.match(config, /output:\s*release/);
  assert.match(config, /appId:\s*com\.agentfittrace\.desktop/);
  assert.match(config, /productName:\s*fit-trace/);
  // mac dmg/zip, win nsis/portable, linux AppImage.
  for (const target of ["dmg", "zip", "nsis", "portable", "AppImage"]) {
    assert.match(config, new RegExp(`target:\\s*${target}`), `missing ${target} target`);
  }
  // No hardcoded `arch:` list: the Electron payload comes from the workspace's
  // installed electron (host arch), so declaring extra arches would emit
  // mislabelled artifacts — an arm64 binary under an x64 name.
  assert.doesNotMatch(config, /^\s+arch:\s*\[/m, "arch must follow the build host, not a hardcoded list");
  // The daemon bundle and staged web shell ship as extraResources, which is
  // how main/paths.cjs finds them in a packaged app.
  assert.match(config, /from:\s*staging\/daemon\.mjs/);
  assert.match(config, /from:\s*staging\/app-dist/);
  // `!node_modules/**` is load-bearing: electron-builder appends its own
  // `**/*` nodeModuleFilePatterns, which packed the whole pnpm dependency graph
  // (~40MB / 5869 files) into app.asar until this exclusion was added. The
  // packaged app reads none of it — the daemon is a self-contained bundle.
  assert.match(config, /"?!node_modules\/\*\*/, "the asar must exclude node_modules explicitly");
});

test("the packaging config is explicitly unsigned and has no auto-update", () => {
  const config = readFileSync(join(DESKTOP_DIR, "electron-builder.yml"), "utf8");
  // `identity: null` rather than merely absent: a keychain identity must never
  // be auto-discovered, even on a maintainer's machine.
  assert.match(config, /identity:\s*null/, "mac identity must be explicitly null (unsigned)");
  assert.match(config, /notarize:\s*false/, "notarization must be explicitly off");
  // No publisher / updater: this round ships no update channel, and an
  // unsigned update path would be worse than none.
  assert.doesNotMatch(config, /^\s*publish:/m, "no publish block while builds are unsigned");
  assert.doesNotMatch(config, /autoUpdater|electron-updater/, "no auto-update wiring this round");
});

test("no signing material or local database is committed under the desktop package", () => {
  // This round is explicitly unsigned; a committed cert/profile would mean
  // someone wired signing in behind the ADR.
  const forbidden = [
    /\.p12$/i,
    /\.pfx$/i,
    /\.cer$/i,
    /\.mobileprovision$/i,
    /\.provisionprofile$/i,
    /\.pem$/i,
    /\.key$/i,
    /\.db$/i,
    /\.sqlite3?$/i,
  ];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Build outputs are gitignored artifacts, not committed material.
      if (entry.name === "node_modules" || entry.name === "release" || entry.name === "staging" || entry.name === ".cache") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (forbidden.some((pattern) => pattern.test(entry.name))) {
        offenders.push(full.slice(DESKTOP_DIR.length + 1));
      }
    }
  };
  walk(DESKTOP_DIR);
  assert.deepEqual(offenders, [], `signing material / databases must not be committed: ${offenders.join(", ")}`);
});

test("build outputs stay out of version control", () => {
  const ignore = readFileSync(join(DESKTOP_DIR, ".gitignore"), "utf8");
  for (const entry of ["staging/", "release/", ".cache/"]) {
    assert.ok(ignore.includes(entry), `.gitignore must ignore ${entry}`);
  }
});
