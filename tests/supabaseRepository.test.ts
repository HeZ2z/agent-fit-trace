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

test("repository sends the caller token (RLS) and validates stored rows", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const record = seedRecord({ id: "w-1", date: "2026-09-01" });
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async (input: string, init?: RequestInit) => {
        seen.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify([rowFor(record)]), { status: 200 });
      }) as typeof fetch,
    },
  );
  assert.deepEqual(await store.listWorkouts(), [record]);
  assert.equal(seen[0]?.headers.Authorization, "Bearer user-token");
  assert.equal(seen[0]?.headers.apikey, "pub-key");
  assert.match(seen[0]?.url ?? "", /\/rest\/v1\/workouts\?select=payload/);
  // Defence in depth: explicit owner filter beyond RLS.
  assert.match(seen[0]?.url ?? "", /owner_id=eq\.user-1/);
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

test("repository paginates past PostgREST max_rows with deterministic order (core sortRecords)", async () => {
  // 1001 records force a second page (limit=1000): all rows must be
  // returned, in core sortRecords order, with the second request carrying
  // offset=1000. Rows arrive reversed so sorting is genuinely exercised.
  const records: WorkoutRecord[] = Array.from({ length: 1001 }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, "0");
    return seedRecord({ id: `w-${String(index).padStart(4, "0")}`, date: `2026-09-${day}` });
  });
  const rows = records.map((record) => rowFor(record)).reverse();
  const seenUrls: string[] = [];
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async (input: string) => {
        seenUrls.push(input);
        const url = new URL(input);
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        return new Response(JSON.stringify(rows.slice(offset, offset + limit)), { status: 200 });
      }) as typeof fetch,
    },
  );
  const listed = await store.listWorkouts();
  assert.equal(listed.length, 1001);
  assert.deepEqual(
    listed.map((entry) => entry.id),
    [...records].sort((a, b) =>
      a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1,
    ).map((entry) => entry.id),
  );
  assert.equal(seenUrls.length, 2);
  assert.match(seenUrls[0] ?? "", /limit=1000/);
  assert.match(seenUrls[0] ?? "", /offset=0/);
  assert.match(seenUrls[0] ?? "", /order=date\.asc/);
  assert.match(seenUrls[1] ?? "", /offset=1000/);
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
          return new Response(JSON.stringify([rowFor(stored)]), { status: 200 });
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
  let posts = 0;
  const record = seedRecord({ id: "w-a", date: "2026-10-05" });
  const store = createSupabaseWorkoutStore(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl: (async (input: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") posts += 1;
        void input;
        return new Response(JSON.stringify([rowFor(record)]), { status: 200 });
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
  assert.equal(posts, 0);
});
