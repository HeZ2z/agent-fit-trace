import { describe, expect, it } from "vitest";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { deriveWorkoutId } from "./ids.ts";

function baseRecord(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "ignored-by-derivation",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

describe("deriveWorkoutId", () => {
  it("returns the same id for identical content", () => {
    expect(deriveWorkoutId(baseRecord())).toBe(deriveWorkoutId(baseRecord()));
  });

  it("is deterministic across repeated calls (no clock or randomness)", () => {
    const first = deriveWorkoutId(baseRecord());
    const second = deriveWorkoutId(baseRecord());
    const third = deriveWorkoutId(baseRecord());
    expect(new Set([first, second, third]).size).toBe(1);
  });

  it("ignores the incoming id and schema_version", () => {
    const a = deriveWorkoutId(baseRecord({ id: "a", schema_version: 1 }));
    const b = deriveWorkoutId(baseRecord({ id: "b", schema_version: 1 }));
    expect(a).toBe(b);
  });

  it("changes when the date changes", () => {
    expect(deriveWorkoutId(baseRecord())).not.toBe(deriveWorkoutId(baseRecord({ date: "2026-01-06" })));
  });

  it("changes when the session content changes", () => {
    const heavier = baseRecord({
      exercises: [{ name: "Squat", sets: [{ weight: 105, reps: 5, rpe: 8 }] }],
    });
    const differentExercise = baseRecord({
      exercises: [{ name: "Bench Press", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    });

    const base = deriveWorkoutId(baseRecord());
    expect(deriveWorkoutId(heavier)).not.toBe(base);
    expect(deriveWorkoutId(differentExercise)).not.toBe(base);
  });

  it("follows the wkt_<date>_<session_type>_<hash> shape", () => {
    expect(deriveWorkoutId(baseRecord())).toMatch(/^wkt_2026-01-05_strength_[0-9a-f]{8}$/);
  });
});
