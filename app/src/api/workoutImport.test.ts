import { describe, expect, it } from "vitest";
import { parseWorkoutImportFile } from "@pi-fit-trace/api-contracts";
import { ApiError, NetworkError } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { FakeFitTraceClient } from "../test/asyncClient.ts";
import { previewWorkoutImport, runWorkoutImport } from "./workoutImport.ts";

function record(id: string, weight = 100): WorkoutRecord {
  return {
    id,
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight, reps: 5, rpe: 8 }] }],
  };
}

function file(records: unknown[]): ReturnType<typeof parseWorkoutImportFile> {
  return parseWorkoutImportFile(JSON.stringify({ schema_version: 1, records }));
}

describe("previewWorkoutImport", () => {
  it("classifies new, existing-identical and conflicting records", () => {
    const parsed = file([record("a"), record("a"), record("b"), record("c", 120)]);
    const preview = previewWorkoutImport(parsed, [record("b"), record("c")]);

    expect(preview.totalEntries).toBe(3);
    expect(preview.totalIndexes).toBe(4);
    expect(preview.newIds).toEqual(["a"]);
    expect(preview.duplicateIds).toEqual(["b"]);
    expect(preview.conflictIds).toEqual(["c"]);
    expect(preview.canConfirm).toBe(false);
    expect(preview.entries[0].indexes).toEqual([0, 1]);
  });

  it("allows confirmation when every id is new or identical", () => {
    const preview = previewWorkoutImport(file([record("a"), record("b")]), [record("b")]);
    expect(preview.canConfirm).toBe(true);
    expect(preview.conflictIds).toEqual([]);
  });

  it("treats a backup with no records as an explicit no-op", () => {
    const preview = previewWorkoutImport(file([]), []);
    expect(preview.totalEntries).toBe(0);
    expect(preview.totalIndexes).toBe(0);
    expect(preview.canConfirm).toBe(false);
  });
});

describe("runWorkoutImport", () => {
  it("submits sequentially and receipts every original index", async () => {
    const client = new FakeFitTraceClient();
    const calls: string[] = [];
    client.createWorkout = async (value) => {
      calls.push(value.id);
      return { record: value, duplicate: false, warnings: [] };
    };

    const parsed = file([record("a"), record("a"), record("b")]);
    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(parsed, []).entries,
      existing: [],
    });

    expect(calls).toEqual(["a", "b"]);
    expect(receipt.items.map((item) => [item.index, item.recordId, item.status])).toEqual([
      [0, "a", "created"],
      [1, "a", "duplicate"],
      [2, "b", "created"],
    ]);
    expect(receipt.items.map((item) => item.index)).toEqual([0, 1, 2]);
    // One actual write per unique id: identical file repeats are merged
    // duplicates, not claimed as additional creations.
    expect(receipt.counts.created).toBe(2);
    expect(receipt.counts.duplicate).toBe(1);
  });

  it("counts one write followed by merged duplicate indexes", async () => {
    const client = new FakeFitTraceClient();
    let calls = 0;
    client.createWorkout = async (value) => {
      calls += 1;
      return { record: value, duplicate: false, warnings: [] };
    };

    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(file([record("a"), record("a")]), []).entries,
      existing: [],
    });

    expect(calls).toBe(1);
    expect(receipt.items.map((item) => [item.index, item.status])).toEqual([
      [0, "created"],
      [1, "duplicate"],
    ]);
    expect(receipt.counts.created).toBe(1);
    expect(receipt.counts.duplicate).toBe(1);
  });

  it("does not write ids that already match current history", async () => {
    const client = new FakeFitTraceClient();
    let calls = 0;
    client.createWorkout = async (value) => {
      calls += 1;
      return { record: value, duplicate: false, warnings: [] };
    };

    const parsed = file([record("a"), record("b")]);
    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(parsed, [record("a")]).entries,
      existing: [record("a")],
    });

    expect(calls).toBe(1);
    expect(receipt.items.map((item) => item.status)).toEqual(["duplicate", "created"]);
  });

  it("stops at the first conflict and leaves later indexes untouched", async () => {
    const client = new FakeFitTraceClient();
    client.createWorkout = async (value) => {
      if (value.id === "b") {
        throw new ApiError({ code: "CONFLICT", message: "exists", status: 409 });
      }
      return { record: value, duplicate: false, warnings: [] };
    };

    const parsed = file([record("a"), record("b"), record("c")]);
    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(parsed, []).entries,
      existing: [],
    });

    expect(receipt.items.map((item) => item.status)).toEqual([
      "created",
      "conflict",
      "not_attempted",
    ]);
    expect(receipt.stopped).toBe(true);
  });

  it("reads back an ambiguous network failure instead of fabricating created", async () => {
    const client = new FakeFitTraceClient({
      records: [record("a")],
    });
    client.createWorkout = async () => {
      throw new NetworkError("connection reset");
    };

    const parsed = file([record("a"), record("b")]);
    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(parsed, []).entries,
      existing: [],
    });

    expect(receipt.items[0]).toMatchObject({
      index: 0,
      status: "duplicate",
      readback: "present",
    });
    expect(receipt.items[1].status).toBe("not_attempted");
  });

  it("keeps an ambiguous write unknown when readback cannot find it", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    client.createWorkout = async () => {
      throw new NetworkError("timeout");
    };

    const parsed = file([record("a"), record("b")]);
    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(parsed, []).entries,
      existing: [],
    });

    expect(receipt.items[0]).toMatchObject({ status: "unknown", readback: "absent" });
    expect(receipt.items[0].error).toMatch(/may have been saved/i);
    expect(receipt.items[1].status).toBe("not_attempted");
  });

  it("reads back a malformed response because the write may already be committed", async () => {
    const client = new FakeFitTraceClient({ records: [record("a")] });
    client.createWorkout = async () => {
      throw new ApiError({
        code: "MALFORMED_RESPONSE",
        message: "Malformed response: `data` is missing.",
        status: 400,
      });
    };

    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(file([record("a"), record("b")]), []).entries,
      existing: [],
    });

    expect(receipt.items[0]).toMatchObject({
      status: "duplicate",
      readback: "present",
    });
    expect(receipt.items[1].status).toBe("not_attempted");
    expect(receipt.stopped).toBe(true);
  });

  it("does not claim created when the returned record differs from the submitted one", async () => {
    const client = new FakeFitTraceClient({ records: [record("a", 120)] });
    client.createWorkout = async () => ({
      record: record("a", 120),
      duplicate: false,
      warnings: [],
    });

    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(file([record("a"), record("b")]), []).entries,
      existing: [],
    });

    expect(receipt.items[0]).toMatchObject({
      status: "conflict",
      readback: "present",
    });
    expect(receipt.items[0].error).toMatch(/different content/i);
    expect(receipt.items[1].status).toBe("not_attempted");
    expect(receipt.stopped).toBe(true);
  });

  it("keeps an ambiguous write unknown when readback fails too", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    client.createWorkout = async () => {
      throw new ApiError({ code: "API_ERROR", message: "upstream", status: 503 });
    };
    client.listWorkouts = async () => {
      throw new Error("readback down");
    };

    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(file([record("a")]), []).entries,
      existing: [],
    });

    expect(receipt.items[0]).toMatchObject({ status: "unknown", readback: "unavailable" });
  });

  it("cancels only unstarted records", async () => {
    const client = new FakeFitTraceClient();
    let calls = 0;
    let cancelled = false;
    client.createWorkout = async (value) => {
      calls += 1;
      cancelled = true;
      return { record: value, duplicate: false, warnings: [] };
    };

    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(file([record("a"), record("b")]), []).entries,
      existing: [],
      isCancelled: () => cancelled,
    });

    expect(calls).toBe(1);
    expect(receipt.items.map((item) => item.status)).toEqual(["created", "not_attempted"]);
    expect(receipt.cancelled).toBe(true);
  });

  it("invalidates the run when the owner/client generation changes", async () => {
    const client = new FakeFitTraceClient();
    let current = true;
    let calls = 0;
    client.createWorkout = async (value) => {
      calls += 1;
      current = false;
      return { record: value, duplicate: false, warnings: [] };
    };

    const receipt = await runWorkoutImport({
      client,
      entries: previewWorkoutImport(file([record("a"), record("b")]), []).entries,
      existing: [],
      isCurrent: () => current,
    });

    expect(calls).toBe(1);
    expect(receipt.invalidated).toBe(true);
    expect(receipt.items[1].status).toBe("not_attempted");
  });
});
