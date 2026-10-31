import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { ConflictError, ValidationError, stableStringify, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";
import { createCloudFitTraceStore, createFitTraceMcpServer } from "@agent-fit-trace/mcp";
import type { FitTraceStore } from "@agent-fit-trace/mcp";

import { loadFixture } from "./helpers.ts";
import { runStoreContractSuite } from "./store.contract.ts";

/**
 * Cloud `FitTraceStore` adapter tests.
 *
 * The fake `fetchImpl` speaks the same two PostgREST RPC routes the real
 * Supabase client calls — the keyset-paginated read (`list_workouts_page`) and
 * the write (`create_workout`) — and mirrors their documented behaviors:
 * per-owner rows, `(date, id)` ordering, a hard `max_rows` cap that truncates
 * below the requested `p_limit`, `created: false` for an identical re-insert,
 * and a 409 `WORKOUT_CONFLICT` for a different payload under the same id.
 * Only the request shaping, completeness, and error translation are proven
 * here; real RLS is proven by `tests/supabaseIntegration.test.ts`.
 */

type Call = {
  url: string;
  method: string;
  token: string | null;
  body: Record<string, unknown> | null;
};

interface FakeRow {
  payload: unknown;
  owner_id: string;
  id: string;
  date: string;
}

interface FakeSupabase {
  rows: FakeRow[];
  calls: Call[];
  /** Simulated PostgREST `max_rows`: every page is truncated to this size. */
  cap: number;
  /** Answer every read with this status (storage-failure tests). */
  readStatus: number | null;
  /** Make the next `create_workout` answer 400 with a PostgREST validation code. */
  nextCreateValidationError: boolean;
  fetchImpl: typeof fetch;
}

function orderRows(rows: FakeRow[]): FakeRow[] {
  return [...rows].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Fake PostgREST wired to a token → owner mapping, so one fake can serve two
 * principals and any cross-scope leak shows up as a wrong `owner_id`.
 */
function makeSupabase(
  tokenToOwner: Record<string, string>,
  options?: { cap?: number },
): FakeSupabase {
  const db: FakeSupabase = {
    rows: [],
    calls: [],
    cap: options?.cap ?? 10_000,
    readStatus: null,
    nextCreateValidationError: false,
    fetchImpl: null as unknown as typeof fetch,
  };

  db.fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    let body: Record<string, unknown> | null = null;
    try {
      body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
    } catch {
      body = null;
    }
    db.calls.push({ url, method, token, body });

    const ownerId = tokenToOwner[token];
    if (ownerId === undefined) return jsonResponse(401, { message: "invalid token" });

    if (url.endsWith("/rest/v1/rpc/list_workouts_page")) {
      if (db.readStatus !== null) return jsonResponse(db.readStatus, { message: "boom" });
      const afterDate = (body?.p_after_date ?? null) as string | null;
      const afterId = (body?.p_after_id ?? null) as string | null;
      const limit = typeof body?.p_limit === "number" ? body.p_limit : 1000;
      const own = orderRows(db.rows.filter((row) => row.owner_id === ownerId));
      const after =
        afterDate === null || afterId === null
          ? own
          : own.filter((row) => row.date > afterDate || (row.date === afterDate && row.id > afterId));
      return jsonResponse(200, after.slice(0, Math.min(limit, db.cap)));
    }

    if (url.endsWith("/rest/v1/rpc/create_workout")) {
      if (db.nextCreateValidationError) {
        db.nextCreateValidationError = false;
        return jsonResponse(400, { code: "22023", message: "WORKOUT_INVALID" });
      }
      const id = body?.p_id;
      const date = body?.p_date;
      const payload = body?.p_payload;
      if (typeof id !== "string" || typeof date !== "string" || payload === undefined) {
        return jsonResponse(400, { code: "22023", message: "WORKOUT_INVALID" });
      }
      const existing = db.rows.find((row) => row.owner_id === ownerId && row.id === id);
      if (existing !== undefined) {
        if (stableStringify(existing.payload) === stableStringify(payload)) {
          return jsonResponse(200, { created: false, payload: existing.payload });
        }
        return jsonResponse(409, { code: "23505", message: "WORKOUT_CONFLICT", detail: id });
      }
      db.rows.push({ payload, owner_id: ownerId, id, date });
      return jsonResponse(200, { created: true, payload });
    }

    return jsonResponse(404, { code: "PGRST202", message: "not found" });
  }) as typeof fetch;

  return db;
}

function cloudStoreFor(
  db: FakeSupabase,
  input: { principal: AuthPrincipal; token: string; publishableKey?: string },
): FitTraceStore {
  return createCloudFitTraceStore(input.principal, {
    supabaseUrl: "http://db.invalid",
    publishableKey: input.publishableKey ?? "pub-key",
    accessToken: input.token,
    fetchImpl: db.fetchImpl,
  });
}

function storeFor(db: FakeSupabase): FitTraceStore {
  return cloudStoreFor(db, { principal: { id: "user-1" }, token: "token-1" });
}

function record(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

function creates(db: FakeSupabase): Call[] {
  return db.calls.filter((call) => call.url.endsWith("/rpc/create_workout"));
}

// ---------------------------------------------------------------------------
// Backend parity: the same contract suite the JSON and SQLite backends satisfy.
// ---------------------------------------------------------------------------

runStoreContractSuite("cloud store", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  return { store: storeFor(db), cleanup: () => {} };
});

// ---------------------------------------------------------------------------
// Read completeness and query parity.
// ---------------------------------------------------------------------------

test("all() returns every page, never a truncated first page", async () => {
  // 10 rows, server cap of 3: the client asks for 1000 per page and must keep
  // reading until an empty page, so a `max_rows` truncation cannot lose data.
  const db = makeSupabase({ "token-1": "user-1" }, { cap: 3 });
  const records = Array.from({ length: 10 }, (_, index) =>
    record({ id: `w-${String(index).padStart(2, "0")}`, date: `2026-09-${String(index + 1).padStart(2, "0")}` }),
  );
  for (const entry of records) {
    db.rows.push({ payload: entry, owner_id: "user-1", id: entry.id, date: entry.date });
  }
  // Store out of order so the adapter cannot rely on insertion order.
  db.rows.reverse();

  const store = storeFor(db);
  const listed = await store.all();
  assert.deepEqual(
    listed.map((entry) => entry.id),
    records.map((entry) => entry.id),
  );
  assert.equal(new Set(listed.map((entry) => entry.id)).size, 10);

  const reads = db.calls.filter((call) => call.url.endsWith("/rpc/list_workouts_page"));
  // 10 rows / 3 per page = 4 pages, plus the terminating empty page.
  assert.equal(reads.length, 5);
  assert.equal(reads[0]?.body?.p_after_date, null);
  for (const read of reads.slice(1)) {
    assert.notEqual(read.body?.p_after_id, null);
  }
});

test("query matches the local backends for date bounds, exercise, and paging", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  const history = await loadFixture<WorkoutRecord[]>("history-strength.json");
  for (const entry of history) await store.import(validateWorkoutRecord(entry).record);

  assert.deepEqual((await store.query()).records.map((entry) => entry.id), [
    "2026-09-01-strength",
    "2026-09-04-strength",
    "2026-09-08-strength",
  ]);

  const ranged = await store.query({ from: "2026-09-04", to: "2026-09-04" });
  assert.deepEqual(ranged.records.map((entry) => entry.id), ["2026-09-04-strength"]);

  const byExercise = await store.query({ exercise: "SQUAT" });
  assert.equal(byExercise.total, 3);

  const page = await store.query({ limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.offset, 1);
  assert.equal(page.limit, 2);
  assert.deepEqual(page.records.map((entry) => entry.id), [
    "2026-09-04-strength",
    "2026-09-08-strength",
  ]);

  // Open-ended bounds and a no-match exercise behave the same as local stores.
  assert.deepEqual((await store.query({ from: "2026-09-04" })).records.map((entry) => entry.id), [
    "2026-09-04-strength",
    "2026-09-08-strength",
  ]);
  assert.equal((await store.query({ exercise: "deadlift" })).total, 0);
});

test("query validates the filter before reading anything from the network", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  for (const filter of [
    { from: "not-a-date" },
    { from: "2026-09-10", to: "2026-09-01" },
  ] satisfies HistoryFilter[]) {
    await assert.rejects(store.query(filter), ValidationError);
  }
  assert.equal(db.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Import semantics.
// ---------------------------------------------------------------------------

test("import reports the post-write total and an identical re-import is a no-op", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  const first = record({ id: "w-1", date: "2026-09-01" });
  const second = record({ id: "w-2", date: "2026-09-02" });

  assert.deepEqual(await store.import(first), { duplicate: false, total: 1 });
  assert.deepEqual(await store.import(second), { duplicate: false, total: 2 });

  const again = await store.import(first);
  assert.deepEqual(again, { duplicate: true, total: 2 });
  assert.equal((await store.all()).length, 2);
  // One write reached the database for the duplicate; it answered created:false.
  assert.equal(creates(db).length, 3);
});

test("the same id with different content throws the domain ConflictError and never overwrites", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  const original = record({ id: "w-1", date: "2026-09-01" });
  await store.import(original);

  const mutated = structuredClone(original);
  mutated.exercises[0]!.sets[0]!.weight = 82.5;

  await assert.rejects(
    () => store.import(mutated),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.ok(!(error instanceof ApiError));
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.existingId, "w-1");
      return true;
    },
  );
  assert.equal(db.rows.length, 1);
  assert.equal(stableStringify((await store.all())[0]), stableStringify(original));
});

test("an invalid record throws the domain ValidationError with the core issues", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  const invalid = { ...record({ id: "w-1", date: "2026-09-01" }) };
  invalid.exercises[0]!.sets[0]!.weight = -5;

  // The Supabase client validates through core first and wraps the failure in
  // an ApiError carrying `details.issues`; the adapter must restore the domain
  // error and keep the issues the MCP layer reports.
  await assert.rejects(
    () => store.import(invalid as WorkoutRecord),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(!(error instanceof ApiError));
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.issues[0]?.code, "INVALID_WEIGHT");
      assert.equal(error.issues[0]?.path, "exercises[0].sets[0].weight");
      return true;
    },
  );
  assert.equal(creates(db).length, 0);
});

test("a server-side validation rejection becomes a domain ValidationError", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  db.nextCreateValidationError = true;

  await assert.rejects(
    () => store.import(record({ id: "w-1", date: "2026-09-01" })),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.deepEqual(error.issues, []);
      return true;
    },
  );
  assert.equal(db.rows.length, 0);
});

test("CORRUPT_STORE and STORAGE_UNAVAILABLE propagate unchanged", async () => {
  const corrupt = makeSupabase({ "token-1": "user-1" });
  corrupt.rows.push({ payload: { id: "broken" }, owner_id: "user-1", id: "broken", date: "2026-09-01" });
  await assert.rejects(storeFor(corrupt).all(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, API_ERROR_CODES.CORRUPT_STORE);
    return true;
  });

  const unavailable = makeSupabase({ "token-1": "user-1" });
  unavailable.readStatus = 500;
  await assert.rejects(storeFor(unavailable).all(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, API_ERROR_CODES.STORAGE_UNAVAILABLE);
    return true;
  });
});

test("propagated storage errors reach MCP clients as an error result carrying the code, with no stack or token", async () => {
  // `errorResult` keeps a coded non-domain error's code (CORRUPT_STORE here)
  // while replacing its message with fixed copy, so the failure stays
  // actionable (retryable outage vs. needs-intervention) without leaking a
  // stack, a path, or any credential.
  const corrupt = makeSupabase({ "token-1": "user-1" });
  corrupt.rows.push({ payload: { id: "broken" }, owner_id: "user-1", id: "broken", date: "2026-09-01" });
  await withCloudClient(storeFor(corrupt), async (client) => {
    const result = await client.callTool({ name: "get_training_history", arguments: {} });
    assert.equal(result.isError, true);
    const text = firstText(result);
    assert.match(text, /^CORRUPT_STORE: /);
    assert.ok(!text.includes("token-1"));
    assert.ok(!text.includes("pub-key"));
    assert.ok(!/\bat .+:\d+:\d+/.test(text), `stack frame leaked: ${text}`);
  });
});

// ---------------------------------------------------------------------------
// Identity: the principal and token are closed over, never caller-supplied.
// ---------------------------------------------------------------------------

test("two principals keep separate rows, tokens, and requests", async () => {
  const db = makeSupabase({ "token-a": "user-a", "token-b": "user-b" });
  const storeA = cloudStoreFor(db, { principal: { id: "user-a" }, token: "token-a" });
  const storeB = cloudStoreFor(db, { principal: { id: "user-b" }, token: "token-b" });

  await storeA.import(record({ id: "a-1", date: "2026-09-01" }));
  await storeB.import(record({ id: "b-1", date: "2026-09-02" }));

  const a = await storeA.all();
  const b = await storeB.all();
  assert.deepEqual(a.map((entry) => entry.id), ["a-1"]);
  assert.deepEqual(b.map((entry) => entry.id), ["b-1"]);

  // Every request carried the caller's own bearer; no request ever crossed over.
  const byToken = new Map<string, Call[]>();
  for (const call of db.calls) {
    const bucket = byToken.get(call.token ?? "") ?? [];
    bucket.push(call);
    byToken.set(call.token ?? "", bucket);
  }
  assert.deepEqual([...byToken.keys()].sort(), ["token-a", "token-b"]);
  assert.ok(db.calls.every((call) => call.method === "POST"));

  // Creates never carry an owner: the RPC derives it from auth.uid().
  for (const call of creates(db)) {
    assert.deepEqual(Object.keys(call.body ?? {}).sort(), ["p_date", "p_id", "p_payload"]);
    assert.ok(!("owner_id" in (call.body?.p_payload as Record<string, unknown>)));
  }
});

// ---------------------------------------------------------------------------
// The unchanged MCP tools run on the cloud store.
// ---------------------------------------------------------------------------

async function withCloudClient<T>(
  store: FitTraceStore,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createFitTraceMcpServer({ store, skillText: "" });
  const client = new Client({ name: "fit-trace-mcp-cloud-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function firstText(result: unknown): string {
  const content = (result as { content?: ReadonlyArray<{ text?: unknown }> }).content;
  const block = content?.[0];
  return typeof block?.text === "string" ? block.text : "";
}

test("generate_next_plan never writes; import_workout does", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  const history = await loadFixture<WorkoutRecord[]>("history-strength.json");
  for (const entry of history) await store.import(validateWorkoutRecord(entry).record);
  const writesAfterSeed = creates(db).length;
  assert.equal(writesAfterSeed, 3);

  await withCloudClient(store, async (client) => {
    const plan = await client.callTool({ name: "generate_next_plan", arguments: { goal: "strength" } });
    assert.ok(!plan.isError, firstText(plan));
    assert.equal((plan.structuredContent as { is_draft?: boolean }).is_draft, true);
    assert.equal(creates(db).length, writesAfterSeed);

    const analysis = await client.callTool({ name: "analyze_progress", arguments: {} });
    assert.ok(!analysis.isError, firstText(analysis));
    assert.equal(creates(db).length, writesAfterSeed);

    const historyResult = await client.callTool({ name: "get_training_history", arguments: {} });
    assert.match(firstText(historyResult), /Returned 3 of 3 matching record\(s\)\./);

    const imported = await client.callTool({
      name: "import_workout",
      arguments: { record: record({ id: "w-mcp-1", date: "2026-10-01" }) },
    });
    assert.ok(!imported.isError, firstText(imported));
    assert.equal((imported.structuredContent as { total_records?: number }).total_records, 4);
    assert.equal(creates(db).length, writesAfterSeed + 1);
  });

  assert.equal(db.rows.length, 4);
});

test("the MCP layer reports CONFLICT and VALIDATION_ERROR as codes, not stacks", async () => {
  const db = makeSupabase({ "token-1": "user-1" });
  const store = storeFor(db);
  const original = record({ id: "w-1", date: "2026-09-01" });
  await store.import(original);

  await withCloudClient(store, async (client) => {
    const mutated = structuredClone(original) as WorkoutRecord & { exercises: { sets: { weight: number }[] }[] };
    mutated.exercises[0]!.sets[0]!.weight = 90;
    const conflict = await client.callTool({ name: "import_workout", arguments: { record: mutated } });
    assert.equal(conflict.isError, true);
    assert.match(firstText(conflict), /^CONFLICT: /);

    const invalidDate = { ...original, id: "w-2", date: "not-a-date" };
    const invalid = await client.callTool({ name: "import_workout", arguments: { record: invalidDate } });
    assert.equal(invalid.isError, true);
    assert.match(firstText(invalid), /^VALIDATION_ERROR: /);
  });

  // Neither rejection wrote anything.
  assert.equal(db.rows.length, 1);
});
