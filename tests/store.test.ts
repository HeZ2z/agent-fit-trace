import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConflictError, CorruptStoreError, ValidationError, validateWorkoutRecord } from "@agent-fit-trace/core";
import { JsonFileStorage, MemoryStorage, WorkoutStore } from "../.pi/extensions/fit-trace/store.ts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { loadFixture } from "./helpers.ts";

async function fixtureRecord(name: string): Promise<WorkoutRecord> {
  const input = await loadFixture(name);
  return validateWorkoutRecord(input).record;
}

test("imports a valid record and reports the total", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const record = await fixtureRecord("valid-strength.json");

  const result = await store.import(record);
  assert.equal(result.duplicate, false);
  assert.equal(result.total, 1);
  assert.equal((await store.all()).length, 1);
});

test("re-importing identical content is an idempotent no-op", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const record = await fixtureRecord("valid-strength.json");

  await store.import(record);
  const second = await store.import({ ...record });

  assert.equal(second.duplicate, true);
  assert.equal(second.total, 1);
  assert.equal((await store.all()).length, 1);
});

test("re-importing the same id with different content throws ConflictError", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const record = await fixtureRecord("valid-strength.json");
  await store.import(record);

  const mutated: WorkoutRecord = structuredClone(record);
  mutated.exercises[0].sets[0].weight = 82.5;

  await assert.rejects(() => store.import(mutated), ConflictError);
  assert.equal((await store.all()).length, 1);
});

test("queries by date range, exercise, and pagination in ascending order", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  const history = await loadFixture<unknown[]>("history-strength.json");
  for (const entry of history) {
    await store.import(validateWorkoutRecord(entry).record);
  }

  const all = await store.query();
  assert.deepEqual(
    all.records.map((record) => record.id),
    ["2026-09-01-strength", "2026-09-04-strength", "2026-09-08-strength"],
  );

  const ranged = await store.query({ from: "2026-09-04", to: "2026-09-04" });
  assert.deepEqual(ranged.records.map((record) => record.id), ["2026-09-04-strength"]);

  const byExercise = await store.query({ exercise: "SQUAT" });
  assert.equal(byExercise.total, 3);

  const page = await store.query({ limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.records.map((record) => record.id), [
    "2026-09-04-strength",
    "2026-09-08-strength",
  ]);
});

test("persists across store instances via JsonFileStorage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-"));
  const path = join(dir, "nested", "workouts.json");
  try {
    const record = await fixtureRecord("valid-strength.json");
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

test("rejects an invalid date filter with a readable ValidationError", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  await assert.rejects(
    () => store.query({ from: "not-a-date" }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues[0].code, "INVALID_FILTER_DATE");
      return true;
    },
  );
});

test("rejects an inverted date range instead of silently returning nothing", async () => {
  const store = new WorkoutStore(new MemoryStorage());
  await assert.rejects(() => store.query({ from: "2026-09-10", to: "2026-09-01" }), ValidationError);
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
