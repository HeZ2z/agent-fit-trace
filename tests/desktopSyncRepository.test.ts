import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import { SqliteWorkoutStore } from "@agent-fit-trace/store";
import { WorkoutSyncRepository } from "../server/workoutSyncRepository.ts";
import { runWorkoutSync } from "../packages/fit-trace-sync/src/syncRunner.ts";
import { loadFixture } from "./helpers.ts";

test("desktop sync reconciles idempotently, fences consent, and keeps destinations isolated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-"));
  const store = new SqliteWorkoutStore(join(dir, "test.db"));
  try {
    const history = (await loadFixture<unknown[]>("history-strength.json")).map(x => validateWorkoutRecord(x).record);
    await store.import(history[0]);
    const repo = new WorkoutSyncRepository(store);
    const scope = { accountId: "test-account", issuer: "https://auth.test/auth/v1", sessionId: "00000000-0000-0000-0000-000000000001", endpoint: "https://example.test/api" };
    const remote = [history[1]];
    const client = {
      config: { status: "configured" as const, baseUrl: scope.endpoint },
      async listRemoteWorkouts() { return [...remote]; },
      async createRemoteWorkout(record: typeof history[number]) { remote.push(record); return "created" as const; },
    };
    const account = { userId: scope.accountId, accessToken: "test-token" };
    const run = () => runWorkoutSync({ repository: repo, client, account, getCurrentAccount: () => account, scope });
    assert.notEqual((await run()).status, "done");
    repo.enableSync(scope);
    const first = await run();
    assert.equal(first.status, "done");
    assert.equal(first.counts.pushed, 1);
    assert.equal(first.counts.pulled, 1);
    assert.equal((await run()).counts.pushed, 0);
    assert.equal((await repo.listSyncWorkouts({ ...scope, endpoint: "https://other.test/api" })).length, 1);
    const lease = await repo.acquireSyncLease(scope, "test-owner", new Date());
    assert.ok(lease);
    const leased = { ...scope, leaseOwner: lease.owner, leaseGeneration: lease.generation };
    repo.disableSync(scope);
    await assert.rejects(() => repo.saveWorkout(history[2], { origin: "remote", scope: leased }));
    assert.equal(await repo.getWorkout(history[2].id), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("expired lease and same-id conflict never overwrite local workouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-fence-"));
  const store = new SqliteWorkoutStore(join(dir, "test.db"));
  try {
    const record = validateWorkoutRecord(await loadFixture("valid-strength.json")).record;
    await store.import(record);
    const repo = new WorkoutSyncRepository(store);
    const scope = { accountId: "account", issuer: "https://auth.test/auth/v1", sessionId: "00000000-0000-0000-0000-000000000002", endpoint: "https://example.test" };
    repo.enableSync(scope);
    const stale = await repo.acquireSyncLease(scope, "stale", new Date(Date.now() - 10_000), 1);
    assert.ok(stale);
    const current = await repo.acquireSyncLease(scope, "current", new Date());
    assert.ok(current);
    await assert.rejects(() => repo.saveWorkout(record, { origin: "remote", scope: { ...scope, leaseOwner: stale.owner, leaseGeneration: stale.generation } }));
    const changed = structuredClone(record);
    changed.exercises[0].sets[0].weight = (changed.exercises[0].sets[0].weight ?? 0) + 1;
    await assert.rejects(() => repo.saveWorkout(changed, { origin: "remote", scope: { ...scope, leaseOwner: current.owner, leaseGeneration: current.generation } }));
    assert.deepEqual(await repo.getWorkout(record.id), record);
    repo.enableSync({ ...scope, endpoint: "https://new.example.test" });
    assert.equal(await repo.isSyncEnabled(scope), false);
    await assert.rejects(() => repo.linkRemoteMembership({ ...scope, leaseOwner: current.owner, leaseGeneration: current.generation }, record));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("revocation survives reopening and fences the same session while a new session can run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-revoke-"));
  const path = join(dir, "test.db");
  const scope = { accountId: "account", issuer: "https://auth.test/auth/v1", sessionId: "00000000-0000-0000-0000-000000000001", endpoint: "https://api.test" };
  try {
    const first = new SqliteWorkoutStore(path);
    const repo = new WorkoutSyncRepository(first);
    repo.enableSync(scope);
    const lease = await repo.acquireSyncLease(scope, "old", new Date());
    assert.ok(lease);
    repo.revokeSession(scope);
    await assert.rejects(() => repo.acquireSyncLease(scope, "late", new Date()));
    first.close();
    const second = new SqliteWorkoutStore(path);
    try {
      const reopened = new WorkoutSyncRepository(second);
      await assert.rejects(() => reopened.acquireSyncLease(scope, "after-restart", new Date()));
      const newSession = { ...scope, sessionId: "00000000-0000-0000-0000-000000000002" };
      const newLease = await reopened.acquireSyncLease(newSession, "new", new Date());
      assert.ok(newLease);
      reopened.revokeSession(scope); // A delayed old-session logout must not cancel the new session.
      assert.equal(await reopened.isSyncLeaseCurrent({ ...newSession, leaseOwner: newLease.owner, leaseGeneration: newLease.generation }, new Date()), true);
    } finally { second.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
