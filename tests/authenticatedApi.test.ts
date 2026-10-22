import assert from "node:assert/strict";
import { test } from "node:test";

import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { createAuthenticatedHandler } from "../server/authenticatedHandler.ts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { createPrincipalMemoryStores } from "../server/principalMemoryStore.ts";

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function makeHandler() {
  return createAuthenticatedHandler({
    verifier: createTestVerifier({
      "token-a": { id: "user-a", email: "a@example.com" },
      "token-b": { id: "user-b", email: "b@example.com" },
    }),
    stores: createPrincipalMemoryStores(),
    publicConfig: {
      supabaseUrl: "http://127.0.0.1:54321",
      supabasePublishableKey: "publishable-key",
    },
  });
}

test("missing bearer token → 401 UNAUTHENTICATED with WWW-Authenticate", async () => {
  const handler = makeHandler();
  for (const authorization of [undefined, "", "Bearer ", "Token token-a"]) {
    const response = await handler("/workouts", { authorization });
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], "Bearer");
    const body = JSON.parse(response.body) as { error: { code: string } };
    assert.equal(body.error.code, API_ERROR_CODES.UNAUTHENTICATED);
  }
});

test("invalid token → 401 UNAUTHENTICATED on all four endpoints", async () => {
  const handler = makeHandler();
  const record = seedRecord({ id: "w-x", date: "2026-09-01" });
  const routes: [string, { method?: string; body?: string }][] = [
    ["/workouts", {}],
    ["/workouts", { method: "POST", body: JSON.stringify({ record }) }],
    ["/analysis", {}],
    ["/plans/drafts", { method: "POST" }],
  ];
  for (const [route, init] of routes) {
    const response = await handler(route, { ...init, authorization: "Bearer nope" });
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], "Bearer");
    const body = JSON.parse(response.body) as { error: { code: string } };
    assert.equal(body.error.code, API_ERROR_CODES.UNAUTHENTICATED);
  }
});

test("valid tokens isolate principals sharing one business id", async () => {
  const handler = makeHandler();
  const forA = { authorization: "Bearer token-a" };
  const forB = { authorization: "Bearer token-b" };

  await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record: seedRecord({ id: "shared", date: "2026-09-01" }) }),
    ...forA,
  });
  const other = seedRecord({
    id: "shared",
    date: "2026-09-02",
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }],
  });
  const conflict = await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record: other }),
    ...forB,
  });
  // Same business id under a different owner is a separate record, not a conflict.
  assert.equal(conflict.status, 201);

  const listA = JSON.parse((await handler("/workouts", forA)).body) as {
    data: { id: string; date: string }[];
  };
  const listB = JSON.parse((await handler("/workouts", forB)).body) as {
    data: { id: string; date: string }[];
  };
  assert.deepEqual(listA.data.map((entry) => entry.date), ["2026-09-01"]);
  assert.deepEqual(listB.data.map((entry) => entry.date), ["2026-09-02"]);

  const analysisB = JSON.parse((await handler("/analysis", forB)).body) as {
    data: { source_records: string[] };
  };
  assert.deepEqual(analysisB.data.source_records, ["shared"]);

  // Same id + different content under ONE principal still conflicts.
  const clash = await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record: other }),
    ...forA,
  });
  assert.equal(clash.status, 409);
  const clashBody = JSON.parse(clash.body) as { error: { code: string } };
  assert.equal(clashBody.error.code, API_ERROR_CODES.CONFLICT);
});

test("identical retry under one principal is a duplicate no-op", async () => {
  const handler = makeHandler();
  const auth = { authorization: "Bearer token-a" };
  const record = seedRecord({ id: "w-dup", date: "2026-09-03" });
  const first = await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record }),
    ...auth,
  });
  assert.equal(first.status, 201);
  const retry = await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record }),
    ...auth,
  });
  assert.equal(retry.status, 200);
  assert.equal(
    (JSON.parse(retry.body) as { data: { duplicate: boolean } }).data.duplicate,
    true,
  );
});

test("plan drafts never write and date filters validate", async () => {
  const handler = makeHandler();
  const auth = { authorization: "Bearer token-a" };
  const before = JSON.parse((await handler("/workouts", auth)).body) as { data: unknown[] };
  const draft = await handler("/plans/drafts", { method: "POST", ...auth });
  assert.equal(draft.status, 200);
  const after = JSON.parse((await handler("/workouts", auth)).body) as { data: unknown[] };
  assert.equal(after.data.length, before.data.length);

  const inverted = await handler("/analysis?from=2026-09-10&to=2026-09-01", auth);
  assert.equal(inverted.status, 400);
  const body = JSON.parse(inverted.body) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("public-config is public and carries only public fields", async () => {
  const handler = makeHandler();
  const response = await handler("/public-config");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(body.data).sort(), [
    "guestSignInCaptchaRequired",
    "guestSignInEnabled",
    "guestUpgradeEnabled",
    "supabasePublishableKey",
    "supabaseUrl",
  ]);
  assert.equal(body.data.guestSignInEnabled, false);
  assert.equal(body.data.guestUpgradeEnabled, false);
  assert.equal(body.data.guestSignInCaptchaRequired, false);
});

test("missing verifier or stores fail closed (never anonymous access)", async () => {
  const noVerifier = createAuthenticatedHandler({
    verifier: null,
    stores: createPrincipalMemoryStores(),
    publicConfig: null,
  });
  const denied = await noVerifier("/workouts", { authorization: "Bearer token-a" });
  assert.equal(denied.status, 500);

  const noStores = createAuthenticatedHandler({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores: null,
  });
  const unstored = await noStores("/workouts", { authorization: "Bearer token-a" });
  assert.equal(unstored.status, 500);
});

test("transient verifier outages surface as 503, not 401 logout", async () => {
  const flaky = createAuthenticatedHandler({
    verifier: {
      verify(): Promise<never> {
        return Promise.reject(
          new ApiError({
            code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: "Authentication service is unavailable.",
            status: 503,
          }),
        );
      },
    },
    stores: createPrincipalMemoryStores(),
    publicConfig: null,
  });
  const response = await flaky("/workouts", { authorization: "Bearer token-a" });
  assert.equal(response.status, 503);
  const body = JSON.parse(response.body) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
  assert.equal(response.headers["www-authenticate"], undefined);
});

test("oversized bodies reject as VALIDATION_ERROR", async () => {
  const handler = createAuthenticatedHandler({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores: createPrincipalMemoryStores(),
    publicConfig: null,
    maxBodyBytes: 16,
  });
  const response = await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record: seedRecord({ id: "w-big", date: "2026-09-04" }) }),
    authorization: "Bearer token-a",
  });
  assert.equal(response.status, 400);
  const body = JSON.parse(response.body) as { error: { code: string } };
  assert.equal(body.error.code, API_ERROR_CODES.VALIDATION_ERROR);
});

test("workout restore requests may carry one large valid backup record", async () => {
  const handler = makeHandler();
  // Larger than the 64 KiB general HTTP cap but within the workout restore
  // bound; restore submits one whole record per request.
  const record = seedRecord({
    id: "w-large",
    date: "2026-09-05",
    notes: "n".repeat(100_000),
  });
  const response = await handler("/workouts", {
    method: "POST",
    body: JSON.stringify({ record }),
    authorization: "Bearer token-a",
  });
  assert.equal(response.status, 201);
  const body = JSON.parse(response.body) as {
    data: { record: WorkoutRecord; duplicate: boolean };
  };
  assert.equal(body.data.duplicate, false);
  assert.equal(body.data.record.notes?.length, 100_000);
});

test("import routes are principal-scoped and hide other owners behind NOT_FOUND", async () => {
  const handler = makeHandler();
  const authA = { authorization: "Bearer token-a" };
  const authB = { authorization: "Bearer token-b" };
  const payload = analyzeProgress([seedRecord({ id: "w-imp", date: "2026-09-01" })]);

  const created = await handler("/imports", {
    method: "POST",
    body: JSON.stringify({ kind: "analysis", payload_schema_version: 1, payload }),
    ...authA,
  });
  assert.equal(created.status, 201);
  const artifact = (JSON.parse(created.body) as { data: { artifact: { id: string; content_digest: string } } })
    .data.artifact;

  const listA = JSON.parse((await handler("/imports", authA)).body) as { data: { items: { id: string }[] } };
  assert.deepEqual(listA.data.items.map((item) => item.id), [artifact.id]);
  const listB = JSON.parse((await handler("/imports", authB)).body) as { data: { items: unknown[] } };
  assert.deepEqual(listB.data.items, []);

  const otherRead = await handler(`/imports/${encodeURIComponent(artifact.id)}`, authB);
  assert.equal(otherRead.status, 404);
  assert.equal(
    (JSON.parse(otherRead.body) as { error: { code: string } }).error.code,
    API_ERROR_CODES.NOT_FOUND,
  );

  const missingAuth = await handler("/imports");
  assert.equal(missingAuth.status, 401);

  const selection = await handler("/import-selections/analysis", {
    method: "PUT",
    body: JSON.stringify({ artifact_id: artifact.id }),
    ...authA,
  });
  assert.equal(selection.status, 200);
  const selectionB = JSON.parse(
    (await handler("/import-selections/analysis", authB)).body,
  ) as { data: { artifact_id: string | null } };
  assert.deepEqual(selectionB.data, { artifact_id: null });

  const adoption = await handler("/plan-adoption", {
    method: "PUT",
    body: JSON.stringify({ artifact_id: artifact.id, confirmed_digest: artifact.content_digest }),
    ...authA,
  });
  // An analysis snapshot cannot be adopted as a plan.
  assert.equal(adoption.status, 400);
});

test("imports warn about unknown root and payload fields exactly once", async () => {
  const handler = makeHandler();
  const payload = analyzeProgress([seedRecord({ id: "w-warn", date: "2026-09-01" })]);
  const response = await handler("/imports", {
    method: "POST",
    body: JSON.stringify({
      kind: "analysis",
      payload_schema_version: 1,
      payload: { ...payload, extra: true },
      extra: true,
    }),
    authorization: "Bearer token-a",
  });
  assert.equal(response.status, 201);
  const body = JSON.parse(response.body) as {
    data: { warnings: { code: string; path?: string }[] };
  };
  assert.deepEqual(
    body.data.warnings.filter((warning) => warning.code === "UNKNOWN_FIELD").map((warning) => warning.path),
    ["(root).extra", "extra"],
  );
});

test("import POST bodies are capped below the generic body limit", async () => {
  const handler = makeHandler();
  const response = await handler("/imports", {
    method: "POST",
    body: "x".repeat(61 * 1024),
    authorization: "Bearer token-a",
  });
  assert.equal(response.status, 400);
  assert.equal(
    (JSON.parse(response.body) as { error: { code: string } }).error.code,
    API_ERROR_CODES.VALIDATION_ERROR,
  );
});
