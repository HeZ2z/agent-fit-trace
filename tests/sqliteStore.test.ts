import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CorruptStoreError, validateWorkoutRecord } from "@agent-fit-trace/core";
import { SqliteWorkoutStore } from "@agent-fit-trace/store";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { loadFixture } from "./helpers.ts";
import { runStoreContractSuite } from "./store.contract.ts";

runStoreContractSuite("SqliteWorkoutStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sqlite-"));
  const store = new SqliteWorkoutStore(join(dir, "workouts.db"));
  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

async function historyRecords(): Promise<WorkoutRecord[]> {
  const history = await loadFixture<unknown[]>("history-strength.json");
  return history.map((entry) => validateWorkoutRecord(entry).record);
}

test("two stores on the same db file import alternately without losing records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sqlite-shared-"));
  try {
    const path = join(dir, "shared.db");
    const first = new SqliteWorkoutStore(path);
    const second = new SqliteWorkoutStore(path);
    try {
      const records = await historyRecords();

      // Alternate between the two connections, then cross-read.
      await first.import(records[0]);
      await second.import(records[1]);
      await first.import(records[2]);

      const ids = records.map((record) => record.id);
      assert.deepEqual((await first.all()).map((record) => record.id), ids);
      assert.deepEqual((await second.all()).map((record) => record.id), ids);

      // Both connections racing on the same id with identical content stay idempotent.
      await Promise.all([first.import(records[0]), second.import(records[0])]);
      assert.equal((await second.all()).length, 3);
    } finally {
      first.close();
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("raises CORRUPT_STORE with the row index for a hand-corrupted row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sqlite-corrupt-"));
  try {
    const store = new SqliteWorkoutStore(join(dir, "workouts.db"));
    try {
      const records = await historyRecords();
      await store.import(records[0]);
      await store.import(records[1]);

      store.db.exec(`UPDATE workouts SET record = '{bad' WHERE id = '${records[1].id}'`);

      await assert.rejects(
        () => store.all(),
        (error: unknown) => {
          assert.ok(error instanceof CorruptStoreError);
          assert.equal(error.code, "CORRUPT_STORE");
          // Row order under `ORDER BY date`: the corrupted 2026-09-04 row is second.
          assert.equal(error.recordIndex, 1);
          return true;
        },
      );
      await assert.rejects(() => store.query(), CorruptStoreError);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an idempotent re-import leaves no dirty files behind after close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sqlite-wal-"));
  try {
    const store = new SqliteWorkoutStore(join(dir, "workouts.db"));
    try {
      const record = (await historyRecords())[0];
      await store.import(record);
      const again = await store.import({ ...record });
      assert.equal(again.duplicate, true);
    } finally {
      store.close();
    }

    // The db file (plus at most its WAL sidecars) is all that may remain: no
    // temp files from a torn transaction, no orphaned checkpoint state.
    const entries = await readdir(dir);
    const leftovers = entries.filter((name) => !/^workouts\.db(-wal|-shm)?$/.test(name));
    assert.deepEqual(leftovers, []);
    assert.ok(entries.includes("workouts.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
