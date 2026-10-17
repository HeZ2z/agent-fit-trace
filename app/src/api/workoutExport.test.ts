import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, ValidationError, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_RECORDS,
  parseWorkoutImportFile,
} from "@pi-fit-trace/api-contracts";
import { planWorkoutExport, serializeWorkoutExport } from "./workoutExport.ts";
import type { WorkoutExportFile } from "./contracts.ts";

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

describe("serializeWorkoutExport", () => {
  it("serializes to the documented exchange shape", () => {
    const output = serializeWorkoutExport([record(), record({ id: "wkt_b", date: "2026-01-07" })]);
    const parsed = JSON.parse(output) as WorkoutExportFile;

    expect(parsed.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records.map((entry) => entry.id)).toEqual(["wkt_a", "wkt_b"]);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("is byte-identical for the same records (idempotent, no clock or randomness)", () => {
    const records = [record(), record({ id: "wkt_b", date: "2026-01-07" })];

    const first = serializeWorkoutExport(records);
    const second = serializeWorkoutExport(records);

    expect(first).toBe(second);
  });

  it("emits records that each pass validateWorkoutRecord", () => {
    const output = serializeWorkoutExport([record(), record({ id: "wkt_b", date: "2026-01-07" })]);
    const parsed = JSON.parse(output) as WorkoutExportFile;

    for (const entry of parsed.records) {
      expect(() => validateWorkoutRecord(entry)).not.toThrow();
    }
  });

  it("throws and produces nothing when a record is invalid", () => {
    const invalid = record({
      exercises: [{ name: "Squat", sets: [{ weight: -10, reps: 5 }] }],
    });

    expect(() => serializeWorkoutExport([invalid])).toThrow(ValidationError);
  });
});

describe("planWorkoutExport", () => {
  it("keeps a small history in the existing workout.json file", () => {
    const records = [record(), record({ id: "wkt_b", date: "2026-01-07" })];
    const parts = planWorkoutExport(records);

    expect(parts.map((part) => part.filename)).toEqual(["workout.json"]);
    expect(parts[0]?.text).toBe(serializeWorkoutExport(records));
    expect(parts[0]?.recordCount).toBe(2);
  });

  it("splits a history above the restore record cap into restorable files", () => {
    const records = Array.from({ length: IMPORT_MAX_FILE_RECORDS + 1 }, (_, index) =>
      record({ id: `wkt_${index}` }),
    );

    const parts = planWorkoutExport(records);
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.filename)).toEqual([
      "workout-01-of-02.json",
      "workout-02-of-02.json",
    ]);

    const restoredIds = parts.flatMap((part) => {
      expect(byteLength(part.text)).toBeLessThanOrEqual(IMPORT_MAX_FILE_BYTES);
      const parsed = parseWorkoutImportFile(part.text);
      expect(parsed.entries.length).toBeGreaterThan(0);
      expect(parsed.entries.length).toBeLessThanOrEqual(IMPORT_MAX_FILE_RECORDS);
      return parsed.entries.map((entry) => entry.record.id);
    });
    expect(restoredIds).toEqual(records.map((entry) => entry.id));
  });

  it("splits by bytes as well as count while keeping each record restorable", () => {
    // Each record is under the single-record request bound but 30 of them
    // exceed the 1 MiB file bound.
    const sets = Array.from({ length: 80 }, () => ({ weight: 100, reps: 5, rpe: 8 }));
    const exercises = Array.from({ length: 10 }, () => ({ name: "Squat", sets }));
    const records = Array.from({ length: 30 }, (_, index) =>
      record({ id: `wkt_${index}`, notes: "n".repeat(4_000), exercises }),
    );

    const parts = planWorkoutExport(records);
    expect(parts.length).toBeGreaterThan(1);
    const restored = parts.flatMap((part) =>
      parseWorkoutImportFile(part.text).entries.map((entry) => entry.record.id),
    );
    expect(restored).toEqual(records.map((entry) => entry.id));
  });

  it("fails explicitly instead of downloading a file restore would reject", () => {
    const oversized = record({ notes: "n".repeat(IMPORT_MAX_FILE_BYTES) });

    expect(() => planWorkoutExport([oversized])).toThrow(/cannot export record/i);
  });
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
