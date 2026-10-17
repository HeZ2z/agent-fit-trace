/**
 * Focused durable local journal tests (no HTTP).
 *
 * A restart is simulated by constructing a second service over the same
 * journal file. Runtime factories are fakes, so "no second spawn" means the
 * second service never constructs a runtime at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeProgress, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { createPrincipalMemoryStores } from "../server/principalMemoryStore.ts";
import {
  CoachingServiceError,
  createCoachingService,
  storeFactorySource,
} from "../server/coaching/coachingService.ts";
import type {
  CoachingService,
  RuntimeFactory,
  RuntimeLaunchOptions,
} from "../server/coaching/coachingService.ts";
import { createCoachingRuntimeRegistry } from "../server/coaching/runtimeRegistry.ts";
import { CoachingJournalCorruptError } from "../server/coaching/coachingJournal.ts";
import type { CoachingJournalState } from "../server/coaching/coachingJournal.ts";

const PRINCIPAL_A = { id: "journal-user-a", email: "journal-a@example.com" };
const PRINCIPAL_B = { id: "journal-user-b", email: "journal-b@example.com" };

function record(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

async function seedStores(): Promise<ReturnType<typeof createPrincipalMemoryStores>> {
  const stores = createPrincipalMemoryStores();
  await stores.storeFor(PRINCIPAL_A).createWorkout(record({ id: "journal-w1", date: "2026-09-01" }));
  await stores.storeFor(PRINCIPAL_A).createWorkout(record({ id: "journal-w2", date: "2026-09-03" }));
  return stores;
}

function makeJournal(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fit-trace-journal-test-"));
  return { dir, path: join(dir, "coaching-journal.json") };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupCaptures(captures: RuntimeLaunchOptions[]): void {
  for (const launch of captures) {
    for (const dir of [launch.snapshotDir, launch.sessionDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Fake that emits a valid analysis and confirms exit. */
function completingFactory(
  captured: RuntimeLaunchOptions[],
  native: "pi-file" | "codex-handle" = "pi-file",
): RuntimeFactory {
  return (launch) => {
    captured.push(launch);
    return {
      start(): void {
        launch.onEvent({ type: "text_delta", delta: "journal" });
        launch.onEvent({ type: "analysis_result", result: analyzeProgress([]) });
        launch.onDone("completed", undefined, {
          processExitConfirmed: true,
          ...(native === "pi-file"
            ? { sessionFile: `${launch.sessionDir}/pi-session.json` }
            : { nativeSessionHandle: "thr_codex_journal_1" }),
        });
      },
      cancel(): void {},
      async close(): Promise<void> {},
    };
  };
}

/** Fake that never settles: the run stays active in the journal. */
function idleFactory(captured: RuntimeLaunchOptions[]): RuntimeFactory {
  return (launch) => {
    captured.push(launch);
    return {
      start(): void {},
      cancel(): void {},
      async close(): Promise<void> {},
    };
  };
}

function serviceFor(
  stores: ReturnType<typeof createPrincipalMemoryStores>,
  journalPath: string,
  runtimeFactory: RuntimeFactory,
  overrides: {
    retentionMs?: number;
    snapshotTtlMs?: number;
    runtimeRegistry?: ReturnType<typeof createCoachingRuntimeRegistry>;
  } = {},
): CoachingService {
  return createCoachingService({
    source: storeFactorySource(stores),
    runtimeFactory,
    ...(overrides.runtimeRegistry === undefined ? {} : { runtimeRegistry: overrides.runtimeRegistry }),
    journalPath,
    cancelGraceMs: 30,
    retentionMs: overrides.retentionMs ?? 60_000,
    snapshotTtlMs: overrides.snapshotTtlMs ?? 60_000,
  });
}

function submitInput(
  sessionId: string,
  snapshot: { snapshotId: string; source: string; accountId: string },
  key: string,
  over: Record<string, unknown> = {},
) {
  return {
    sessionId,
    prompt: "analyze my training",
    idempotencyKey: key,
    snapshot,
    ...over,
  };
}

test("terminal run, events, native ownership, and expired-snapshot replay survive restart", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const capturesA: RuntimeLaunchOptions[] = [];
  const capturesB: RuntimeLaunchOptions[] = [];
  let serviceA: CoachingService | null = null;
  let serviceB: CoachingService | null = null;
  try {
    serviceA = serviceFor(stores, path, completingFactory(capturesA), { snapshotTtlMs: 40 });
    const session = serviceA.createSession(PRINCIPAL_A, "journal-sess-a");
    const snapshot = await serviceA.createSnapshot(PRINCIPAL_A);
    const input = submitInput(session.id, snapshot, "journal-key-1");
    const first = await serviceA.submitRun(PRINCIPAL_A, input);
    assert.equal(first.run.status, "completed");
    const before = serviceA.readEvents(PRINCIPAL_A, first.run.id);
    assert.ok(before.events.some((envelope) => envelope.event.type === "analysis_result"));

    // Snapshot TTL lapses while the terminal run stays retained.
    await wait(120);
    await serviceA.shutdown();
    serviceA = null;

    assert.ok(existsSync(path), "shutdown must retain the journal");
    const journalText = readFileSync(path, "utf8");
    const journal = JSON.parse(journalText) as CoachingJournalState & { generation: number };
    assert.ok(journal.generation >= 1);
    assert.equal(journal.runs.length, 1, "shutdown must retain run history");
    assert.equal(journal.sessions.length, 1, "shutdown must retain session history");
    assert.ok(journal.runs[0]?.events.length, "shutdown must retain stored events");
    assert.equal(statSync(path).mode & 0o777, 0o600, "journal file is private");
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700, "journal parent is private");

    serviceB = serviceFor(stores, path, completingFactory(capturesB), { snapshotTtlMs: 40 });
    // Idempotent replay survives restart even though the snapshot handle expired.
    const replay = await serviceB.submitRun(PRINCIPAL_A, input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, first.run.id);
    assert.deepEqual(serviceB.readEvents(PRINCIPAL_A, first.run.id).events, before.events);
    assert.equal(capturesB.length, 0, "replay must not construct a runtime");

    // The persisted native ownership is passed only to the same session.
    const snapshot2 = await serviceB.createSnapshot(PRINCIPAL_A);
    const second = await serviceB.submitRun(PRINCIPAL_A, submitInput(session.id, snapshot2, "journal-key-2"));
    assert.equal(second.run.status, "completed");
    assert.equal(capturesB.length, 1);
    assert.equal(capturesB[0]?.resumeSessionFile, `${capturesA[0]?.sessionDir ?? ""}/pi-session.json`);
  } finally {
    await serviceA?.shutdown().catch(() => undefined);
    await serviceB?.shutdown().catch(() => undefined);
    cleanupCaptures([...capturesA, ...capturesB]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention expiry after restart removes the run/session and refuses a replay", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const capturesA: RuntimeLaunchOptions[] = [];
  const capturesB: RuntimeLaunchOptions[] = [];
  let serviceA: CoachingService | null = null;
  let serviceB: CoachingService | null = null;
  try {
    serviceA = serviceFor(stores, path, completingFactory(capturesA), {
      retentionMs: 100,
      snapshotTtlMs: 100,
    });
    const session = serviceA.createSession(PRINCIPAL_A, "journal-expiry-sess");
    const snapshot = await serviceA.createSnapshot(PRINCIPAL_A);
    const input = submitInput(session.id, snapshot, "journal-expiry-key");
    const first = await serviceA.submitRun(PRINCIPAL_A, input);
    assert.equal(first.run.status, "completed");
    await serviceA.shutdown();
    serviceA = null;

    await wait(300);
    serviceB = serviceFor(stores, path, completingFactory(capturesB), {
      retentionMs: 100,
      snapshotTtlMs: 100,
    });
    assert.equal(serviceB.runCount(), 0, "expired terminal run must not be resurrected");
    assert.throws(() => serviceB?.readRun(PRINCIPAL_A, first.run.id), /not found/i);
    await assert.rejects(serviceB.submitRun(PRINCIPAL_A, input), /session not found/i);
    assert.equal(capturesB.length, 0, "no runtime may launch for an expired history");
  } finally {
    await serviceA?.shutdown().catch(() => undefined);
    await serviceB?.shutdown().catch(() => undefined);
    cleanupCaptures([...capturesA, ...capturesB]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt journal state fails closed without rewriting the file", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const captures: RuntimeLaunchOptions[] = [];
  const service = serviceFor(stores, path, completingFactory(captures));
  const session = service.createSession(PRINCIPAL_A, "journal-corrupt-sess");
  const snapshot = await service.createSnapshot(PRINCIPAL_A);
  const submitted = await service.submitRun(
    PRINCIPAL_A,
    submitInput(session.id, snapshot, "journal-corrupt-key"),
  );
  assert.equal(submitted.run.status, "completed");
  await service.shutdown();

  const baseText = readFileSync(path, "utf8");
  const base = JSON.parse(baseText) as Record<string, unknown> & {
    runs: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    idempotency: Array<Record<string, unknown>>;
  };
  assert.ok(base.runs[0]?.events);
  assert.ok(base.sessions[0]);

  const tampered: Array<{ label: string; value: Record<string, unknown> }> = [];
  {
    const next = structuredClone(base);
    const events = next.runs[0]?.events as Array<Record<string, unknown>>;
    events[0]!.seq = 9;
    tampered.push({ label: "seq must be 0", value: next });
  }
  {
    const next = structuredClone(base);
    next.runs[0]!.accountId = PRINCIPAL_B.id;
    tampered.push({ label: "does not match the embedded snapshot account", value: next });
  }
  {
    const next = structuredClone(base);
    next.runs[0]!.canonical = JSON.stringify({ prompt: "different" });
    tampered.push({ label: "canonical does not match the stored run request", value: next });
  }
  {
    const next = structuredClone(base);
    next.idempotency[0]!.runId = "run-missing";
    tampered.push({ label: "references missing run", value: next });
  }
  {
    const next = structuredClone(base);
    next.sessions[0]!.nativeSessionVersion = "bogus-version";
    tampered.push({ label: "native session version does not match backend", value: next });
  }
  {
    const next = structuredClone(base);
    next.sessions[0]!.nativeSessionDir = "/";
    tampered.push({ label: "must stay under the app-owned scratch root", value: next });
  }
  {
    const next = structuredClone(base);
    next.runs[0]!.snapshotDir = join(tmpdir(), "not-app-owned");
    tampered.push({ label: "is not an app-owned fit-trace-coach- directory", value: next });
  }

  try {
    for (const entry of tampered) {
      const text = `${JSON.stringify(entry.value)}\n`;
      writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
      assert.throws(
        () => serviceFor(stores, path, completingFactory([])),
        (error: unknown) =>
          error instanceof CoachingJournalCorruptError &&
          error.code === "CORRUPT_STORE" &&
          new RegExp(entry.label, "i").test(error.message),
        `tampered ${entry.label} must fail closed`,
      );
      assert.equal(readFileSync(path, "utf8"), text, "a corrupt journal is never silently reset");
    }
    // Still corrupt after repeated attempts: no load side effect repaired it.
    assert.throws(() => serviceFor(stores, path, completingFactory([])), /corrupt/i);
  } finally {
    cleanupCaptures(captures);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another account cannot read, cancel, or replay journal-owned history", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const capturesA: RuntimeLaunchOptions[] = [];
  const capturesB: RuntimeLaunchOptions[] = [];
  let serviceA: CoachingService | null = null;
  let serviceB: CoachingService | null = null;
  try {
    serviceA = serviceFor(stores, path, completingFactory(capturesA));
    const session = serviceA.createSession(PRINCIPAL_A, "journal-owner-sess");
    const snapshot = await serviceA.createSnapshot(PRINCIPAL_A);
    const input = submitInput(session.id, snapshot, "journal-owner-key");
    const first = await serviceA.submitRun(PRINCIPAL_A, input);
    await serviceA.shutdown();
    serviceA = null;

    serviceB = serviceFor(stores, path, completingFactory(capturesB));
    const denied = (error: unknown): boolean =>
      error instanceof CoachingServiceError && error.code === "RUN_NOT_FOUND";
    assert.throws(() => serviceB?.readRun(PRINCIPAL_B, first.run.id), denied);
    assert.throws(() => serviceB?.readEvents(PRINCIPAL_B, first.run.id), denied);
    assert.throws(() => serviceB?.cancelRun(PRINCIPAL_B, first.run.id), denied);
    // The owner's session id is invisible to another account...
    await assert.rejects(
      serviceB.submitRun(PRINCIPAL_B, input),
      (error: unknown) => error instanceof CoachingServiceError && error.code === "SESSION_NOT_FOUND",
    );
    // ...and supplying a fresh session does not make the owner's snapshot valid.
    await assert.rejects(
      serviceB.submitRun(PRINCIPAL_B, { ...input, sessionId: serviceB.createSession(PRINCIPAL_B).id }),
      (error: unknown) => error instanceof CoachingServiceError && error.code === "FORBIDDEN",
    );
    assert.equal(capturesB.length, 0, "denied cross-account access never spawns");

    // The owner still replays the same retained run.
    const replay = await serviceB.submitRun(PRINCIPAL_A, input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, first.run.id);
    assert.equal(capturesB.length, 0);
  } finally {
    await serviceA?.shutdown().catch(() => undefined);
    await serviceB?.shutdown().catch(() => undefined);
    cleanupCaptures([...capturesA, ...capturesB]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logout removes runs, sessions, snapshots, and idempotency from the journal", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const capturesA: RuntimeLaunchOptions[] = [];
  const capturesB: RuntimeLaunchOptions[] = [];
  let serviceA: CoachingService | null = null;
  let serviceB: CoachingService | null = null;
  try {
    serviceA = serviceFor(stores, path, completingFactory(capturesA));
    const session = serviceA.createSession(PRINCIPAL_A, "journal-logout-sess");
    const snapshot = await serviceA.createSnapshot(PRINCIPAL_A);
    const input = submitInput(session.id, snapshot, "journal-logout-key");
    const first = await serviceA.submitRun(PRINCIPAL_A, input);
    assert.equal(first.run.status, "completed");

    await serviceA.logoutAccount(PRINCIPAL_A);
    await serviceA.shutdown();
    serviceA = null;

    const journal = JSON.parse(readFileSync(path, "utf8")) as CoachingJournalState;
    assert.deepEqual(journal.runs, []);
    assert.deepEqual(journal.sessions, []);
    assert.deepEqual(journal.snapshots, []);
    assert.deepEqual(journal.idempotency, []);

    serviceB = serviceFor(stores, path, completingFactory(capturesB));
    assert.equal(serviceB.runCount(), 0, "a logged-out run must not resurrect");
    assert.throws(() => serviceB?.readRun(PRINCIPAL_A, first.run.id), /not found/i);
    await assert.rejects(serviceB.submitRun(PRINCIPAL_A, input), /session not found/i);
    assert.equal(capturesB.length, 0);
  } finally {
    await serviceA?.shutdown().catch(() => undefined);
    await serviceB?.shutdown().catch(() => undefined);
    cleanupCaptures([...capturesA, ...capturesB]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prior active process becomes execution-unconfirmed: capacity held, no spawn, no false cancel", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const capturesA: RuntimeLaunchOptions[] = [];
  const capturesB: RuntimeLaunchOptions[] = [];
  let serviceA: CoachingService | null = null;
  let serviceB: CoachingService | null = null;
  try {
    serviceA = serviceFor(stores, path, idleFactory(capturesA));
    const session = serviceA.createSession(PRINCIPAL_A, "journal-active-sess");
    const snapshot = await serviceA.createSnapshot(PRINCIPAL_A);
    const input = submitInput(session.id, snapshot, "journal-active-key");
    const first = await serviceA.submitRun(PRINCIPAL_A, input);
    assert.equal(first.run.status, "queued");

    // Abrupt restart: no shutdown, so the journal still says the run is active.
    serviceB = serviceFor(stores, path, completingFactory(capturesB));
    assert.equal(serviceB.activeRunCount(), 1, "an unknown prior child keeps global capacity");
    const restored = serviceB.readRun(PRINCIPAL_A, first.run.id);
    assert.equal(restored.run.status, "failed");
    assert.match(restored.run.failure?.message ?? "", /unconfirmed|unknown/i);

    // Cancel cannot confirm a process it does not own: it stays failed and
    // capacity remains held. No pid is persisted, so nothing is killed.
    const cancelled = serviceB.cancelRun(PRINCIPAL_A, first.run.id, "user cancel");
    assert.equal(cancelled.run.status, "failed");
    assert.equal(serviceB.activeRunCount(), 1);

    // Identical retry replays the unconfirmed run; a new run is refused.
    const replay = await serviceB.submitRun(PRINCIPAL_A, input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, first.run.id);
    const newSession = serviceB.createSession(PRINCIPAL_A, "journal-active-new");
    const newSnapshot = await serviceB.createSnapshot(PRINCIPAL_A);
    await assert.rejects(
      serviceB.submitRun(PRINCIPAL_A, submitInput(newSession.id, newSnapshot, "journal-active-key-2")),
      (error: unknown) => error instanceof CoachingServiceError && error.code === "RUN_BUSY",
    );
    assert.equal(capturesB.length, 0, "a restart must never adopt or spawn a second child");
  } finally {
    await serviceB?.shutdown().catch(() => undefined);
    // The original handle was never adopted; close its fake for cleanup.
    await serviceA?.shutdown().catch(() => undefined);
    cleanupCaptures([...capturesA, ...capturesB]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native continuation stays partitioned by backend/runtime/version across restart", async () => {
  const { dir, path } = makeJournal();
  const stores = await seedStores();
  const capturesA: RuntimeLaunchOptions[] = [];
  const capturesB: RuntimeLaunchOptions[] = [];
  let serviceA: CoachingService | null = null;
  let serviceB: CoachingService | null = null;
  try {
    const piOnly = createCoachingRuntimeRegistry([
      {
        backendId: "local-pi",
        runtimeId: "pi",
        executionLocation: "local",
        displayName: "pi CLI (local)",
        available: true,
        factory: completingFactory(capturesA, "pi-file"),
      },
    ]);
    serviceA = serviceFor(stores, path, completingFactory(capturesA, "pi-file"), {
      runtimeRegistry: piOnly,
    });
    const session = serviceA.createSession(PRINCIPAL_A, "journal-native-sess");
    const snapshot = await serviceA.createSnapshot(PRINCIPAL_A);
    await serviceA.submitRun(PRINCIPAL_A, submitInput(session.id, snapshot, "journal-native-pi-1"));
    await serviceA.shutdown();
    serviceA = null;

    const duplicated = createCoachingRuntimeRegistry([
      {
        backendId: "local-pi",
        runtimeId: "pi",
        executionLocation: "local",
        displayName: "pi CLI (local)",
        available: true,
        factory: completingFactory(capturesB, "pi-file"),
      },
      {
        backendId: "local-codex",
        runtimeId: "codex",
        executionLocation: "local",
        displayName: "Codex CLI (local)",
        available: true,
        factory: completingFactory(capturesB, "codex-handle"),
      },
    ]);
    serviceB = serviceFor(stores, path, completingFactory(capturesB, "pi-file"), {
      runtimeRegistry: duplicated,
    });
    const snapshot2 = await serviceB.createSnapshot(PRINCIPAL_A);
    await serviceB.submitRun(
      PRINCIPAL_A,
      submitInput(session.id, snapshot2, "journal-native-codex-1", {
        backendId: "local-codex",
        runtimeId: "codex",
      }),
    );
    assert.equal(capturesB.length, 1);
    assert.equal(capturesB[0]?.resumeSessionFile, undefined, "a pi file is never handed to Codex");
    assert.equal(capturesB[0]?.resumeNativeSessionHandle, undefined);

    const snapshot3 = await serviceB.createSnapshot(PRINCIPAL_A);
    await serviceB.submitRun(PRINCIPAL_A, submitInput(session.id, snapshot3, "journal-native-pi-2"));
    assert.equal(capturesB.length, 2);
    // Codex now owns the session's native handle: pi must not receive it (or
    // its own superseded file).
    assert.equal(capturesB[1]?.resumeSessionFile, undefined);
    assert.equal(capturesB[1]?.resumeNativeSessionHandle, undefined);
  } finally {
    await serviceA?.shutdown().catch(() => undefined);
    await serviceB?.shutdown().catch(() => undefined);
    cleanupCaptures([...capturesA, ...capturesB]);
    rmSync(dir, { recursive: true, force: true });
  }
});
