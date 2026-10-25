import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Isolation guard for the desktop shell (issue #41): electron must exist only
 * as the devDependency of packages/fit-trace-desktop — never at the root and
 * never in any other workspace package. Reads package.json files directly so
 * a stray `pnpm add electron` elsewhere fails this suite.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface PackageJson {
  name?: string;
  private?: boolean;
  main?: string;
  type?: string;
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

test("root package.json has no electron dependency and keeps the desktop:dev script", () => {
  const root = readPackageJson("package.json");
  for (const [section, deps] of dependencySections(root)) {
    assert.ok(
      deps === undefined || !Object.hasOwn(deps, "electron"),
      `root package.json must not list electron in ${section}`,
    );
  }
  assert.equal(root.scripts?.["desktop:dev"], "pnpm --filter @agent-fit-trace/desktop run dev");
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

test("electron exists exactly once: desktop devDependencies, never its runtime deps", () => {
  const desktop = readPackageJson("packages/fit-trace-desktop/package.json");
  assert.equal(desktop.name, "@agent-fit-trace/desktop");
  assert.ok(
    desktop.devDependencies !== undefined && Object.hasOwn(desktop.devDependencies, "electron"),
    "electron must be a devDependency of @agent-fit-trace/desktop",
  );
  assert.match(desktop.devDependencies?.electron ?? "", /^\^?\d/);
  for (const [section, deps] of dependencySections(desktop)) {
    if (section === "devDependencies") {
      continue;
    }
    assert.ok(
      deps === undefined || !Object.hasOwn(deps, "electron"),
      `desktop package.json must not list electron in ${section}`,
    );
  }
});

test("the desktop package keeps its no-build v1 shape (commonjs, dev-only entry)", () => {
  const desktop = readPackageJson("packages/fit-trace-desktop/package.json");
  assert.equal(desktop.type, "commonjs");
  assert.equal(desktop.main, "main/main.cjs");
  assert.equal(desktop.scripts?.dev, "node scripts/dev.cjs");
  assert.ok(desktop.private, "the desktop package stays private (no publish, no packaging in v1)");
});
