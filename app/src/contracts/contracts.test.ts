import { describe, expect, it } from "vitest";
import { ValidationError, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";

const validRecord: WorkoutRecord = {
  id: "browser-1",
  schema_version: 1,
  date: "2026-01-05",
  session_type: "strength",
  exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
};

describe("@agent-fit-trace/core in the browser bundle", () => {
  it("accepts a valid workout record", () => {
    const { record, warnings } = validateWorkoutRecord(validRecord);

    expect(record.id).toBe("browser-1");
    expect(record.exercises[0]?.sets[0]?.weight).toBe(100);
    expect(warnings).toEqual([]);
  });

  it("rejects a negative weight as a hard validation error", () => {
    const invalid = {
      ...validRecord,
      exercises: [{ name: "Squat", sets: [{ weight: -10, reps: 5 }] }],
    };

    expect(() => validateWorkoutRecord(invalid)).toThrow(ValidationError);

    try {
      validateWorkoutRecord(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues.map((issue) => issue.code)).toContain(
        "INVALID_WEIGHT",
      );
    }
  });
});
