import assert from "node:assert/strict";
import { test } from "node:test";

import { API_ERROR_CODES } from "@pi-fit-trace/api-contracts";
import { validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { createSupabaseVerifier } from "../server/auth/supabaseVerifier.ts";
import { extractBearerToken } from "../server/auth/verifier.ts";
import { createSupabaseWorkoutStore } from "../server/db/supabaseWorkouts.ts";

/**
 * Repository + verifier unit tests with an injected `fetch` double.
 *
 * These prove request shaping, error mapping, and core-validation reuse —
 * they intentionally do NOT prove Postgres isolation or RLS. Only
 * `tests/supabaseIntegration.test.ts` (real local Supabase) proves that.
 */

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

test("extractBearerToken accepts only non-empty Bearer values", () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(""), null);
  assert.equal(extractBearerToken("Bearer "), null);
  assert.equal(extractBearerToken("Token abc"), null);
  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("  Bearer abc  "), "abc");
});

test("supabase verifier fails closed without URL/key", () => {
  assert.throws(() => createSupabaseVerifier({ supabaseUrl: "", publishableKey: "k" }));
  assert.throws(() => createSupabaseVerifier({ supabaseUrl: "http://x", publishableKey: "" }));
});

test("supabase verifier resolves sub/email and rejects bad responses", async () => {
  const calls: string[][] = [];
  const verifier = createSupabaseVerifier({
    supabaseUrl: "http://auth.invalid",
    publishableKey: "pub-key",
    fetchImpl: (async (input: string, init?: RequestInit) => {
      calls.push([input, JSON.stringify(init?.headers ?? {})]);
      return jsonResponse(200, { id: "user-1", email: "u@example.com" });
    }) as typeof fetch,
  });
  const principal = await verifier.verify("user-token");
  assert.deepEqual(principal, { id: "user-1", email: "u@example.com" });
  assert.equal(calls[0]?.[0], "http://auth.invalid/auth/v1/user");
  assert.match(calls[0]?.[1] ?? "", /user-token/);

  const bad = createSupabaseVerifier({
    supabaseUrl: "http://auth.invalid",
    publishableKey: "pub-key",
    fetchImpl: (async () => jsonResponse(401, { message: "bad" })) as typeof fetch,
  });
  await assert.rejects(bad.verify("stale"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.UNAUTHENTICATED);
    return true;
  });

  const noSub = createSupabaseVerifier({
    supabaseUrl: "http://auth.invalid",
    publishableKey: "pub-key",
    fetchImpl: (async () => jsonResponse(200, { email: "noid@example.com" })) as typeof fetch,
  });
  await assert.rejects(noSub.verify("token"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.UNAUTHENTICATED);
    return true;
  });

  const down = createSupabaseVerifier({
    supabaseUrl: "http://auth.invalid",
    publishableKey: "pub-key",
    fetchImpl: (async () => {
      throw new TypeError("offline");
    }) as typeof fetch,
  });
  await assert.rejects(down.verify("token"), (error: unknown) => {
    // Transient network failures are 503 unavailable, never 401 logout.
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
    assert.equal((error as { status?: number }).status, 503);
    return true;
  });

  const flaky = createSupabaseVerifier({
    supabaseUrl: "http://auth.invalid",
    publishableKey: "pub-key",
    fetchImpl: (async () => jsonResponse(503, { message: "overloaded" })) as typeof fetch,
  });
  await assert.rejects(flaky.verify("token"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
    return true;
  });
});

function rowFor(record: WorkoutRecord, ownerId = "user-1"): unknown {
  return { payload: record, owner_id: ownerId, id: record.id, date: record.date };
}

interface MockDb {
  rows: { payload: WorkoutRecord; owner_id: string; id: string; date: string }[];
  /** Simulated PostgREST max_rows: every page is truncated to this size. */
  cap: number;
  calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
}

/**
 * Mock PostgREST that speaks ONLY the keyset pagination RPC
 * (`POST /rest/v1/rpc/list_workouts_page` with a JSON cursor body) and sorts
 * by the database's own (date, id) order. Anything else (e.g. the old
 * offset/limit table read) answers 404, like PostgREST's PGRST202 for an
 * unknown route. The JS `<` sort below approximates SQL `text` ordering; the
 * real ordering is proven by `tests/supabaseIntegration.test.ts`.
 */
function makeKeysetFetch(
  db: MockDb,
  opts?: { missingRpc?: boolean; onPage?: (page: number) => void },
) {
  let pages = 0;
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    try {
      body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as unknown);
    } catch {
      body = null;
    }
    db.calls.push({ url, method, headers: ((init?.headers ?? {}) as Record<string, string>), body });
    if (!url.endsWith("/rpc/list_workouts_page") || opts?.missingRpc === true) {
      return new Response(JSON.stringify({ code: "PGRST202", message: "not found" }), {
        status: 404,
      });
    }
    pages += 1;
    opts?.onPage?.(pages);
    const params = (body ?? {}) as {
      p_after_date?: string | null;
      p_after_id?: string | null;
      p_limit?: number;
    };
    const afterDate = params.p_after_date ?? null;
    const afterId = params.p_after_id ?? null;
    const sorted = [...db.rows].sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const filtered =
      afterDate === null || afterId === null
        ? sorted
        : sorted.filter(
            (row) => row.date > afterDate || (row.date === afterDate && row.id > afterId),
          );
    const limit = Math.min(params.p_limit ?? 1000, db.cap);
    return new Response(JSON.stringify(filtered.slice(0, limit)), { status: 200 });
  }) as typeof fetch;
}

function makeDb(count: number, cap: number): { db: MockDb; records: WorkoutRecord[] } {
  const records: WorkoutRecord[] = Array.from({ length: count }, (_, index) => {
    const month = String((index % 12) + 1).padStart(2, "0");
    const day = String((index % 28) + 1).padStart(2, "0");
    return seedRecord({ id: `w-${String(index).padStart(4, "0")}`, date: `2026-${month}-${day}` });
  });
  // Store in reverse so the mock's own (date, id) sort is genuinely exercised.
  const rows = records
    .map((record) => ({ payload: record, owner_id: "user-1", id: record.id, date: record.date }))
    .reverse();
  return { db: { rows, cap, calls: [] }, records };
}

function storeWithDb(
  db: MockDb,
  opts?: { pageSize?: number; onPage?: (page: number) => void; missingRpc?: boolean },
) {
  return createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      ...(opts?.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
      fetchImpl: makeKeysetFetch(db, opts),
    },
  );
}

test("repository sends the caller token (RLS) and validates stored rows", async () => {
  const record = seedRecord({ id: "w-1", date: "2026-09-01" });
  const { db } = makeDb(0, 100);
  db.rows.push({ payload: record, owner_id: "user-1", id: record.id, date: record.date });
  const store = storeWithDb(db);
  assert.deepEqual(await store.listWorkouts(), [record]);
  const first = db.calls[0];
  assert.equal(first?.method, "POST");
  assert.match(first?.url ?? "", /\/rest\/v1\/rpc\/list_workouts_page/);
  // The caller's own token authorizes (RLS); the publishable key names the project.
  assert.equal(first?.headers.Authorization, "Bearer user-token");
  assert.equal(first?.headers.apikey, "pub-key");
  // First page carries a null cursor; the owner scope lives server-side
  // (auth.uid()) plus per-row validation below.
  assert.deepEqual(first?.body, { p_after_date: null, p_after_id: null, p_limit: 1000 });
});

test("repository rejects rows whose owner/id/date disagree with the payload", async () => {
  const record = seedRecord({ id: "w-1", date: "2026-09-01" });
  for (const row of [
    { payload: record, owner_id: "user-2", id: record.id, date: record.date },
    { payload: record, owner_id: "user-1", id: "other", date: record.date },
    { payload: record, owner_id: "user-1", id: record.id, date: "2026-09-02" },
  ]) {
    const store = createSupabaseWorkoutStore(
      { id: "user-1" },
      {
        supabaseUrl: "http://db.invalid",
        publishableKey: "pub-key",
        accessToken: "user-token",
        fetchImpl: (async () =>
          new Response(JSON.stringify([row]), { status: 200 })) as typeof fetch,
      },
    );
    await assert.rejects(store.listWorkouts(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, API_ERROR_CODES.CORRUPT_STORE);
      return true;
    });
  }
});

test("repository keyset-paginates past a small server cap with an empty page stop (251 rows, cap 100)", async () => {
  // The server truncates every page to max_rows=100 while the client asks for
  // 1000: all 251 rows must arrive exactly once, ending with an empty page —
  // a short page never terminates the read early.
  const { db, records } = makeDb(251, 100);
  const store = storeWithDb(db);
  const listed = await store.listWorkouts();
  assert.equal(listed.length, 251);
  assert.deepEqual(
    listed.map((entry) => entry.id),
    [...records]
      .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1))
      .map((entry) => entry.id),
  );
  assert.deepEqual(
    listed.map((entry) => entry.id).sort(),
    [...new Set(listed.map((entry) => entry.id))].sort(),
  );
  assert.equal(db.calls.length, 4);
  for (const call of db.calls) {
    assert.match(call.url, /\/rest\/v1\/rpc\/list_workouts_page/);
    assert.ok(!call.url.includes("offset="));
  }
  // Cursors chain strictly forward from the previous page's last row.
  const bodies = db.calls.map((call) => call.body as { p_after_date: string | null; p_after_id: string | null });
  assert.deepEqual(bodies[0], { p_after_date: null, p_after_id: null, p_limit: 1000 });
  for (let i = 1; i < bodies.length; i += 1) {
    assert.ok(bodies[i]?.p_after_date !== null && bodies[i]?.p_after_id !== null);
  }
});

test("repository handles 1000/1001-row boundaries and empty history", async () => {
  const exact = makeDb(1000, 10_000);
  assert.equal((await storeWithDb(exact.db).listWorkouts()).length, 1000);
  assert.equal(exact.db.calls.length, 2);

  const over = makeDb(1001, 10_000);
  const listed = await storeWithDb(over.db).listWorkouts();
  assert.equal(listed.length, 1001);
  assert.equal(new Set(listed.map((entry) => entry.id)).size, 1001);
  assert.equal(over.db.calls.length, 3);

  const empty = makeDb(0, 100);
  assert.deepEqual(await storeWithDb(empty.db).listWorkouts(), []);
  assert.equal(empty.db.calls.length, 1);
});

test("repository pages same-date rows by id cursor without gaps or duplicates", async () => {
  const records: WorkoutRecord[] = Array.from({ length: 10 }, (_, index) =>
    seedRecord({ id: `w-same-${String(index).padStart(2, "0")}`, date: "2026-09-15" }),
  );
  const rows = records
    .map((record) => ({ payload: record, owner_id: "user-1", id: record.id, date: record.date }))
    .reverse();
  const db: MockDb = { rows, cap: 1000, calls: [] };
  const listed = await storeWithDb(db, { pageSize: 3 }).listWorkouts();
  assert.deepEqual(
    listed.map((entry) => entry.id),
    records.map((entry) => entry.id),
  );
  // 10 rows at 3 per page, plus the terminating empty page.
  assert.equal(db.calls.length, 5);
});

test("repository never duplicates rows inserted mid-read; analysis counts each once", async () => {
  const { db } = makeDb(12, 100);
  const lateOld = seedRecord({ id: "w-late-old", date: "2026-01-02" });
  const lateNew = seedRecord({ id: "w-late-new", date: "2026-12-30" });
  let inserted = false;
  const store = storeWithDb(db, {
    pageSize: 5,
    onPage: (page) => {
      // Insert while the second page is being served: the first page (and
      // its cursor) is already fixed.
      if (page === 2 && !inserted) {
        inserted = true;
        // One row lands strictly before the first cursor, one after it.
        db.rows.push(
          { payload: lateOld, owner_id: "user-1", id: lateOld.id, date: lateOld.date },
          { payload: lateNew, owner_id: "user-1", id: lateNew.id, date: lateNew.date },
        );
      }
    },
  });
  const listed = await store.listWorkouts();
  const ids = listed.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("w-late-old"));
  assert.ok(ids.includes("w-late-new"));
  // A fresh read (analysis reloads) picks up the row that landed before the
  // cursor — still exactly once, so totals never double-count…
  const analysis = await store.analyze();
  assert.equal(analysis.metrics.sessions, ids.length + 1);
  assert.equal(analysis.metrics.volume_kg, (ids.length + 1) * 400);
  assert.equal(new Set(analysis.source_records).size, ids.length + 1);
  assert.ok(analysis.source_records.includes("w-late-old"));
  // …and a reload agrees.
  const reloaded = await store.listWorkouts();
  assert.equal(reloaded.length, ids.length + 1);
  assert.equal(new Set(reloaded.map((entry) => entry.id)).size, ids.length + 1);
});

test("repository round-trips special-character and unicode ids through the JSON cursor", async () => {
  const specialIds = [
    `w-quote-"q"`,
    "w-comma,a",
    "w-paren-(a)",
    "w-back\\slash",
    "w-unicode-你好-🏋️",
    "w-space inside",
    "w-plus+c",
    "w-semi;colon",
  ];
  const records = specialIds.map((id, index) =>
    seedRecord({ id, date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}` }),
  );
  const rows = records.map((record) => ({
    payload: record,
    owner_id: "user-1",
    id: record.id,
    date: record.date,
  }));
  const db: MockDb = { rows, cap: 1000, calls: [] };
  const listed = await storeWithDb(db, { pageSize: 2 }).listWorkouts();
  assert.equal(listed.length, specialIds.length);
  assert.equal(new Set(listed.map((entry) => entry.id)).size, specialIds.length);
  // Cursor values travel as exact JSON strings — never URL-encoded fragments.
  for (const call of db.calls) {
    const body = call.body as { p_after_id: string | null };
    assert.ok(body.p_after_id === null || specialIds.includes(body.p_after_id));
    assert.ok(!call.url.includes("access_token") && !call.url.includes("w-quote"));
  }
});

test("repository maps a missing pagination RPC to STORAGE_UNAVAILABLE", async () => {
  const { db } = makeDb(3, 100);
  const store = storeWithDb(db, { missingRpc: true });
  await assert.rejects(store.listWorkouts(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
    return true;
  });
});

test("repository surfaces CORRUPT_STORE for invalid persisted payloads", async () => {
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify([{ payload: { id: "", date: "nope" }, owner_id: "user-1", id: "", date: "nope" }]), {
          status: 200,
        })) as typeof fetch,
    },
  );
  await assert.rejects(store.listWorkouts(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.CORRUPT_STORE);
    return true;
  });
});

test("repository never exposes raw PostgREST bodies or causes", async () => {
  const record = seedRecord({ id: "w-1", date: "2026-09-01" });
  const secretBody = {
    code: "22023",
    message: "duplicate key value violates secret https://internal/db?key=s3cret payload {...}",
  };
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async (input: string) => {
        if (input.endsWith("/rpc/create_workout")) return jsonResponse(400, secretBody);
        return new Response(JSON.stringify([rowFor(record)]), { status: 200 });
      }) as typeof fetch,
    },
  );
  await assert.rejects(store.createWorkout(record), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.VALIDATION_ERROR);
    assert.equal((error as Error).message, "Invalid workout record.");
    assert.ok(!(error as Error).message.includes("s3cret"));
    return true;
  });

  const offline = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async () => {
        throw new TypeError("offline https://secret");
      }) as typeof fetch,
    },
  );
  await assert.rejects(offline.listWorkouts(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
    assert.ok(!(error as Error).message.includes("secret"));
    assert.equal((error as { details?: unknown }).details, undefined);
    return true;
  });
});

test("repository maps unreachable storage to STORAGE_UNAVAILABLE", async () => {
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
    },
  );
  await assert.rejects(store.listWorkouts(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
    return true;
  });
});

test("repository create validates input and posts to the RPC (never owner ids)", async () => {
  const posted: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const record = seedRecord({ id: "w-new", date: "2026-09-02" });
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async (input: string, init?: RequestInit) => {
        posted.push({
          url: input,
          body: JSON.parse(String(init?.body)),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse(200, { created: true, payload: record });
      }) as typeof fetch,
    },
  );
  const result = await store.createWorkout(record);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.record, record);
  assert.equal(posted[0]?.url, "http://db.invalid/rest/v1/rpc/create_workout");
  assert.equal(posted[0]?.headers.Authorization, "Bearer user-token");
  const body = posted[0]?.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["p_date", "p_id", "p_payload"]);
  assert.equal(body.p_id, "w-new");

  await assert.rejects(
    store.createWorkout({ ...record, exercises: [] } as unknown as WorkoutRecord),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, API_ERROR_CODES.VALIDATION_ERROR);
      return true;
    },
  );
});

test("repository maps RPC conflict vs identical duplicate via canonical comparison", async () => {
  const record = seedRecord({ id: "w-c", date: "2026-09-03" });
  const differing = seedRecord({
    id: "w-c",
    date: "2026-09-03",
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }],
  });

  async function storeWith(stored: WorkoutRecord): Promise<ReturnType<typeof createSupabaseWorkoutStore>> {
    let reads = 0;
    return createSupabaseWorkoutStore(
      { id: "user-1" },
      {
        supabaseUrl: "http://db.invalid",
        publishableKey: "pub-key",
        accessToken: "user-token",
        fetchImpl: (async (input: string) => {
          if (input.endsWith("/rpc/create_workout")) {
            return jsonResponse(409, { code: "23505", message: "WORKOUT_CONFLICT" });
          }
          // One row on the first page, then the terminating empty page.
          reads += 1;
          return new Response(JSON.stringify(reads === 1 ? [rowFor(stored)] : []), { status: 200 });
        }) as typeof fetch,
      },
    );
  }

  const identical = await (await storeWith(record)).createWorkout(record);
  assert.equal(identical.duplicate, true);

  await assert.rejects((await storeWith(record)).createWorkout(differing), (error: unknown) => {
    assert.equal((error as { code?: string }).code, API_ERROR_CODES.CONFLICT);
    return true;
  });
});

test("repository rejects non-strict RPC shapes and mismatched payloads", async () => {
  const record = seedRecord({ id: "w-s", date: "2026-09-05" });
  const other = seedRecord({ id: "w-other", date: "2026-09-05" });
  for (const body of [
    { payload: record },
    { created: true },
    record,
    { created: true, payload: other },
    { created: "yes", payload: record },
  ]) {
    const store = createSupabaseWorkoutStore(
      { id: "user-1" },
      {
        supabaseUrl: "http://db.invalid",
        publishableKey: "pub-key",
        accessToken: "user-token",
        fetchImpl: (async () => jsonResponse(200, body)) as typeof fetch,
      },
    );
    await assert.rejects(store.createWorkout(record), (error: unknown) => {
      assert.equal((error as { code?: string }).code, API_ERROR_CODES.CORRUPT_STORE);
      return true;
    });
  }
});

test("repository analyze validates filters and drafts never write", async () => {
  const writes: { method: string; url: string }[] = [];
  const record = seedRecord({ id: "w-a", date: "2026-10-05" });
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        // Reads page through the pagination RPC (POST); anything else that
        // mutates (any POST/PUT/PATCH off the list RPC) is a write.
        if (method !== "GET" && !input.endsWith("/rpc/list_workouts_page")) {
          writes.push({ method, url: input });
        }
        void input;
        // Stateless paging: every read serves the single row on its first
        // (null-cursor) page and terminates on the next — no shared counter
        // that would starve later reads into an empty history.
        const body = JSON.parse(String(init?.body ?? "{}")) as { p_after_date?: string | null };
        const firstPage = method === "POST" && (body.p_after_date ?? null) === null;
        return new Response(JSON.stringify(firstPage ? [rowFor(record)] : []), { status: 200 });
      }) as typeof fetch,
    },
  );
  const result = await store.analyze({ from: "2026-10-03", to: "2026-10-07" });
  assert.deepEqual(result.source_records, ["w-a"]);
  await assert.rejects(store.analyze({ from: "2026-09-10", to: "2026-09-01" }), (e: unknown) => {
    assert.equal((e as { code?: string }).code, API_ERROR_CODES.VALIDATION_ERROR);
    return true;
  });
  const draft = await store.createPlanDraft();
  assert.equal(draft.is_draft, true);
  assert.equal(draft.requires_confirmation, true);
  // The draft is grounded in the stored workout, not an empty history…
  assert.deepEqual(draft.based_on.source_records, ["w-a"]);
  assert.equal(draft.based_on.sessions, 1);
  // …and the whole flow dispatched zero writes.
  assert.deepEqual(writes, []);
});
