import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CorruptStoreError, ValidationError, validateWorkoutRecord } from "@agent-fit-trace/core";
import { JsonFileStorage, MemoryStorage, WorkoutStore } from "@agent-fit-trace/store";
import { loadFixture } from "./helpers.ts";
import { runStoreContractSuite } from "./store.contract.ts";

/**
 * The backend-agnostic store behavior (import idempotency, query semantics,
 * read-time re-validation) lives in the shared contract suite, which also runs
 * against the SQLite backend. This file keeps only JSON-specific persistence
 * and corruption cases.
 */
runStoreContractSuite("WorkoutStore (JSON)", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  return { store, cleanup: () => undefined };
});

test("persists across store instances via JsonFileStorage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-"));
  const path = join(dir, "nested", "workouts.json");
  try {
    const input = await loadFixture("valid-strength.json");
    const record = validateWorkoutRecord(input).record;
    await new WorkoutStore(new JsonFileStorage(path)).import(record);

    const reloaded = await new WorkoutStore(new JsonFileStorage(path)).all();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id, "2026-09-01-strength");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializes concurrent imports without losing records", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const history = await loadFixture<unknown[]>("history-strength.json");
  const records = history.map((entry) => validateWorkoutRecord(entry).record);

  await Promise.all(records.map((record) => store.import(record)));
  assert.equal((await store.all()).length, 3);
});

test("raises CORRUPT_STORE with the failing index for a malformed persisted record", async () => {
  const storage = new MemoryStorage();
  storage.data = JSON.stringify({
    schema_version: 1,
    records: [
      {
        id: "ok",
        schema_version: 1,
        date: "2026-09-01",
        session_type: "strength",
        exercises: [{ name: "squat", sets: [{ reps: 5 }] }],
      },
      {
        id: "bad",
        schema_version: 1,
        date: "not-a-date",
        session_type: "strength",
        exercises: [{ name: "squat", sets: [{ reps: 5 }] }],
      },
    ],
  });

  await assert.rejects(
    () => new WorkoutStore(storage).load(),
    (error: unknown) => {
      assert.ok(error instanceof CorruptStoreError);
      assert.equal(error.code, "CORRUPT_STORE");
      assert.equal(error.recordIndex, 1);
      return true;
    },
  );
});

test("raises CORRUPT_STORE when the records field is not an array", async () => {
  const storage = new MemoryStorage();
  storage.data = JSON.stringify({ schema_version: 1, records: {} });
  await assert.rejects(() => new WorkoutStore(storage).load(), CorruptStoreError);
});

test("raises CORRUPT_STORE for malformed JSON instead of a raw SyntaxError", async () => {
  const storage = new MemoryStorage();
  storage.data = '{"schema_version": 1, "records": [';
  await assert.rejects(
    () => new WorkoutStore(storage).load(),
    (error: unknown) => {
      assert.ok(error instanceof CorruptStoreError);
      assert.equal(error.code, "CORRUPT_STORE");
      assert.equal(error.recordIndex, -1);
      return true;
    },
  );
});

test("re-validates imported records on read and raises CORRUPT_STORE", async () => {
  // The JSON backend persists imports without validating them first, so a
  // stored record with a malformed date must fail the read loudly instead of
  // surfacing as data.
  const store = new WorkoutStore(new MemoryStorage());
  const record = validateWorkoutRecord(await loadFixture("valid-strength.json")).record;
  await store.import({ ...record, date: "not-a-date" });

  await assert.rejects(
    () => store.all(),
    (error: unknown) => {
      assert.ok(error instanceof CorruptStoreError);
      assert.equal(error.code, "CORRUPT_STORE");
      assert.equal(error.recordIndex, 0);
      return true;
    },
  );
  await assert.rejects(() => store.query(), CorruptStoreError);
});

test("an invalid date filter fails before a corrupt store is read", async () => {
  // Filter validation must happen before storage access: a corrupt store must
  // not mask the readable date error with CORRUPT_STORE.
  const storage = new MemoryStorage();
  storage.data = '{"schema_version": 1, "records": [';

  await assert.rejects(
    () => new WorkoutStore(storage).query({ from: "not-a-date" }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.issues[0].code, "INVALID_FILTER_DATE");
      return true;
    },
  );
});
