/**
 * Direct service tests for review-3c items 2/3 (no HTTP): the service owns
 * terminal exactly-once + expiry, so these drive `createCoachingService`
 * with faithful adapter-order fakes.
 *
 * - Item 2: the real adapter emits onEvent(terminal) THEN onDone with the
 *   same outcome. The service buffers the intent and emits exactly ONE
 *   terminal on confirmed onDone; late nonterminals after the intent are
 *   dropped; cancel wins over a late completion; a cap seal stands over a
 *   later intent.
 * - Item 3: confirmed-terminal runs/sessions/snapshots are swept by the
 *   automatic timer with NO subsequent calls (small TTL); active and
 *   terminal-unconfirmed runs are never swept and their dirs are preserved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stat } from "node:fs/promises";
import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { AnalysisResult, WorkoutRecord } from "@pi-fit-trace/core";
import type { CoachingEventPayload } from "@pi-fit-trace/api-contracts";
import { createPrincipalMemoryStores } from "../server/principalMemoryStore.ts";
import {
  createCoachingService,
  storeFactorySource,
} from "../server/coaching/coachingService.ts";
import type {
  CoachingService,
  RuntimeFactory,
  RuntimeLaunchOptions,
} from "../server/coaching/coachingService.ts";

const PRINCIPAL = { id: "user-a", email: "a@example.com" };

function record(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface Captured {
  options: RuntimeLaunchOptions;
  cancelled: boolean;
  cancelReason?: string;
  closed: boolean;
}

function captureFactory(
  captured: Captured[],
  behavior: {
    onStart?: (options: RuntimeLaunchOptions) => void;
    onCancel?: (options: RuntimeLaunchOptions, reason?: string) => void;
    hangClose?: boolean;
  } = {},
): RuntimeFactory {
  return (options: RuntimeLaunchOptions) => {
    const entry: Captured = { options, cancelled: false, closed: false };
    captured.push(entry);
    return {
      start(): void {
        behavior.onStart?.(options);
      },
      cancel(reason?: string): void {
        entry.cancelled = true;
        entry.cancelReason = reason;
        behavior.onCancel?.(options, reason);
      },
      async close(): Promise<void> {
        if (behavior.hangClose === true) {
          await new Promise(() => undefined);
          return;
        }
        entry.closed = true;
      },
    };
  };
}

async function setupService(
  service: CoachingService,
  prompt = "analyze my training",
  key = `key-${Math.random().toString(36).slice(2)}`,
) {
  const session = service.createSession(PRINCIPAL);
  const snapshot = await service.createSnapshot(PRINCIPAL);
  const submitted = await service.submitRun(PRINCIPAL, {
    sessionId: session.id,
    prompt,
    idempotencyKey: key,
    snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
  });
  return { session, snapshot, runId: submitted.run.id };
}

function contentEvents(analysis?: AnalysisResult): CoachingEventPayload[] {
  const result = analysis ?? analyzeProgress([]);
  return [
    { type: "text_delta", delta: "hello " },
    { type: "tool_start", tool: "get_training_history", callId: "c1" },
    { type: "tool_end", tool: "get_training_history", callId: "c1", ok: true },
    { type: "analysis_result", result },
    { type: "text_delta", delta: "world" },
  ];
}

async function seedWorkouts(): Promise<ReturnType<typeof createPrincipalMemoryStores>> {
  const stores = createPrincipalMemoryStores();
  await stores.storeFor(PRINCIPAL).createWorkout(record({ id: "w-a1", date: "2026-09-01" }));
  await stores.storeFor(PRINCIPAL).createWorkout(record({ id: "w-a2", date: "2026-09-03" }));
  return stores;
}

test("adapter-order terminal intent + onDone emits exactly one terminal; late payloads dropped", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        for (const payload of contentEvents()) options.onEvent(payload);
        // Real adapter order: intent first, then a late payload, then onDone.
        options.onEvent({ type: "terminal", status: "completed" });
        options.onEvent({ type: "text_delta", delta: "should-be-dropped" });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(service);
    const page = service.readEvents(PRINCIPAL, runId);
    assert.equal(page.run.status, "completed");
    const terminals = page.events.filter((envelope) => envelope.event.type === "terminal");
    assert.equal(terminals.length, 1);
    assert.equal(page.events.length, 6);
    assert.deepEqual(page.events.map((envelope) => envelope.seq), [0, 1, 2, 3, 4, 5]);
    assert.ok(
      page.events.every((envelope) =>
        envelope.event.type !== "text_delta" || (envelope.event as { delta: string }).delta !== "should-be-dropped"
      ),
    );
    assert.equal(page.lastSeq, 5);
  } finally {
    await service.shutdown();
  }
});

test("cancel wins over a late buffered completion intent", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    // Fake cancel is a no-op so the test drives the late onDone manually,
    // exactly like a completion racing the cancel grace.
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        options.onEvent({ type: "terminal", status: "completed" });
      },
    }),
    cancelGraceMs: 5000,
  });
  try {
    const { runId } = await setupService(service);
    // Intent buffered: no terminal stored yet, run still active.
    const before = service.readEvents(PRINCIPAL, runId);
    assert.ok(before.events.every((envelope) => envelope.event.type !== "terminal"));
    service.cancelRun(PRINCIPAL, runId, "user cancel");
    // Late completion arrives during the grace: cancel still wins.
    captured[0]?.options.onDone("completed", undefined, { processExitConfirmed: true });
    const page = service.readEvents(PRINCIPAL, runId);
    assert.equal(page.run.status, "cancelled");
    const terminals = page.events.filter((envelope) => envelope.event.type === "terminal");
    assert.equal(terminals.length, 1);
    assert.equal((terminals[0]?.event as { status: string }).status, "cancelled");
  } finally {
    await service.shutdown();
  }
});

test("event-cap seal stands over a later terminal intent; still exactly one terminal", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        options.onEvent({ type: "text_delta", delta: "one" });
        options.onEvent({ type: "text_delta", delta: "two" });
        options.onEvent({ type: "text_delta", delta: "three-trips-cap" });
        // Runtime intent after the seal must not override the cap failure.
        options.onEvent({ type: "terminal", status: "completed" });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    maxEventsPerRun: 2,
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(service);
    // Seal path closes asynchronously; wait for the terminal.
    const start = Date.now();
    for (;;) {
      const read = service.readRun(PRINCIPAL, runId);
      if (read.run.status === "failed") break;
      assert.ok(Date.now() - start < 5000, "seal did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const page = service.readEvents(PRINCIPAL, runId);
    assert.equal(page.run.status, "failed");
    const terminals = page.events.filter((envelope) => envelope.event.type === "terminal");
    assert.equal(terminals.length, 1);
    assert.ok(page.events.some((envelope) =>
      envelope.event.type === "run_error" && (envelope.event as { code: string }).code === "EVENT_CAP"
    ));
  } finally {
    await service.shutdown();
  }
});

test("automatic sweep expires confirmed runs/sessions with no subsequent calls", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        for (const payload of contentEvents()) options.onEvent(payload);
        options.onEvent({ type: "terminal", status: "completed" });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    retentionMs: 120,
    snapshotTtlMs: 120,
    cancelGraceMs: 50,
  });
  try {
    const { runId, session } = await setupService(service);
    const snapshotDir = captured[0]?.options.snapshotDir ?? "";
    const sessionDir = captured[0]?.options.sessionDir ?? "";
    assert.equal(service.runCount(), 1);
    assert.ok(await exists(snapshotDir));
    // No service calls at all during the wait: the timer must sweep alone.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(service.runCount(), 0);
    assert.ok(!(await exists(snapshotDir)));
    assert.ok(!(await exists(sessionDir)));
    assert.throws(() => service.readRun(PRINCIPAL, runId), /not found/i);
    assert.throws(() => service.readSession(PRINCIPAL, session.id), /not found/i);
  } finally {
    await service.shutdown();
  }
});

test("active and unconfirmed runs are never swept and keep their dirs", async () => {
  // Active run: hang fake, small TTL, wait past retention.
  const hangCaptured: Captured[] = [];
  const hangStores = await seedWorkouts();
  const hangService = createCoachingService({
    source: storeFactorySource(hangStores),
    runtimeFactory: captureFactory(hangCaptured, {}),
    retentionMs: 120,
    snapshotTtlMs: 120,
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(hangService, "hang prompt", "hang-key");
    const snapshotDir = hangCaptured[0]?.options.snapshotDir ?? "";
    const sessionDir = hangCaptured[0]?.options.sessionDir ?? "";
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hangService.runCount(), 1);
    assert.equal(hangService.readRun(PRINCIPAL, runId).run.status, "queued");
    assert.ok(await exists(snapshotDir));
    assert.ok(await exists(sessionDir));
  } finally {
    await hangService.shutdown();
  }

  // Terminal-but-unconfirmed run: past retention, still retained with files.
  const unconfirmedCaptured: Captured[] = [];
  const unconfirmedStores = await seedWorkouts();
  const unconfirmedService = createCoachingService({
    source: storeFactorySource(unconfirmedStores),
    runtimeFactory: captureFactory(unconfirmedCaptured, {
      onStart: (options) => {
        options.onEvent({ type: "text_delta", delta: "partial" });
        options.onDone("completed", undefined, { processExitConfirmed: false });
      },
    }),
    retentionMs: 120,
    snapshotTtlMs: 120,
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(unconfirmedService, "unconfirmed prompt", "unconfirmed-key");
    const snapshotDir = unconfirmedCaptured[0]?.options.snapshotDir ?? "";
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(unconfirmedService.runCount(), 1);
    // Success withheld without exit confirmation.
    assert.equal(unconfirmedService.readRun(PRINCIPAL, runId).run.status, "failed");
    assert.ok(await exists(snapshotDir));
  } finally {
    await unconfirmedService.shutdown();
  }
});

test("oversized snapshot range rejects instead of truncating", async () => {
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory([], {}),
    maxRecordsPerSnapshot: 1,
    cancelGraceMs: 50,
  });
  try {
    await assert.rejects(
      service.createSnapshot(PRINCIPAL),
      /exceeding the per-snapshot limit.*narrow the date range/i,
    );
  } finally {
    await service.shutdown();
  }
});

test("completed onDone without a validated analysis becomes failed", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        options.onEvent({ type: "text_delta", delta: "hello" });
        options.onEvent({ type: "tool_start", tool: "get_training_history", callId: "c1" });
        options.onEvent({ type: "tool_end", tool: "get_training_history", callId: "c1", ok: true });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(service);
    const read = service.readRun(PRINCIPAL, runId);
    assert.equal(read.run.status, "failed");
    assert.match(read.run.failure?.message ?? "", /without a validated analysis/i);
  } finally {
    await service.shutdown();
  }
});

test("completed onDone with a malformed analysis becomes failed", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        options.onEvent({ type: "text_delta", delta: "hello" });
        options.onEvent({ type: "analysis_result", result: { bogus: true } as unknown as AnalysisResult });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(service);
    const read = service.readRun(PRINCIPAL, runId);
    assert.equal(read.run.status, "failed");
    assert.match(read.run.failure?.message ?? "", /malformed analysis/i);
  } finally {
    await service.shutdown();
  }
});

test("completed onDone with a tool-end failure becomes failed", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        options.onEvent({ type: "text_delta", delta: "hello" });
        options.onEvent({ type: "tool_start", tool: "get_training_history", callId: "c1" });
        options.onEvent({ type: "tool_end", tool: "get_training_history", callId: "c1", ok: false, error: "boom" });
        options.onEvent({ type: "analysis_result", result: analyzeProgress([]) });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    cancelGraceMs: 50,
  });
  try {
    const { runId } = await setupService(service);
    const read = service.readRun(PRINCIPAL, runId);
    assert.equal(read.run.status, "failed");
    assert.match(read.run.failure?.message ?? "", /boom/i);
  } finally {
    await service.shutdown();
  }
});
