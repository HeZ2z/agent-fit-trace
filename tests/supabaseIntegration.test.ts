import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  createSupabaseCoachingRequestRepository,
  createSupabaseCoachingWorkerRepository,
} from "../server/cloud/supabaseCoachingRepository.ts";
import type { CloudWorkerRepository } from "../server/cloud/repository.ts";

/**
 * Real local-Supabase integration: migrations, RLS isolation, and concurrent
 * idempotent creates against the CLI + Docker stack.
 *
 * Run explicitly (never in the default suite, never against cloud):
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<local key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<local service key> \
 *     FIT_TRACE_SUPABASE_INTEGRATION=1 node --test tests/supabaseIntegration.test.ts
 *
 * The service key is used ONLY here to provision throwaway local test users
 * via the Admin API; all workout assertions use the users' own access tokens
 * so RLS is genuinely exercised. When `FIT_TRACE_SUPABASE_INTEGRATION=1` the
 * suite FAILS (never skips) on missing keys, non-loopback URLs, or an
 * unavailable stack. Mocked suites never claim to prove database isolation —
 * only this file does, and only locally.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ENABLED = process.env.FIT_TRACE_SUPABASE_INTEGRATION === "1";

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

// When enabled, misconfiguration is a hard failure, not a skip.
const HARD_FAIL: string | null = !ENABLED
  ? null
  : SUPABASE_URL === "" || PUBLISHABLE_KEY === ""
    ? "FIT_TRACE_SUPABASE_INTEGRATION=1 requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (local `supabase status`)."
    : !isLoopback(SUPABASE_URL)
      ? `refusing non-loopback SUPABASE_URL (${SUPABASE_URL}); integration tests never touch cloud.`
      : null;

const CAN_PROVISION = ENABLED && HARD_FAIL === null && SERVICE_KEY !== "";
const PROVISION_FAIL: string | null =
  ENABLED && HARD_FAIL === null && SERVICE_KEY === ""
    ? "FIT_TRACE_SUPABASE_INTEGRATION=1 requires SUPABASE_SERVICE_ROLE_KEY (local only) to provision throwaway users."
    : null;

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function headers(token?: string, service = false): Record<string, string> {
  return {
    apikey: PUBLISHABLE_KEY,
    "Content-Type": "application/json",
    ...(service ? { Authorization: `Bearer ${SERVICE_KEY}` } : {}),
    ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function stackUp(): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: PUBLISHABLE_KEY },
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

/** Read a response body exactly once; returns status + raw text + parsed JSON. */
async function readOnce(response: Response): Promise<{ status: number; text: string; json: unknown }> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

const createdUserIds: string[] = [];
// Fixtures created by the test currently running. Cleaned after each test so
// this test's reservations cannot exhaust the shared production global cap and
// block the next test. Only this file's throwaway users are touched.
const activeTestUserIds: string[] = [];

async function provisionUser(tag: string): Promise<TestUser> {
  const email = `fit-trace-${tag}-${Date.now()}@example.com`;
  const password = `Test-${Date.now()}-pw!`;
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: headers(undefined, true),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const createdOnce = await readOnce(created);
  assert.equal(createdOnce.status, 200, `admin user creation failed: ${createdOnce.text.slice(0, 200)}`);
  const createdBody = createdOnce.json as { id: string };
  createdUserIds.push(createdBody.id);
  activeTestUserIds.push(createdBody.id);
  const signed = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const signedOnce = await readOnce(signed);
  assert.equal(signedOnce.status, 200, `test user sign-in failed: ${signedOnce.text.slice(0, 200)}`);
  const session = signedOnce.json as { access_token: string };
  return { id: createdBody.id, email, accessToken: session.access_token };
}

async function rpcCreate(token: string, record: WorkoutRecord): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/create_workout`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      p_id: record.id,
      p_payload: JSON.parse(JSON.stringify(record)) as unknown,
      p_date: record.date,
    }),
  });
}

async function listPayloads(token: string): Promise<WorkoutRecord[]> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/workouts?select=payload,owner_id,id,date&order=date.asc,id.asc`,
    { headers: headers(token) },
  );
  const once = await readOnce(response);
  assert.equal(once.status, 200, `list failed: ${once.text.slice(0, 200)}`);
  const rows = once.json as { payload: WorkoutRecord }[];
  return rows.map((row) => validateWorkoutRecord(row.payload).record);
}

/**
 * Remove only the cloud fixtures owned by users provisioned for the test that
 * just finished. Deleting runs cascades to their events, ledger, and outbox
 * rows; deleting the quota row releases the concurrency/token reservations.
 * The production global cap is intentionally left unchanged.
 */
async function cleanupActiveCloudFixtures(): Promise<void> {
  if (!ENABLED || HARD_FAIL !== null || SERVICE_KEY === "" || !isLoopback(SUPABASE_URL)) {
    activeTestUserIds.length = 0;
    return;
  }
  for (const ownerId of activeTestUserIds.splice(0)) {
    for (const table of [
      "coaching_runs",
      "coaching_snapshots",
      "coaching_sessions",
      "coaching_quota",
    ]) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/${table}?owner_id=eq.${ownerId}`, {
          method: "DELETE",
          headers: headers(undefined, true),
        });
      } catch {
        // Best-effort; the throwaway user is also deleted in the final hook.
      }
    }
  }
}

afterEach(cleanupActiveCloudFixtures);

after(async () => {
  if (!ENABLED || HARD_FAIL !== null || SERVICE_KEY === "" || !isLoopback(SUPABASE_URL)) return;
  // Restore the fail-closed default after the opt-in suite.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_runtime_control?id=eq.global`, {
      method: "PATCH",
      headers: headers(undefined, true),
      body: JSON.stringify({ provider_enabled: false }),
    });
  } catch {
    // Best-effort restore of the local-only switch.
  }
  for (const id of createdUserIds) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: headers(undefined, true),
      });
    } catch {
      // Best-effort cleanup of throwaway local users.
    }
  }
});

test("migrations applied: workouts table + RPC reachable, anonymous denied", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) {
    assert.fail("local Supabase stack is not running (`supabase start`).");
  }
  // Anonymous read must not return rows (RLS / no anon policy).
  const anon = await fetch(`${SUPABASE_URL}/rest/v1/workouts?select=id&limit=1`, {
    headers: { apikey: PUBLISHABLE_KEY },
  });
  const anonOnce = await readOnce(anon);
  assert.ok(
    anonOnce.status === 401 || anonOnce.status === 403 || anonOnce.text === "[]",
    `expected anonymous denial or empty, got ${anonOnce.status}: ${anonOnce.text.slice(0, 120)}`,
  );
  // The RPC must exist: an unauthenticated call fails with auth/permission —
  // not with "function not found" (PGRST202 / 404 schema cache miss).
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_workout`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_id: "probe", p_payload: {}, p_date: "2026-09-01" }),
  });
  const rpcOnce = await readOnce(rpc);
  assert.ok(
    !(rpcOnce.status === 404 && rpcOnce.text.includes("PGRST202")),
    `create_workout RPC is missing — run migrations (supabase db reset): ${rpcOnce.text.slice(0, 160)}`,
  );
});

test("RLS: two principals cannot see each other; same business id is separate", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) {
    assert.fail("local Supabase stack is not running (`supabase start`).");
  }
  const userA = await provisionUser("a");
  const userB = await provisionUser("b");

  const recordA = seedRecord({ id: "shared-id", date: "2026-09-01" });
  const createdAResponse = await rpcCreate(userA.accessToken, recordA);
  const createdA = await readOnce(createdAResponse);
  // PostgREST RPC calls answer 200; the API maps `created` to 201 itself.
  assert.equal(createdA.status, 200, `user A create failed: ${createdA.text.slice(0, 200)}`);

  // Same business id, different content, different owner → separate row.
  const recordB = seedRecord({
    id: "shared-id",
    date: "2026-09-02",
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }],
  });
  const createdBResponse = await rpcCreate(userB.accessToken, recordB);
  const createdB = await readOnce(createdBResponse);
  assert.equal(createdB.status, 200, `user B create failed: ${createdB.text.slice(0, 200)}`);

  const listA = await listPayloads(userA.accessToken);
  const listB = await listPayloads(userB.accessToken);
  assert.deepEqual(listA.map((entry) => entry.date), ["2026-09-01"]);
  assert.deepEqual(listB.map((entry) => entry.date), ["2026-09-02"]);

  // Same id + different content under ONE owner → conflict.
  const clashResponse = await rpcCreate(userA.accessToken, { ...recordA, date: "2026-12-31" });
  const clash = await readOnce(clashResponse);
  assert.equal(clash.status, 409, `expected conflict, got ${clash.status}: ${clash.text.slice(0, 200)}`);
});

async function directInsert(
  token: string,
  ownerId: string,
  row: { id: string; date: string; payload: unknown },
): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/workouts`, {
    method: "POST",
    headers: { ...headers(token), Prefer: "return=representation" },
    body: JSON.stringify({ owner_id: ownerId, ...row }),
  });
}

test("CHECK constraints reject direct inserts with payload id/date mismatch", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) {
    assert.fail("local Supabase stack is not running (`supabase start`).");
  }
  const user = await provisionUser("check");
  const record = seedRecord({ id: `w-direct-${Date.now()}`, date: "2026-09-04" });

  // A matching direct insert succeeds (RLS own-row + CHECKs agree).
  const valid = await readOnce(await directInsert(user.accessToken, user.id, {
    id: record.id,
    date: record.date,
    payload: record,
  }));
  assert.equal(valid.status, 201, `matching direct insert failed: ${valid.text.slice(0, 200)}`);

  // Payload id disagreeing with the row id is rejected by the CHECK, not only by the RPC.
  const idMismatch = await readOnce(await directInsert(user.accessToken, user.id, {
    id: record.id,
    date: record.date,
    payload: { ...record, id: "smuggled-id" },
  }));
  assert.equal(idMismatch.status, 400, `expected CHECK rejection, got ${idMismatch.status}: ${idMismatch.text.slice(0, 200)}`);
  assert.match(idMismatch.text, /workouts_payload_id_match/);

  // Payload date disagreeing with the row date is rejected likewise.
  const otherId = `w-direct-other-${Date.now()}`;
  const dateMismatch = await readOnce(await directInsert(user.accessToken, user.id, {
    id: otherId,
    date: "2026-09-05",
    payload: { ...record, id: otherId },
  }));
  assert.equal(dateMismatch.status, 400, `expected CHECK rejection, got ${dateMismatch.status}: ${dateMismatch.text.slice(0, 200)}`);
  assert.match(dateMismatch.text, /workouts_payload_date_match/);
});

test("local signup stays denied while invited-user email login works", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  if (!(await stackUp())) {
    assert.fail("local Supabase stack is not running (`supabase start`).");
  }
  // Public registration must stay denied (`auth.enable_signup = false`):
  // `[auth.email].enable_signup = true` re-enables email *login* only.
  const attempt = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `self-signup-${Date.now()}@example.com`,
      password: `Test-${Date.now()}-pw!`,
    }),
  });
  const once = await readOnce(attempt);
  assert.ok(
    once.status >= 400,
    `public signup must be denied, got ${once.status}: ${once.text.slice(0, 200)}`,
  );
});

test("pagination: keyset history over the RPC with special ids and small pages", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) {
    assert.fail("local Supabase stack is not running (`supabase start`).");
  }
  const { createSupabaseWorkoutStore } = await import("../server/db/supabaseWorkouts.ts");
  const { sortRecords } = await import("@pi-fit-trace/core");
  const user = await provisionUser("page");
  const ids = [
    "w-page-01",
    "w-page-02",
    "w-page-03",
    "w-page-04",
    `w-page-"quoted"`,
    "w-page-comma,x",
    "w-page-paren-(x)",
    "w-page-back\\slash",
    "w-page-unicode-你好-🏋️",
    "w-page-space x",
  ];
  // Same-date subgroup (cursor must page by id within one date) plus an
  // earlier and a later date around it.
  const dates = [
    "2026-09-14",
    "2026-09-15",
    "2026-09-15",
    "2026-09-15",
    "2026-09-15",
    "2026-09-15",
    "2026-09-15",
    "2026-09-15",
    "2026-09-15",
    "2026-09-16",
  ];
  const store = createSupabaseWorkoutStore(
    { id: user.id },
    {
      supabaseUrl: SUPABASE_URL,
      publishableKey: PUBLISHABLE_KEY,
      accessToken: user.accessToken,
      pageSize: 3,
      fetchImpl: fetch as typeof fetch,
    },
  );
  for (let i = 0; i < ids.length; i += 1) {
    const created = await store.createWorkout(seedRecord({ id: ids[i] as string, date: dates[i] as string }));
    assert.equal(created.duplicate, false);
  }
  const listed = await store.listWorkouts();
  assert.equal(listed.length, ids.length);
  assert.deepEqual([...new Set(listed.map((entry) => entry.id))].sort(), [...ids].sort());
  // Output order is core's sortRecords (shared by every store); the keyset
  // cursor itself always follows database order, so pages never gap or repeat
  // even when the two orderings disagree on punctuation (see w-page-"quoted").
  const expected = sortRecords(
    ids.map((id, i) => seedRecord({ id: id as string, date: dates[i] as string })),
  );
  assert.deepEqual(
    listed.map((entry) => entry.id),
    expected.map((entry) => entry.id),
  );
});

test("concurrency: parallel identical creates yield one row + duplicates", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) {
    assert.fail("local Supabase stack is not running (`supabase start`).");
  }
  const user = await provisionUser("race");
  const record = seedRecord({ id: `w-race-${Date.now()}`, date: "2026-09-13" });
  const attempts = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const response = await rpcCreate(user.accessToken, record);
      const once = await readOnce(response);
      return { status: once.status, body: once.json };
    }),
  );
  // PostgREST RPC calls answer 200 for both fresh and duplicate creates;
  // the API layer maps `created: true` to 201. Here we assert on the `created`
  // flag directly.
  const fresh = attempts.filter(
    (attempt) =>
      attempt.status === 200 &&
      typeof attempt.body === "object" &&
      attempt.body !== null &&
      (attempt.body as { created?: boolean }).created === true,
  );
  const duplicates = attempts.filter(
    (attempt) =>
      attempt.status === 200 &&
      typeof attempt.body === "object" &&
      attempt.body !== null &&
      (attempt.body as { created?: boolean }).created === false,
  );
  assert.equal(fresh.length, 1, `expected exactly one create, got ${JSON.stringify(attempts)}`);
  assert.equal(duplicates.length, 9);
  const listed = (await listPayloads(user.accessToken)).filter((entry) => entry.id === record.id);
  assert.equal(listed.length, 1);
});

// ---------------------------------------------------------------------------
// Durable cloud coaching: direct-RPC hardening (opt-in, isolated local users).
// No reset: every test provisions throwaway users and relies on FK cascades.
// ---------------------------------------------------------------------------

async function rpcCloud(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(args),
  });
  return readOnce(response);
}

async function configureCloudQuota(user: TestUser): Promise<void> {
  // 00300 defaults the global provider switch OFF. Enabling it is an explicit
  // operator action, even on a throwaway local stack.
  const control = await fetch(`${SUPABASE_URL}/rest/v1/coaching_runtime_control`, {
    method: "POST",
    headers: {
      ...headers(undefined, true),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ id: "global", provider_enabled: true }),
  });
  const controlOnce = await readOnce(control);
  assert.ok(
    controlOnce.status === 200 || controlOnce.status === 201 || controlOnce.status === 204,
    `provider switch update failed: ${controlOnce.status} ${controlOnce.text.slice(0, 200)}`,
  );

  const response = await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota`, {
    method: "POST",
    headers: {
      ...headers(undefined, true),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      owner_id: user.id,
      configured: true,
      concurrent_limit: 20,
      reserved_count: 0,
      tokens_limit: 1_000_000,
      tokens_used: 0,
      tokens_reserved: 0,
      per_run_token_budget: 20_000,
      per_step_token_budget: 4_096,
      per_run_request_limit: 8,
    }),
  });
  const once = await readOnce(response);
  assert.ok(
    once.status === 200 || once.status === 201 || once.status === 204,
    `quota configure failed: ${once.status} ${once.text.slice(0, 200)}`,
  );
}

async function cloudSession(token: string, id: string): Promise<string> {
  const created = await rpcCloud(token, "coaching_create_session", {
    p_id: id,
    p_ttl_ms: 1_800_000,
  });
  assert.equal(created.status, 200, created.text.slice(0, 200));
  return (created.json as { id: string }).id;
}

async function cloudSnapshot(token: string, id: string): Promise<{ snapshotId: string; source: string }> {
  const created = await rpcCloud(token, "coaching_create_snapshot", {
    p_snapshot_id: id,
    p_source: "authenticated-store",
    p_from: null,
    p_to: null,
    p_ttl_ms: 1_800_000,
  });
  assert.equal(created.status, 200, created.text.slice(0, 200));
  const body = created.json as { snapshotId: string; source: string };
  return { snapshotId: body.snapshotId, source: body.source };
}

function cloudSubmitArgs(
  user: TestUser,
  sessionId: string,
  snapshotId: string,
  idempotencyKey: string,
  runId: string,
  prompt = "Review my training.",
): Record<string, unknown> {
  return {
    p_run_id: runId,
    p_session_id: sessionId,
    p_idempotency_key: idempotencyKey,
    p_prompt: prompt,
    p_backend_id: "cloud-default",
    p_runtime_id: "hosted-sdk",
    p_snapshot_id: snapshotId,
    p_snapshot_source: "authenticated-store",
    p_request: {
      prompt,
      backendId: "cloud-default",
      runtimeId: "hosted-sdk",
      snapshot: {
        snapshotId,
        source: "authenticated-store",
        accountId: user.id,
      },
    },
  };
}

test("cloud direct RPC: fabricated snapshot records are rejected; contents come from workouts", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-snapshot");
  const records = [
    seedRecord({ id: `w-cloud-a-${Date.now()}`, date: "2026-09-01" }),
    seedRecord({ id: `w-cloud-b-${Date.now()}`, date: "2026-09-02" }),
  ];
  for (const record of records) {
    const created = await readOnce(await rpcCreate(user.accessToken, record));
    assert.equal(created.status, 200, created.text.slice(0, 160));
  }

  // The old record-bearing signature must not exist: direct callers cannot
  // smuggle payloads even with a fully valid authenticated token.
  const forged = await rpcCloud(user.accessToken, "coaching_create_snapshot", {
    p_snapshot_id: `snap-forged-${Date.now()}`,
    p_source: "authenticated-store",
    p_from: null,
    p_to: null,
    p_ttl_ms: 1_800_000,
    p_records: [{ id: "forged", date: "2026-09-03", schema_version: 1 }],
    p_record_ids: ["forged"],
    p_record_count: 1,
  });
  assert.ok(forged.status >= 400, `forged snapshot call unexpectedly succeeded: ${forged.status}`);

  const valid = await rpcCloud(user.accessToken, "coaching_create_snapshot", {
    p_snapshot_id: `snap-authoritative-${Date.now()}`,
    p_source: "authenticated-store",
    p_from: null,
    p_to: null,
    p_ttl_ms: 1_800_000,
  });
  assert.equal(valid.status, 200, valid.text.slice(0, 200));
  const body = valid.json as { recordIds: string[]; recordCount: number; expiresAt: number };
  assert.deepEqual([...body.recordIds].sort(), records.map((record) => record.id).sort());
  assert.equal(body.recordCount, 2);
  assert.ok(
    body.expiresAt <= Date.now() + 24 * 60 * 60 * 1000 + 5_000,
    "snapshot TTL must be hard-clamped to 24h",
  );

  const badSource = await rpcCloud(user.accessToken, "coaching_create_snapshot", {
    p_snapshot_id: `snap-badsource-${Date.now()}`,
    p_source: "forged-source",
    p_from: null,
    p_to: null,
    p_ttl_ms: 1_800_000,
  });
  assert.ok(badSource.status >= 400, "caller-chosen snapshot source must be refused");
});

test("cloud direct RPC: malicious TTL is clamped for sessions and snapshots", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-ttl");
  const session = await rpcCloud(user.accessToken, "coaching_create_session", {
    p_id: `sess-ttl-${Date.now()}`,
    p_ttl_ms: 2_147_483_647,
  });
  assert.equal(session.status, 200, session.text.slice(0, 160));
  assert.ok(
    (session.json as { expiresAt: number }).expiresAt <= Date.now() + 24 * 60 * 60 * 1000 + 5_000,
  );

  const snapshot = await rpcCloud(user.accessToken, "coaching_create_snapshot", {
    p_snapshot_id: `snap-ttl-${Date.now()}`,
    p_source: "authenticated-store",
    p_from: null,
    p_to: null,
    p_ttl_ms: 2_147_483_647,
  });
  assert.equal(snapshot.status, 200, snapshot.text.slice(0, 160));
  assert.ok(
    (snapshot.json as { expiresAt: number }).expiresAt <= Date.now() + 24 * 60 * 60 * 1000 + 5_000,
  );
});

test("cloud direct RPC: concurrent session creates cannot exceed the per-account cap", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-cap");
  const results = await Promise.all(
    Array.from({ length: 55 }, (_, index) =>
      rpcCloud(user.accessToken, "coaching_create_session", {
        p_id: `sess-cap-${index}`,
        p_ttl_ms: 60_000,
      }),
    ),
  );
  const successes = results.filter((result) => result.status === 200);
  assert.ok(successes.length <= 50, `per-account session cap exceeded: ${successes.length}`);
  assert.ok(results.some((result) => result.status >= 400), "concurrent overflow must be rejected");

  const listed = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_sessions?select=id`, {
      headers: headers(user.accessToken),
    }),
  );
  assert.equal(listed.status, 200, listed.text.slice(0, 160));
  assert.ok((listed.json as unknown[]).length <= 50);
});

test("cloud direct RPC: concurrent identical submits create one run and replay", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-idem");
  const record = seedRecord({ id: `w-cloud-idem-${Date.now()}`, date: "2026-09-10" });
  assert.equal((await readOnce(await rpcCreate(user.accessToken, record))).status, 200);
  await configureCloudQuota(user);
  const sessionId = await cloudSession(user.accessToken, `sess-idem-${Date.now()}`);
  const snapshot = await cloudSnapshot(user.accessToken, `snap-idem-${Date.now()}`);
  const key = `idem-${Date.now()}`;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      rpcCloud(
        user.accessToken,
        "coaching_submit_run",
        cloudSubmitArgs(user, sessionId, snapshot.snapshotId, key, `run-idem-${Date.now()}-${index}`),
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === 200).length, 10);
  const runIds = new Set(
    results.map((result) => (result.json as { run: { id: string } }).run.id),
  );
  assert.equal(runIds.size, 1, "one idempotency key must map to one retained run");

  const runs = await readOnce(
    await fetch(
      `${SUPABASE_URL}/rest/v1/coaching_runs?select=id&session_id=eq.${encodeURIComponent(sessionId)}`,
      { headers: headers(user.accessToken) },
    ),
  );
  assert.equal(runs.status, 200, runs.text.slice(0, 160));
  assert.equal((runs.json as unknown[]).length, 1);
});

test("cloud direct RPC: 21 concurrent unique submits stop at the 20 reservation cap", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-quota");
  const record = seedRecord({ id: `w-cloud-quota-${Date.now()}`, date: "2026-09-11" });
  assert.equal((await readOnce(await rpcCreate(user.accessToken, record))).status, 200);
  await configureCloudQuota(user);
  const sessionId = await cloudSession(user.accessToken, `sess-quota-${Date.now()}`);
  const snapshot = await cloudSnapshot(user.accessToken, `snap-quota-${Date.now()}`);
  const results = await Promise.all(
    Array.from({ length: 21 }, (_, index) =>
      rpcCloud(
        user.accessToken,
        "coaching_submit_run",
        cloudSubmitArgs(
          user,
          sessionId,
          snapshot.snapshotId,
          `quota-key-${Date.now()}-${index}`,
          `run-quota-${Date.now()}-${index}`,
        ),
      ),
    ),
  );
  const successes = results.filter((result) => result.status === 200).length;
  assert.ok(successes <= 20, `reservation cap exceeded: ${successes} successes`);
  assert.ok(results.some((result) => result.status >= 400), "the 21st reservation must fail");

  const quota = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota?select=reserved_count`, {
      headers: headers(user.accessToken),
    }),
  );
  assert.equal(quota.status, 200, quota.text.slice(0, 160));
  const reserved = (quota.json as { reserved_count: number }[])[0]?.reserved_count ?? 0;
  assert.ok(reserved <= 20, `reserved_count exceeded cap: ${reserved}`);
});

// ---------------------------------------------------------------------------
// Durable cloud coaching: 00300 execution guards and real worker RPCs.
// ---------------------------------------------------------------------------

async function serviceRest(
  path: string,
  init: { method: "PATCH" | "POST" | "DELETE"; body?: unknown },
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method,
    headers: {
      ...headers(undefined, true),
      Prefer: "return=minimal",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return readOnce(response);
}

async function provisionCloudRun(
  tag: string,
  prompt = "Review my training.",
): Promise<{ user: TestUser; runId: string; sessionId: string; snapshotId: string }> {
  const user = await provisionUser(tag);
  const stamp = Date.now();
  const record = seedRecord({ id: `w-${tag}-${stamp}`, date: "2026-09-10" });
  assert.equal((await readOnce(await rpcCreate(user.accessToken, record))).status, 200);
  await configureCloudQuota(user);
  const sessionId = await cloudSession(user.accessToken, `sess-${tag}-${stamp}`);
  const snapshot = await cloudSnapshot(user.accessToken, `snap-${tag}-${stamp}`);
  const runId = `run-${tag}-${stamp}`;
  const submitted = await rpcCloud(
    user.accessToken,
    "coaching_submit_run",
    cloudSubmitArgs(user, sessionId, snapshot.snapshotId, `idem-${tag}-${stamp}`, runId, prompt),
  );
  assert.equal(submitted.status, 200, submitted.text.slice(0, 240));
  return { user, runId, sessionId, snapshotId: snapshot.snapshotId };
}

async function claimSpecific(
  worker: CloudWorkerRepository,
  runId: string,
  tag: string,
): Promise<{ generation: number; run: { id: string } }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const jobs = await worker.claimOutbox(`itest-${tag}-${Date.now()}-${attempt}`, 60_000, 10);
    const match = jobs.find((job) => job.run.id === runId);
    if (match) return { generation: match.leaseGeneration, run: match.run };
    if (jobs.length === 0) break;
  }
  assert.fail(`outbox job for ${runId} was not claimable`);
}

test("cloud direct RPC guards: unknown keys, huge text, and impossible dates are rejected", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-guards");
  await configureCloudQuota(user);
  const stamp = Date.now();
  await cloudSession(user.accessToken, `sess-guards-${stamp}`);
  const snapshot = await cloudSnapshot(user.accessToken, `snap-guards-${stamp}`);

  const withUnknownKey = cloudSubmitArgs(
    user,
    `sess-guards-${stamp}`,
    snapshot.snapshotId,
    `unknown-${stamp}`,
    `run-unknown-${stamp}`,
  );
  (withUnknownKey.p_request as Record<string, unknown>).surprise = true;
  const unknown = await rpcCloud(user.accessToken, "coaching_submit_run", withUnknownKey);
  assert.ok(unknown.status >= 400, `unknown request key was accepted: ${unknown.text.slice(0, 200)}`);

  const withForeignAccount = cloudSubmitArgs(
    user,
    `sess-guards-${stamp}`,
    snapshot.snapshotId,
    `account-${stamp}`,
    `run-account-${stamp}`,
  );
  (withForeignAccount.p_request as { snapshot: { accountId: string } }).snapshot.accountId =
    "00000000-0000-0000-0000-000000000000";
  const foreign = await rpcCloud(user.accessToken, "coaching_submit_run", withForeignAccount);
  assert.ok(foreign.status >= 400, `foreign account id was accepted: ${foreign.text.slice(0, 200)}`);

  const hugePrompt = "x".repeat(70_000);
  const huge = await rpcCloud(
    user.accessToken,
    "coaching_submit_run",
    cloudSubmitArgs(
      user,
      `sess-guards-${stamp}`,
      snapshot.snapshotId,
      `huge-${stamp}`,
      `run-huge-${stamp}`,
      hugePrompt,
    ),
  );
  assert.ok(huge.status >= 400, `oversized prompt was accepted: ${huge.status}`);

  const badDate = await rpcCloud(user.accessToken, "coaching_create_snapshot", {
    p_snapshot_id: `snap-baddate-${stamp}`,
    p_source: "authenticated-store",
    p_from: "2026-02-30",
    p_to: null,
    p_ttl_ms: 1_800_000,
  });
  assert.ok(badDate.status >= 400, `impossible calendar date was accepted: ${badDate.text.slice(0, 200)}`);
});

test("cloud direct RPC guards: submit reserves a finite budget and replay survives snapshot expiry", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const user = await provisionUser("cloud-reserve");
  const stamp = Date.now();
  const record = seedRecord({ id: `w-reserve-${stamp}`, date: "2026-09-12" });
  assert.equal((await readOnce(await rpcCreate(user.accessToken, record))).status, 200);
  await configureCloudQuota(user);
  const sessionId = await cloudSession(user.accessToken, `sess-reserve-${stamp}`);
  const snapshotId = (await cloudSnapshot(user.accessToken, `snap-reserve-${stamp}`)).snapshotId;
  const runId = `run-reserve-${stamp}`;
  const key = `reserve-${stamp}`;
  const submitted = await rpcCloud(
    user.accessToken,
    "coaching_submit_run",
    cloudSubmitArgs(user, sessionId, snapshotId, key, runId),
  );
  assert.equal(submitted.status, 200, submitted.text.slice(0, 240));

  const run = await readOnce(
    await fetch(
      `${SUPABASE_URL}/rest/v1/coaching_runs?select=token_budget,request_budget&id=eq.${runId}`,
      { headers: headers(user.accessToken) },
    ),
  );
  assert.equal(run.status, 200, run.text.slice(0, 200));
  const runRow = (run.json as { token_budget: number; request_budget: number }[])[0];
  assert.equal(runRow?.token_budget, 20_000);
  assert.equal(runRow?.request_budget, 8);

  const quota = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota?select=tokens_reserved,reserved_count`, {
      headers: headers(user.accessToken),
    }),
  );
  assert.equal(quota.status, 200, quota.text.slice(0, 200));
  const quotaRow = (quota.json as { tokens_reserved: number; reserved_count: number }[])[0];
  assert.equal(quotaRow?.tokens_reserved, 20_000);
  assert.equal(quotaRow?.reserved_count, 1);

  // Expiry must not break an identical replay: identity is checked first.
  const expired = await serviceRest(`coaching_snapshots?owner_id=eq.${user.id}&id=eq.${snapshotId}`, {
    method: "PATCH",
    body: { expires_at: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(expired.status, 204, expired.text.slice(0, 200));

  const replay = await rpcCloud(
    user.accessToken,
    "coaching_submit_run",
    cloudSubmitArgs(user, sessionId, snapshotId, key, `run-reserve-retry-${stamp}`),
  );
  assert.equal(replay.status, 200, replay.text.slice(0, 240));
  assert.equal((replay.json as { replayed: boolean }).replayed, true);
  assert.equal((replay.json as { run: { id: string } }).run.id, runId);

  const changed = await rpcCloud(
    user.accessToken,
    "coaching_submit_run",
    cloudSubmitArgs(user, sessionId, snapshotId, key, `run-reserve-changed-${stamp}`, "Different prompt."),
  );
  assert.equal(changed.status, 409, `changed request must conflict: ${changed.status} ${changed.text.slice(0, 200)}`);

  const quotaAfter = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota?select=tokens_reserved,reserved_count`, {
      headers: headers(user.accessToken),
    }),
  );
  const quotaAfterRow = (quotaAfter.json as { tokens_reserved: number; reserved_count: number }[])[0];
  assert.equal(quotaAfterRow?.tokens_reserved, 20_000, "replay must not double-reserve");
  assert.equal(quotaAfterRow?.reserved_count, 1, "replay must not double-count concurrency");
});

test("cloud worker RPC (real DB): claim -> mark -> authorize -> accepted -> append -> settle -> terminal", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const { user, runId } = await provisionCloudRun("worker-ok");
  const worker = createSupabaseCoachingWorkerRepository({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
  });
  const request = createSupabaseCoachingRequestRepository({
    supabaseUrl: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
    accessToken: user.accessToken,
  });

  const claimed = await claimSpecific(worker, runId, "ok");
  const started = await worker.markProviderCallStarted(runId, claimed.generation);
  assert.equal(started.started, true);
  const step1 = await worker.authorizeProviderStep(runId, claimed.generation, { tokens: 500, requests: 1 });
  assert.equal(step1.allowed, true);
  const step2 = await worker.authorizeProviderStep(runId, claimed.generation, { tokens: 500, requests: 1 });
  assert.equal(step2.allowed, true);

  await worker.markProviderAccepted(runId, claimed.generation, { generationId: `gen-${runId}` });
  const seq = await worker.appendEvent(runId, claimed.generation, { type: "text_delta", delta: "hello" });
  assert.equal(seq, 0);
  const settled = await worker.settleUsage(runId, claimed.generation, {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    known: true,
    knownTokens: 120,
    complete: true,
    generationId: `gen-${runId}`,
  });
  assert.equal(settled.settled, true);

  const terminal = await worker.terminateRun(runId, claimed.generation, {
    status: "completed",
    terminationConfirmed: true,
    releaseReservation: true,
  });
  assert.equal(terminal.run.status, "completed");
  assert.equal(terminal.run.terminationConfirmed, true);

  const read = await request.readRun(runId);
  assert.equal(read.run.status, "completed");
  assert.equal(read.lastSeq, 1);

  const ledger = await readOnce(
    await fetch(
      `${SUPABASE_URL}/rest/v1/coaching_usage_ledger?select=total_tokens,usage_complete&run_id=eq.${runId}`,
      { headers: headers(undefined, true) },
    ),
  );
  assert.equal(ledger.status, 200, ledger.text.slice(0, 200));
  const ledgerRow = (ledger.json as { total_tokens: number; usage_complete: boolean }[])[0];
  assert.equal(ledgerRow?.total_tokens, 120);
  assert.equal(ledgerRow?.usage_complete, true);

  const quota = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota?select=tokens_used,tokens_reserved,reserved_count`, {
      headers: headers(user.accessToken),
    }),
  );
  const quotaRow = (quota.json as { tokens_used: number; tokens_reserved: number; reserved_count: number }[])[0];
  assert.equal(quotaRow?.tokens_used, 120);
  assert.equal(quotaRow?.tokens_reserved, 0);
  assert.equal(quotaRow?.reserved_count, 0);
});

test("cloud worker RPC (real DB): cancel after acceptance settles usage and stays unconfirmed", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const { user, runId } = await provisionCloudRun("worker-cancel");
  const worker = createSupabaseCoachingWorkerRepository({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
  });
  const request = createSupabaseCoachingRequestRepository({
    supabaseUrl: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
    accessToken: user.accessToken,
  });

  const claimed = await claimSpecific(worker, runId, "cancel");
  await worker.markProviderCallStarted(runId, claimed.generation);
  assert.equal(
    (await worker.authorizeProviderStep(runId, claimed.generation, { tokens: 500, requests: 1 })).allowed,
    true,
  );
  await worker.markProviderAccepted(runId, claimed.generation, { generationId: `gen-${runId}` });
  await request.cancelRun(runId, "stop after acceptance");

  const afterCancel = await worker.authorizeProviderStep(runId, claimed.generation, {
    tokens: 500,
    requests: 1,
  });
  assert.equal(afterCancel.allowed, false);
  assert.equal(afterCancel.cancelled, true);

  assert.equal(
    (
      await worker.settleUsage(runId, claimed.generation, {
        promptTokens: 40,
        completionTokens: 10,
        totalTokens: 50,
        known: false,
        knownTokens: 50,
        complete: false,
        generationId: `gen-${runId}`,
      })
    ).settled,
    true,
  );
  const terminal = await worker.terminateRun(runId, claimed.generation, {
    status: "cancelled",
    reason: "cancel requested; provider termination unconfirmed",
    terminationConfirmed: false,
    releaseReservation: false,
  });
  assert.equal(terminal.run.status, "unconfirmed");
  assert.equal(terminal.run.terminationConfirmed, false);

  const read = await request.readRun(runId);
  assert.equal(read.run.status, "unconfirmed");
  const quota = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota?select=tokens_used,tokens_reserved,reserved_count`, {
      headers: headers(user.accessToken),
    }),
  );
  const quotaRow = (quota.json as { tokens_used: number; tokens_reserved: number; reserved_count: number }[])[0];
  assert.equal(quotaRow?.tokens_used, 50, "known usage must still be charged");
  assert.equal(quotaRow?.tokens_reserved, 19_950, "unknown remainder must stay reserved");
  assert.equal(quotaRow?.reserved_count, 1, "an unconfirmed run retains its concurrency slot");
});

test("cloud worker RPC (real DB): an expired accepted lease is reaped as unconfirmed, never redispatched", async (t) => {
  if (!ENABLED) {
    t.skip("skipped: set FIT_TRACE_SUPABASE_INTEGRATION=1 with local SUPABASE_URL + keys to run.");
    return;
  }
  assert.equal(HARD_FAIL, null, HARD_FAIL ?? "misconfigured");
  assert.equal(PROVISION_FAIL, null, PROVISION_FAIL ?? "missing service key");
  if (!CAN_PROVISION) assert.fail(PROVISION_FAIL ?? "cannot provision");
  if (!(await stackUp())) assert.fail("local Supabase stack is not running (`supabase start`).");

  const { user, runId } = await provisionCloudRun("worker-reaper");
  const worker = createSupabaseCoachingWorkerRepository({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
  });
  const request = createSupabaseCoachingRequestRepository({
    supabaseUrl: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
    accessToken: user.accessToken,
  });

  const claimed = await claimSpecific(worker, runId, "reaper");
  await worker.markProviderCallStarted(runId, claimed.generation);
  assert.equal(
    (await worker.authorizeProviderStep(runId, claimed.generation, { tokens: 500, requests: 1 })).allowed,
    true,
  );

  // Simulate a crashed worker: the lease expires after the fetch marker.
  const expired = await serviceRest(`coaching_outbox?run_id=eq.${runId}`, {
    method: "PATCH",
    body: { lease_until: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(expired.status, 204, expired.text.slice(0, 200));

  // Any later claim runs the reaper first.
  await worker.claimOutbox(`itest-reaper-cleanup-${Date.now()}`, 60_000, 10);
  const read = await request.readRun(runId);
  assert.equal(read.run.status, "unconfirmed");
  const events = await request.readEvents(runId, 0, 10);
  const terminal = events.events.at(-1);
  assert.ok(terminal?.event.type === "terminal");
  assert.match(terminal.event.type === "terminal" ? terminal.event.reason ?? "" : "", /unconfirmed/);

  // Nothing may put it back in the queue.
  const jobs = await worker.claimOutbox(`itest-reaper-again-${Date.now()}`, 60_000, 10);
  assert.ok(!jobs.some((job) => job.run.id === runId));
  const outbox = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_outbox?select=status&run_id=eq.${runId}`, {
      headers: headers(undefined, true),
    }),
  );
  assert.equal((outbox.json as { status: string }[])[0]?.status, "dead");

  const quota = await readOnce(
    await fetch(`${SUPABASE_URL}/rest/v1/coaching_quota?select=tokens_reserved,reserved_count`, {
      headers: headers(user.accessToken),
    }),
  );
  const quotaRow = (quota.json as { tokens_reserved: number; reserved_count: number }[])[0];
  assert.equal(quotaRow?.tokens_reserved, 20_000);
  assert.equal(quotaRow?.reserved_count, 1);
});
