import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Tests for the desktop shell's launch-path resolution
 * (packages/fit-trace-desktop/main/paths.cjs — plain Node, no electron).
 *
 * This is the module that makes the packaged app work at all, so the cases
 * pin the two layouts explicitly rather than testing "it returns a string":
 * dev must keep resolving the repo's `cli.ts` and let the daemon pick its own
 * `app/dist`, and packaged must resolve everything under `resourcesPath`,
 * spawn the app's own binary, and force `ELECTRON_RUN_AS_NODE=1` on the child.
 */

const require = createRequire(import.meta.url);
const paths = require("../packages/fit-trace-desktop/main/paths.cjs") as {
  PACKAGED_DAEMON_FILE: string;
  PACKAGED_EXTENSION_FILE: string;
  PACKAGED_DIST_DIR: string;
  MIN_NODE_MAJOR: number;
  resolveLaunchPlan: (options: {
    packaged: boolean;
    resourcesPath: string;
    devRepoRoot: string;
    execPath: string;
    env: NodeJS.ProcessEnv;
  }) => {
    mode: "packaged" | "dev";
    nodePath: string;
    daemonPath: string;
    distDir: string | undefined;
    extensionPath: string | undefined;
    env: NodeJS.ProcessEnv;
  };
  nodeMajor: (version: string) => number;
  isSupportedNodeVersion: (version: string) => boolean;
  describeLaunchPlan: (plan: {
    mode: string;
    nodePath: string;
    daemonPath: string;
    distDir?: string;
    extensionPath?: string;
  }) => string;
};

const RESOURCES = "/Applications/fit-trace.app/Contents/Resources";
const REPO_ROOT = "/repo/agent-fit-trace";
const APP_BINARY = "/Applications/fit-trace.app/Contents/MacOS/fit-trace";
const DAEMON_BUNDLE = join(RESOURCES, "daemon.mjs");
const STAGED_DIST = join(RESOURCES, "app-dist");
const BUNDLED_EXTENSION = join(RESOURCES, "pi-extension.mjs");

test("packaged: launches the bundled daemon with the app's own binary as node", () => {
  const plan = paths.resolveLaunchPlan({
    packaged: true,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: APP_BINARY,
    env: { PATH: "/usr/bin" },
  });

  assert.equal(plan.mode, "packaged");
  // Strategy A: no separate node binary ships with the app.
  assert.equal(plan.nodePath, APP_BINARY);
  assert.equal(plan.daemonPath, DAEMON_BUNDLE);
  // The shell path must be explicit: the daemon's own default is
  // import.meta.url-relative and would resolve against the bundle.
  assert.equal(plan.distDir, STAGED_DIST);
  // Same for the pi extension: the bundled copy is the only loadable one
  // inside the app, and the daemon also derives coaching availability from it.
  assert.equal(plan.extensionPath, BUNDLED_EXTENSION);
  // The file name is a contract with electron-builder.yml extraResources.
  assert.equal(paths.PACKAGED_EXTENSION_FILE, "pi-extension.mjs");
  // The child only behaves as node when this is set for the child.
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
  // Unrelated environment passes through untouched.
  assert.equal(plan.env.PATH, "/usr/bin");
});

test("packaged: nothing resolves outside the app bundle (no repo dependency)", () => {
  const plan = paths.resolveLaunchPlan({
    packaged: true,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: APP_BINARY,
    env: {},
  });

  // A packaged app must never point at the build machine's checkout.
  assert.ok(
    !plan.daemonPath.startsWith(REPO_ROOT),
    `packaged daemonPath must not reference the repo: ${plan.daemonPath}`,
  );
  assert.ok(
    plan.distDir !== undefined && !plan.distDir.startsWith(REPO_ROOT),
    `packaged distDir must not reference the repo: ${String(plan.distDir)}`,
  );
  assert.ok(plan.daemonPath.startsWith(RESOURCES));
  assert.ok(plan.distDir?.startsWith(RESOURCES));
  assert.ok(
    plan.extensionPath !== undefined && plan.extensionPath.startsWith(RESOURCES),
    `packaged extensionPath must live in resources: ${String(plan.extensionPath)}`,
  );
  // The file names are a contract with electron-builder.yml extraResources.
  assert.equal(paths.PACKAGED_DAEMON_FILE, "daemon.mjs");
  assert.equal(paths.PACKAGED_DIST_DIR, "app-dist");
  assert.equal(paths.PACKAGED_EXTENSION_FILE, "pi-extension.mjs");
});

test("dev: keeps the repo cli.ts and lets the daemon resolve its own app/dist", () => {
  const plan = paths.resolveLaunchPlan({
    packaged: false,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: "/usr/local/bin/electron",
    env: {},
  });

  assert.equal(plan.mode, "dev");
  // Bare `node` from PATH: dev has a real runtime and never needs the flag.
  assert.equal(plan.nodePath, "node");
  assert.equal(plan.daemonPath, join(REPO_ROOT, "packages/fit-trace-cli/src/cli.ts"));
  // Deliberately undefined: dev behaviour must be byte-for-byte unchanged, so
  // the daemon keeps its own <repo>/app/dist default.
  assert.equal(plan.distDir, undefined);
  // Symmetrically undefined: the daemon resolves
  // <repo>/.pi/extensions/fit-trace/index.ts itself in a checkout.
  assert.equal(plan.extensionPath, undefined);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("dev: FIT_TRACE_DESKTOP_NODE still selects the runtime, and empty means unset", () => {
  const explicit = paths.resolveLaunchPlan({
    packaged: false,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: "/usr/local/bin/electron",
    env: { FIT_TRACE_DESKTOP_NODE: "/opt/node/bin/node" },
  });
  assert.equal(explicit.nodePath, "/opt/node/bin/node");

  const empty = paths.resolveLaunchPlan({
    packaged: false,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: "/usr/local/bin/electron",
    env: { FIT_TRACE_DESKTOP_NODE: "" },
  });
  assert.equal(empty.nodePath, "node");
});

test("the resolved paths never alias the caller's env object", () => {
  // The child env is mutated with ELECTRON_RUN_AS_NODE in packaged mode; if it
  // were the caller's own `process.env`, the flag would leak into the shell
  // itself (which would then refuse to start as a GUI app).
  const callerEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const plan = paths.resolveLaunchPlan({
    packaged: true,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: APP_BINARY,
    env: callerEnv,
  });
  assert.notEqual(plan.env, callerEnv);
  assert.equal(callerEnv.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
});

test("nodeMajor parses correctly and rejects nonsense", () => {
  assert.equal(paths.nodeMajor("24.22.0"), 24);
  assert.equal(paths.nodeMajor("24"), 24);
  assert.ok(Number.isNaN(paths.nodeMajor("")));
  assert.ok(Number.isNaN(paths.nodeMajor("v24.1.0")));
  assert.ok(Number.isNaN(paths.nodeMajor("abc")));
});

test("isSupportedNodeVersion requires the node:sqlite floor (Node >= 24)", () => {
  assert.equal(paths.MIN_NODE_MAJOR, 24);
  assert.equal(paths.isSupportedNodeVersion("24.22.0"), true);
  assert.equal(paths.isSupportedNodeVersion("25.0.0"), true);
  assert.equal(paths.isSupportedNodeVersion("23.11.1"), false);
  assert.equal(paths.isSupportedNodeVersion("22.20.0"), false);
  assert.equal(paths.isSupportedNodeVersion(""), false);
});

test("describeLaunchPlan names mode, node, daemon, and (packaged) dist", () => {
  const packaged = paths.describeLaunchPlan({
    mode: "packaged",
    nodePath: APP_BINARY,
    daemonPath: DAEMON_BUNDLE,
    distDir: STAGED_DIST,
  });
  assert.match(packaged, /mode=packaged/);
  assert.match(packaged, /node=.*fit-trace/);
  assert.match(packaged, /daemon=.*daemon\.mjs/);
  assert.match(packaged, /dist=.*app-dist/);

  const dev = paths.describeLaunchPlan({
    mode: "dev",
    nodePath: "node",
    daemonPath: join(REPO_ROOT, "packages/fit-trace-cli/src/cli.ts"),
  });
  assert.match(dev, /mode=dev/);
  // Dev omits dist on purpose (the daemon resolves it).
  assert.doesNotMatch(dev, /dist=/);
});

test("packaged paths stay inside the app bundle, never the user's home", () => {
  // A regression guard with teeth: an absolute-path bug would place the
  // daemon/staged shell in the user's home or the repo instead of the bundle.
  const plan = paths.resolveLaunchPlan({
    packaged: true,
    resourcesPath: RESOURCES,
    devRepoRoot: REPO_ROOT,
    execPath: APP_BINARY,
    env: {},
  });
  for (const resolved of [plan.daemonPath, String(plan.distDir)]) {
    assert.ok(!resolved.startsWith(homedir()), `${resolved} must not live in the home dir`);
    assert.ok(!resolved.includes("node_modules"), `${resolved} must not reference node_modules`);
  }
});

test("main.cjs no longer hard-codes a repo-layout CLI path", () => {
  // The packaging bug this change fixes: `path.join(__dirname, "..","..","..")`
  // + `packages/fit-trace-cli/src/cli.ts` breaks as soon as the shell is packed
  // into app.asar. Guard the shape, not the implementation.
  const manifest = require("../packages/fit-trace-desktop/package.json") as {
    main?: string;
  };
  assert.equal(manifest.main, "main/main.cjs");
  const mainSource = require("node:fs").readFileSync(
    join(import.meta.dirname, "..", "packages", "fit-trace-desktop", "main", "main.cjs"),
    "utf8",
  ) as string;
  assert.doesNotMatch(
    mainSource,
    /packages["'],\s*["']fit-trace-cli/,
    "main.cjs must not build the CLI path from a repo layout",
  );
  assert.match(mainSource, /resolveLaunchPlan/, "main.cjs must delegate path resolution to paths.cjs");
});
