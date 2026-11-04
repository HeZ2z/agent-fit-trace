import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // `opencode` does not exist in the fixture, so detection must report no path
    // AND still probe: a missing executable is a probe answer, not a crash.
    process.env.PATH = `${clis.shadowDir}:${clis.realDir}`;
    let probedBinary: string | undefined = "not-called";
    const detected = await detectLocalOpenCode({
      probe: async (options) => {
        probedBinary = options.binary;
        return { supported: false, isolationVerified: false, gap: "not installed" };
      },
    });
    assert.equal(detected.executablePath, undefined, "no opencode exists in the fixture");
    // With nothing resolved the probe is asked about the bare name, preserving
    // the pre-existing behavior rather than inventing a path.
    assert.equal(probedBinary, undefined);
    assert.equal(detected.support.supported, false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await clis.cleanup();
  }
});
