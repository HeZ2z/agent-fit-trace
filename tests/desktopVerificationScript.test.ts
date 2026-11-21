import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  DESKTOP_EVIDENCE,
  DESKTOP_REQUIRED_EVIDENCE,
  DESKTOP_SCENARIO_EXPECTED,
  DESKTOP_STEP_IDS,
  DESKTOP_WORKOUT,
  computeAppTreeDigest,
  defaultDesktopAppPath,
  desktopLaunchArgs,
  desktopLaunchEnvironment,
  findDaemonDescendant,
  parseDesktopCliOptions,
  parseDevToolsActivePort,
  parseDevToolsListeningLine,
  parseProcessTable,
  portFromLoopbackUrl,
  resolveDesktopApp,
  selectDesktopPageTarget,
} from "../scripts/verification/desktop.ts";
import type { DesktopAppDeps, TargetDescriptor } from "../scripts/verification/desktop.ts";
import {
  DESKTOP_SCENARIO_ID,
  MANIFEST_SCHEMA,
  buildManifest,
  evaluateCleanup,
  exitCodeForOutcome,
} from "../scripts/verification/helpers.ts";
import type { ManifestInput, Provenance } from "../scripts/verification/helpers.ts";

/** Minimal in-memory filesystem for bundle resolution. */
function fakeDeps(files: Record<string, string>, directories: readonly string[]): DesktopAppDeps {
  const dirs = new Set(directories);
  return {
    exists: (candidate) => candidate in files || dirs.has(candidate),
    isDirectory: (candidate) => dirs.has(candidate),
    readDirectory: (candidate) => {
      const prefix = `${candidate}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (file.startsWith(prefix)) {
          const rest = file.slice(prefix.length);
          names.add(rest.includes("/") ? rest.split("/")[0] : rest);
        }
      }
      return [...names].sort();
    },
    readPlistValue: (plistPath, key) => files[`${plistPath}#${key}`] ?? null,
  };
}

const APP = "/Applications/fit-trace.app";
const CONTENTS = `${APP}/Contents`;
const MACOS = `${CONTENTS}/MacOS`;
const PLIST = `${CONTENTS}/Info.plist`;

function baseFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [`${MACOS}/fit-trace`]: "binary",
    [`${PLIST}#CFBundleExecutable`]: "fit-trace",
    [`${PLIST}#CFBundleShortVersionString`]: "0.1.0",
    [`${PLIST}#CFBundleIdentifier`]: "com.agentfittrace.desktop",
    ...overrides,
  };
}

test("parseDesktopCliOptions applies defaults and accepts every documented flag", () => {
  assert.deepEqual(parseDesktopCliOptions([]), {
    help: false,
    app: null,
    headed: false,
    evidence: null,
    keepData: false,
    timeoutMs: 30_000,
  });
  assert.deepEqual(
    parseDesktopCliOptions([
      "--app",
      "/tmp/fit-trace.app",
      "--headed",
      "--evidence",
      "/tmp/evidence",
      "--keep-data",
      "--timeout",
      "45000",
    ]),
    {
      help: false,
      app: "/tmp/fit-trace.app",
      headed: true,
      evidence: "/tmp/evidence",
      keepData: true,
      timeoutMs: 45_000,
    },
  );
  assert.equal(parseDesktopCliOptions(["--help"]).help, true);
  assert.throws(() => parseDesktopCliOptions(["--timeout", "999"]), /--timeout must be an integer/);
  assert.throws(() => parseDesktopCliOptions(["--timeout", "soon"]), /--timeout must be an integer/);
  assert.throws(() => parseDesktopCliOptions(["--app"]), /--app requires a path/);
  assert.throws(() => parseDesktopCliOptions(["--evidence"]), /--evidence requires a path/);
  assert.throws(() => parseDesktopCliOptions(["--bogus"]), /unknown argument/);
});

test("defaultDesktopAppPath prefers the host-arch release directory", () => {
  const repo = "/repo";
  const arm = path.join(repo, "packages", "fit-trace-desktop", "release", "mac-arm64", "fit-trace.app");
  const generic = path.join(repo, "packages", "fit-trace-desktop", "release", "mac", "fit-trace.app");
  assert.equal(defaultDesktopAppPath(repo, "arm64", () => true), arm);
  assert.equal(defaultDesktopAppPath(repo, "arm64", (candidate) => candidate === generic), generic);
  // Nothing exists: report the canonical path so the precondition names a real target.
  assert.equal(defaultDesktopAppPath(repo, "arm64", () => false), arm);
});

test("resolveDesktopApp uses CFBundleExecutable and reads bundle metadata", () => {
  const deps = fakeDeps(baseFiles(), [APP, CONTENTS, MACOS]);
  const info = resolveDesktopApp(APP, deps);
  assert.notEqual(info, null);
  assert.equal(info?.appPath, APP);
  assert.equal(info?.executable, `${MACOS}/fit-trace`);
  assert.equal(info?.version, "0.1.0");
  assert.equal(info?.bundleId, "com.agentfittrace.desktop");
});

test("resolveDesktopApp falls back to fit-trace and to a single MacOS entry", () => {
  const conventional = fakeDeps(baseFiles(), [APP, CONTENTS, MACOS]);
  assert.equal(resolveDesktopApp(APP, conventional)?.executable, `${MACOS}/fit-trace`);

  const renamed = fakeDeps(
    {
      [`${MACOS}/renamed`]: "binary",
      [`${PLIST}#CFBundleShortVersionString`]: "1.2.3",
    },
    [APP, CONTENTS, MACOS],
  );
  assert.equal(resolveDesktopApp(APP, renamed)?.executable, `${MACOS}/renamed`);
  assert.equal(resolveDesktopApp(APP, renamed)?.version, "1.2.3");
  assert.equal(resolveDesktopApp(APP, renamed)?.bundleId, null);

  const declared = fakeDeps(
    baseFiles({ [`${MACOS}/custom`]: "binary", [`${PLIST}#CFBundleExecutable`]: "custom" }),
    [APP, CONTENTS, MACOS],
  );
  assert.equal(resolveDesktopApp(APP, declared)?.executable, `${MACOS}/custom`);
});

test("resolveDesktopApp rejects paths that are not macOS bundles", () => {
  const deps = fakeDeps(baseFiles(), [APP, CONTENTS, MACOS]);
  assert.equal(resolveDesktopApp("/missing/fit-trace.app", deps), null);
  // Exists, but only as a file.
  assert.equal(resolveDesktopApp(PLIST, deps), null);
  // Directory without Contents/MacOS.
  const noMacOS = fakeDeps({}, [APP, CONTENTS]);
  assert.equal(resolveDesktopApp(APP, noMacOS), null);
  // macOS directory with no executable candidate.
  const emptyMacOS = fakeDeps({}, [APP, CONTENTS, MACOS]);
  assert.equal(resolveDesktopApp(APP, emptyMacOS), null);
});

test("computeAppTreeDigest is order-independent, byte-sensitive, and hashes symlinks", () => {
  const index = new TextEncoder().encode("<!doctype html>");
  const binary = new TextEncoder().encode("MZ");
  const entries = [
    { path: "Contents/MacOS/fit-trace", kind: "file" as const, bytes: binary },
    { path: "Contents/Info.plist", kind: "file" as const, bytes: index },
    { path: "Contents/Frameworks/Current", kind: "symlink" as const, target: "Versions/A" },
  ];
  const forward = computeAppTreeDigest(entries);
  const reversed = computeAppTreeDigest([...entries].reverse());
  assert.deepEqual(forward, reversed);
  assert.match(forward.sha256, /^[0-9a-f]{64}$/);
  assert.equal(forward.fileCount, 2);
  assert.equal(forward.bytes, index.byteLength + binary.byteLength);

  // Same paths and bytes, different symlink target -> different digest.
  const retargeted = computeAppTreeDigest([
    entries[0],
    entries[1],
    { path: "Contents/Frameworks/Current", kind: "symlink", target: "Versions/B" },
  ]);
  assert.notEqual(forward.sha256, retargeted.sha256);

  // One changed byte -> different digest.
  const mutated = computeAppTreeDigest([
    entries[0],
    { path: "Contents/Info.plist", kind: "file", bytes: new TextEncoder().encode("<!doctype HTML>") },
    entries[2],
  ]);
  assert.notEqual(forward.sha256, mutated.sha256);

  assert.throws(
    () =>
      computeAppTreeDigest([
        { path: "a", kind: "file", bytes: index },
        { path: "a", kind: "file", bytes: binary },
      ]),
    /duplicate tree path: a/,
  );
});

test("DevTools endpoint parsing accepts the port file and the stderr fallback", () => {
  assert.deepEqual(
    parseDevToolsActivePort("51234\n/devtools/browser/abc-def\n"),
    { port: 51234, browserWebSocketUrl: "ws://127.0.0.1:51234/devtools/browser/abc-def" },
  );
  assert.equal(parseDevToolsActivePort("0\n/devtools/browser/x"), null);
  assert.equal(parseDevToolsActivePort("not-a-port\n/devtools/browser/x"), null);
  assert.equal(parseDevToolsActivePort("51234\n/browser/x"), null);
  assert.equal(parseDevToolsActivePort("51234"), null);

  const fromLog = parseDevToolsListeningLine(
    "some noise\nDevTools listening on ws://127.0.0.1:60001/devtools/browser/xyz\n",
  );
  assert.deepEqual(fromLog, {
    port: 60001,
    browserWebSocketUrl: "ws://127.0.0.1:60001/devtools/browser/xyz",
  });
  assert.equal(parseDevToolsListeningLine("nothing here"), null);
});

test("selectDesktopPageTarget ignores retry/devtools targets and picks the daemon page", () => {
  const targets: TargetDescriptor[] = [
    { targetId: "devtools", type: "page", url: "devtools://devtools/bundled/inspector.html" },
    {
      targetId: "retry",
      type: "page",
      url: "data:text/html;charset=utf-8,%3Cp%3Erestarting%3C/p%3E",
    },
    { targetId: "blank", type: "background_page", url: "http://127.0.0.1:5555/" },
    { targetId: "app", type: "page", url: "http://127.0.0.1:5199/" },
    { targetId: "second", type: "page", url: "http://127.0.0.1:6000/analysis" },
  ];
  const selected = selectDesktopPageTarget(targets);
  assert.equal(selected?.targetId, "app");
  assert.equal(selectDesktopPageTarget([targets[0], targets[1], targets[2]]), null);
  assert.equal(portFromLoopbackUrl("http://127.0.0.1:5199/"), 5199);
  assert.equal(portFromLoopbackUrl("https://127.0.0.1:5199/"), null);
  assert.equal(portFromLoopbackUrl("data:text/html,hi"), null);
  assert.equal(portFromLoopbackUrl("http://127.0.0.1:5199/analysis"), 5199);
});

test("parseProcessTable and findDaemonDescendant locate the packaged daemon", () => {
  const table = [
    "  100     1 /Applications/fit-trace.app/Contents/MacOS/fit-trace",
    "  100     1 /Applications/fit-trace.app/Contents/MacOS/fit-trace --type=renderer",
    "  200   100 /Applications/fit-trace.app/Contents/MacOS/fit-trace /Applications/fit-trace.app/Contents/Resources/daemon.mjs daemon --port 0",
    "  300     1 /usr/libexec/other",
  ].join("\n");
  const rows = parseProcessTable(table);
  assert.deepEqual(rows[0], {
    pid: 100,
    ppid: 1,
    command: "/Applications/fit-trace.app/Contents/MacOS/fit-trace",
  });
  assert.equal(rows.length, 4);
  assert.equal(findDaemonDescendant(rows, 100), 200);
  assert.equal(findDaemonDescendant(rows, 300), null);
  assert.equal(findDaemonDescendant([], 100), null);
});

test("desktopLaunchEnvironment forces guest mode and isolates HOME/data dir", () => {
  const env = desktopLaunchEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      SUPABASE_ANON_KEY: "legacy",
      FIT_TRACE_API_BASE_URL: "https://api.example",
      FIT_TRACE_SYNC_PUBLIC_KEYS: "keys",
      FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH: "issuer",
      FIT_TRACE_CLOUD_API_BASE_URL: "https://cloud.example",
      FIT_TRACE_DATA_DIR: "/Users/someone/.fit-trace/data",
      ELECTRON_RUN_AS_NODE: "1",
    },
    { home: "/tmp/run/home", dataDir: "/tmp/run/data" },
  );
  assert.equal(env.HOME, "/tmp/run/home");
  assert.equal(env.FIT_TRACE_DATA_DIR, "/tmp/run/data");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.PATH, "/usr/bin");
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "FIT_TRACE_API_BASE_URL",
    "FIT_TRACE_CLOUD_API_BASE_URL",
    "FIT_TRACE_SYNC_PUBLIC_KEYS",
    "FIT_TRACE_SYNC_TRUSTED_SUPABASE_AUTH",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    assert.equal(key in env, false, `${key} must not reach the packaged app`);
  }
});

test("desktopLaunchArgs uses a fresh profile and headless only when not --headed", () => {
  const headless = desktopLaunchArgs({ userDataDir: "/tmp/electron-a", headed: false });
  assert.ok(headless.includes("--remote-debugging-port=0"));
  assert.ok(headless.includes("--user-data-dir=/tmp/electron-a"));
  assert.ok(headless.includes("--headless=new"));
  assert.ok(headless.includes("--disable-gpu"));

  const headed = desktopLaunchArgs({ userDataDir: "/tmp/electron-b", headed: true });
  assert.equal(headed.includes("--headless=new"), false);
  assert.ok(headed.includes("--user-data-dir=/tmp/electron-b"));
});

test("desktop scenario constants are the documented deterministic values", () => {
  assert.equal(DESKTOP_WORKOUT.exercise, "Barbell Bench Press - Medium Grip");
  assert.equal(DESKTOP_WORKOUT.weight, 80);
  assert.equal(DESKTOP_WORKOUT.reps, 5);
  assert.equal(DESKTOP_WORKOUT.rpe, 7);
  assert.deepEqual(
    { ...DESKTOP_SCENARIO_EXPECTED },
    { sessions: 1, totalSets: 1, totalReps: 5, volumeKg: 400, avgRpe: 7, sourceRecords: 1 },
  );
  assert.deepEqual(
    Object.values(DESKTOP_STEP_IDS),
    [
      "desktop-launch",
      "desktop-guest-config",
      "desktop-log",
      "desktop-reload",
      "desktop-quit",
      "desktop-reopen",
      "desktop-persisted",
      "desktop-analysis",
      "desktop-cleanup",
    ],
  );
  assert.ok(DESKTOP_REQUIRED_EVIDENCE.includes(DESKTOP_EVIDENCE.reopened));
  assert.ok(DESKTOP_REQUIRED_EVIDENCE.includes(DESKTOP_EVIDENCE.analysis));
  assert.ok(DESKTOP_REQUIRED_EVIDENCE.includes(DESKTOP_EVIDENCE.appLog));
});

test("evaluateCleanup accepts a desktop cleanup and fails on unconfirmed exit or open port", () => {
  const clean = {
    desktopApp: { stopped: true, exitConfirmed: true },
    daemonPorts: [
      { port: 5199, released: true },
      { port: 6000, released: true },
    ],
    tempRoot: { kept: false, deleted: true },
  };
  assert.deepEqual(evaluateCleanup(clean), { failed: false, reasons: [] });

  // The desktop cleanup has no chrome/daemon block; absent blocks are fine.
  assert.equal(evaluateCleanup({ tempRoot: { kept: true, deleted: false } }).failed, false);

  const unconfirmed = evaluateCleanup({
    ...clean,
    desktopApp: { stopped: true, exitConfirmed: false },
  });
  assert.equal(unconfirmed.failed, true);
  assert.match(unconfirmed.reasons.join("; "), /desktop app process exit was not confirmed/);

  const openPort = evaluateCleanup({
    ...clean,
    daemonPorts: [
      { port: 5199, released: true },
      { port: 6000, released: false },
    ],
  });
  assert.equal(openPort.failed, true);
  assert.match(openPort.reasons.join("; "), /daemon port 6000 was not released/);

  const undeleted = evaluateCleanup({ ...clean, tempRoot: { kept: false, deleted: false } });
  assert.equal(undeleted.failed, true);
  assert.match(undeleted.reasons.join("; "), /temporary workspace was not deleted/);
});

test("buildManifest carries the desktop scenario, artifact, launches, and cleanup", () => {
  const provenance: Provenance = {
    testedSha: "f9c64e3aeac8120b160ee5b08bb7505b48b48e4b",
    branch: "main",
    dirty: false,
    dirtyFileCount: 0,
    artifactSha256: "a".repeat(64),
    nodeVersion: "v24.22.3",
    chromeVersion: null,
    platform: "darwin",
    arch: "arm64",
  };
  const cleanup = {
    desktopApp: { stopped: true, exitConfirmed: true },
    daemonPorts: [{ port: 5199, released: true }],
    tempRoot: { kept: false, deleted: true },
  };
  const input: ManifestInput = {
    startedAt: "2026-11-21T10:00:00.000Z",
    finishedAt: "2026-11-21T10:00:02.000Z",
    provenance,
    baseUrl: "http://127.0.0.1:5199",
    evidenceDir: "/repo/.fit-trace/verification/run",
    dataDir: "/tmp/run/data",
    outcome: "passed",
    steps: [],
    assertions: [],
    evidence: [],
    cleanup,
    scenarioId: DESKTOP_SCENARIO_ID,
    artifact: {
      kind: "desktop-app",
      path: "/repo/fit-trace.app",
      sha256: "b".repeat(64),
      fileCount: 42,
      bytes: 1024,
      version: "0.1.0",
      bundleId: "com.agentfittrace.desktop",
    },
    launches: [
      {
        phase: "first",
        pid: 100,
        baseUrl: "http://127.0.0.1:5199",
        port: 5199,
        appVersion: "0.1.0",
        daemonPid: 200,
        exitConfirmed: true,
        portReleased: true,
      },
      {
        phase: "reopen",
        pid: 300,
        baseUrl: "http://127.0.0.1:6000",
        port: 6000,
        appVersion: "0.1.0",
        exitConfirmed: true,
        portReleased: true,
      },
    ],
  };

  const manifest = buildManifest(input);
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.scenarioId, "desktop-app-log-reopen");
  assert.equal(manifest.provenance.artifactSha256, "a".repeat(64));
  assert.deepEqual(manifest.artifact, input.artifact);
  assert.deepEqual(manifest.launches, input.launches);
  assert.deepEqual(manifest.cleanup, cleanup);
  assert.equal("chrome" in (manifest.cleanup ?? {}), false);
  if (manifest.cleanup === null) throw new Error("desktop manifest must record cleanup");
  assert.deepEqual(evaluateCleanup(manifest.cleanup), { failed: false, reasons: [] });

  // Copies, not aliases: mutating the input must not change the manifest.
  input.artifact!.fileCount = 1;
  input.launches![0].exitConfirmed = false;
  cleanup.desktopApp.exitConfirmed = false;
  assert.equal(manifest.artifact?.fileCount, 42);
  assert.equal(manifest.launches?.[0].exitConfirmed, true);
  assert.equal(manifest.cleanup?.desktopApp?.exitConfirmed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);

  // The browser scenario still defaults to its own id and has no desktop fields.
  const browser = buildManifest({ ...input, scenarioId: undefined, artifact: undefined, launches: undefined });
  assert.equal(browser.scenarioId, "guest-app-log-analyze");
  assert.equal("artifact" in browser, false);
  assert.equal("launches" in browser, false);
  assert.equal(exitCodeForOutcome("precondition-missing"), 2);
});
