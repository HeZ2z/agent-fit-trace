import { describe, expect, it } from "vitest";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { loadRecords, saveRecord } from "../storage/workoutRepository.ts";
import { LocalFitTraceClient } from "./localFitTraceClient.ts";

function record(id: string, date = "2026-10-01"): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    id,
    date,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
  }).record;
}

describe("LocalFitTraceClient owner namespace", () => {
  it("isolates owner-scoped records and hides legacy unowned keys", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record("legacy", "2026-09-01"));
    const ownerA = new LocalFitTraceClient(adapter, {
      ownerId: "owner-a",
      now: () => new Date("2026-10-17T12:00:00Z"),
    });
    const ownerB = new LocalFitTraceClient(adapter, "owner-b");

    await ownerA.createWorkout(record("shared", "2026-10-01"));
    await ownerB.createWorkout(record("shared", "2026-11-01"));

    expect((await ownerA.listWorkouts()).map((item) => item.id)).toEqual(["shared"]);
    expect((await ownerA.listWorkouts())[0]?.date).toBe("2026-10-01");
    expect((await ownerB.listWorkouts())[0]?.date).toBe("2026-11-01");
    // Legacy keys are still on disk but never surface in an owner view.
    expect(loadRecords(adapter).map((item) => item.id)).toEqual(["legacy"]);
    expect(await ownerA.listWorkouts()).toHaveLength(1);
  });

  it("keeps idempotency per owner, not global", async () => {
    const adapter = new MemoryStorageAdapter();
    const ownerA = new LocalFitTraceClient(adapter, "owner-a");
    const ownerB = new LocalFitTraceClient(adapter, "owner-b");
    const input = record("same-id");

    const first = await ownerA.createWorkout(input);
    const other = await ownerB.createWorkout(input);

    expect(first.duplicate).toBe(false);
    expect(other.duplicate).toBe(false);
  });

  it("leaves the legacy namespace behaviour unchanged when no owner is supplied", async () => {
    const adapter = new MemoryStorageAdapter();
    const legacy = new LocalFitTraceClient(adapter);
    await legacy.createWorkout(record("legacy-only"));
    expect(loadRecords(adapter).map((item) => item.id)).toEqual(["legacy-only"]);
  });
});
