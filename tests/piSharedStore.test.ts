import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { validateWorkoutRecord } from "@agent-fit-trace/core";
import fitTraceExtension from "../.pi/extensions/fit-trace/index.ts";
import { SqliteWorkoutStore } from "@agent-fit-trace/store";

import { loadFixture } from "./helpers.ts";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: any;
};

type AnyTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
};

/** Minimal pi harness (same shape as tests/extension.test.ts): no runtime. */
function createHarness(): Map<string, AnyTool> {
  const tools = new Map<string, AnyTool>();
  const pi = {
    registerTool: (definition: AnyTool) => {
      tools.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;

  fitTraceExtension(pi);
  return tools;
}

const ctx = { cwd: process.cwd() } as unknown as ExtensionContext;

/**
 * Pin the four store-resolution env keys for one test and restore them after,
 * so a developer shell's overrides cannot leak into (or out of) a case.
 */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("normal mode without PI_FIT_TRACE_STORE opens the shared guest db under FIT_TRACE_DATA_DIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-pi-shared-"));
  try {
    const dataDir = join(dir, "data");
    await withEnv(
      {
        PI_FIT_TRACE_STORE: undefined,
        PI_FIT_TRACE_COACHED: undefined,
        FIT_TRACE_PRINCIPAL: undefined,
        FIT_TRACE_DATA_DIR: dataDir,
      },
      async () => {
        const tools = createHarness();
        const record = await loadFixture<Record<string, unknown>>("valid-strength.json");

        const imported = await tools
          .get("import_workout")!
          .execute("call", { record }, undefined, undefined, ctx);
        assert.equal(imported.details.accepted, true);
        assert.equal(imported.details.duplicate, false);

        const history = await tools
          .get("get_training_history")!
          .execute("call", {}, undefined, undefined, ctx);
        assert.equal(history.details.total, 1);

        // The record landed in the per-identity guest database, not a JSON file.
        assert.ok(existsSync(join(dataDir, "guest.db")));
        assert.equal(existsSync(join(dataDir, "workouts.json")), false);
        const check = new SqliteWorkoutStore(join(dataDir, "guest.db"));
        try {
          const stored = await check.all();
          assert.equal(stored.length, 1);
          assert.equal(stored[0].id, record.id);
        } finally {
          check.close();
        }
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PI_FIT_TRACE_STORE keeps the legacy JSON path: idempotent duplicate then CONFLICT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-pi-json-"));
  try {
    const storePath = join(dir, "workouts.json");
    await withEnv(
      {
        PI_FIT_TRACE_STORE: storePath,
        PI_FIT_TRACE_COACHED: undefined,
        FIT_TRACE_PRINCIPAL: undefined,
        FIT_TRACE_DATA_DIR: undefined,
      },
      async () => {
        const tools = createHarness();
        const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");

        for (const record of records) {
          const result = await tools
            .get("import_workout")!
            .execute("call", { record }, undefined, undefined, ctx);
          assert.equal(result.details.duplicate, false);
        }

        // Identical re-import is a no-op with the same totals as before #40.
        const duplicate = await tools
          .get("import_workout")!
          .execute("call", { record: records[0] }, undefined, undefined, ctx);
        assert.equal(duplicate.details.duplicate, true);
        assert.equal(duplicate.details.total_records, 3);

        // The same id with different content still throws CONFLICT.
        const mutated = structuredClone(records[0]);
        (mutated.exercises as Array<{ sets: Array<{ weight: number }> }>)[0].sets[0].weight = 90;
        await assert.rejects(
          () =>
            tools
              .get("import_workout")!
              .execute("call", { record: mutated }, undefined, undefined, ctx),
          /CONFLICT/,
        );

        assert.ok(existsSync(storePath), "the explicit .json path must back the store");
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("records written by another SQLite connection are visible to pi normal mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-pi-e2e-"));
  try {
    const dataDir = join(dir, "data");
    // Daemon/app-style writer populates the guest db first, then closes.
    const writer = new SqliteWorkoutStore(join(dataDir, "guest.db"));
    const records = await loadFixture<Array<Record<string, unknown>>>("history-strength.json");
    try {
      for (const record of records) {
        await writer.import(validateWorkoutRecord(record).record);
      }
    } finally {
      writer.close();
    }

    await withEnv(
      {
        PI_FIT_TRACE_STORE: undefined,
        PI_FIT_TRACE_COACHED: undefined,
        FIT_TRACE_PRINCIPAL: undefined,
        FIT_TRACE_DATA_DIR: dataDir,
      },
      async () => {
        const tools = createHarness();
        const history = await tools
          .get("get_training_history")!
          .execute("call", {}, undefined, undefined, ctx);
        assert.equal(history.details.total, 3);

        const analysis = await tools
          .get("analyze_progress")!
          .execute("call", {}, undefined, undefined, ctx);
        assert.equal(analysis.details.metrics.sessions, 3);
        assert.equal(analysis.details.metrics.volume_kg, 8325);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
