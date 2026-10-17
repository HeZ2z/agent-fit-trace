import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuthPrincipal, CoachingEventPayload } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { validateWorkoutRecord } from "@pi-fit-trace/core";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { createCloudCoachingHandler } from "../server/cloud/httpHandler.ts";
import type { CloudCoachingProvider } from "../server/cloud/openRouterProvider.ts";
import { createCloudOutboxWorker } from "../server/cloud/outboxWorker.ts";
import { FakeCloudDatabase } from "./cloudFakes.ts";

const TOKENS: Record<string, AuthPrincipal> = {
  "token-formal": { id: "user-1", email: "formal@example.com", isAnonymous: false },
  "token-guest": { id: "guest-1", email: "guest@example.com", isAnonymous: true },
  "token-unknown": { id: "user-1", email: "unknown@example.com" },
};

function workout(): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    id: "2026-09-01-strength",
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 8 }] }],
    duration_minutes: 60,
    sleep_hours: 7.5,
    pain: [],
  }).record;
}

function setup(db = new FakeCloudDatabase()) {
  let repositoryCalls = 0;
  const handler = createCloudCoachingHandler({
    verifier: createTestVerifier(TOKENS),
    repositoryFor: () => {
      repositoryCalls += 1;
      return db.requestRepository();
    },
    source: {
      async listWorkouts(): Promise<WorkoutRecord[]> {
        return [workout()];
      },
    },
    providerConfigured: true,
    providerLimits: { maxSteps: 4, maxTokens: 2048, timeoutMs: 60_000 },
    sse: { pollMs: 1, maxDurationMs: 100, pageLimit: 200 },
    now: () => db.nowMs,
    sleep: async () => undefined,
  });
  return { db, handler, repositoryCalls: () => repositoryCalls };
}

type Handler = ReturnType<typeof setup>["handler"];

async function call(
  handler: Handler,
  input: {
    method: string;
    pathname: string;
    token?: string;
    body?: unknown;
    accept?: string;
    search?: string;
  },
) {
  const response = await handler({
    method: input.method,
    pathname: input.pathname,
    searchParams: new URLSearchParams(input.search ?? ""),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
    ...(input.accept === undefined ? {} : { accept: input.accept }),
  });
  const isSse = (response.headers["content-type"] ?? "").startsWith("text/event-stream");
  return {
    status: response.status,
    headers: response.headers,
    json:
      isSse || response.body === ""
        ? null
        : (JSON.parse(response.body) as Record<string, unknown>),
    raw: response.body,
  };
}

async function createSessionAndSnapshot(handler: Handler) {
  const session = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/sessions",
    token: "token-formal",
    body: {},
  });
  assert.equal(session.status, 201);
  const sessionId = ((session.json?.data as { id: string }).id);
  const snapshot = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/snapshots",
    token: "token-formal",
    body: {},
  });
  assert.equal(snapshot.status, 201);
  const snapshotData = snapshot.json?.data as {
    snapshotId: string;
    source: string;
    accountId: string;
  };
  return { sessionId, snapshot: snapshotData };
}

function submitBody(
  sessionId: string,
  snapshot: { snapshotId: string; source: string; accountId: string },
  idempotencyKey = "idem-1",
  prompt = "Review bench press.",
) {
  return {
    sessionId,
    prompt,
    idempotencyKey,
    snapshot: {
      snapshotId: snapshot.snapshotId,
      source: snapshot.source,
      accountId: snapshot.accountId,
    },
  };
}

test("cloud HTTP: guest, unknown classification, and DB guest all fail closed before RPC", async () => {
  const { db, handler } = setup();
  const guest = await call(handler, {
    method: "GET",
    pathname: "/coaching/cloud/capabilities",
    token: "token-guest",
  });
  assert.equal(guest.status, 403);
  assert.equal((guest.json?.error as { code: string }).code, "ACCOUNT_NOT_FORMAL");

  const unknown = await call(handler, {
    method: "GET",
    pathname: "/coaching/cloud/capabilities",
    token: "token-unknown",
  });
  assert.equal(unknown.status, 403);

  // The trusted principal says formal, but the authoritative DB row says
  // guest: the second gate still denies.
  db.setAccount({ isAnonymous: true });
  const dbGuest = await call(handler, {
    method: "GET",
    pathname: "/coaching/cloud/capabilities",
    token: "token-formal",
  });
  assert.equal(dbGuest.status, 403);
  assert.equal((dbGuest.json?.error as { code: string }).code, "ACCOUNT_NOT_FORMAL");
});

test("cloud HTTP: forged snapshot records/account id are rejected in the request shape", async () => {
  const { handler } = setup();
  const { sessionId, snapshot } = await createSessionAndSnapshot(handler);

  const forgedRecords = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body: {
      ...submitBody(sessionId, snapshot),
      snapshot: { ...snapshot, recordCount: 1, recordIds: [workout().id], records: [workout()] },
    },
  });
  assert.equal(forgedRecords.status, 400);
  assert.equal((forgedRecords.json?.error as { code: string }).code, "VALIDATION_ERROR");

  const forgedAccount = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body: submitBody(sessionId, { ...snapshot, accountId: "someone-else" }),
  });
  assert.equal(forgedAccount.status, 403);
  assert.equal((forgedAccount.json?.error as { code: string }).code, "FORBIDDEN");
});

test("cloud HTTP: identical replay survives snapshot expiry; changed request is 409", async () => {
  const { db, handler } = setup();
  const { sessionId, snapshot } = await createSessionAndSnapshot(handler);
  const body = submitBody(sessionId, snapshot);

  const first = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body,
  });
  assert.equal(first.status, 201);
  const firstRun = (first.json?.data as { run: { id: string } }).run;

  db.advance(31 * 60 * 1000);
  const replay = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body,
  });
  assert.equal(replay.status, 200);
  const replayData = replay.json?.data as { run: { id: string }; replayed: boolean };
  assert.equal(replayData.replayed, true);
  assert.equal(replayData.run.id, firstRun.id);

  const changed = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body: { ...body, prompt: "A different request." },
  });
  assert.equal(changed.status, 409);
  assert.equal((changed.json?.error as { code: string }).code, "IDEMPOTENCY_CONFLICT");
});

test("cloud HTTP: 21st submit is rejected by the 20-concurrency reservation cap", async () => {
  const { db, handler } = setup();
  const { sessionId, snapshot } = await createSessionAndSnapshot(handler);
  for (let index = 0; index < 20; index += 1) {
    const response = await call(handler, {
      method: "POST",
      pathname: "/coaching/cloud/runs",
      token: "token-formal",
      body: submitBody(sessionId, snapshot, `idem-${index}`),
    });
    assert.equal(response.status, 201, `submit ${index} should reserve capacity`);
  }
  assert.equal(db.reservedCount, 20);
  const extra = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body: submitBody(sessionId, snapshot, "idem-extra"),
  });
  assert.equal(extra.status, 429);
  assert.equal((extra.json?.error as { code: string }).code, "QUOTA_EXHAUSTED");
});

test("cloud HTTP: SSE replays only stored events and resumes from cursor", async () => {
  const { db, handler } = setup();
  const { sessionId, snapshot } = await createSessionAndSnapshot(handler);
  const submitted = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/runs",
    token: "token-formal",
    body: submitBody(sessionId, snapshot, "idem-sse"),
  });
  assert.equal(submitted.status, 201);
  const runId = (submitted.json?.data as { run: { id: string } }).run.id;

  const provider: CloudCoachingProvider = {
    async run(input) {
      await input.beforeProviderRequest();
      await input.onAccepted({
        generationId: "gen-sse",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, known: true },
      });
      const event: CoachingEventPayload = { type: "text_delta", delta: "stored only" };
      await input.onEvent(event);
      return {
        status: "completed",
        generationId: "gen-sse",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, known: true },
      };
    },
  };
  const worker = createCloudOutboxWorker({
    repository: db.workerRepository(),
    provider,
    enabled: true,
    workerId: "worker-http",
    leaseMs: 60_000,
    batch: 1,
  });
  assert.equal((await worker.tick()).completed, 1);

  const sse = await call(handler, {
    method: "GET",
    pathname: `/coaching/cloud/runs/${runId}/events`,
    token: "token-formal",
    accept: "text/event-stream",
  });
  assert.equal(sse.status, 200);
  assert.match(String(sse.headers["content-type"]), /^text\/event-stream/);
  assert.match(sse.raw, /"type":"text_delta"/);
  assert.match(sse.raw, /"status":"completed"/);
  assert.ok(!sse.raw.includes("heartbeat"), "no invented frames");

  const resumed = await call(handler, {
    method: "GET",
    pathname: `/coaching/cloud/runs/${runId}/events`,
    token: "token-formal",
    accept: "text/event-stream",
    search: "fromSeq=1",
  });
  assert.ok(!resumed.raw.includes('"seq":0'), "cursor must not replay seq 0");
  assert.match(resumed.raw, /"status":"completed"/);
});

test("cloud HTTP: invalid snapshot date filter maps to 400, not an internal error", async () => {
  const { handler } = setup();
  const response = await call(handler, {
    method: "POST",
    pathname: "/coaching/cloud/snapshots",
    token: "token-formal",
    body: { from: "2026-09-10", to: "2026-09-01" },
  });
  assert.equal(response.status, 400);
  assert.equal((response.json?.error as { code: string }).code, "VALIDATION_ERROR");
});
