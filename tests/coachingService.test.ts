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
import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { AnalysisResult, WorkoutRecord } from "@agent-fit-trace/core";
import type { CoachingEventEnvelope, CoachingEventPayload } from "@agent-fit-trace/api-contracts";
import {
  COACHING_PROTOCOL_VERSION,
  COACHING_SSE_RESERVED_FRAME_BYTES,
  COACHING_TRUNCATION_MARKER,
  MAX_COACHING_SESSION_ID_LENGTH,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  coachingEventFrameBytes,
  utf8ByteLength,
} from "@agent-fit-trace/api-contracts";
import { createPrincipalMemoryStores } from "../server/principalMemoryStore.ts";
import {
  CoachingServiceError,
  createCoachingService,
  DEFAULT_MAX_EVENT_BYTES_PER_RUN,
  normalizeMaxEventBytesPerRun,
  storeFactorySource,
} from "../server/coaching/coachingService.ts";
import type {
  CoachingService,
  RuntimeFactory,
  RuntimeLaunchOptions,
  ServiceErrorCode,
} from "../server/coaching/coachingService.ts";
import { writeSnapshotDir } from "../server/coaching/snapshotFile.ts";
import type { SnapshotDir } from "../server/coaching/snapshotFile.ts";
import { createCoachingRuntimeRegistry } from "../server/coaching/runtimeRegistry.ts";

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

// --- startup cancellation race: an awaited workspace write must re-verify ---

/**
 * Injected snapshot writer that writes the real per-run workspace, then parks
 * inside the awaited window so cancel/logout/shutdown can win deterministically.
 */
function gatedWrite(): {
  writeSnapshot: (records: WorkoutRecord[]) => Promise<SnapshotDir>;
  started: Promise<void>;
  release: () => void;
  dir: () => string;
} {
  let dir = "";
  let signalStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    writeSnapshot: async (records) => {
      const written = await writeSnapshotDir(records);
      dir = written.dir;
      signalStarted();
      await gate;
      return written;
    },
    started,
    release,
    dir: () => dir,
  };
}

function idleRuntimeFactory(starts: RuntimeLaunchOptions[]): RuntimeFactory {
  return (options) => {
    starts.push(options);
    return { start(): void {}, cancel(): void {}, async close(): Promise<void> {} };
  };
}

test("logout during the snapshot write never starts an orphan runtime and cleans the new dir", async () => {
  const starts: RuntimeLaunchOptions[] = [];
  const stores = await seedWorkouts();
  const gated = gatedWrite();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: idleRuntimeFactory(starts),
    writeSnapshot: gated.writeSnapshot,
    cancelGraceMs: 50,
  });
  try {
    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const submitted = service.submitRun(PRINCIPAL, {
      sessionId: session.id,
      prompt: "analyze",
      idempotencyKey: "race-logout",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    });
    await gated.started;
    // Logout wins the awaited workspace window: the reservation is removed.
    await service.logoutAccount(PRINCIPAL);
    assert.equal(service.activeRunCount(), 0);
    gated.release();
    await assert.rejects(submitted, /cancelled before it started/i);
    assert.equal(starts.length, 0, "no runtime may be constructed/started after the run was removed");
    assert.ok(gated.dir() !== "");
    assert.equal(await exists(gated.dir()), false, "the fresh run workspace must be cleaned up");
  } finally {
    gated.release();
    await service.shutdown();
  }
});

test("shutdown during the snapshot write reports cancelled without an orphan runtime", async () => {
  const starts: RuntimeLaunchOptions[] = [];
  const stores = await seedWorkouts();
  const gated = gatedWrite();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: idleRuntimeFactory(starts),
    writeSnapshot: gated.writeSnapshot,
    cancelGraceMs: 50,
  });
  try {
    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const submitted = service.submitRun(PRINCIPAL, {
      sessionId: session.id,
      prompt: "analyze",
      idempotencyKey: "race-shutdown",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    });
    await gated.started;
    await service.shutdown();
    assert.equal(service.activeRunCount(), 0);
    gated.release();
    const result = await submitted;
    assert.equal(result.run.status, "cancelled");
    assert.equal(starts.length, 0, "no runtime may be constructed/started for a cancelled reservation");
    assert.ok(gated.dir() !== "");
    assert.equal(await exists(gated.dir()), false, "the fresh run workspace must be cleaned up");
  } finally {
    gated.release();
    await service.shutdown().catch(() => undefined);
  }
});

test("a pending snapshot-write failure after logout does not erase a newer run's idempotency record", async () => {
  const stores = await seedWorkouts();
  const control: { failFirst?: (error: Error) => void } = {};
  let calls = 0;
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: idleRuntimeFactory([]),
    writeSnapshot: (records) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<SnapshotDir>((_resolve, reject) => {
          control.failFirst = reject;
        });
      }
      return writeSnapshotDir(records);
    },
    cancelGraceMs: 50,
  });
  try {
    const session = service.createSession(PRINCIPAL, "sess-race");
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const input = {
      sessionId: session.id,
      prompt: "analyze",
      idempotencyKey: "shared-key",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    };
    const first = service.submitRun(PRINCIPAL, input);
    const firstRejected = assert.rejects(first, /workspace is temporarily unavailable/i);
    await service.logoutAccount(PRINCIPAL);
    // Same user returns and reuses the same session id + idempotency key.
    service.createSession(PRINCIPAL, "sess-race");
    const snapshot2 = await service.createSnapshot(PRINCIPAL);
    const secondInput = {
      ...input,
      snapshot: { snapshotId: snapshot2.snapshotId, source: snapshot2.source, accountId: snapshot2.accountId },
    };
    const second = await service.submitRun(PRINCIPAL, secondInput);
    const failFirst = control.failFirst;
    assert.ok(failFirst !== undefined);
    failFirst(new Error("workspace write failed"));
    await firstRejected;
    const replay = await service.submitRun(PRINCIPAL, secondInput);
    assert.equal(replay.replayed, true, "the newer run's idempotency record must survive the stale failure");
    assert.equal(replay.run.id, second.run.id);
  } finally {
    await service.shutdown();
  }
});

test("direct cancelRun during the gated snapshot write never starts an orphan runtime", async () => {
  const starts: RuntimeLaunchOptions[] = [];
  const stores = await seedWorkouts();
  const gated = gatedWrite();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: idleRuntimeFactory(starts),
    writeSnapshot: gated.writeSnapshot,
    cancelGraceMs: 50,
  });
  try {
    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const input = {
      sessionId: session.id,
      prompt: "analyze",
      idempotencyKey: "race-cancel",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    };
    const submitted = service.submitRun(PRINCIPAL, input);
    await gated.started;
    // The reservation is published synchronously BEFORE the gated write, so an
    // identical idempotency-key submit replays the SAME reserved queued run.
    // This discovers the run id through the production service — no internal
    // map is exposed and no path is bypassed.
    const duplicate = await service.submitRun(PRINCIPAL, input);
    assert.equal(duplicate.replayed, true, "the reserved run must be replayable mid-submit");
    assert.equal(duplicate.run.status, "queued");
    const runId = duplicate.run.id;
    // No runtime handle exists yet: the confirmed cancel is terminal and
    // releases the reservation's held capacity immediately.
    const cancelled = service.cancelRun(PRINCIPAL, runId, "user cancel");
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(service.activeRunCount(), 0, "a confirmed cancel releases the reservation's capacity");
    gated.release();
    const result = await submitted;
    assert.equal(result.run.id, runId);
    assert.equal(result.run.status, "cancelled", "the submit must report the real cancelled run");
    assert.equal(starts.length, 0, "no runtime may be constructed/started after a direct cancelRun");
    assert.ok(gated.dir() !== "");
    assert.equal(await exists(gated.dir()), false, "the fresh run workspace must be cleaned up");
  } finally {
    gated.release();
    await service.shutdown();
  }
});

test("a cancelled reservation retains its idempotency mapping for identical retries until retention", async () => {
  const starts: RuntimeLaunchOptions[] = [];
  const stores = await seedWorkouts();
  const gated = gatedWrite();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: idleRuntimeFactory(starts),
    writeSnapshot: gated.writeSnapshot,
    retentionMs: 200,
    cancelGraceMs: 50,
  });
  try {
    const session = service.createSession(PRINCIPAL, "sess-cancel-idem");
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const input = {
      sessionId: session.id,
      prompt: "analyze",
      idempotencyKey: "cancel-idem-key",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    };
    const submitted = service.submitRun(PRINCIPAL, input);
    await gated.started;
    const runId = (await service.submitRun(PRINCIPAL, input)).run.id;
    service.cancelRun(PRINCIPAL, runId, "user cancel");
    gated.release();
    const first = await submitted;
    assert.equal(first.run.id, runId);
    assert.equal(first.run.status, "cancelled");

    // Identical retry while the cancelled run is retained: the SAME cancelled
    // run is replayed and no second run is ever launched under the key.
    const replay = await service.submitRun(PRINCIPAL, input);
    assert.equal(replay.replayed, true, "the cancelled run's idempotency mapping must be retained");
    assert.equal(replay.run.id, runId);
    assert.equal(replay.run.status, "cancelled");
    assert.equal(service.runCount(), 1, "an identical retry must not create a second run");
    assert.equal(starts.length, 0, "an identical retry must never launch another run");

    // Retention drops the run (and its mapping with it): the key no longer
    // resolves to the removed reservation.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(service.submitRun(PRINCIPAL, input), /not found/i);
  } finally {
    gated.release();
    await service.shutdown();
  }
});

// --- retained-run replay after snapshot expiry (review finding 4266413460) ---

const PRINCIPAL_B = { id: "user-b", email: "b@example.com" };

/** Assert a service error code without depending on message text. */
function hasCode(code: ServiceErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof CoachingServiceError && error.code === code;
}

/**
 * The snapshot store keeps source records only for `snapshotTtlMs`; a run is
 * retained for `retentionMs`. A same-key retry that arrives between the two
 * lifetimes must replay the stored run, so submission resolves the caller's
 * idempotency record BEFORE it demands a live snapshot.
 */
async function setupExpiredSnapshotReplay(options?: { retentionMs?: number }): Promise<{
  service: CoachingService;
  starts: RuntimeLaunchOptions[];
  sessionId: string;
  input: {
    sessionId: string;
    prompt: string;
    idempotencyKey: string;
    snapshot: { snapshotId: string; source: string; accountId: string };
  };
  firstRunId: string;
}> {
  const starts: RuntimeLaunchOptions[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: idleRuntimeFactory(starts),
    snapshotTtlMs: 100,
    retentionMs: options?.retentionMs ?? 60_000,
    cancelGraceMs: 50,
  });
  const session = service.createSession(PRINCIPAL, "sess-replay");
  const snapshot = await service.createSnapshot(PRINCIPAL);
  const input = {
    sessionId: session.id,
    prompt: "analyze my training",
    idempotencyKey: "replay-key",
    snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
  };
  const first = await service.submitRun(PRINCIPAL, input);
  assert.equal(first.created, true);
  assert.equal(starts.length, 1);
  // Let the snapshot TTL lapse while the run stays retained (active run: its
  // retention clock has not started, and its idempotency mapping is retained).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { service, starts, sessionId: session.id, input, firstRunId: first.run.id };
}

test("an identical retry replays the retained run after its snapshot expires", async () => {
  const { service, starts, input, firstRunId } = await setupExpiredSnapshotReplay();
  try {
    // The expired handle itself no longer resolves: a different key cannot
    // start a new run from it (no fake resurrection of removed records).
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, idempotencyKey: "other-key" }),
      hasCode("SNAPSHOT_NOT_FOUND"),
    );
    assert.equal(starts.length, 1);

    // The identical retry replays the SAME run without launching a runtime.
    const replay = await service.submitRun(PRINCIPAL, input);
    assert.equal(replay.replayed, true, "a retained run must replay after snapshot expiry");
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, firstRunId);
    assert.equal(replay.run.status, "queued");
    assert.equal(starts.length, 1, "replay must never launch another runtime");
    assert.equal(service.runCount(), 1, "replay must never create a second run");
  } finally {
    await service.shutdown();
  }
});

test("after snapshot expiry, changed content/source conflicts against the stored run", async () => {
  const { service, starts, input, firstRunId } = await setupExpiredSnapshotReplay();
  try {
    // Prompt change under the same key: the stored canonical content wins.
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, prompt: "different question" }),
      hasCode("IDEMPOTENCY_CONFLICT"),
    );
    // Backend/runtime change is still refused in depth under the same key.
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, runtimeId: "codex" }),
      hasCode("IDEMPOTENCY_CONFLICT"),
    );
    // Source change on the SAME snapshot handle keeps the live-path FORBIDDEN.
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, snapshot: { ...input.snapshot, source: "other-source" } }),
      hasCode("FORBIDDEN"),
    );
    // A different (even newly live) snapshot handle is a different request
    // under the key: no blind substitution of the stored snapshot.
    const live = await service.createSnapshot(PRINCIPAL);
    await assert.rejects(
      service.submitRun(PRINCIPAL, {
        ...input,
        snapshot: { snapshotId: live.snapshotId, source: live.source, accountId: live.accountId },
      }),
      hasCode("IDEMPOTENCY_CONFLICT"),
    );
    // Foreign account principal on the reference is always FORBIDDEN.
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, snapshot: { ...input.snapshot, accountId: PRINCIPAL_B.id } }),
      hasCode("FORBIDDEN"),
    );
    // Nothing above created a run or launched a runtime; the original still replays.
    assert.equal(starts.length, 1);
    assert.equal(service.runCount(), 1);
    const replay = await service.submitRun(PRINCIPAL, input);
    assert.equal(replay.run.id, firstRunId);
    assert.equal(replay.replayed, true);
  } finally {
    await service.shutdown();
  }
});

test("another account cannot replay a retained run after its snapshot expires", async () => {
  const { service, starts, input, firstRunId } = await setupExpiredSnapshotReplay();
  try {
    const foreignSession = service.createSession(PRINCIPAL_B, "sess-foreign");
    // Same session id is not the foreign account's: not found, never replayed.
    await assert.rejects(
      service.submitRun(PRINCIPAL_B, { ...input, sessionId: input.sessionId }),
      hasCode("SESSION_NOT_FOUND"),
    );
    // Foreign session + the other account's snapshot handle: FORBIDDEN.
    await assert.rejects(
      service.submitRun(PRINCIPAL_B, { ...input, sessionId: foreignSession.id }),
      hasCode("FORBIDDEN"),
    );
    // Re-labelling the handle as the foreign account does not resolve it.
    await assert.rejects(
      service.submitRun(PRINCIPAL_B, {
        ...input,
        sessionId: foreignSession.id,
        snapshot: { ...input.snapshot, accountId: PRINCIPAL_B.id },
      }),
      hasCode("SNAPSHOT_NOT_FOUND"),
    );
    // A different owned session under the same key is a fresh key scope.
    const otherSession = service.createSession(PRINCIPAL, "sess-replay-2");
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, sessionId: otherSession.id }),
      hasCode("SNAPSHOT_NOT_FOUND"),
    );
    assert.equal(starts.length, 1);
    // Only the original account on the original session replays.
    const replay = await service.submitRun(PRINCIPAL, input);
    assert.equal(replay.run.id, firstRunId);
    assert.equal(replay.replayed, true);
  } finally {
    await service.shutdown();
  }
});

test("a run removed by retention plus an expired snapshot cannot launch a new run", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        for (const payload of contentEvents()) options.onEvent(payload);
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    snapshotTtlMs: 100,
    retentionMs: 100,
    cancelGraceMs: 50,
  });
  try {
    const session = service.createSession(PRINCIPAL, "sess-retained");
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const input = {
      sessionId: session.id,
      prompt: "analyze my training",
      idempotencyKey: "retained-key",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    };
    const first = await service.submitRun(PRINCIPAL, input);
    assert.equal(first.run.status, "completed");
    const launches = captured.length;
    // Past both lifetimes: the run and its session are gone, the snapshot too.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(service.runCount(), 0);
    await assert.rejects(service.submitRun(PRINCIPAL, input), hasCode("SESSION_NOT_FOUND"));
    // A renewed session cannot revive the expired handle either.
    const renewed = service.createSession(PRINCIPAL, "sess-retained");
    await assert.rejects(
      service.submitRun(PRINCIPAL, { ...input, sessionId: renewed.id }),
      hasCode("SNAPSHOT_NOT_FOUND"),
    );
    assert.equal(captured.length, launches, "no runtime may launch for a removed run or expired handle");
  } finally {
    await service.shutdown();
  }
});

/** Wait for a run to reach a terminal status (bounded). */
async function waitForTerminal(service: CoachingService, runId: string): Promise<"completed" | "failed" | "cancelled"> {
  const start = Date.now();
  for (;;) {
    const status = service.readRun(PRINCIPAL, runId).run.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return status;
    assert.ok(Date.now() - start < 5000, `run did not settle (still ${status})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function totalFrameBytes(service: CoachingService, runId: string): number {
  return service
    .readEvents(PRINCIPAL, runId)
    .events.reduce((sum, envelope) => sum + coachingEventFrameBytes(envelope), 0);
}

test("a configured maxEventBytesPerRun above the shared content budget is clamped", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  // ~4.8 MB of content: above the shared content budget (~4.19 MB) but each
  // frame stays under the 1 MiB frame cap.
  const chunk = "x".repeat(800_000);
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        for (let index = 0; index < 6; index += 1) {
          options.onEvent({ type: "text_delta", delta: `${index}-${chunk}` });
        }
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
    }),
    // Deliberately far ABOVE the shared content budget: it must be clamped so
    // an accepted run can never exceed what the browser client will read.
    maxEventBytesPerRun: MAX_COACHING_SSE_TOTAL_BYTES * 3,
    cancelGraceMs: 30,
  });
  try {
    const { runId } = await setupService(service);
    assert.equal(await waitForTerminal(service, runId), "failed");
    const page = service.readEvents(PRINCIPAL, runId);
    // Content + cap-seal + terminal always fit the shared total budget.
    assert.ok(
      totalFrameBytes(service, runId) <= MAX_COACHING_SSE_TOTAL_BYTES,
      "clamped content + seal + terminal must fit the shared total budget",
    );
    assert.ok(
      page.events.some((envelope) =>
        envelope.event.type === "run_error" && (envelope.event as { code: string }).code === "EVENT_CAP"
      ),
      "the clamp must still seal explicitly",
    );
    assert.equal(page.events.filter((envelope) => envelope.event.type === "terminal").length, 1);
    // Without the clamp all 6 chunks would be stored; the clamp stops content.
    assert.ok(page.events.length < 8, "content must be clamped, not all six chunks retained");
  } finally {
    await service.shutdown();
  }
});

test("caller/runtime terminal reasons are bounded so the terminal frame fits the reserve", async () => {
  // Runtime-supplied reason (onDone): ASCII, far above the reserve.
  {
    const captured: Captured[] = [];
    const stores = await seedWorkouts();
    const service = createCoachingService({
      source: storeFactorySource(stores),
      runtimeFactory: captureFactory(captured, {
        onStart: (options) => {
          options.onEvent({ type: "analysis_result", result: analyzeProgress([]) });
          options.onDone("failed", "Z".repeat(200_000), { processExitConfirmed: true });
        },
      }),
      cancelGraceMs: 30,
    });
    try {
      const { runId } = await setupService(service);
      const page = service.readEvents(PRINCIPAL, runId);
      const terminal = page.events.find((envelope) => envelope.event.type === "terminal");
      assert.ok(terminal, "a terminal must be emitted");
      const reason = (terminal.event as { reason?: string }).reason ?? "";
      assert.ok(reason.includes(COACHING_TRUNCATION_MARKER), "a shortened reason must say so");
      assert.ok(utf8ByteLength(reason) > 1000, "a meaningful prefix must survive");
      assert.ok(coachingEventFrameBytes(terminal) <= COACHING_SSE_RESERVED_FRAME_BYTES);
      assert.ok(totalFrameBytes(service, runId) <= MAX_COACHING_SSE_TOTAL_BYTES);
    } finally {
      await service.shutdown();
    }
  }
  // Caller-supplied cancel reason: multibyte, truncated WITHOUT splitting a codepoint.
  {
    const captured: Captured[] = [];
    const stores = await seedWorkouts();
    const service = createCoachingService({
      source: storeFactorySource(stores),
      runtimeFactory: captureFactory(captured, {}),
      cancelGraceMs: 30,
    });
    try {
      const { runId } = await setupService(service);
      service.cancelRun(PRINCIPAL, runId, "é".repeat(100_000));
      assert.equal(await waitForTerminal(service, runId), "cancelled");
      const page = service.readEvents(PRINCIPAL, runId);
      const terminal = page.events.find((envelope) => envelope.event.type === "terminal");
      assert.ok(terminal);
      const reason = (terminal.event as { reason?: string }).reason ?? "";
      assert.ok(reason.includes(COACHING_TRUNCATION_MARKER), "a shortened reason must say so");
      assert.ok(!reason.includes("\uFFFD"), "truncation must not split a multibyte codepoint");
      assert.ok(coachingEventFrameBytes(terminal) <= COACHING_SSE_RESERVED_FRAME_BYTES);
      assert.ok(totalFrameBytes(service, runId) <= MAX_COACHING_SSE_TOTAL_BYTES);
    } finally {
      await service.shutdown();
    }
  }
});

test("session ids are bounded so every frame (including the terminal) fits the wire budget", async () => {
  const captured: Captured[] = [];
  const stores = createPrincipalMemoryStores();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {}),
    cancelGraceMs: 30,
  });
  try {
    const atBound = service.createSession(PRINCIPAL, "é".repeat(MAX_COACHING_SESSION_ID_LENGTH));
    assert.equal(atBound.id.length, MAX_COACHING_SESSION_ID_LENGTH);
    assert.throws(
      () => service.createSession(PRINCIPAL, "s".repeat(MAX_COACHING_SESSION_ID_LENGTH + 1)),
      /at most/,
    );
  } finally {
    await service.shutdown();
  }
});

test("a control-character session id + terminal reason stay inside the reserved frame budget (JSON escapes counted)", async () => {
  const captured: Captured[] = [];
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory(captured, {
      onStart: (options) => {
        options.onEvent({ type: "text_delta", delta: "ok" });
        // 4000 NULs: 4000 raw bytes but ~24 KB once JSON-escaped.
        options.onDone("failed", "\u0000".repeat(4000), { processExitConfirmed: true });
      },
    }),
    cancelGraceMs: 30,
  });
  try {
    const session = service.createSession(PRINCIPAL, "\u0000".repeat(MAX_COACHING_SESSION_ID_LENGTH));
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const submitted = await service.submitRun(PRINCIPAL, {
      sessionId: session.id,
      prompt: "analyze my training",
      idempotencyKey: "key-control",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
    });
    assert.equal(await waitForTerminal(service, submitted.run.id), "failed");
    const page = service.readEvents(PRINCIPAL, submitted.run.id);
    const terminal = page.events.find((envelope) => envelope.event.type === "terminal");
    assert.ok(terminal, "a terminal must be emitted");
    assert.ok(
      coachingEventFrameBytes(terminal) <= COACHING_SSE_RESERVED_FRAME_BYTES,
      "the escaped session id + escaped reason must still fit the reserved frame budget",
    );
    const reason = (terminal.event as { reason?: string }).reason ?? "";
    assert.ok(reason.includes(COACHING_TRUNCATION_MARKER));
    assert.ok(reason.startsWith("\u0000"), "a diagnostic prefix must survive");
    assert.ok(totalFrameBytes(service, submitted.run.id) <= MAX_COACHING_SSE_TOTAL_BYTES);
  } finally {
    await service.shutdown();
  }
});

test("nonfinite/negative byte-budget options normalize to a safe finite bound", () => {
  // NaN defeats Math.min (Math.min(NaN, x) === NaN), which would leave the byte
  // cap permanently untripped; every invalid value normalizes to the shared
  // content budget instead. Behavioral clamp coverage shares the clamp test.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    const normalized = normalizeMaxEventBytesPerRun(bad);
    assert.ok(Number.isFinite(normalized), `${String(bad)} must normalize to a finite bound`);
    assert.equal(normalized, DEFAULT_MAX_EVENT_BYTES_PER_RUN);
  }
  assert.equal(normalizeMaxEventBytesPerRun(undefined), DEFAULT_MAX_EVENT_BYTES_PER_RUN);
  assert.equal(normalizeMaxEventBytesPerRun(4096), 4096);
  assert.equal(
    normalizeMaxEventBytesPerRun(MAX_COACHING_SSE_TOTAL_BYTES * 3),
    DEFAULT_MAX_EVENT_BYTES_PER_RUN,
    "an over-budget value is clamped, never raised",
  );
});

test("the per-run byte cap is exact and counted in UTF-8 full-frame bytes (boundary + nonASCII)", async () => {
  const CAP = 4096;
  // ASCII: a frame EXACTLY at the cap is accepted; the next event seals.
  {
    const captured: Captured[] = [];
    const stores = await seedWorkouts();
    const service = createCoachingService({
      source: storeFactorySource(stores),
      runtimeFactory: captureFactory(captured, {
        onStart: (options) => {
          const build = (delta: string): CoachingEventEnvelope => ({
            protocolVersion: COACHING_PROTOCOL_VERSION,
            sessionId: options.sessionId,
            runId: options.runId,
            seq: 0,
            event: { type: "text_delta", delta },
          });
          const overhead = coachingEventFrameBytes(build(""));
          const delta = "x".repeat(CAP - overhead);
          assert.equal(coachingEventFrameBytes(build(delta)), CAP, "probe frame must be exactly at the cap");
          options.onEvent({ type: "text_delta", delta });
          options.onEvent({ type: "text_delta", delta: "overflow" });
          options.onDone("completed", undefined, { processExitConfirmed: true });
        },
      }),
      maxEventBytesPerRun: CAP,
      cancelGraceMs: 30,
    });
    try {
      const { runId } = await setupService(service);
      assert.equal(await waitForTerminal(service, runId), "failed");
      const page = service.readEvents(PRINCIPAL, runId);
      // Exactly-at-cap delta + seal run_error + terminal.
      assert.equal(page.events.length, 3);
      assert.equal(coachingEventFrameBytes(page.events[0] as CoachingEventEnvelope), CAP);
      assert.equal(page.events.filter((envelope) => envelope.event.type === "terminal").length, 1);
    } finally {
      await service.shutdown();
    }
  }
  // nonASCII: a near-cap multibyte frame is accepted; overflow seals. Bytes,
  // not characters, decide the boundary.
  {
    const captured: Captured[] = [];
    const stores = await seedWorkouts();
    const service = createCoachingService({
      source: storeFactorySource(stores),
      runtimeFactory: captureFactory(captured, {
        onStart: (options) => {
          const build = (delta: string): CoachingEventEnvelope => ({
            protocolVersion: COACHING_PROTOCOL_VERSION,
            sessionId: options.sessionId,
            runId: options.runId,
            seq: 0,
            event: { type: "text_delta", delta },
          });
          const overhead = coachingEventFrameBytes(build(""));
          const count = Math.floor((CAP - overhead) / 2);
          const delta = "é".repeat(count);
          const frame = coachingEventFrameBytes(build(delta));
          assert.ok(frame <= CAP && CAP - frame < 2, "multibyte probe must sit within one byte of the cap");
          options.onEvent({ type: "text_delta", delta });
          options.onEvent({ type: "text_delta", delta: "é" });
          options.onDone("completed", undefined, { processExitConfirmed: true });
        },
      }),
      maxEventBytesPerRun: CAP,
      cancelGraceMs: 30,
    });
    try {
      const { runId } = await setupService(service);
      assert.equal(await waitForTerminal(service, runId), "failed");
      const page = service.readEvents(PRINCIPAL, runId);
      const deltas = page.events.filter((envelope) => envelope.event.type === "text_delta");
      assert.equal(deltas.length, 1, "the near-cap multibyte frame is accepted and the overflow is not stored");
      assert.ok(page.events.some((envelope) => envelope.event.type === "run_error"));
      assert.equal(page.events.filter((envelope) => envelope.event.type === "terminal").length, 1);
    } finally {
      await service.shutdown();
    }
  }
});

test("runtime registry routes the selected backend and pins backendId in the run", async () => {
  const calls: string[] = [];
  const stores = await seedWorkouts();
  const factoryFor = (label: string): RuntimeFactory => (options) => {
    calls.push(label);
    return {
      start(): void {
        for (const payload of contentEvents()) options.onEvent(payload);
        options.onEvent({ type: "terminal", status: "completed" });
        options.onDone("completed", undefined, { processExitConfirmed: true });
      },
      cancel(): void {},
      async close(): Promise<void> {},
    };
  };
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeRegistry: createCoachingRuntimeRegistry([
      {
        backendId: "local-pi",
        runtimeId: "pi",
        executionLocation: "local",
        displayName: "pi CLI (local)",
        available: true,
        factory: factoryFor("pi"),
      },
      {
        backendId: "local-codex",
        runtimeId: "codex",
        executionLocation: "local",
        displayName: "Codex CLI (local)",
        available: true,
        factory: factoryFor("codex"),
      },
    ]),
    cancelGraceMs: 30,
  });
  try {
    const legacy = await setupService(service, undefined, "legacy-key");
    assert.equal(legacy.runId.length > 0, true);
    const legacyRun = service.readRun(PRINCIPAL, legacy.runId);
    assert.equal(legacyRun.run.backendId, "local-pi");
    assert.equal(legacyRun.run.runtimeId, "pi");

    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const codex = await service.submitRun(PRINCIPAL, {
      sessionId: session.id,
      prompt: "analyze with codex",
      idempotencyKey: "codex-key",
      snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
      backendId: "local-codex",
      runtimeId: "codex",
    });
    assert.equal(codex.run.backendId, "local-codex");
    assert.equal(codex.run.runtimeId, "codex");
    assert.deepEqual(calls, ["pi", "codex"]);
  } finally {
    await service.shutdown();
  }
});

test("native continuation handles are partitioned by backend/runtime/version", async () => {
  const launches: RuntimeLaunchOptions[] = [];
  const factoryFor = (label: "pi" | "codex"): RuntimeFactory => (options) => {
    launches.push(options);
    return {
      start(): void {
        options.onEvent({ type: "terminal", status: "completed" });
        options.onDone("completed", undefined, {
          processExitConfirmed: true,
          ...(label === "pi"
            ? { sessionFile: `${options.sessionDir}/pi-session.json` }
            : { nativeSessionHandle: "thr_codex_native_1" }),
        });
      },
      cancel(): void {},
      async close(): Promise<void> {},
    };
  };
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeRegistry: createCoachingRuntimeRegistry([
      {
        backendId: "local-pi",
        runtimeId: "pi",
        executionLocation: "local",
        displayName: "pi CLI (local)",
        available: true,
        factory: factoryFor("pi"),
      },
      {
        backendId: "local-codex",
        runtimeId: "codex",
        executionLocation: "local",
        displayName: "Codex CLI (local)",
        available: true,
        factory: factoryFor("codex"),
      },
    ]),
    cancelGraceMs: 30,
  });
  try {
    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const ref = { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId };
    const submit = async (backendId: "local-pi" | "local-codex", runtimeId: "pi" | "codex", key: string) => {
      const result = await service.submitRun(PRINCIPAL, {
        sessionId: session.id,
        prompt: "partitioned resume",
        idempotencyKey: key,
        snapshot: ref,
        backendId,
        runtimeId,
      });
      await waitForTerminal(service, result.run.id);
    };

    await submit("local-pi", "pi", "partition-pi-1");
    await submit("local-codex", "codex", "partition-codex-1");
    // Switching back to pi must not receive the codex thread id, and pi's old
    // file was replaced by the codex owner.
    await submit("local-pi", "pi", "partition-pi-2");
    await submit("local-pi", "pi", "partition-pi-3");

    assert.equal(launches.length, 4);
    assert.equal(launches[0]?.resumeSessionFile, undefined);
    assert.equal(launches[0]?.resumeNativeSessionHandle, undefined);
    assert.equal(launches[1]?.resumeSessionFile, undefined);
    assert.equal(launches[1]?.resumeNativeSessionHandle, undefined);
    assert.equal(launches[2]?.resumeSessionFile, undefined);
    assert.equal(launches[2]?.resumeNativeSessionHandle, undefined);
    // Only the immediately preceding same-backend/same-version handle resumes.
    assert.match(launches[3]?.resumeSessionFile ?? "", /pi-session\.json$/);
    assert.equal(launches[3]?.resumeNativeSessionHandle, undefined);
  } finally {
    await service.shutdown();
  }
});

test("an explicit unavailable local-pi registry entry beats the legacy factory", async () => {
  const stores = await seedWorkouts();
  let legacyCalls = 0;
  const legacyFactory: RuntimeFactory = () => {
    legacyCalls += 1;
    return { start(): void {}, cancel(): void {}, async close(): Promise<void> {} };
  };
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: legacyFactory,
    runtimeRegistry: createCoachingRuntimeRegistry([
      {
        backendId: "local-pi",
        runtimeId: "pi",
        executionLocation: "local",
        displayName: "pi CLI (local)",
        available: false,
        unavailableReason: { code: "cli-not-installed", message: "pi CLI is not available on PATH." },
      },
    ]),
    cancelGraceMs: 30,
  });
  try {
    const discovery = service.discoverBackends(PRINCIPAL);
    const pi = discovery.backends.find((entry) => entry.backendId === "local-pi");
    assert.equal(pi?.available, false);
    assert.equal(pi?.unavailableReason?.code, "cli-not-installed");
    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    await assert.rejects(
      service.submitRun(PRINCIPAL, {
        sessionId: session.id,
        prompt: "must not fall back",
        idempotencyKey: "unavailable-legacy",
        snapshot: { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId },
      }),
      /pi CLI is not available/,
    );
    assert.equal(legacyCalls, 0);
  } finally {
    await service.shutdown();
  }
});

test("runtime selection rejects mismatches/unavailable backends and backend changes conflict under one key", async () => {
  const stores = await seedWorkouts();
  const factory: RuntimeFactory = (options) => ({
    start(): void {
      for (const payload of contentEvents()) options.onEvent(payload);
      options.onEvent({ type: "terminal", status: "completed" });
      options.onDone("completed", undefined, { processExitConfirmed: true });
    },
    cancel(): void {},
    async close(): Promise<void> {},
  });
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeRegistry: createCoachingRuntimeRegistry([
      {
        backendId: "local-pi",
        runtimeId: "pi",
        executionLocation: "local",
        displayName: "pi CLI (local)",
        available: true,
        factory,
      },
      {
        backendId: "local-codex",
        runtimeId: "codex",
        executionLocation: "local",
        displayName: "Codex CLI (local)",
        available: false,
        unavailableReason: { code: "cli-not-installed", message: "Codex CLI is not installed." },
      },
    ]),
    cancelGraceMs: 30,
  });
  try {
    const session = service.createSession(PRINCIPAL);
    const snapshot = await service.createSnapshot(PRINCIPAL);
    const ref = { snapshotId: snapshot.snapshotId, source: snapshot.source, accountId: snapshot.accountId };

    await assert.rejects(
      service.submitRun(PRINCIPAL, {
        sessionId: session.id,
        prompt: "mismatch",
        idempotencyKey: "mismatch-key",
        snapshot: ref,
        backendId: "local-codex",
        runtimeId: "pi",
      }),
      /backend\/runtime selection/,
    );
    await assert.rejects(
      service.submitRun(PRINCIPAL, {
        sessionId: session.id,
        prompt: "unavailable",
        idempotencyKey: "unavailable-key",
        snapshot: ref,
        backendId: "local-codex",
        runtimeId: "codex",
      }),
      /Codex CLI is not installed/,
    );

    const first = await service.submitRun(PRINCIPAL, {
      sessionId: session.id,
      prompt: "same prompt",
      idempotencyKey: "shared-key",
      snapshot: ref,
    });
    const replay = await service.submitRun(PRINCIPAL, {
      sessionId: session.id,
      prompt: "same prompt",
      idempotencyKey: "shared-key",
      snapshot: ref,
    });
    assert.equal(first.run.id, replay.run.id);
    assert.equal(replay.replayed, true);
    // Same key, different backend is a conflict, never a silent reroute.
    await assert.rejects(
      service.submitRun(PRINCIPAL, {
        sessionId: session.id,
        prompt: "same prompt",
        idempotencyKey: "shared-key",
        snapshot: ref,
        backendId: "local-codex",
        runtimeId: "codex",
      }),
      (error: unknown) => error instanceof CoachingServiceError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await service.shutdown();
  }
});

test("discovery marks planned CLIs unavailable and fails cloud closed without trusted identity", async () => {
  const stores = await seedWorkouts();
  const service = createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory: captureFactory([]),
    trustedIdentity: () => null,
    cloudQuota: { configured: true, remaining: 10 },
    cloudProviderConfigured: true,
  });
  try {
    const discovery = service.discoverBackends(PRINCIPAL);
    const byId = new Map(discovery.backends.map((entry) => [entry.backendId, entry]));
    assert.equal(byId.get("local-pi")?.available, true);
    assert.equal(byId.get("local-codex")?.available, false);
    assert.equal(byId.get("local-codex")?.unavailableReason?.code, "adapter-not-implemented");
    assert.equal(byId.get("local-opencode")?.available, false);
    assert.equal(byId.get("cloud-default")?.available, false);
    assert.equal(byId.get("cloud-default")?.unavailableReason?.code, "identity-unverified");
    assert.equal(byId.get("cloud-default")?.capabilities.accountEligibility, "required");
    assert.equal(byId.get("cloud-default")?.capabilities.quotaReservation, "required");
  } finally {
    await service.shutdown();
  }
});
