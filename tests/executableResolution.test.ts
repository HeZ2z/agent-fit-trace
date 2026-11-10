import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectLocalCodex,
  detectLocalOpenCode,
  resolveLocalCodexRegistration,
} from "../server/coaching/localRuntimeRegistrations.ts";
import { resolveExecutable } from "../server/coaching/executableResolution.ts";

/**
 * Detection and execution must agree on WHICH binary runs (#68).
 *
 * The failure this guards is silent and nasty: a capability probe verifies one
 * executable (say the user's real Codex), and the coached run later spawns
 * whatever `PATH` resolves to at that moment. If a different, unverified binary
 * wins, the product has proven a safety property about a program it is not
 * running. Resolving once, then feeding the SAME absolute path to both the probe
 * and the adapter, is the fix.
 *
 * These tests use a real temporary `PATH` with a deliberately shadowed entry, so
 * they exercise the actual filesystem lookup rather than a mock of it.
 */

interface FakeClis {
  dir: string;
  /** Directory prepended to PATH: the "shadowing" one. */
  shadowDir: string;
  /** Directory of the "real" binary. */
  realDir: string;
  cleanup(): Promise<void>;
}

/**
 * Create two directories each holding an executable named `codex`, where
 * `shadowDir` comes first in PATH. Returns both so a test can assert the
 * resolver picks the shadow and NOT the other.
 */
async function makeShadowedClis(): Promise<FakeClis> {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-shadowed-path-"));
  const shadowDir = join(dir, "shadow");
  const realDir = join(dir, "real");
  await mkdir(shadowDir, { recursive: true });
  await mkdir(realDir, { recursive: true });
  for (const target of [shadowDir, realDir]) {
    const file = join(target, "codex");
    await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(file, 0o755);
  }
  return {
    dir,
    shadowDir,
    realDir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("resolveExecutable prefers the first PATH entry, so a shadowed CLI is detectable", async () => {
  const clis = await makeShadowedClis();
  try {
    const resolved = resolveExecutable("codex", {
      pathEnv: `${clis.shadowDir}:${clis.realDir}`,
      platform: "linux",
    });
    assert.equal(resolved, join(clis.shadowDir, "codex"), "the FIRST PATH entry must win");

    // Reversing PATH reverses the answer: the resolver does not cache or guess.
    const reversed = resolveExecutable("codex", {
      pathEnv: `${clis.realDir}:${clis.shadowDir}`,
      platform: "linux",
    });
    assert.equal(reversed, join(clis.realDir, "codex"));
  } finally {
    await clis.cleanup();
  }
});

test("detection probes and reports the SAME executable a shadowed PATH resolves to", async () => {
  const clis = await makeShadowedClis();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${clis.shadowDir}:${clis.realDir}`;
    // The probe double records the binary it was asked to inspect. That binary
    // is what the run must later spawn, so asserting on it is the whole point.
    let probedBinary: string | undefined;
    const detected = await detectLocalCodex({
      probe: async (binary) => {
        probedBinary = binary;
        return { supported: true, builtinIsolationVerified: true, version: "1.2.3" };
      },
    });

    const expected = join(clis.shadowDir, "codex");
    assert.equal(detected.executablePath, expected, "detection must report the first PATH match");
    assert.equal(probedBinary, expected, "the PROBE must inspect that exact file");

    // The registration the server publishes reports the same path…
    const registration = resolveLocalCodexRegistration(detected.support, {
      ...(detected.executablePath !== undefined ? { executablePath: detected.executablePath } : {}),
    });
    assert.equal(registration.executablePath, expected);

    // …and its factory SPAWNS that same path. Driving the factory with a fake
    // launch is enough: what matters is the binary it is constructed with.
    const factory = registration.factory;
    assert.ok(factory !== undefined, "a verified Codex must have a factory");
    const launch = {
      sessionId: "s",
      runId: "r",
      prompt: "p",
      snapshotFile: "/tmp/snapshot.json",
      snapshotDir: "/tmp/snapshot-dir",
      sessionDir: "/tmp/session-dir",
      onEvent: () => undefined,
      onDone: () => undefined,
    };
    const handle = factory(launch) as unknown as { argv: { binary: string } };
    assert.equal(
      handle.argv.binary,
      expected,
      "execution must spawn the SAME executable detection verified",
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await clis.cleanup();
  }
});

test("a command absent from PATH resolves to null and reports no path", async () => {
  const clis = await makeShadowedClis();
  try {
    assert.equal(
      resolveExecutable("definitely-not-installed-xyz", {
        pathEnv: `${clis.shadowDir}:${clis.realDir}`,
        platform: "linux",
      }),
      null,
    );
  } finally {
    await clis.cleanup();
  }
});

test("an empty PATH entry is skipped instead of resolving against the cwd", async () => {
  const clis = await makeShadowedClis();
  try {
    // POSIX shells treat an empty entry as the current directory. Honouring it
    // would let a binary in the daemon's cwd win over the installed CLI, which
    // is precisely the confusion single-resolution exists to remove.
    const resolved = resolveExecutable("codex", {
      pathEnv: `:${clis.realDir}`,
      platform: "linux",
    });
    assert.equal(resolved, join(clis.realDir, "codex"));
  } finally {
    await clis.cleanup();
  }
});

test("PATHEXT is honoured on win32 so an npm .cmd shim is found", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-pathext-"));
  try {
    const shim = join(dir, "codex.cmd");
    await writeFile(shim, "@echo off\r\n", "utf8");
    const resolved = resolveExecutable("codex", {
      pathEnv: dir,
      pathExtEnv: ".COM;.EXE;.BAT;.CMD",
      platform: "win32",
      // Windows has no reliable executable bit; existence is the test.
      isExecutableFile: (candidate) => candidate === shim,
    });
    assert.equal(resolved, shim);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode detection follows the same single-resolution rule", async () => {
  const clis = await makeShadowedClis();
  const originalPath = process.env.PATH;
  try {
    // An explicit missing executable never falls back to a user installation.
    process.env.PATH = `${clis.shadowDir}:${clis.realDir}`;
    let probedBinary: string | undefined = "not-called";
    const detected = await detectLocalOpenCode({
      binary: join(clis.realDir, "missing-opencode"),
      probe: async (options) => {
        probedBinary = options.binary;
        return { supported: false, isolationVerified: false, gap: "not installed" };
      },
    });
    assert.equal(detected.executablePath, undefined, "no opencode exists in the fixture");
    // The injected probe sees the requested path, never a different install.
    assert.equal(probedBinary, join(clis.realDir, "missing-opencode"));
    assert.equal(detected.support.supported, false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await clis.cleanup();
  }
});

test("executable identity changes on replacement and symlink retargeting", async () => {
  const { executableIdentity } = await import("../server/coaching/executableResolution.ts");
  const { mkdtemp, writeFile, symlink, unlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-identity-"));
  try {
    const first = join(dir, "first");
    const second = join(dir, "second");
    const link = join(dir, "tool");
    await writeFile(first, "first");
    await writeFile(second, "second");
    await symlink(first, link);
    const before = executableIdentity(link);
    await unlink(link);
    await symlink(second, link);
    assert.notEqual(executableIdentity(link), before);
    const beforeReplacement = executableIdentity(link);
    await unlink(second);
    await writeFile(second, "new replacement");
    assert.notEqual(executableIdentity(link), beforeReplacement);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("relative PATH entries never resolve through the working directory", () => {
  const seen: string[] = [];
  const found = resolveExecutable("codex", {
    pathEnv: "relative:/absolute", isExecutableFile: (candidate) => { seen.push(candidate); return false; },
  });
  assert.equal(found, null);
  assert.deepEqual(seen, ["/absolute/codex"]);
});


test("shadowed executable runs with the environment captured during detection", async () => {
  if (process.platform === "win32") return;
  const clis = await makeShadowedClis();
  const marker = join(clis.dir, "observed-path");
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  try {
    const selected = join(clis.shadowDir, "codex");
    await writeFile(selected, `#!/bin/sh\nprintf '%s' "$PATH" > '${marker}'\nexit 1\n`);
    await chmod(selected, 0o755);
    process.env.PATH = `${clis.shadowDir}:${clis.realDir}`;
    process.env.NODE_OPTIONS = "--inspect";
    const detected = await detectLocalCodex({ probe: async () => ({ supported: true, builtinIsolationVerified: true }) });
    assert.equal(detected.executablePath, selected);
    assert.equal(detected.env?.NODE_OPTIONS, undefined);
    const capturedPath = detected.env?.PATH;
    process.env.PATH = clis.realDir;
    const registration = resolveLocalCodexRegistration(detected.support, {
      executablePath: selected, env: detected.env, validateExecutable: detected.validateExecutable,
    });
    assert.ok(registration.factory);
    const done = new Promise<void>((resolve) => {
      const handle = registration.factory!({ sessionId: "s", runId: "r", prompt: "p", snapshotFile: join(clis.dir, "snapshot"), snapshotDir: clis.dir, sessionDir: join(clis.dir, "session"), onEvent: () => {}, onDone: () => resolve() });
      handle.start();
    });
    await done;
    assert.equal(await readFile(marker, "utf8"), capturedPath);
    assert.ok(capturedPath?.startsWith(`${clis.shadowDir}:`));
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
    await clis.cleanup();
  }
});


test("a replaced executable is rejected before a coached process starts", async () => {
  if (process.platform === "win32") return;
  const clis = await makeShadowedClis();
  try {
    const selected = join(clis.shadowDir, "codex");
    const detected = await detectLocalCodex({ binary: selected, probe: async () => ({ supported: true, builtinIsolationVerified: true }) });
    await rm(selected);
    await writeFile(selected, "#!/bin/sh\nexit 0\n");
    await chmod(selected, 0o755);
    const registration = resolveLocalCodexRegistration(detected.support, { executablePath: selected, env: detected.env, validateExecutable: detected.validateExecutable });
    assert.ok(registration.factory);
    const reason = await new Promise<string | undefined>((resolve) => {
      const handle = registration.factory!({ sessionId: "s", runId: "r", prompt: "p", snapshotFile: join(clis.dir, "snapshot"), snapshotDir: clis.dir, sessionDir: join(clis.dir, "session"), onEvent: () => {}, onDone: (_status, why) => resolve(why) });
      handle.start();
    });
    assert.match(reason ?? "", /changed since detection; rescan/);
  } finally { await clis.cleanup(); }
});
