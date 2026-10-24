import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ValidationError } from "@agent-fit-trace/core";
import {
  StaleIdentityError,
  identityFilePath,
  principalDbPath,
  readIdentity,
  resolveActiveStore,
  resolveDataDir,
  writeIdentity,
} from "@agent-fit-trace/store";
import type { IdentityFile } from "@agent-fit-trace/store";

const CAROL: IdentityFile = { schema_version: 1, active_principal: "carol" };

/** Deps that must never be consulted for the case under test. */
function failingDeps() {
  return {
    readIdentity: async (): Promise<IdentityFile | null> => {
      throw new Error("identity.json must not be read for this precedence level");
    },
    fileExists: async (): Promise<boolean> => {
      throw new Error("fileExists must not be called for this precedence level");
    },
  };
}

test("an explicit store path wins over principal, env, and identity.json", async () => {
  const dbPath = await resolveActiveStore({
    storePath: "/tmp/override.db",
    principal: "alice",
    env: { FIT_TRACE_PRINCIPAL: "bob" },
    dataDir: "/data",
    ...failingDeps(),
  });
  assert.equal(dbPath, "/tmp/override.db");
});

test("an explicit principal beats the env override and identity.json", async () => {
  // Neither the identity file nor existence check may be consulted: an explicit
  // principal resolves to its db path directly (and may bootstrap a new one).
  const dbPath = await resolveActiveStore({
    principal: "alice",
    env: { FIT_TRACE_PRINCIPAL: "bob" },
    dataDir: "/data",
    ...failingDeps(),
  });
  assert.equal(dbPath, join("/data", "alice.db"));
});

test("FIT_TRACE_PRINCIPAL beats identity.json", async () => {
  const dbPath = await resolveActiveStore({
    env: { FIT_TRACE_PRINCIPAL: "bob" },
    dataDir: "/data",
    readIdentity: async () => CAROL,
    fileExists: async () => true,
  });
  assert.equal(dbPath, join("/data", "bob.db"));
});

test("identity.json's active_principal names the store when its db exists", async () => {
  const dbPath = await resolveActiveStore({
    env: {},
    dataDir: "/data",
    readIdentity: async () => CAROL,
    fileExists: async (path) => path === join("/data", "carol.db"),
  });
  assert.equal(dbPath, join("/data", "carol.db"));
});

test("a missing identity.json falls back to the guest db on first run", async () => {
  const dbPath = await resolveActiveStore({
    env: {},
    dataDir: "/data",
    readIdentity: async () => null,
    fileExists: async () => false,
  });
  assert.equal(dbPath, join("/data", "guest.db"));
});

test("a recorded principal whose db file is missing raises StaleIdentityError", async () => {
  const identityPath = identityFilePath("/data");
  const missingDbPath = join("/data", "carol.db");
  await assert.rejects(
    () =>
      resolveActiveStore({
        env: {},
        dataDir: "/data",
        readIdentity: async () => CAROL,
        fileExists: async () => false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StaleIdentityError);
      assert.equal(error.code, "STALE_IDENTITY");
      assert.equal(error.details.identity_path, identityPath);
      assert.equal(error.details.missing_db_path, missingDbPath);
      for (const fragment of [identityPath, missingDbPath, "--principal", "FIT_TRACE_PRINCIPAL", "--store"]) {
        assert.ok(error.message.includes(fragment), `message must mention ${fragment}`);
      }
      return true;
    },
  );
});

test("a principal with path characters is rejected before it can escape the data dir", async () => {
  assert.throws(() => principalDbPath("/data", "../evil"), ValidationError);
  await assert.rejects(
    () => resolveActiveStore({ env: {}, dataDir: "/data", principal: "../evil" }),
    ValidationError,
  );
});

test("resolveDataDir honors FIT_TRACE_DATA_DIR and falls back to the home default", () => {
  assert.equal(resolveDataDir({ FIT_TRACE_DATA_DIR: "/custom/data" }), "/custom/data");
  assert.equal(
    resolveDataDir({ FIT_TRACE_DATA_DIR: "  " }, "/home/tester"),
    join("/home/tester", ".fit-trace", "data"),
  );
  assert.equal(
    resolveDataDir({}, "/home/tester"),
    join("/home/tester", ".fit-trace", "data"),
  );
});

test("identity helpers round-trip through a real file and reject malformed content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-identity-"));
  try {
    const path = join(dir, "identity.json");
    assert.equal(await readIdentity(path), null);

    await writeIdentity(path, "alice");
    assert.deepEqual(await readIdentity(path), { schema_version: 1, active_principal: "alice" });

    await assert.rejects(() => writeIdentity(path, "../evil"), ValidationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
