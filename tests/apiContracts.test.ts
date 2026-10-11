import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import {
  API_ENDPOINTS,
  API_ERROR_CODES,
  ApiError,
  deriveWorkoutId,
  MalformedResponseError,
  parseAnalysisResult,
  parseCreateWorkoutResult,
  parsePlanDraft,
  parseWorkoutList,
} from "@pi-fit-trace/api-contracts";
import type { CreateWorkoutResult, FitTraceClient } from "@pi-fit-trace/api-contracts";
import { createMemoryHandler } from "@pi-fit-trace/api-contracts/testing";
import type { HandlerResponse } from "@pi-fit-trace/api-contracts/testing";
import type { WorkoutRecord } from "@pi-fit-trace/core";

function record(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    sleep_hours: 8,
    ...over,
  }).record;
}

const r1 = record({ id: "wkt-1", date: "2026-09-01" });
const r2 = record({
  id: "wkt-2",
  date: "2026-09-03",
  exercises: [{ name: "bench_press", sets: [{ weight: 85, reps: 5, rpe: 7 }] }],
});

function body(input: WorkoutRecord): unknown {
  return JSON.parse(
    JSON.stringify({
      ...input,
      id: "ignored",
      schema_version: 99,
    }),
  );
}

test("deriveWorkoutId ignores id/schema_version and matches the documented format", () => {
  const content = { ...r1, id: "aaa", schema_version: 1 };
  const sameOtherMeta = { ...r1, id: "bbb", schema_version: 99 };
  assert.equal(deriveWorkoutId(content), deriveWorkoutId(sameOtherMeta));
  assert.match(deriveWorkoutId(content), /^wkt_2026-09-01_strength_[0-9a-f]{8}$/);
});

test("deriveWorkoutId changes when content changes", () => {
  assert.notEqual(deriveWorkoutId(r1), deriveWorkoutId(r2));
});

test("validators round-trip real core outputs", () => {
  assert.deepEqual(parseWorkoutList([r1, r2]), [r1, r2]);
  assert.deepEqual(
    parseCreateWorkoutResult({ record: r1, duplicate: false, warnings: [] }),
    { record: r1, duplicate: false, warnings: [] },
  );
  assert.deepEqual(parseAnalysisResult(analyzeProgress([r1, r2])), analyzeProgress([r1, r2]));
  assert.deepEqual(parsePlanDraft(generateNextPlan([r1, r2])), generateNextPlan([r1, r2]));
});

test("parseWorkoutList rejects a malformed item, naming the index", () => {
  assert.throws(
    () => parseWorkoutList([r1, { id: "", date: "nope" }]),
    (error: unknown) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.equal(error.field, "(root)[1]");
      return true;
    },
  );
});

test("parseAnalysisResult rejects a missing numeric field", () => {
  const bad = structuredClone(analyzeProgress([r1, r2]));
  delete (bad.metrics as unknown as Record<string, unknown>).sessions;
  assert.throws(
    () => parseAnalysisResult(bad),
    (error: unknown) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.match(error.message, /metrics\.sessions/);
      return true;
    },
  );
});

test("parseAnalysisResult rejects a non-finite (NaN) metric", () => {
  const bad = structuredClone(analyzeProgress([r1, r2])) as unknown as {
    metrics: { volume_kg: number };
  };
  bad.metrics.volume_kg = Number.NaN;
  assert.throws(
    () => parseAnalysisResult(bad),
    (error: unknown) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.match(error.message, /metrics\.volume_kg/);
      return true;
    },
  );
});

test("parseAnalysisResult rejects an out-of-vocabulary severity", () => {
  const bad = {
    ...analyzeProgress([r1, r2]),
    flags: [{ code: "X", severity: "catastrophic", message: "m", evidence: {} }],
  };
  assert.throws(
    () => parseAnalysisResult(bad),
    (error: unknown) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.match(error.message, /flags\[0\]\.severity/);
      return true;
    },
  );
});

test("parseAnalysisResult rejects a non-object root", () => {
  assert.throws(
    () => parseAnalysisResult(42),
    (error: unknown) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.equal(error.field, "(root)");
      return true;
    },
  );
});

test("parsePlanDraft rejects a non-draft payload", () => {
  const notDraft = { ...generateNextPlan([r1, r2]), is_draft: false };
  assert.throws(
    () => parsePlanDraft(notDraft),
    (error: unknown) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.equal(error.field, "is_draft");
      return true;
    },
  );
});

test("ApiError carries code, details and status; codes are exported", () => {
  const err = new ApiError({
    code: API_ERROR_CODES.CONFLICT,
    message: "conflict",
    details: { id: "wkt-1" },
    status: 409,
  });
  assert.ok(err instanceof Error);
  assert.equal(err.code, "CONFLICT");
  assert.deepEqual(err.details, { id: "wkt-1" });
  assert.equal(err.status, 409);
  assert.deepEqual(API_ERROR_CODES, {
    VALIDATION_ERROR: "VALIDATION_ERROR",
    CONFLICT: "CONFLICT",
    CORRUPT_STORE: "CORRUPT_STORE",
    STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
    UNAUTHENTICATED: "UNAUTHENTICATED",
    FORBIDDEN: "FORBIDDEN",
    NETWORK_ERROR: "NETWORK_ERROR",
    MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
    API_ERROR: "API_ERROR",
  });
});

function makeClient(): FitTraceClient {
  const store = new Map<string, WorkoutRecord>();
  store.set(r1.id, r1);
  return {
    async listWorkouts() {
      return [...store.values()];
    },
    async createWorkout(input: WorkoutRecord): Promise<CreateWorkoutResult> {
      let normalized: WorkoutRecord;
      try {
        normalized = validateWorkoutRecord(input).record;
      } catch (error) {
        throw new ApiError({
          code: API_ERROR_CODES.VALIDATION_ERROR,
          message: (error as Error).message,
        });
      }
      const existing = store.get(normalized.id);
      if (existing !== undefined) {
        if (stableStringify(existing) === stableStringify(normalized)) {
          return { record: existing, duplicate: true, warnings: [] };
        }
        throw new ApiError({
          code: API_ERROR_CODES.CONFLICT,
          message: `id ${normalized.id} already exists`,
          details: { id: normalized.id },
        });
      }
      store.set(normalized.id, normalized);
      return { record: normalized, duplicate: false, warnings: [] };
    },
    async analyze(filter) {
      return analyzeProgress([...store.values()], filter);
    },
    async createPlanDraft(input) {
      return generateNextPlan([...store.values()], input);
    },
  };
}

function decode(response: HandlerResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

test("memory handler serves all four endpoints with correct statuses", async () => {
  const handler = createMemoryHandler(makeClient());

  const list = await handler(API_ENDPOINTS.workouts);
  assert.equal(list.status, 200);
  assert.deepEqual(decode(list).data, [r1]);

  const created = await handler(API_ENDPOINTS.workouts, {
    method: "POST",
    body: JSON.stringify({ record: r2 }),
  });
  assert.equal(created.status, 201);
  assert.equal((decode(created).data as CreateWorkoutResult).duplicate, false);

  const retry = await handler(API_ENDPOINTS.workouts, {
    method: "POST",
    body: JSON.stringify({ record: r2 }),
  });
  assert.equal(retry.status, 200);
  assert.equal((decode(retry).data as CreateWorkoutResult).duplicate, true);

  const conflict = await handler(API_ENDPOINTS.workouts, {
    method: "POST",
    body: JSON.stringify({ record: { ...r1, date: "2026-12-31" } }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((decode(conflict).error as { code: string }).code, API_ERROR_CODES.CONFLICT);

  const invalid = await handler(API_ENDPOINTS.workouts, {
    method: "POST",
    body: JSON.stringify({ record: body(r1) }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((decode(invalid).error as { code: string }).code, API_ERROR_CODES.VALIDATION_ERROR);

  const analysis = await handler(`${API_ENDPOINTS.analysis}?from=2026-09-01&exercises=bench_press,squat`);
  assert.equal(analysis.status, 200);
  assert.deepEqual(decode(analysis).data, analyzeProgress([r1, r2], { from: "2026-09-01", exercises: ["bench_press", "squat"] }));

  const draft = await handler(API_ENDPOINTS.planDrafts, { method: "POST" });
  assert.equal(draft.status, 200);
  assert.equal((decode(draft).data as { is_draft: boolean }).is_draft, true);
});
