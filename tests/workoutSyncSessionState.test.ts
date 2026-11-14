import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteWorkoutStore, principalDbPath } from "@agent-fit-trace/store";
import { WorkoutSyncRepository } from "../server/workoutSyncRepository.ts";
import { WorkoutSyncSessionState } from "../server/workoutSyncSessionState.ts";

const a = { issuer: "https://auth.test/auth/v1", accountId: "a", sessionId: "00000000-0000-0000-0000-000000000001", endpoint: "https://api.test" };
const b = { ...a, accountId: "b", sessionId: "00000000-0000-0000-0000-000000000002" };
test("active session uses compare-and-swap and fences late authentication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-state-"));
  try {
    const state = new WorkoutSyncSessionState(dir);
    try {
      assert.throws(() => new WorkoutSyncSessionState(dir));
      const version = state.version();
      const cap = state.bootstrap(a, version);
      const refreshed = state.bootstrap(a, state.version());
      state.require(refreshed, a);
      const moved = { ...a, endpoint: "https://new-api.test" };
      const movedCap = state.transition(cap, moved, () => {});
      assert.throws(() => state.require(refreshed, a));
      state.require(movedCap, moved);
      const next = state.transition(movedCap, b, () => {});
      assert.throws(() => state.transition(refreshed, a, () => {}));
      assert.throws(() => state.bootstrap(a, state.version()));
      assert.throws(() => state.bootstrap(b, version));
      state.require(next, b);
      state.logout(next, () => {});
      assert.throws(() => state.bootstrap(b, state.version()));
      const newA = { ...a, sessionId: "00000000-0000-0000-0000-000000000003" };
      state.require(state.bootstrap(newA, state.version()), newA);
    } finally { state.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("crash between revoking old and writing new active session fails closed after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-crash-"));
  try {
    const state = new WorkoutSyncSessionState(dir);
    state.bootstrap(a, state.version());
    const store = new SqliteWorkoutStore(principalDbPath(dir, a.accountId));
    new WorkoutSyncRepository(store).revokeSession(a);
    store.close();
    state.close();
    const restarted = new WorkoutSyncSessionState(dir);
    try {
      assert.throws(() => restarted.bootstrap(a, restarted.version()));
      assert.throws(() => restarted.bootstrap(b, restarted.version()), /recovery required/);
      assert.equal(restarted.confirmRevoked(b, () => {}), false);
      assert.equal(restarted.confirmRevoked(a, () => {}), true);
      const next = restarted.bootstrap(b, restarted.version());
      assert.equal(restarted.confirmRevoked(a, () => { throw new Error("must not cancel B"); }), true);
      restarted.require(next, b);
    } finally { restarted.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
