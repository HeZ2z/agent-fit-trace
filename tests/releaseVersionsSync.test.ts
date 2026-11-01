import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `scripts/sync-versions.mjs` is the release guard that keeps the root
 * `package.json` version authoritative. These tests pin the two behaviors the
 * release workflow depends on — `--check` reports drift and exits non-zero, and
 * the write mode stamps copies without touching anything else — against
 * fixture trees under a temp root, so no committed file is ever rewritten here.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "sync-versions.mjs");

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "fit-trace-sync-versions-"));

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

interface FixtureOptions {
  rootVersion?: string;
  appVersion?: string;
  packageVersions?: Record<string, string>;
  mobileVersion?: string;
  expoVersion?: string;
}

let fixtureCount = 0;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Build a miniature checkout: root manifest, app/, packages/<name>/,
 * mobile/package.json and mobile/app.json. The shape mirrors the real tree
 * closely enough for path discovery and the depth-sensitive version rewrite.
 */
function makeFixture(options: FixtureOptions = {}): string {
  const root = join(TEMP_ROOT, `fixture-${fixtureCount}`);
  fixtureCount += 1;
  const rootVersion = options.rootVersion ?? "0.1.0";

  mkdirSync(root, { recursive: true });
  writeJson(join(root, "package.json"), { name: "agent-fit-trace", version: rootVersion, private: true });

  mkdirSync(join(root, "app"), { recursive: true });
  writeJson(join(root, "app", "package.json"), {
    name: "@agent-fit-trace/app",
    version: options.appVersion ?? rootVersion,
    private: true,
  });

  const packageVersions = options.packageVersions ?? { core: rootVersion, cli: rootVersion };
  for (const [name, version] of Object.entries(packageVersions)) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeJson(join(root, "packages", name, "package.json"), {
      name: `@agent-fit-trace/${name}`,
      version,
      private: true,
    });
  }

  mkdirSync(join(root, "mobile"), { recursive: true });
  writeJson(join(root, "mobile", "package.json"), {
    name: "@agent-fit-trace/mobile",
    version: options.mobileVersion ?? rootVersion,
    private: true,
  });
  writeJson(join(root, "mobile", "app.json"), {
    expo: {
      name: "Fit Trace",
      slug: "fit-trace",
      version: options.expoVersion ?? rootVersion,
      android: { package: "com.pifittrace.app" },
    },
  });

  return root;
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("the repository tree is in lockstep", () => {
  const result = runScript(["--check"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sync-versions: up to date \(0\.\d+\.\d+/);
});

test("--check passes on a fixture whose copies all match", () => {
  const root = makeFixture();
  const result = runScript(["--check", "--root", root]);

  assert.equal(result.status, 0, result.stderr);
  // Five targets: root is the reference, so app/, packages/core, packages/cli,
  // mobile/package.json and mobile/app.json are compared.
  assert.match(result.stdout, /up to date \(0\.1\.0; 5 file\(s\) checked\)/);
});

test("--check lists every drifted file and exits non-zero", () => {
  const root = makeFixture({
    appVersion: "0.2.0",
    packageVersions: { core: "0.1.1", cli: "0.1.0" },
    expoVersion: "0.0.9",
  });
  const result = runScript(["--check", "--root", root]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /3 file\(s\) disagree with the root package\.json version 0\.1\.0/);
  assert.match(result.stderr, /app\/package\.json\s+0\.2\.0\s+→ 0\.1\.0/);
  assert.match(result.stderr, /packages\/core\/package\.json\s+0\.1\.1\s+→ 0\.1\.0/);
  assert.match(result.stderr, /mobile\/app\.json expo\.version\s+0\.0\.9\s+→ 0\.1\.0/);
  // The in-lockstep copy is never listed as drift.
  assert.doesNotMatch(result.stderr, /packages\/cli\/package\.json/);
});

test("write mode stamps every copy from the root version", () => {
  const root = makeFixture({
    rootVersion: "1.2.3",
    appVersion: "1.2.2",
    packageVersions: { core: "0.1.0", cli: "1.2.3" },
    mobileVersion: "0.0.1",
    expoVersion: "9.9.9",
  });

  const write = runScript(["--root", root]);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /stamped 4 file\(s\) at 1\.2\.3/);

  const check = runScript(["--check", "--root", root]);
  assert.equal(check.status, 0, check.stderr);
});

test("write mode preserves key order, formatting and unrelated fields", () => {
  const root = makeFixture({ appVersion: "0.0.1" });
  const appPath = join(root, "app", "package.json");
  const appJsonPath = join(root, "mobile", "app.json");
  const appBefore = readFileSync(appPath, "utf8");
  const appJsonBefore = readFileSync(appJsonPath, "utf8");

  const write = runScript(["--root", root]);
  assert.equal(write.status, 0, write.stderr);

  // Only the version value changes — the byte diff is exactly one line.
  const appAfter = readFileSync(appPath, "utf8");
  assert.equal(appAfter.replace('"version": "0.1.0"', '"version": "0.0.1"'), appBefore);
  assert.equal(appJsonBefore, readFileSync(appJsonPath, "utf8"), "mobile/app.json was already in lockstep");

  const app = JSON.parse(appAfter) as Record<string, unknown>;
  assert.deepEqual(Object.keys(app), ["name", "version", "private"]);
  assert.equal(app.version, "0.1.0");
  assert.match(appAfter, /\n$/, "trailing newline survives the rewrite");

  const expo = (JSON.parse(readFileSync(appJsonPath, "utf8")) as { expo: Record<string, unknown> }).expo;
  assert.deepEqual(Object.keys(expo), ["name", "slug", "version", "android"]);
});

test("a second write run is a no-op", () => {
  const root = makeFixture({ appVersion: "0.5.0" });
  assert.equal(runScript(["--root", root]).status, 0);

  const second = runScript(["--root", root]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /nothing to do/);
});

test("a missing version field is a hard error, not a silent skip", () => {
  const root = makeFixture();
  writeJson(join(root, "mobile", "app.json"), { expo: { name: "Fit Trace" } });

  const result = runScript(["--check", "--root", root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mobile\/app\.json expo\.version: no version field/);
});

test("an unparseable manifest is reported with the offending file", () => {
  const root = makeFixture();
  writeFileSync(join(root, "packages", "core", "package.json"), "{ not json", "utf8");

  const result = runScript(["--check", "--root", root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/core\/package\.json is not valid JSON/);
});

test("a non-semver root version is rejected", () => {
  const root = makeFixture({ rootVersion: "v0.1" });

  const result = runScript(["--check", "--root", root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a plain semver string/);
});

test("unknown arguments print the usage block", () => {
  const result = runScript(["--bogus"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument "--bogus"/);
  assert.match(result.stderr, /node scripts\/sync-versions\.mjs --check/);
});

test("--help exits zero and documents both modes", () => {
  const result = runScript(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stamp every copy from the root version/);
  assert.match(result.stdout, /verify only; exit 1 if any copy drifted/);
});
