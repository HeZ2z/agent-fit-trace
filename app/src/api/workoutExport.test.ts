import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  ValidationError,
  stableStringify,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_RECORDS,
  IMPORT_MAX_REQUEST_BYTES,
  WORKOUT_MAX_ID_BYTES,
  WORKOUT_MAX_REQUEST_BYTES,
  parseWorkoutImportFile,
} from "@agent-fit-trace/api-contracts";
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
    const plan = planWorkoutExport(records);

    expect(plan.files.map((part) => part.filename)).toEqual(["workout.json"]);
    expect(plan.files[0]?.text).toBe(serializeWorkoutExport(records));
    expect(plan.files[0]?.recordCount).toBe(2);
    expect(plan.excluded).toEqual([]);
  });

  it("splits a history above the restore record cap into restorable files", () => {
    const records = Array.from({ length: IMPORT_MAX_FILE_RECORDS + 1 }, (_, index) =>
      record({ id: `wkt_${index}` }),
    );

    const plan = planWorkoutExport(records);
    expect(plan.excluded).toEqual([]);
    expect(plan.files).toHaveLength(2);
    expect(plan.files.map((part) => part.filename)).toEqual([
      "workout-01-of-02.json",
      "workout-02-of-02.json",
    ]);

    const restoredIds = plan.files.flatMap((part) => {
      expect(byteLength(part.text)).toBeLessThanOrEqual(IMPORT_MAX_FILE_BYTES);
      const parsed = parseWorkoutImportFile(part.text);
      expect(parsed.entries.length).toBeGreaterThan(0);
      expect(parsed.entries.length).toBeLessThanOrEqual(IMPORT_MAX_FILE_RECORDS);
      return parsed.entries.map((entry) => entry.record.id);
    });
    expect(restoredIds).toEqual(records.map((entry) => entry.id));
  });

  it("exports a large but valid stored workout above the snapshot request cap", () => {
    // Local saves have no snapshot request cap. This is a valid stored record
    // whose single-record request is above 40 KiB but within the backup file.
    const large = record({ id: "wkt_large", notes: "n".repeat(50_000) });
    expect(() => validateWorkoutRecord(large)).not.toThrow();
    const requestBytes = byteLength(stableStringify({ record: large }));
    expect(requestBytes).toBeGreaterThan(IMPORT_MAX_REQUEST_BYTES);
    expect(requestBytes).toBeLessThanOrEqual(WORKOUT_MAX_REQUEST_BYTES);

    const plan = planWorkoutExport([large, record({ id: "wkt_small" })]);
    expect(plan.excluded).toEqual([]);
    expect(plan.files).toHaveLength(1);
    const restored = parseWorkoutImportFile(plan.files[0]?.text as string).entries;
    expect(restored.map((entry) => entry.record.id)).toEqual(["wkt_large", "wkt_small"]);
    expect(restored[0]?.record.notes).toHaveLength(50_000);
  });

  it("splits by bytes as well as count while keeping each record restorable", () => {
    // Each record is under the workout restore request bound but 30 of them
    // exceed the 1 MiB file bound.
    const sets = Array.from({ length: 80 }, () => ({ weight: 100, reps: 5, rpe: 8 }));
    const exercises = Array.from({ length: 10 }, () => ({ name: "Squat", sets }));
    const records = Array.from({ length: 30 }, (_, index) =>
      record({ id: `wkt_${index}`, notes: "n".repeat(4_000), exercises }),
    );

    const plan = planWorkoutExport(records);
    expect(plan.excluded).toEqual([]);
    expect(plan.files.length).toBeGreaterThan(1);
    const restored = plan.files.flatMap((part) =>
      parseWorkoutImportFile(part.text).entries.map((entry) => entry.record.id),
    );
    expect(restored).toEqual(records.map((entry) => entry.id));
  });

  it("exports and restores a 300-character id under the btree-safe byte bound", () => {
    // Existing history can contain ids longer than the snapshot/source-id
    // contract. Workout ids are bounded in UTF-8 bytes, not characters, so a
    // 300-character legacy id must still round-trip through backup and restore.
    const legacy = record({ id: "w".repeat(300) });
    expect(legacy.id).toHaveLength(300);
    expect(byteLength(legacy.id)).toBeLessThanOrEqual(WORKOUT_MAX_ID_BYTES);

    const plan = planWorkoutExport([legacy]);
    expect(plan.excluded).toEqual([]);
    expect(plan.files).toHaveLength(1);
    const restored = parseWorkoutImportFile(plan.files[0]?.text as string).entries;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.record.id).toBe(legacy.id);
  });

  it("reports an over-bound record without blocking the rest of the export", () => {
    const overBoundId = "w".repeat(WORKOUT_MAX_ID_BYTES + 1);
    expect(byteLength(overBoundId)).toBeGreaterThan(WORKOUT_MAX_ID_BYTES);
    const records = [
      record({ id: "wkt_first" }),
      record({ id: overBoundId, date: "2026-01-06" }),
      record({ id: "wkt_last", date: "2026-01-07" }),
    ];

    const plan = planWorkoutExport(records);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0]?.id).toBe(overBoundId);
    expect(plan.excluded[0]?.reason).toMatch(
      new RegExp(`at most ${WORKOUT_MAX_ID_BYTES} UTF-8 bytes`),
    );

    const restoredIds = plan.files.flatMap((part) =>
      parseWorkoutImportFile(part.text).entries.map((entry) => entry.record.id),
    );
    expect(restoredIds).toEqual(["wkt_first", "wkt_last"]);
    // No silent loss: every input record is either in a restorable file or
    // explicitly reported as excluded.
    expect([...restoredIds, ...plan.excluded.map((entry) => entry.id)].sort()).toEqual(
      records.map((entry) => entry.id).sort(),
    );
  });

  it("reports a single record that cannot fit any restorable file instead of throwing", () => {
    const oversized = record({ notes: "n".repeat(IMPORT_MAX_FILE_BYTES) });

    const plan = planWorkoutExport([oversized]);
    expect(plan.files).toEqual([]);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0]?.id).toBe("wkt_a");
    expect(plan.excluded[0]?.reason).toMatch(
      new RegExp(`above the ${IMPORT_MAX_FILE_BYTES} byte restore limit`),
    );
  });

  it("reports a record the core validator rejects while exporting valid history", () => {
    const invalid = record({ id: "wkt_invalid", exercises: [] });

    const plan = planWorkoutExport([
      record({ id: "wkt_first" }),
      invalid,
      record({ id: "wkt_last" }),
    ]);
    expect(plan.excluded).toEqual([
      { id: "wkt_invalid", reason: expect.stringMatching(/workout validator/) },
    ]);
    const restoredIds = plan.files.flatMap((part) =>
      parseWorkoutImportFile(part.text).entries.map((entry) => entry.record.id),
    );
    expect(restoredIds).toEqual(["wkt_first", "wkt_last"]);
  });
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
