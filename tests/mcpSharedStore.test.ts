import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { validateWorkoutRecord } from "@agent-fit-trace/core";
import { createFitTraceMcpServer, resolveMcpStore } from "@agent-fit-trace/mcp";
import {
  JsonFileStorage,
  SqliteWorkoutStore,
  StaleIdentityError,
  WorkoutStore,
} from "@agent-fit-trace/store";

import { loadFixture } from "./helpers.ts";

type StructuredDetails = { [key: string]: any };

/** Injected homeDir; every case pins the data dir via env, so it never matters. */
const HOME = "/home/u";

test("resolveMcpStore follows the pinned five-level precedence", async () => {
  // 1. `--store` flag: explicit file used as-is, kind by suffix (.db -> sqlite).
  assert.deepEqual(
    await resolveMcpStore({
      storeArg: "/flag/store.db",
      env: { PI_FIT_TRACE_STORE: "/env/store.json", FIT_TRACE_PRINCIPAL: "alice" },
      homeDir: HOME,
    }),
    { path: "/flag/store.db", kind: "sqlite" },
  );

  // 2. Legacy `PI_FIT_TRACE_STORE` env: explicit file, `.json` keeps the JSON backend.
  assert.deepEqual(
    await resolveMcpStore({
      env: { PI_FIT_TRACE_STORE: "/env/store.json", FIT_TRACE_PRINCIPAL: "alice" },
      homeDir: HOME,
    }),
    { path: "/env/store.json", kind: "json" },
  );

  // 3. `--principal` flag / `FIT_TRACE_PRINCIPAL` env (flag wins): the named db,
  //    created on first run, so no fileExists/readIdentity is consulted.
  assert.deepEqual(
    await resolveMcpStore({
      principalArg: "bob",
      env: { FIT_TRACE_PRINCIPAL: "alice", FIT_TRACE_DATA_DIR: "/data" },
      homeDir: HOME,
    }),
    { path: join("/data", "bob.db"), kind: "sqlite" },
  );
  assert.deepEqual(
    await resolveMcpStore({
      env: { FIT_TRACE_PRINCIPAL: "alice", FIT_TRACE_DATA_DIR: "/data" },
      homeDir: HOME,
    }),
    { path: join("/data", "alice.db"), kind: "sqlite" },
  );

  // 4. identity.json's active principal, db file present -> that principal's db.
  assert.deepEqual(
    await resolveMcpStore({
      env: { FIT_TRACE_DATA_DIR: "/data" },
      homeDir: HOME,
      readIdentity: async () => ({ schema_version: 1, active_principal: "alice" }),
      fileExists: async () => true,
    }),
    { path: join("/data", "alice.db"), kind: "sqlite" },
  );

  // 5. No identity.json (first run) -> the guest db.
  assert.deepEqual(
    await resolveMcpStore({
      env: { FIT_TRACE_DATA_DIR: "/data" },
      homeDir: HOME,
      readIdentity: async () => null,
    }),
    { path: join("/data", "guest.db"), kind: "sqlite" },
  );
});

test("resolveMcpStore fails loudly when identity.json names a missing database", async () => {
  await assert.rejects(
    () =>
      resolveMcpStore({
        env: { FIT_TRACE_DATA_DIR: "/data" },
        homeDir: HOME,
        readIdentity: async () => ({ schema_version: 1, active_principal: "alice" }),
        fileExists: async () => false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StaleIdentityError);
      // The message must name the file and both override methods — no silent
      // guest fallback that would fragment the dataset.
      assert.match((error as Error).message, /\/data\/identity\.json/);
      assert.match((error as Error).message, /\/data\/alice\.db/);
      assert.match((error as Error).message, /--principal/);
      assert.match((error as Error).message, /FIT_TRACE_PRINCIPAL/);
      assert.match((error as Error).message, /--store/);
      return true;
    },
  );
});

test("an app-style SQLite import is visible to the MCP server through the shared guest db", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-shared-"));
  const connections: SqliteWorkoutStore[] = [];
  let serverClient: { client: Client; server: ReturnType<typeof createFitTraceMcpServer> } | null =
    null;
  try {
    const dataDir = join(dir, "data");
    const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");

    // Daemon-style writer: the app's import path lands in the guest db first.
    const daemonStore = new SqliteWorkoutStore(join(dataDir, "guest.db"));
    connections.push(daemonStore);
    for (const record of records) {
      await daemonStore.import(validateWorkoutRecord(record).record);
    }

    // Default MCP resolution (no identity.json yet) resolves to the same file.
    const resolved = await resolveMcpStore({ env: { FIT_TRACE_DATA_DIR: dataDir }, homeDir: HOME });
    assert.deepEqual(resolved, { path: join(dataDir, "guest.db"), kind: "sqlite" });

    const mcpStore = new SqliteWorkoutStore(resolved.path);
    connections.push(mcpStore);
    const server = createFitTraceMcpServer({ store: mcpStore, skillText: "" });
    const client = new Client({ name: "fit-trace-mcp-shared-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    serverClient = { client, server };

    const analysis = await client.callTool({ name: "analyze_progress", arguments: {} });
    assert.ok(!analysis.isError);
    assert.equal((analysis.structuredContent as StructuredDetails).metrics.sessions, 3);
    assert.equal((analysis.structuredContent as StructuredDetails).metrics.volume_kg, 8325);

    // A second independent connection (the role of another process) imports a
    // new record; the already-open MCP connection must see it through the
    // WAL multi-connection posture.
    const second = new SqliteWorkoutStore(resolved.path);
    connections.push(second);
    const newer = validateWorkoutRecord({
      ...records[0],
      id: "2026-09-11-strength",
      date: "2026-09-11",
    }).record;
    await second.import(newer);

    const history = await client.callTool({ name: "get_training_history", arguments: {} });
    assert.ok(!history.isError);
    assert.equal((history.structuredContent as StructuredDetails).total, 4);
    const stored = (history.structuredContent as StructuredDetails).records as Array<{
      id: string;
    }>;
    assert.equal(stored[stored.length - 1].id, "2026-09-11-strength");
  } finally {
    if (serverClient !== null) {
      await serverClient.client.close();
      await serverClient.server.close();
    }
    for (const connection of connections) connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a --store .json path keeps the JSON backend and the tools work unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-mcp-json-"));
  const connections: SqliteWorkoutStore[] = [];
  let serverClient: { client: Client; server: ReturnType<typeof createFitTraceMcpServer> } | null =
    null;
  try {
    const storePath = join(dir, "workouts.json");
    const resolved = await resolveMcpStore({ storeArg: storePath, env: {}, homeDir: HOME });
    assert.deepEqual(resolved, { path: storePath, kind: "json" });

    // Same kind-based construction as main.ts.
    const store =
      resolved.kind === "json"
        ? new WorkoutStore(new JsonFileStorage(resolved.path))
        : new SqliteWorkoutStore(resolved.path);
    const server = createFitTraceMcpServer({ store, skillText: "" });
    const client = new Client({ name: "fit-trace-mcp-json-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    serverClient = { client, server };

    const record = validateWorkoutRecord(
      await loadFixture<Record<string, unknown>>("valid-strength.json"),
    ).record;
    const imported = await client.callTool({
      name: "import_workout",
      arguments: { record },
    });
    assert.ok(!imported.isError);
    assert.equal((imported.structuredContent as StructuredDetails).accepted, true);

    const history = await client.callTool({ name: "get_training_history", arguments: {} });
    assert.ok(!history.isError);
    assert.equal((history.structuredContent as StructuredDetails).total, 1);
    assert.ok(existsSync(storePath), "the JSON backend must write the .json file");
  } finally {
    if (serverClient !== null) {
      await serverClient.client.close();
      await serverClient.server.close();
    }
    for (const connection of connections) connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});
