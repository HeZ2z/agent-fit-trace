import assert from "node:assert/strict";
import { after, test } from "node:test";

import { validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";

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

after(async () => {
  if (!ENABLED || HARD_FAIL !== null || SERVICE_KEY === "" || !isLoopback(SUPABASE_URL)) return;
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
