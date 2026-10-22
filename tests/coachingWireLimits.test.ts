/**
 * Shared SSE wire-limit integration (service → real HTTP SSE → real browser client).
 *
 * The coaching run service, the loopback HTTP server, and the browser
 * `CoachingClient` must consume ONE set of frame/total byte budgets so an
 * event the service accepts is always readable by the client. Before this
 * batch the service accepted events up to 512KB (measured as JSON *characters*)
 * while the client rejected frames over 256KB: a large but valid
 * `AnalysisResult` was stored and then undecodable by the browser.
 *
 * These tests cross the real wire (a real `startCoachingServer` on loopback,
 * the real `CoachingClient` with a same-origin fetch shim) and assert the
 * browser can read whatever the service accepted — never a silent truncation:
 * an over-budget frame is rejected explicitly with a safe, readable terminal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { AnalysisResult, WorkoutRecord } from "@agent-fit-trace/core";
import type { CoachingEventEnvelope, CoachingEventPayload } from "@agent-fit-trace/api-contracts";
import { MAX_COACHING_SSE_FRAME_BYTES } from "@agent-fit-trace/api-contracts";
import {
  COACHING_SSE_RESERVED_FRAME_BYTES,
  COACHING_TRUNCATION_MARKER,
  MAX_COACHING_SESSION_ID_LENGTH,
  MAX_COACHING_SSE_TOTAL_BYTES,
  coachingEventFrameBytes,
} from "@agent-fit-trace/api-contracts";
import { CoachingClient } from "../app/src/api/coachingClient.ts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import { createPrincipalMemoryStores } from "../server/principalMemoryStore.ts";
import { startCoachingServer } from "../server/coaching/coachingServer.ts";
import type { RuntimeFactory } from "../server/coaching/coachingService.ts";

function record(id: string, date: string): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    id,
    date,
  }).record;
}

/** A structurally valid AnalysisResult carrying the given source record ids. */
function analysisWith(ids: string[]): AnalysisResult {
  return {
    period: { from: "2026-09-01", to: "2026-10-01" },
    metrics: {
      sessions: ids.length,
      total_sets: 0,
      total_reps: 0,
      volume_kg: 0,
      avg_rpe: null,
      avg_rest_days: 0,
      max_gap_days: 0,
    },
    trends: [],
    flags: [],
    source_records: ids,
  };
}

function analysisFactory(analysis: AnalysisResult): RuntimeFactory {
  return (options) => ({
    start(): void {
      options.onEvent({ type: "analysis_result", result: analysis });
      options.onDone("completed", undefined, { processExitConfirmed: true });
    },
    cancel(): void {},
    async close(): Promise<void> {},
  });
}

/** Assert the full analysis AND the terminal reached the browser client. */
function assertFullAnalysisReached(events: CoachingEventEnvelope[], result: { aborted: boolean; lastConsumed: number }): void {
  assert.equal(result.aborted, false, "the client must complete the stream, not abort or reject");
  const terminal = events.find((event) => event.event.type === "terminal");
  assert.ok(terminal, "the terminal frame must reach the client");
  assert.equal((terminal!.event as { status: string }).status, "completed");
  assert.equal(
    result.lastConsumed,
    terminal!.seq,
    "lastConsumed must be the terminal seq, proving the whole stream was consumed",
  );
}

function deltaFactory(count: number): RuntimeFactory {
  return (options) => ({
    start(): void {
      for (let index = 0; index < count; index += 1) {
        const payload: CoachingEventPayload = { type: "text_delta", delta: `chunk-${index}-${"y".repeat(50)}` };
        options.onEvent(payload);
      }
      options.onDone("completed", undefined, { processExitConfirmed: true });
    },
    cancel(): void {},
    async close(): Promise<void> {},
  });
}

interface ClientRun {
  result: { aborted: boolean; lastConsumed: number };
  events: CoachingEventEnvelope[];
}

/**
 * Drive one full run through the real browser client against a real server.
 * The fetch shim only resolves the client's same-origin relative URLs against
 * the loopback server origin — the transport, framing, and parsing are the
 * production ones.
 */
async function runThroughClient(
  runtimeFactory: RuntimeFactory,
  serviceOptions: Record<string, unknown> = {},
): Promise<ClientRun> {
  const stores = createPrincipalMemoryStores();
  await stores.storeFor({ id: "user-a" }).createWorkout(record("w-a1", "2026-09-01"));
  await stores.storeFor({ id: "user-a" }).createWorkout(record("w-a2", "2026-09-03"));
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores,
    runtimeFactory,
    serviceOptions: { cancelGraceMs: 200, ...serviceOptions },
    publicConfig: null,
  });
  try {
    const client = new CoachingClient({
      fetchImpl: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(new URL(String(input), server.url), init)) as typeof fetch,
      getAccessToken: () => "token-a",
    });
    await client.bootstrap();
    const session = await client.createSession();
    const snapshot = await client.createSnapshot();
    const submitted = await client.submitRun({
      sessionId: session.id,
      prompt: "analyze my training",
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    });
    const events: CoachingEventEnvelope[] = [];
    const result = await client.subscribeRunEvents(
      { runId: submitted.run.id, sessionId: session.id, fromSeq: 0 },
      (event) => events.push(event),
    ).done;
    return { result, events };
  } finally {
    await server.close();
  }
}

test("a large valid AnalysisResult (2000 ASCII record ids) is readable by the browser client", async () => {
  const ids = Array.from({ length: 2000 }, (_, index) => `w-${index}`.padEnd(150, "x"));
  const { result, events } = await runThroughClient(analysisFactory(analysisWith(ids)));
  assertFullAnalysisReached(events, result);
  const analysis = events.find((event) => event.event.type === "analysis_result");
  assert.ok(analysis, "the browser client must read the large analysis_result frame the service accepted");
  assert.equal((analysis.event as { result: AnalysisResult }).result.source_records.length, 2000);
});

test("a large multibyte AnalysisResult counts UTF-8 bytes and still round-trips", async () => {
  // 2000 ids padded to 150 code units with a 2-byte character: ~600KB of UTF-8,
  // well over the old 256KB client frame cap but under the shared frame budget.
  const ids = Array.from({ length: 2000 }, (_, index) => `w-${index}`.padEnd(150, "é"));
  const { result, events } = await runThroughClient(analysisFactory(analysisWith(ids)));
  assertFullAnalysisReached(events, result);
  const analysis = events.find((event) => event.event.type === "analysis_result");
  assert.ok(analysis, "multibyte analysis frame must be measured and read in bytes");
  assert.equal((analysis.event as { result: AnalysisResult }).result.source_records.length, 2000);
});

test("an analysis frame over the shared frame budget fails explicitly with a readable terminal", async () => {
  const ids = ["z".repeat(MAX_COACHING_SSE_FRAME_BYTES + 4096)];
  const { result, events } = await runThroughClient(analysisFactory(analysisWith(ids)));
  assert.equal(result.aborted, false, "the client must read the safe terminal, not reject the stream");
  assert.equal(
    events.some((event) => event.event.type === "analysis_result"),
    false,
    "an over-budget frame is rejected, never truncated or delivered",
  );
  const terminal = events.find((event) => event.event.type === "terminal");
  assert.ok(terminal, "a safe terminal must still fit within the budget");
  assert.equal((terminal!.event as { status: string }).status, "failed");
  assert.equal(result.lastConsumed, terminal!.seq, "the terminal is the last consumed event");
});

test("tripping the per-run byte budget still leaves a readable terminal", async () => {
  const { result, events } = await runThroughClient(deltaFactory(200), { maxEventBytesPerRun: 2000 });
  assert.equal(result.aborted, false);
  assert.ok(events.some((event) => event.event.type === "run_error"));
  const terminal = events.find((event) => event.event.type === "terminal");
  assert.ok(terminal, "the cap-seal terminal must fit after the content budget is exhausted");
  assert.equal((terminal!.event as { status: string }).status, "failed");
  assert.equal(result.lastConsumed, terminal!.seq, "the terminal is the last consumed event");
  assert.equal(
    events.filter((event) => event.event.type === "terminal").length,
    1,
    "exactly one terminal reaches the client",
  );
});

test("near-content-budget stream with an escaped session id + control-character reason stays inside the shared total", async () => {
  const sessionId = "\u0000".repeat(MAX_COACHING_SESSION_ID_LENGTH);
  const stores = createPrincipalMemoryStores();
  await stores.storeFor({ id: "user-a" }).createWorkout(record("w-a1", "2026-09-01"));
  await stores.storeFor({ id: "user-a" }).createWorkout(record("w-a2", "2026-09-03"));
  // ~4.15 MB of content: just under the shared content budget (total - reserve)
  // while each frame stays well under the 1 MiB frame cap, so NO cap-seal fires
  // and the control-character terminal reason is the one that must be bounded.
  const chunk = "y".repeat(830_000);
  const runtimeFactory: RuntimeFactory = (options) => ({
    start(): void {
      for (let index = 0; index < 5; index += 1) {
        options.onEvent({ type: "text_delta", delta: `${index}-${chunk}` });
      }
      // 4000 NULs: 4000 raw bytes but ~24 KB once JSON-escaped.
      options.onDone("failed", "\u0000".repeat(4000), { processExitConfirmed: true });
    },
    cancel(): void {},
    async close(): Promise<void> {},
  });
  const server = await startCoachingServer({
    verifier: createTestVerifier({ "token-a": { id: "user-a" } }),
    stores,
    runtimeFactory,
    serviceOptions: { cancelGraceMs: 200 },
    publicConfig: null,
  });
  try {
    const client = new CoachingClient({
      fetchImpl: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(new URL(String(input), server.url), init)) as typeof fetch,
      getAccessToken: () => "token-a",
    });
    await client.bootstrap();
    const session = await client.createSession(sessionId);
    assert.equal(session.id, sessionId, "the escaped session id is accepted at the bound");
    const snapshot = await client.createSnapshot();
    const submitted = await client.submitRun({
      sessionId: session.id,
      prompt: "analyze my training",
      idempotencyKey: "key-near-budget",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    });
    const events: CoachingEventEnvelope[] = [];
    const result = await client.subscribeRunEvents(
      { runId: submitted.run.id, sessionId: session.id, fromSeq: 0 },
      (event) => events.push(event),
    ).done;
    // The terminal is consumable: no client-side rejection of the whole stream.
    assert.equal(result.aborted, false, "the browser client must read the safe terminal, not reject the stream");
    const terminal = events.find((event) => event.event.type === "terminal");
    assert.ok(terminal, "the terminal must reach the client");
    assert.equal(result.lastConsumed, terminal!.seq, "the terminal is the last consumed event");
    // The escaped reason fits the reserved frame budget — pre-fix, a raw-byte
    // bound under-counted the escapes 6x and overflowed the reserve.
    assert.ok(
      coachingEventFrameBytes(terminal!) <= COACHING_SSE_RESERVED_FRAME_BYTES,
      "escaped session id + escaped reason must fit the reserved terminal frame",
    );
    const reason = (terminal!.event as { reason?: string }).reason ?? "";
    assert.ok(reason.includes(COACHING_TRUNCATION_MARKER), "a shortened diagnostic must say so");
    assert.ok(reason.startsWith("\u0000"), "a prefix of the diagnostic must survive");
    // Every frame the client consumed stays within the shared total budget.
    const totalBytes = events.reduce((sum, event) => sum + coachingEventFrameBytes(event), 0);
    assert.ok(totalBytes <= MAX_COACHING_SSE_TOTAL_BYTES, "content + terminal must fit the shared total budget");
  } finally {
    await server.close();
  }
});
