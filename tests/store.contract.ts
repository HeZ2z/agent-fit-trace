import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConflictError,
  CorruptStoreError,
  ValidationError,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";
import type { QueryResult } from "@agent-fit-trace/store";
import { loadFixture } from "./helpers.ts";

/** Minimal store surface both backends expose; the contract suite runs against it. */
export interface ContractStore {
  all(): Promise<WorkoutRecord[]>;
  import(record: WorkoutRecord): Promise<{ duplicate: boolean; total: number }>;
  query(filter?: HistoryFilter): Promise<QueryResult>;
}

export interface ContractStoreHandle {
  store: ContractStore;
  cleanup: () => void | Promise<void>;
}

async function fixtureRecord(name: string): Promise<WorkoutRecord> {
  const input = await loadFixture(name);
  return validateWorkoutRecord(input).record;
}

async function withStore(
  makeStore: () => Promise<ContractStoreHandle>,
  run: (store: ContractStore) => Promise<void>,
): Promise<void> {
  const { store, cleanup } = await makeStore();
  try {
    await run(store);
  } finally {
    await cleanup();
  }
}

const HISTORY_IDS = ["2026-09-01-strength", "2026-09-04-strength", "2026-09-08-strength"];

/**
 * Backend-agnostic WorkoutStore contract: import idempotency/conflict, query
 * date/exercise/pagination semantics, ascending ordering, and read-time
 * re-validation. Every case must hold for the JSON and the SQLite backend
 * alike; each backend test file registers the suite via this function.
 */
export function runStoreContractSuite(
  name: string,
  makeStore: () => Promise<ContractStoreHandle>,
): void {
  test(`${name}: imports a valid record and reports the total`, async () => {
    await withStore(makeStore, async (store) => {
      const result = await store.import(await fixtureRecord("valid-strength.json"));
      assert.equal(result.duplicate, false);
      assert.equal(result.total, 1);
      assert.equal((await store.all()).length, 1);
    });
  });

  test(`${name}: re-importing identical content is an idempotent no-op`, async () => {
    await withStore(makeStore, async (store) => {
      const record = await fixtureRecord("valid-strength.json");
      await store.import(record);

      const second = await store.import({ ...record });
      assert.equal(second.duplicate, true);
      assert.equal(second.total, 1);
      assert.equal((await store.all()).length, 1);
    });
  });

  test(`${name}: re-importing the same id with different content throws ConflictError`, async () => {
    await withStore(makeStore, async (store) => {
      const record = await fixtureRecord("valid-strength.json");
      await store.import(record);

      const mutated: WorkoutRecord = structuredClone(record);
      mutated.exercises[0].sets[0].weight = 82.5;

      await assert.rejects(() => store.import(mutated), ConflictError);
      assert.equal((await store.all()).length, 1);
    });
  });

  test(`${name}: returns history in ascending date order regardless of import order`, async () => {
    await withStore(makeStore, async (store) => {
      const history = await loadFixture<WorkoutRecord[]>("history-strength.json");
      for (const entry of [...history].reverse()) {
        await store.import(validateWorkoutRecord(entry).record);
      }

      assert.deepEqual((await store.all()).map((record) => record.id), HISTORY_IDS);
      assert.deepEqual((await store.query()).records.map((record) => record.id), HISTORY_IDS);
    });
  });

  test(`${name}: an empty store returns no records with total 0`, async () => {
    await withStore(makeStore, async (store) => {
      assert.deepEqual(await store.all(), []);
      assert.deepEqual(await store.query(), { records: [], total: 0, offset: 0, limit: null });
    });
  });

  test(`${name}: queries by date range, exercise, and pagination in ascending order`, async () => {
    await withStore(makeStore, async (store) => {
      const history = await loadFixture<WorkoutRecord[]>("history-strength.json");
      for (const entry of history) {
        await store.import(validateWorkoutRecord(entry).record);
      }

      const all = await store.query();
      assert.deepEqual(all.records.map((record) => record.id), HISTORY_IDS);

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
  });

  test(`${name}: honors open-ended date bounds`, async () => {
    await withStore(makeStore, async (store) => {
      const history = await loadFixture<WorkoutRecord[]>("history-strength.json");
      for (const entry of history) {
        await store.import(validateWorkoutRecord(entry).record);
      }

      const fromOnly = await store.query({ from: "2026-09-04" });
      assert.deepEqual(fromOnly.records.map((record) => record.id), [
        "2026-09-04-strength",
        "2026-09-08-strength",
      ]);

      const toOnly = await store.query({ to: "2026-09-04" });
      assert.deepEqual(toOnly.records.map((record) => record.id), [
        "2026-09-01-strength",
        "2026-09-04-strength",
      ]);
    });
  });

  test(`${name}: rejects an invalid date filter with a readable ValidationError`, async () => {
    await withStore(makeStore, async (store) => {
      await assert.rejects(
        () => store.query({ from: "not-a-date" }),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError);
          assert.equal(error.issues[0].code, "INVALID_FILTER_DATE");
          return true;
        },
      );
    });
  });

  test(`${name}: rejects an inverted date range instead of silently returning nothing`, async () => {
    await withStore(makeStore, async (store) => {
      await assert.rejects(
        () => store.query({ from: "2026-09-10", to: "2026-09-01" }),
        ValidationError,
      );
    });
  });

  test(`${name}: re-validates every record on read and raises CORRUPT_STORE`, async () => {
    await withStore(makeStore, async (store) => {
      // An otherwise-valid record with a malformed date: both backends persist
      // it without import-time validation, and both must fail the read loudly
      // instead of surfacing it as data.
      const record = await fixtureRecord("valid-strength.json");
      const invalid: WorkoutRecord = { ...record, date: "not-a-date" };
      await store.import(invalid);

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
  });
}
