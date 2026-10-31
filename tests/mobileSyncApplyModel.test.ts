import assert from "node:assert/strict";
import { test } from "node:test";

import { API_ERROR_CODES, ApiError, NetworkError } from "@agent-fit-trace/api-contracts";
import { ConflictError, CURRENT_SCHEMA_VERSION, stableStringify } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  SYNC_CONFLICT_ACTIONS,
  abortSyncRun,
  acknowledgeSyncConflict,
  beginSyncRun,
  completeSyncRun,
  conflictExportJson,
  decideSyncConflict,
  recordPulledRecord,
  recordPushedRecord,
  recordSyncConflict,
  recordSyncFailure,
  type SyncRunResult,
} from "../mobile/src/sync/syncApplyModel.ts";
import type { SyncConflict } from "../mobile/src/sync/syncModel.ts";
import { planSync } from "../mobile/src/sync/syncModel.ts";
import { runWorkoutSync } from "../mobile/src/sync/syncRunner.ts";
import type { SyncRunAccount } from "../mobile/src/sync/syncRunner.ts";
import type { SyncConfig } from "../mobile/src/sync/syncConfig.ts";

/**
 * Pure coverage for applying a sync plan, folding conflict decisions, and the
 * manual runner. No Expo, SQLite, fetch or React value is imported: fakes stand
 * in for the repository and the cloud client, so every branch runs in the
 * root `node:test` process without a device or a server.
 */

const CONFIGURED: SyncConfig = {
  status: "configured",
  baseUrl: "https://fit-trace.example.test/api/v1",
};

const ZERO_COUNTS = { pushed: 0, pulled: 0, identical: 0, conflicts: 0 } as const;

/** The account and token pinned when the user started every ordinary run. */
const ACCOUNT_A: SyncRunAccount = {
  userId: "user-a",
  accessToken: "test-access-token",
};

/** A second account, used to simulate a sign-out/sign-in mid-run. */
const ACCOUNT_B: SyncRunAccount = {
  userId: "user-b",
  accessToken: "test-access-token-b",
};

function fixedAccount(): SyncRunAccount {
  return ACCOUNT_A;
}

function record(id: string, overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id,
    schema_version: CURRENT_SCHEMA_VERSION,
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "Back squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

function conflict(id: string, localNotes = "local", remoteNotes = "cloud"): SyncConflict {
  return {
    id,
    local: record(id, { notes: localNotes }),
    remote: record(id, { notes: remoteNotes }),
  };
}

function ids(records: readonly WorkoutRecord[]): string[] {
  return records.map((entry) => entry.id);
}

interface FakeRepositoryOptions {
  /** Records present in storage but hidden from the pre-run list (a write race). */
  hiddenIds?: ReadonlySet<string>;
}

function createRepository(
  initial: readonly WorkoutRecord[],
  options: FakeRepositoryOptions = {},
) {
  const stored = new Map<string, WorkoutRecord>(initial.map((entry) => [entry.id, entry]));
  const calls = { list: 0, saves: [] as string[], gets: [] as string[] };

  return {
    calls,
    stored,
    async listWorkouts(): Promise<WorkoutRecord[]> {
      calls.list += 1;
      return [...stored.values()].filter((entry) => !options.hiddenIds?.has(entry.id));
    },
    async listSyncWorkouts(): Promise<WorkoutRecord[]> {
      calls.list += 1;
      return [...stored.values()].filter((entry) => !options.hiddenIds?.has(entry.id));
    },
    async listUploadCandidates(): Promise<WorkoutRecord[]> {
      return [...stored.values()];
    },
    async isSyncEnabled(): Promise<boolean> { return true; },
    async saveWorkout(entry: WorkoutRecord): Promise<{ id: string; created: boolean }> {
      calls.saves.push(entry.id);
      const existing = stored.get(entry.id);
      if (existing === undefined) {
        stored.set(entry.id, entry);
        return { id: entry.id, created: true };
      }
      if (stableStringify(existing) === stableStringify(entry)) {
        return { id: entry.id, created: false };
      }
      throw new ConflictError(entry.id);
    },
    async getWorkout(id: string): Promise<WorkoutRecord | null> {
      calls.gets.push(id);
      return stored.get(id) ?? null;
    },
  };
}

interface FakeClientOptions {
  /** Throw on the first list call only (preflight abort / mid-run refresh). */
  listErrorOnce?: unknown;
  /** Throw on the first create call only; no retry is expected. */
  createErrorOnce?: unknown;
  /** Throw when creating this id, after any earlier creates succeeded. */
  createErrorForId?: { id: string; error: unknown };
  /**
   * Simulate another device writing the id between the plan and the push.
   * The returned record is stored cloud-side and the create answers 409.
   */
  conflictOnCreate?: (entry: WorkoutRecord) => WorkoutRecord | undefined;
}

function createClient(
  initial: readonly WorkoutRecord[],
  options: FakeClientOptions = {},
) {
  const stored = new Map<string, WorkoutRecord>(initial.map((entry) => [entry.id, entry]));
  const calls = { list: 0, creates: [] as string[] };

  return {
    config: CONFIGURED,
    calls,
    stored,
    async listRemoteWorkouts(): Promise<WorkoutRecord[]> {
      calls.list += 1;
      if (options.listErrorOnce !== undefined && calls.list === 1) {
        throw options.listErrorOnce;
      }
      return [...stored.values()];
    },
    async createRemoteWorkout(entry: WorkoutRecord): Promise<"created" | "duplicate"> {
      calls.creates.push(entry.id);
      if (options.createErrorOnce !== undefined && calls.creates.length === 1) {
        throw options.createErrorOnce;
      }
      if (options.createErrorForId?.id === entry.id) {
        throw options.createErrorForId.error;
      }
      const raced = options.conflictOnCreate?.(entry);
      if (raced !== undefined) {
        stored.set(raced.id, raced);
        throw new ApiError({
          code: API_ERROR_CODES.CONFLICT,
          message: "A record with this id already exists with different content.",
          status: 409,
        });
      }
      const existing = stored.get(entry.id);
      if (existing === undefined) {
        stored.set(entry.id, entry);
        return "created";
      }
      if (stableStringify(existing) === stableStringify(entry)) return "duplicate";
      throw new ApiError({
        code: API_ERROR_CODES.CONFLICT,
        message: "A record with this id already exists with different content.",
        status: 409,
      });
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Applying a plan                                                           */
/* ------------------------------------------------------------------------- */

test("beginning a run seeds identical/conflict counts without mutating the plan", () => {
  const plan = planSync(
    [record("b", { notes: "local" }), record("c")],
    [record("b", { notes: "cloud" }), record("c"), record("d")],
  );
  const before = structuredClone(plan);

  const state = beginSyncRun(plan);

  assert.deepEqual(plan, before);
  assert.equal(state.pushed, 0);
  assert.equal(state.pulled, 0);
  assert.equal(state.identical, 1);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.conflicts[0]?.id, "b");
  assert.equal(state.failure, null);
});

test("pulled and pushed outcomes increment once per applied record", () => {
  let state = beginSyncRun(planSync([], []));
  state = recordPulledRecord(state);
  state = recordPulledRecord(recordPushedRecord(state));
  state = recordPushedRecord(state);

  const result = completeSyncRun(state);
  assert.deepEqual(result, {
    status: "done",
    failure: null,
    abortReason: null,
    counts: { pushed: 2, pulled: 2, identical: 0, conflicts: 0 },
    conflicts: [],
  });
});

test("new conflicts merge by id, stay sorted by id, and never mutate the input", () => {
  let state = beginSyncRun(planSync([], []));
  state = recordSyncConflict(state, conflict("z"));
  const before = structuredClone(state);
  state = recordSyncConflict(state, conflict("a"));

  assert.deepEqual(before.conflicts.map((entry) => entry.id), ["z"]);
  assert.deepEqual(state.conflicts.map((entry) => entry.id), ["a", "z"]);
  const duplicate = recordSyncConflict(state, conflict("a"));
  assert.equal(duplicate, state, "an already-known id is a no-op");

  const result = completeSyncRun(state);
  assert.equal(result.status, "done");
  assert.equal(result.counts.conflicts, 2);
});

test("the first classified failure is kept and turns the run into failed", () => {
  const state = beginSyncRun(planSync([record("a")], []));
  const offline = recordSyncFailure(state, "offline");
  const later = recordSyncFailure(offline, "auth");

  assert.equal(later, offline, "a later failure cannot replace the first");
  const result = completeSyncRun(offline);
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "offline");
  assert.equal(result.abortReason, null);
  assert.deepEqual(result.counts, ZERO_COUNTS);
});

test("aborting a run reports zero writes and no conflicts", () => {
  assert.deepEqual(abortSyncRun("auth", "unauthenticated"), {
    status: "aborted",
    failure: "auth",
    abortReason: "unauthenticated",
    counts: ZERO_COUNTS,
    conflicts: [],
  });
  assert.deepEqual(abortSyncRun("offline", "offline"), {
    status: "aborted",
    failure: "offline",
    abortReason: "offline",
    counts: ZERO_COUNTS,
    conflicts: [],
  });
});

/* ------------------------------------------------------------------------- */
/* Conflict decisions                                                        */
/* ------------------------------------------------------------------------- */

test("every conflict choice is device-only: no upload and no delete", () => {
  for (const action of SYNC_CONFLICT_ACTIONS) {
    const decision = decideSyncConflict(action);
    assert.equal(decision.action, action);
    assert.equal(decision.uploadsLocal, false, `${action} must not upload`);
    assert.equal(decision.deletesLocal, false, `${action} must not delete`);
    assert.equal(decision.localDisposition, "device-only");
    assert.equal(decision.sharesLocal, action === "export-local");
  }
});

test("acknowledging removes one row and decrements the count without mutating the result", () => {
  const result: SyncRunResult = {
    status: "done",
    failure: null,
    abortReason: null,
    counts: { pushed: 0, pulled: 0, identical: 0, conflicts: 2 },
    conflicts: [conflict("a"), conflict("b")],
  };
  const before = structuredClone(result);

  const next = acknowledgeSyncConflict(result, "a");

  assert.deepEqual(result, before);
  assert.deepEqual(next.conflicts.map((entry) => entry.id), ["b"]);
  assert.equal(next.counts.conflicts, 1);
  assert.equal(acknowledgeSyncConflict(next, "missing"), next);
  assert.equal(acknowledgeSyncConflict(next, "a"), next, "already acknowledged is a no-op");
});

test("export JSON is the canonical local record and does not mutate the conflict", () => {
  const pair = conflict("wkt-export", "device version");
  const before = structuredClone(pair);

  assert.equal(conflictExportJson(pair), stableStringify(pair.local));
  assert.notEqual(conflictExportJson(pair), stableStringify(pair.remote));
  assert.deepEqual(pair, before);
});

/* ------------------------------------------------------------------------- */
/* Runner                                                                    */
/* ------------------------------------------------------------------------- */

test("runner pulls remote-only, pushes local-only, and preserves both conflict originals", async () => {
  const onlyLocal = record("a-local", { notes: "device" });
  const conflictLocal = record("b-conflict", { notes: "device version" });
  const conflictRemote = record("b-conflict", { notes: "cloud version" });
  const identicalLocal = record("c-identical", { notes: "same" });
  const identicalRemote = record("c-identical", { notes: "same" });
  const onlyRemote = record("d-remote");
  const repository = createRepository([onlyLocal, conflictLocal, identicalLocal]);
  const client = createClient([conflictRemote, identicalRemote, onlyRemote]);

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "done");
  assert.equal(result.failure, null);
  assert.equal(result.abortReason, null);
  assert.deepEqual(result.counts, {
    pushed: 1,
    pulled: 1,
    identical: 1,
    conflicts: 1,
  });
  assert.deepEqual(
    result.conflicts.map((entry) => entry.id),
    ["b-conflict"],
  );
  assert.equal(result.conflicts[0]?.local, conflictLocal);
  assert.equal(result.conflicts[0]?.remote, conflictRemote);

  assert.deepEqual(ids([...repository.stored.values()].sort((a, b) => (a.id < b.id ? -1 : 1))), [
    "a-local",
    "b-conflict",
    "c-identical",
    "d-remote",
  ]);
  assert.deepEqual(repository.calls.saves, ["d-remote"], "conflicts and identical ids are not re-saved");
  assert.deepEqual(client.calls.creates, ["a-local"], "conflicts and identical ids are not pushed");
  assert.equal(repository.stored.get("b-conflict"), conflictLocal);
  assert.equal(client.stored.get("b-conflict"), conflictRemote);
  assert.equal(repository.stored.get("d-remote"), onlyRemote);
  assert.equal(client.stored.get("a-local"), onlyLocal);
});

test("runner uploads only explicitly enrolled candidates and marks pulled records remote-origin", async () => {
  const local = record("scoped-local");
  const remote = record("cloud-only");
  const candidates: WorkoutRecord[] = [local];
  const savedOrigins: string[] = [];
  const completed: string[] = [];
  const base = createRepository([local]);
  const repository = {
    ...base,
    async listUploadCandidates(scope: { accountId: string; endpoint: string }) {
      assert.deepEqual(scope, { accountId: ACCOUNT_A.userId, endpoint: CONFIGURED.baseUrl });
      return candidates;
    },
    async isSyncEnabled() { return true; },
    async markUploadComplete(_scope: unknown, id: string) { completed.push(id); },
    async saveWorkout(entry: WorkoutRecord, options?: { origin?: "local" | "remote" }) {
      savedOrigins.push(options?.origin ?? "local");
      return base.saveWorkout(entry);
    },
  };
  const client = createClient([remote]);
  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: () => ACCOUNT_A,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });

  assert.equal(result.status, "done");
  assert.deepEqual(client.calls.creates, [local.id]);
  assert.deepEqual(completed, [local.id]);
  assert.deepEqual(savedOrigins, ["remote"]);
});

test("runner fails closed when repository cannot prove explicit upload enrollment", async () => {
  const local = record("not-enrolled");
  const client = createClient([]);
  const result = await runWorkoutSync({
    repository: {
      async listWorkouts() { return [local]; },
      async listSyncWorkouts() { return [local]; },
      async isSyncEnabled() { return true; },
      async saveWorkout() { return { created: true }; },
      async getWorkout() { return null; },
    },
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });
  assert.equal(result.status, "done");
  assert.deepEqual(client.calls.creates, [], "the runner must never substitute a full local-store scan for enrollment");
});

test("runner completes an outbox item when a prior ambiguous upload is already remote", async () => {
  const local = record("lost-response");
  const completed: string[] = [];
  const repository = {
    ...createRepository([local]),
    async listSyncWorkouts() { return [local]; },
    async listUploadCandidates() { return [local]; },
    async isSyncEnabled() { return true; },
    async markUploadComplete(_scope: unknown, id: string) { completed.push(id); },
  };
  const client = createClient([local]);

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });

  assert.equal(result.status, "done");
  assert.equal(result.counts.identical, 1);
  assert.deepEqual(client.calls.creates, [], "an already-present record is never written again");
  assert.deepEqual(completed, [local.id], "the durable queue is cleared after reconciliation");
});

test("runner schedules a bounded retry after a retryable upload response", async () => {
  const local = record("retry-me");
  const retries: string[] = [];
  const repository = {
    ...createRepository([local]),
    async listSyncWorkouts() { return [local]; },
    async listUploadCandidates() { return [local]; },
    async isSyncEnabled() { return true; },
    async scheduleUploadRetry(_scope: unknown, id: string) { retries.push(id); },
  };
  const client = createClient([], {
    createErrorOnce: new ApiError({ code: API_ERROR_CODES.API_ERROR, message: "temporary", status: 503 }),
  });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(retries, [local.id]);
  assert.deepEqual(client.calls.creates, [local.id], "the ambiguous/error response is attempted once");
});

test("runner backs off enrolled items after a retryable cloud read failure", async () => {
  const local = record("read-retry");
  const retries: string[] = [];
  const repository = {
    ...createRepository([local]),
    async scheduleUploadRetry(_scope: unknown, id: string) { retries.push(id); },
  };
  const client = createClient([], {
    listErrorOnce: new ApiError({ code: API_ERROR_CODES.API_ERROR, message: "temporary", status: 503 }),
  });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });

  assert.equal(result.status, "aborted");
  assert.deepEqual(retries, [local.id]);
  assert.deepEqual(client.calls.creates, []);
});

test("runner suppresses only an unchanged, explicitly acknowledged device-only conflict", async () => {
  const local = record("acknowledged", { notes: "device copy" });
  const remote = record("acknowledged", { notes: "cloud copy" });
  let reconciled = 0;
  const repository = {
    ...createRepository([local]),
    async listSyncWorkouts() { return [local]; },
    async listUploadCandidates() { return []; },
    async isSyncEnabled() { return true; },
    async listConflictAcknowledgements() {
      return [{
        workoutId: local.id,
        localFingerprint: stableStringify(local),
        remoteFingerprint: stableStringify(remote),
        action: "keep-local" as const,
      }];
    },
    async recordSuccessfulReconciliation() { reconciled += 1; },
  };
  const client = createClient([remote]);
  const options = {
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  };

  const result = await runWorkoutSync(options);
  assert.equal(result.status, "done");
  assert.equal(result.counts.conflicts, 0);
  assert.equal(reconciled, 1);

  const changed = record("acknowledged", { notes: "edited device copy" });
  const changedRepository = { ...repository, async listSyncWorkouts() { return [changed]; } };
  const changedResult = await runWorkoutSync({ ...options, repository: changedRepository });
  assert.equal(changedResult.counts.conflicts, 1, "fingerprint changes reopen the conflict");
  assert.equal(reconciled, 1, "unresolved divergence does not advance last-success status");
});

test("runner does not advance complete status while queued work is still in backoff", async () => {
  let reconciled = 0;
  const repository = {
    ...createRepository([]),
    async listUploadCandidates() { return []; },
    async getSyncStatus() { return { pendingCount: 1, lastSuccessAt: null }; },
    async recordSuccessfulReconciliation() { reconciled += 1; },
  };
  const result = await runWorkoutSync({
    repository,
    client: createClient([]),
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });
  assert.equal(result.status, "done");
  assert.equal(reconciled, 0);
});

test("remote membership from another account is excluded from sync planning", async () => {
  const accountARecord = record("from-account-a");
  const saves: string[] = [];
  const client = createClient([]);
  const result = await runWorkoutSync({
    repository: {
      async listWorkouts() { return [accountARecord]; },
      async listSyncWorkouts(scope) {
        assert.deepEqual(scope, { accountId: ACCOUNT_B.userId, endpoint: CONFIGURED.baseUrl });
        return [];
      },
      async listUploadCandidates() { return []; },
      async isSyncEnabled() { return true; },
      async markUploadComplete() {},
      async saveWorkout(entry) { saves.push(entry.id); return { created: true }; },
      async getWorkout() { return null; },
    },
    client,
    account: ACCOUNT_B,
    getCurrentAccount: () => ACCOUNT_B,
    scope: { accountId: ACCOUNT_B.userId!, endpoint: CONFIGURED.baseUrl },
  });

  assert.equal(result.status, "done");
  assert.equal(result.counts.conflicts, 0);
  assert.deepEqual(client.calls.creates, []);
  assert.deepEqual(saves, []);
});

test("a stale sync lease stops a suspended worker before its next write", async () => {
  const local = record("fenced-local");
  const client = createClient([]);
  let released = false;
  const result = await runWorkoutSync({
    repository: {
      async listWorkouts() { return [local]; },
      async listSyncWorkouts() { return [local]; },
      async listUploadCandidates() { return [local]; },
      async isSyncEnabled() { return true; },
      async markUploadComplete() {},
      async saveWorkout() { return { created: true }; },
      async getWorkout() { return null; },
      async acquireSyncLease() { return { owner: "worker-a", generation: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
      async renewSyncLease() { return false; },
      async isSyncLeaseCurrent() { return false; },
      async releaseSyncLease() { released = true; },
    },
    client,
    account: ACCOUNT_A,
    getCurrentAccount: () => ACCOUNT_A,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "other");
  assert.deepEqual(client.calls.creates, []);
  assert.equal(released, true);
});

test("a CONFLICT while inserting locally becomes a conflict, not a failed run", async () => {
  const racedLocal = record("r1", { notes: "device version" });
  const remote = record("r1", { notes: "cloud version" });
  const repository = createRepository([racedLocal], {
    hiddenIds: new Set([racedLocal.id]),
  });
  const client = createClient([remote]);

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "done");
  assert.equal(result.failure, null);
  assert.deepEqual(result.counts, {
    pushed: 0,
    pulled: 0,
    identical: 0,
    conflicts: 1,
  });
  assert.equal(result.conflicts[0]?.local, racedLocal);
  assert.equal(result.conflicts[0]?.remote, remote);
  assert.deepEqual(repository.calls.gets, ["r1"]);
  assert.equal(repository.stored.get("r1"), racedLocal);
});

test("a 409 on push re-reads the cloud and pairs the remote original", async () => {
  const local = record("only-local", { notes: "device version" });
  const cloud = record("only-local", { notes: "cloud version" });
  const repository = createRepository([local]);
  const client = createClient([], {
    conflictOnCreate: (entry) => (entry.id === local.id ? cloud : undefined),
  });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "done");
  assert.equal(result.failure, null);
  assert.deepEqual(result.counts, {
    pushed: 0,
    pulled: 0,
    identical: 0,
    conflicts: 1,
  });
  assert.equal(result.conflicts[0]?.local, local);
  assert.equal(result.conflicts[0]?.remote, cloud);
  assert.deepEqual(client.calls.creates, ["only-local"], "the write is attempted exactly once");
  assert.equal(client.calls.list, 2, "one plan read plus one conflict pairing read");
  assert.equal(repository.stored.get("only-local"), local);
  assert.equal(client.stored.get("only-local"), cloud);
});

test("a 409 race with an identical remote record completes the outbox item", async () => {
  const local = record("409-identical");
  const completed: string[] = [];
  const repository = {
    ...createRepository([local]),
    async markUploadComplete(_scope: unknown, id: string) { completed.push(id); },
  };
  const client = createClient([], { conflictOnCreate: () => local });
  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
    scope: { accountId: ACCOUNT_A.userId!, endpoint: CONFIGURED.baseUrl },
  });
  assert.equal(result.status, "done");
  assert.equal(result.counts.pushed, 1);
  assert.equal(result.counts.conflicts, 0);
  assert.deepEqual(completed, [local.id]);
});

test("runner aborts before reading when no signed-in token is supplied", async () => {
  for (const accessToken of [null, undefined, "", "   "]) {
    const repository = createRepository([record("a")]);
    const client = createClient([]);
    const account: SyncRunAccount = { userId: "user-a", accessToken };

    const result = await runWorkoutSync({
      repository,
      client,
      account,
      getCurrentAccount: () => account,
    });

    assert.deepEqual(result, {
      status: "aborted",
      failure: "auth",
      abortReason: "unauthenticated",
      counts: ZERO_COUNTS,
      conflicts: [],
    });
    assert.equal(repository.calls.list, 0);
    assert.equal(client.calls.list, 0);
    assert.deepEqual(repository.calls.saves, []);
    assert.deepEqual(client.calls.creates, []);
  }
});

test("runner aborts before reading when cloud sync is unconfigured", async () => {
  const repository = createRepository([record("a")]);
  const configured = createClient([]);
  const client = { ...configured, config: { status: "unconfigured" } as SyncConfig };

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.deepEqual(result, {
    status: "aborted",
    failure: "other",
    abortReason: "unconfigured",
    counts: ZERO_COUNTS,
    conflicts: [],
  });
  assert.equal(repository.calls.list, 0);
  assert.equal(configured.calls.list, 0);
});

test("runner aborts cleanly when the initial cloud read is offline", async () => {
  const repository = createRepository([record("a")]);
  const client = createClient([], { listErrorOnce: new NetworkError() });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.failure, "offline");
  assert.equal(result.abortReason, "offline");
  assert.deepEqual(result.counts, ZERO_COUNTS);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(repository.calls.saves, []);
  assert.deepEqual(client.calls.creates, []);
});

test("a network failure during push is not retried and reports what completed", async () => {
  const repository = createRepository([record("a")]);
  const client = createClient([], { createErrorOnce: new NetworkError() });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "offline");
  assert.equal(result.abortReason, null);
  assert.deepEqual(result.counts, ZERO_COUNTS);
  assert.deepEqual(client.calls.creates, ["a"], "one attempt only");
  assert.equal(client.calls.list, 1);
  assert.equal(repository.stored.has("a"), true);
});

test("classified auth failures from a read stay auth failures on an aborted run", async () => {
  const repository = createRepository([record("a")]);
  const client = createClient([], {
    listErrorOnce: new ApiError({
      code: API_ERROR_CODES.UNAUTHENTICATED,
      message: "expired",
      status: 401,
    }),
  });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.failure, "auth");
  assert.equal(result.abortReason, null);
  assert.deepEqual(result.counts, ZERO_COUNTS);
});

test("an identical duplicate returned by the local save still counts as pulled", async () => {
  const remote = record("already-local");
  const repository = createRepository([remote], { hiddenIds: new Set([remote.id]) });
  const client = createClient([remote]);

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "done");
  assert.deepEqual(result.counts, {
    pushed: 0,
    pulled: 1,
    identical: 0,
    conflicts: 0,
  });
  assert.equal(repository.calls.saves.length, 1);
});

test("pushes of duplicate cloud records count as pushed without a conflict", async () => {
  const local = record("already-cloud");
  const repository = createRepository([local]);
  // The record exists cloud-side but is hidden from the first list call, so the
  // plan still sees it as local-only; the create then answers "duplicate".
  const client = createClient([]);
  client.stored.set(local.id, local);

  const hiddenThenVisible = {
    ...client,
    async listRemoteWorkouts(): Promise<WorkoutRecord[]> {
      client.calls.list += 1;
      return client.calls.list === 1 ? [] : [...client.stored.values()];
    },
  };

  const result = await runWorkoutSync({
    repository,
    client: hiddenThenVisible,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "done");
  assert.equal(result.failure, null);
  assert.deepEqual(result.counts, {
    pushed: 1,
    pulled: 0,
    identical: 0,
    conflicts: 0,
  });
  assert.deepEqual(client.calls.creates, ["already-cloud"]);
});

test("runner aborts before reading when the pinned account id is missing", async () => {
  for (const userId of [null, undefined, "", "   "]) {
    const repository = createRepository([record("a")]);
    const client = createClient([]);
    const account: SyncRunAccount = { userId, accessToken: "test-access-token" };

    const result = await runWorkoutSync({
      repository,
      client,
      account,
      getCurrentAccount: () => account,
    });

    assert.deepEqual(result, {
      status: "aborted",
      failure: "auth",
      abortReason: "unauthenticated",
      counts: ZERO_COUNTS,
      conflicts: [],
    });
    assert.equal(repository.calls.list, 0);
    assert.equal(client.calls.list, 0);
    assert.deepEqual(repository.calls.saves, []);
    assert.deepEqual(client.calls.creates, []);
  }
});

test("runner stops before the next write when the account changes", async () => {
  const first = record("a-first");
  const second = record("b-second");
  const repository = createRepository([first, second]);
  const client = createClient([]);
  let checks = 0;

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: () => {
      checks += 1;
      return checks === 1 ? ACCOUNT_A : ACCOUNT_B;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "auth");
  assert.equal(result.abortReason, null);
  assert.deepEqual(client.calls.creates, ["a-first"], "only the write before the change lands");
  assert.deepEqual(repository.calls.saves, []);
  assert.equal(client.stored.has(second.id), false, "the second upload never starts");
});

test("a token refresh for the same account does not stop the run", async () => {
  const first = record("a-first");
  const second = record("b-second");
  const repository = createRepository([first, second]);
  const client = createClient([]);

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: () => ({
      userId: ACCOUNT_A.userId,
      accessToken: "rotated-token",
    }),
  });

  assert.equal(result.status, "done");
  assert.equal(result.failure, null);
  assert.deepEqual(result.counts, {
    pushed: 2,
    pulled: 0,
    identical: 0,
    conflicts: 0,
  });
  assert.deepEqual(client.calls.creates, ["a-first", "b-second"]);
});

test("runner stops before a local insert when the account is no longer current", async () => {
  const remote = record("remote-only");
  const repository = createRepository([]);
  const client = createClient([remote]);

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: () => ACCOUNT_B,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "auth");
  assert.deepEqual(repository.calls.saves, [], "no local write after the account change");
  assert.equal(repository.stored.has(remote.id), false);
  assert.deepEqual(client.calls.creates, []);
});

test("a later push failure still returns conflicts collected earlier", async () => {
  const conflictLocal = record("a-conflict", { notes: "device version" });
  const failedLocal = record("b-fail");
  const notAttempted = record("c-not-attempted");
  const cloud = record("a-conflict", { notes: "cloud version" });
  const repository = createRepository([conflictLocal, failedLocal, notAttempted]);
  const client = createClient([], {
    conflictOnCreate: (entry) => (entry.id === conflictLocal.id ? cloud : undefined),
    createErrorForId: { id: failedLocal.id, error: new NetworkError() },
  });

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: fixedAccount,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "offline");
  assert.deepEqual(
    client.calls.creates,
    [conflictLocal.id, failedLocal.id],
    "no upload starts after the failure",
  );
  assert.deepEqual(result.conflicts.map((entry) => entry.id), [conflictLocal.id]);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(result.conflicts[0]?.local, conflictLocal);
  assert.equal(result.conflicts[0]?.remote, cloud);
  assert.equal(client.stored.has(notAttempted.id), false, "the later upload never starts");
});

test("an account change with a pending push conflict still returns that conflict", async () => {
  const conflictLocal = record("a-conflict", { notes: "device version" });
  const notAttempted = record("b-not-attempted");
  const cloud = record("a-conflict", { notes: "cloud version" });
  const repository = createRepository([conflictLocal, notAttempted]);
  const client = createClient([], {
    conflictOnCreate: (entry) => (entry.id === conflictLocal.id ? cloud : undefined),
  });
  let checks = 0;

  const result = await runWorkoutSync({
    repository,
    client,
    account: ACCOUNT_A,
    getCurrentAccount: () => {
      checks += 1;
      return checks === 1 ? ACCOUNT_A : ACCOUNT_B;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "auth");
  assert.deepEqual(client.calls.creates, [conflictLocal.id], "the next upload is stopped");
  assert.deepEqual(result.conflicts.map((entry) => entry.id), [conflictLocal.id]);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(client.stored.has(notAttempted.id), false, "the later upload never starts");
});
