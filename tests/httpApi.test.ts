import assert from "node:assert/strict";
import { after, test } from "node:test";

import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { HttpFitTraceClient } from "../app/src/api/httpFitTraceClient.ts";
import { startDevApiServer } from "../server/devApiServer.ts";
import type { DevApiServer } from "../server/devApiServer.ts";

let server: DevApiServer;
let baseUrl: string;
let client: HttpFitTraceClient;

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

test("setup: start loopback dev API", async () => {
  server = await startDevApiServer({ port: 0 });
  baseUrl = `http://127.0.0.1:${server.port}/api/v1`;
  client = new HttpFitTraceClient({ baseUrl });
});

after(async () => {
  await server?.close();
});

test("empty history returns an empty list", async () => {
  assert.deepEqual(await client.listWorkouts(), []);
});

test("import then list returns deterministic ascending order for out-of-order dates", async () => {
  await client.createWorkout(seedRecord({ id: "w-03", date: "2026-09-08" }));
  await client.createWorkout(seedRecord({ id: "w-01", date: "2026-09-01" }));
  await client.createWorkout(seedRecord({ id: "w-02", date: "2026-09-04" }));
  const ids = (await client.listWorkouts()).map((record) => record.id);
  assert.deepEqual(ids, ["w-01", "w-02", "w-03"]);
});

test("raw POST: 201 on new, 200 duplicate on identical retry, history length stays 1", async () => {
  const record = seedRecord({ id: "w-wire", date: "2026-09-10" });
  const first = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record }),
  });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { data: { duplicate: boolean } };
  assert.equal(firstBody.data.duplicate, false);

  const retry = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record }),
  });
  assert.equal(retry.status, 200);
  const retryBody = (await retry.json()) as { data: { duplicate: boolean } };
  assert.equal(retryBody.data.duplicate, true);

  const list = await fetch(`${baseUrl}/workouts`);
  const listBody = (await list.json()) as { data: unknown[] };
  assert.equal(listBody.data.filter((entry) => (entry as { id: string }).id === "w-wire").length, 1);
});

test("large valid workouts round-trip through the loopback API", async () => {
  // The body is larger than the old 64 KiB general HTTP cap. Restore submits
  // one whole record, so the workout route must accept the backup bound.
  const record = seedRecord({
    id: "w-large-api",
    date: "2026-09-13",
    notes: "n".repeat(200_000),
  });
  const created = await client.createWorkout(record);
  assert.equal(created.duplicate, false);
  assert.ok(created.record.id === "w-large-api");

  const listed = (await client.listWorkouts()).find((entry) => entry.id === "w-large-api");
  assert.equal(listed?.notes?.length, 200_000);
});

test("same id with different content → 409; client surfaces CONFLICT", async () => {
  const record = seedRecord({ id: "w-conflict", date: "2026-09-11" });
  await client.createWorkout(record);
  const raw = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({
      record: { ...record, exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }] },
    }),
  });
  assert.equal(raw.status, 409);
  const error = await client
    .createWorkout({ ...record, exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }] })
    .then(
      () => null,
      (caught: unknown) => caught,
    );
  assert.ok(error instanceof ApiError);
  assert.equal((error as ApiError).code, API_ERROR_CODES.CONFLICT);
});

test("invalid record → 400; client surfaces VALIDATION_ERROR", async () => {
  const record = seedRecord({ id: "w-bad", date: "2026-09-12" });
  const invalid = { ...record, exercises: [{ name: "bench_press", sets: [{ weight: -5, reps: 5 }] }] };
  const raw = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record: invalid }),
  });
  assert.equal(raw.status, 400);
  const error = await client.createWorkout(invalid as WorkoutRecord).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ApiError);
  assert.equal((error as ApiError).code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("analyze respects the from/to window; inverted range → VALIDATION_ERROR", async () => {
  await client.createWorkout(seedRecord({ id: "w-an-early", date: "2026-10-02" }));
  await client.createWorkout(seedRecord({ id: "w-an-mid", date: "2026-10-05" }));
  await client.createWorkout(seedRecord({ id: "w-an-late", date: "2026-10-09" }));
  const result = await client.analyze({ from: "2026-10-03", to: "2026-10-07" });
  assert.deepEqual(result.source_records, ["w-an-mid"]);
  const error = await client.analyze({ from: "2026-09-10", to: "2026-09-01" }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ApiError);
  assert.equal((error as ApiError).code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("createPlanDraft returns a confirmation-gated draft", async () => {
  const draft = await client.createPlanDraft();
  assert.equal(draft.is_draft, true);
  assert.equal(draft.requires_confirmation, true);
});

test("concurrent imports of the same record serialize: one new, rest duplicates", async () => {
  const record = seedRecord({ id: "w-race", date: "2026-09-13" });
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch(`${baseUrl}/workouts`, {
        method: "POST",
        body: JSON.stringify({ record }),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as { data: { duplicate: boolean } },
      })),
    ),
  );
  const fresh = results.filter((result) => result.status === 201);
  const duplicates = results.filter((result) => result.status === 200 && result.body.data.duplicate);
  assert.equal(fresh.length, 1);
  assert.equal(duplicates.length, 9);
  const list = await client.listWorkouts();
  assert.equal(list.filter((entry) => entry.id === "w-race").length, 1);
});

test("retry after a lost acknowledgement stays idempotent", async () => {
  const record = seedRecord({ id: "w-lost-ack", date: "2026-09-14" });
  const before = (await client.listWorkouts()).length;
  await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record }),
  });
  // Simulate the client never seeing the first response: repeat verbatim.
  const retry = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record }),
  });
  const retryBody = (await retry.json()) as { data: { duplicate: boolean } };
  assert.equal(retry.status, 200);
  assert.equal(retryBody.data.duplicate, true);
  assert.equal((await client.listWorkouts()).length, before + 1);
});

test("server preserves caller-supplied ids instead of re-deriving them", async () => {
  const record = seedRecord({ id: "custom-id-kept", date: "2026-09-15" });
  await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record }),
  });
  const list = (await (await fetch(`${baseUrl}/workouts`)).json()) as {
    data: { id: string }[];
  };
  assert.ok(list.data.some((entry) => entry.id === "custom-id-kept"));
});

test("raw POST: null record → 400 VALIDATION_ERROR", async () => {
  const raw = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record: null }),
  });
  assert.equal(raw.status, 400);
  const body = (await raw.json()) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("raw POST: missing id → 400 VALIDATION_ERROR", async () => {
  const record = seedRecord({ id: "w-no-id-tmp", date: "2026-09-16" });
  const { id: _dropped, ...withoutId } = record;
  const raw = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record: withoutId }),
  });
  assert.equal(raw.status, 400);
  const body = (await raw.json()) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("raw POST: blank id → 400 VALIDATION_ERROR", async () => {
  const record = seedRecord({ id: "w-blank-tmp", date: "2026-09-17" });
  const raw = await fetch(`${baseUrl}/workouts`, {
    method: "POST",
    body: JSON.stringify({ record: { ...record, id: "   " } }),
  });
  assert.equal(raw.status, 400);
  const body = (await raw.json()) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("raw POST: null plan body → 400 VALIDATION_ERROR; array body → 400", async () => {
  const nullBody = await fetch(`${baseUrl}/plans/drafts`, {
    method: "POST",
    body: JSON.stringify(null),
  });
  assert.equal(nullBody.status, 400);
  const nullJson = (await nullBody.json()) as { error: { code: string } };
  assert.equal(nullJson.error.code, API_ERROR_CODES.VALIDATION_ERROR);

  const arrayBody = await fetch(`${baseUrl}/plans/drafts`, {
    method: "POST",
    body: JSON.stringify([]),
  });
  assert.equal(arrayBody.status, 400);
  const arrayJson = (await arrayBody.json()) as { error: { code: string } };
  assert.equal(arrayJson.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("raw POST: no plan body still returns a valid draft", async () => {
  const raw = await fetch(`${baseUrl}/plans/drafts`, { method: "POST" });
  assert.equal(raw.status, 200);
  const body = (await raw.json()) as { data: { is_draft: boolean; requires_confirmation: boolean } };
  assert.equal(body.data.is_draft, true);
  assert.equal(body.data.requires_confirmation, true);
});

test("raw POST: non-string goal → 400 VALIDATION_ERROR", async () => {
  const raw = await fetch(`${baseUrl}/plans/drafts`, {
    method: "POST",
    body: JSON.stringify({ goal: 42 }),
  });
  assert.equal(raw.status, 400);
  const body = (await raw.json()) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("raw POST: out-of-range or non-integer days_available → 400", async () => {
  for (const daysAvailable of [0, 8, 3.5]) {
    const raw = await fetch(`${baseUrl}/plans/drafts`, {
      method: "POST",
      body: JSON.stringify({ days_available: daysAvailable }),
    });
    assert.equal(raw.status, 400);
    const body = (await raw.json()) as { error: { code: string } };
    assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
  }
});

test("raw POST: non-array equipment or constraints → 400", async () => {
  for (const payload of [
    { equipment: "barbell" },
    { equipment: ["barbell", 5] },
    { constraints: "no overhead press" },
  ]) {
    const raw = await fetch(`${baseUrl}/plans/drafts`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    assert.equal(raw.status, 400);
    const body = (await raw.json()) as { error: { code: string } };
    assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
  }
});

test("raw POST: boundary days_available → 200", async () => {
  for (const daysAvailable of [1, 7]) {
    const raw = await fetch(`${baseUrl}/plans/drafts`, {
      method: "POST",
      body: JSON.stringify({ days_available: daysAvailable }),
    });
    assert.equal(raw.status, 200);
  }
});

test("raw POST: valid plan constraints return a draft with the goal", async () => {
  const raw = await fetch(`${baseUrl}/plans/drafts`, {
    method: "POST",
    body: JSON.stringify({
      goal: "add 2.5 kg to bench",
      days_available: 3,
      equipment: ["barbell"],
      constraints: ["no overhead press"],
    }),
  });
  assert.equal(raw.status, 200);
  const body = (await raw.json()) as { data: { goal: string } };
  assert.equal(body.data.goal, "add 2.5 kg to bench");
});
