import assert from "node:assert/strict";
import { test } from "node:test";

import { ValidationError, validateWorkoutRecord } from "@agent-fit-trace/core";
import { loadFixture } from "./helpers.ts";

test("accepts a valid strength record and normalizes schema_version", async () => {
  const input = await loadFixture("valid-strength.json");
  const { record, warnings } = validateWorkoutRecord(input);

  assert.equal(record.id, "2026-09-01-strength");
  assert.equal(record.schema_version, 1);
  assert.equal(record.exercises[0].name, "bench_press");
  assert.equal(record.exercises[0].sets[0].weight, 80);
  assert.deepEqual(warnings, []);
});

test("accepts a valid cardio record", async () => {
  const input = await loadFixture("valid-cardio.json");
  const { record } = validateWorkoutRecord(input);
  assert.equal(record.session_type, "cardio");
});

test("accepts suspicious-but-usable data with warnings", async () => {
  const input = await loadFixture("suspicious.json");
  const { record, warnings } = validateWorkoutRecord(input);
  const codes = warnings.map((warning) => warning.code);

  assert.equal(record.schema_version, 1);
  assert.ok(codes.includes("MISSING_SCHEMA_VERSION"));
  assert.ok(codes.includes("SUSPICIOUS_DURATION"));
  assert.ok(codes.includes("SUSPICIOUS_SLEEP_HOURS"));
  assert.ok(codes.includes("ZERO_WEIGHT"));
});

test("rejects a negative weight", async () => {
  const input = await loadFixture("invalid-negative-weight.json");
  assert.throws(
    () => validateWorkoutRecord(input),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.issues.some((issue) => issue.code === "INVALID_WEIGHT"));
      return true;
    },
  );
});

test("rejects an out-of-range RPE", async () => {
  const input = await loadFixture("invalid-rpe.json");
  assert.throws(() => validateWorkoutRecord(input), ValidationError);
});

test("rejects a missing date", async () => {
  const input = await loadFixture("invalid-missing-date.json");
  assert.throws(
    () => validateWorkoutRecord(input),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.issues.some((issue) => issue.code === "INVALID_DATE"));
      return true;
    },
  );
});

test("rejects a malformed calendar date", () => {
  assert.throws(
    () =>
      validateWorkoutRecord({
        id: "x",
        date: "2026-02-30",
        session_type: "strength",
        exercises: [{ name: "squat", sets: [{ reps: 5 }] }],
      }),
    ValidationError,
  );
});

test("rejects an unsupported future schema_version", () => {
  assert.throws(
    () =>
      validateWorkoutRecord({
        id: "x",
        schema_version: 99,
        date: "2026-09-01",
        session_type: "strength",
        exercises: [{ name: "squat", sets: [{ reps: 5 }] }],
      }),
    ValidationError,
  );
});

test("warns on unknown fields instead of rejecting", () => {
  const { warnings } = validateWorkoutRecord({
    id: "x",
    schema_version: 1,
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "squat", sets: [{ reps: 5, tempo: "3-1-1" }] }],
    mood: "good",
  });
  const codes = warnings.map((warning) => warning.code);
  assert.equal(codes.filter((code) => code === "UNKNOWN_FIELD").length, 2);
});

test("rejects a non-object payload", () => {
  assert.throws(() => validateWorkoutRecord("nope"), ValidationError);
});
