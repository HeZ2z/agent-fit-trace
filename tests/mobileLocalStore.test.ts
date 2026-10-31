import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WORKOUTS_DB_NAME,
  WORKOUTS_DB_SCHEMA_VERSION,
  WORKOUTS_MIGRATIONS,
  WORKOUTS_NEWEST_FIRST_INDEX_SQL,
  WORKOUTS_TABLE_SQL,
  WorkoutStoreCorruptionError,
  classifyWorkoutWrite,
  decodeWorkoutPayload,
  encodeWorkoutPayload,
  fromWorkoutRow,
  latestWorkoutSchemaVersion,
  pendingWorkoutMigrations,
  prepareWorkoutId,
  sortWorkoutsNewestFirst,
  toWorkoutRow,
} from "../mobile/src/data/schema.ts";

/**
 * Pure coverage for the mobile local store contract. The SQLite repository is
 * intentionally not imported here: only the dependency-free schema module is
 * exercised, so the root `node:test` suite never needs a native runtime.
 */

type TestWorkout = Parameters<typeof toWorkoutRow>[0];

const CREATED_AT = "2026-09-01T12:00:00.000Z";

function record(overrides: Partial<TestWorkout> = {}): TestWorkout {
  return {
    id: "wkt_2026-09-01_strength_1a2b3c4d",
    schema_version: 1,
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

test("canonical payload round-trips a record exactly", () => {
  const input = record({
    duration_minutes: 60,
    sleep_hours: 7.5,
    pain: [{ area: "lower_back", level: 2 }],
    notes: "felt strong",
  });

  const payload = encodeWorkoutPayload(input);
  assert.deepEqual(decodeWorkoutPayload(payload), input);
  assert.equal(encodeWorkoutPayload(decodeWorkoutPayload(payload)), payload);
});

test("canonical payload sorts keys and drops undefined values", () => {
  const payload = encodeWorkoutPayload(record({ notes: undefined }));

  assert.ok(payload.startsWith('{"date":'));
  assert.ok(payload.indexOf('"date"') < payload.indexOf('"exercises"'));
  assert.ok(payload.indexOf('"exercises"') < payload.indexOf('"id"'));
  assert.ok(payload.indexOf('"id"') < payload.indexOf('"schema_version"'));
  assert.ok(payload.indexOf('"schema_version"') < payload.indexOf('"session_type"'));
  assert.ok(!payload.includes('"notes"'));
});

test("decode fails closed for malformed JSON and invalid records", () => {
  assert.throws(
    () => decodeWorkoutPayload("{not json"),
    (error: unknown) => {
      assert.ok(error instanceof WorkoutStoreCorruptionError);
      assert.equal(error.code, "CORRUPT_STORE");
      return true;
    },
  );
  assert.throws(
    () => decodeWorkoutPayload(JSON.stringify({ id: "missing-fields" })),
    WorkoutStoreCorruptionError,
  );
});

test("toWorkoutRow and fromWorkoutRow preserve the canonical record", () => {
  const input = record({ duration_minutes: 60, notes: "felt strong" });
  const row = toWorkoutRow(input, CREATED_AT);

  assert.deepEqual(row, {
    id: input.id,
    schema_version: 1,
    date: "2026-09-01",
    session_type: "strength",
    payload: encodeWorkoutPayload(input),
    created_at: CREATED_AT,
    origin: "local",
  });
  assert.deepEqual(fromWorkoutRow(row), input);
  assert.deepEqual(toWorkoutRow(input, CREATED_AT), row);
});

test("fromWorkoutRow rejects denormalized columns that disagree with the payload", () => {
  const row = toWorkoutRow(record(), CREATED_AT);

  assert.throws(
    () => fromWorkoutRow({ ...row, id: "other-id" }),
    WorkoutStoreCorruptionError,
  );
  assert.throws(
    () => fromWorkoutRow({ ...row, date: "2026-09-02" }),
    WorkoutStoreCorruptionError,
  );
  assert.throws(
    () => fromWorkoutRow({ ...row, session_type: "cardio" }),
    WorkoutStoreCorruptionError,
  );
  assert.throws(
    () => fromWorkoutRow({ ...row, payload: '{"id":"not-a-record"}' }),
    WorkoutStoreCorruptionError,
  );
  assert.throws(
    () => fromWorkoutRow({ ...row, created_at: "" }),
    WorkoutStoreCorruptionError,
  );
});

test("prepareWorkoutId preserves supplied ids and derives missing ones", () => {
  assert.equal(prepareWorkoutId(record({ id: "caller-supplied" })), "caller-supplied");

  const draft = record({ id: "" });
  const derived = prepareWorkoutId(draft);
  assert.match(derived, /^wkt_2026-09-01_strength_[0-9a-f]{8}$/);
  assert.equal(prepareWorkoutId(record({ id: "" })), derived, "derivation is deterministic");
  assert.equal(prepareWorkoutId(record({ id: "   " })), derived, "blank ids are treated as absent");
});

test("newest-first ordering matches date DESC, id DESC", () => {
  const input = [
    record({ id: "b", date: "2026-09-03" }),
    record({ id: "a", date: "2026-09-01" }),
    record({ id: "c", date: "2026-09-03" }),
    record({ id: "d", date: "2026-09-03T08:00:00Z" }),
  ];

  const sorted = sortWorkoutsNewestFirst(input);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["d", "c", "b", "a"],
  );
  assert.deepEqual(
    input.map((entry) => entry.id),
    ["b", "a", "c", "d"],
    "input order is not mutated",
  );
});

test("newest-first ordering compares instants, not offset text", () => {
  const input = [
    record({ id: "offset", date: "2026-09-02T00:30:00+02:00" }),
    record({ id: "utc", date: "2026-09-01T23:30:00Z" }),
  ];

  assert.deepEqual(
    sortWorkoutsNewestFirst(input).map((entry) => entry.id),
    ["utc", "offset"],
    "the later instant wins even when its text sorts lower",
  );
});

test("schema version and migration list stay consistent", () => {
  assert.equal(WORKOUTS_DB_NAME, "fit-trace.db");
  assert.equal(WORKOUTS_DB_SCHEMA_VERSION, latestWorkoutSchemaVersion());
  assert.ok(WORKOUTS_MIGRATIONS.length > 0);
  WORKOUTS_MIGRATIONS.forEach((migration, index) => {
    assert.equal(migration.version, index + 1, "migrations are contiguous from version 1");
    assert.ok(migration.statements.length > 0, "each migration has statements");
  });
  assert.equal(
    WORKOUTS_MIGRATIONS[WORKOUTS_MIGRATIONS.length - 1]?.version,
    WORKOUTS_DB_SCHEMA_VERSION,
  );

  assert.deepEqual(pendingWorkoutMigrations(0), WORKOUTS_MIGRATIONS);
  assert.deepEqual(pendingWorkoutMigrations(WORKOUTS_DB_SCHEMA_VERSION), []);
  assert.throws(
    () => pendingWorkoutMigrations(WORKOUTS_DB_SCHEMA_VERSION + 1),
    /newer than supported/,
  );
  assert.throws(() => pendingWorkoutMigrations(-1), RangeError);
  assert.throws(() => pendingWorkoutMigrations(1.5), RangeError);
});

test("DDL defines the canonical columns and the newest-first index", () => {
  assert.match(WORKOUTS_TABLE_SQL, /CREATE TABLE IF NOT EXISTS workouts/i);
  assert.match(WORKOUTS_TABLE_SQL, /id TEXT PRIMARY KEY NOT NULL/i);
  assert.match(WORKOUTS_TABLE_SQL, /payload TEXT NOT NULL/i);
  for (const column of ["schema_version", "date", "session_type", "payload", "created_at"]) {
    assert.match(WORKOUTS_TABLE_SQL, new RegExp(`\\b${column}\\b`));
  }
  assert.match(
    WORKOUTS_NEWEST_FIRST_INDEX_SQL,
    /CREATE INDEX IF NOT EXISTS workouts_newest_first_idx/i,
  );
  assert.match(WORKOUTS_NEWEST_FIRST_INDEX_SQL, /ON workouts \(date DESC, id DESC\)/i);

  assert.ok(WORKOUTS_MIGRATIONS[0].statements.includes(WORKOUTS_TABLE_SQL));
  assert.ok(WORKOUTS_MIGRATIONS[0].statements.includes(WORKOUTS_NEWEST_FIRST_INDEX_SQL));
});

test("classifyWorkoutWrite never turns a different record into a duplicate", () => {
  const existing = record({ id: "w-conf", date: "2026-09-01" });
  const identical = record({ id: "w-conf", date: "2026-09-01" });
  const stored = fromWorkoutRow(toWorkoutRow(existing, CREATED_AT));

  assert.deepEqual(classifyWorkoutWrite(null, existing), { action: "insert" });
  assert.equal(classifyWorkoutWrite(stored, identical).action, "duplicate");

  const changed = record({
    id: "w-conf",
    date: "2026-09-01",
    exercises: [{ name: "bench_press", sets: [{ weight: 95, reps: 5, rpe: 9 }] }],
  });
  const decision = classifyWorkoutWrite(stored, changed);
  assert.equal(decision.action, "conflict");
  if (decision.action === "conflict") {
    assert.equal(decision.existing.id, "w-conf");
    assert.notEqual(
      encodeWorkoutPayload(decision.existing),
      encodeWorkoutPayload(changed),
      "conflicting content is detectable before any write",
    );
  }
});
