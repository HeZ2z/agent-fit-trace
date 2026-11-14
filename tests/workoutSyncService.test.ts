import { signedSyncToken, syncAuthFixture } from "./syncAuthFixture.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkoutSyncService } from "../server/workoutSyncService.ts";
import type { SyncScope } from "../packages/fit-trace-sync/src/types.ts";

const claims = { iss: "https://auth.test/auth/v1", sub: "account", role: "authenticated", aud: "authenticated", session_id: "00000000-0000-0000-0000-000000000001" };
const token = (session = claims.session_id) => signedSyncToken(JSON.stringify({ ...claims, session_id: session }));

test("expired signed bearer only confirms an already durable revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-sync-repeat-"));
  let online = true;
  const verifier = { async verify() { if (!online) throw new Error("expired"); return { id: "account", isAnonymous: false }; } };
  const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier });
  const expired = signedSyncToken(JSON.stringify({ ...claims, exp: 1 }));
  try {
    online = false;
    await assert.rejects(() => service.revokeVerifiedSession(expired));
    online = true;
    const cap = await service.bootstrap(token());
    service.logoutCapability(cap);
    online = false;
    await service.revokeVerifiedSession(expired);
    await assert.rejects(() => service.revokeVerifiedSession(expired.slice(0, -2) + "AA"));
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a delayed session ownership check cannot bootstrap after confirmed logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-sync-rpc-fence-"));
  let delay = false;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const service = new WorkoutSyncService({ dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1",
    verifier: { async verify() { return { id: "account", isAnonymous: false }; } },
    syncAuth: { ...syncAuthFixture, fetchImpl: async () => { if (delay) { started(); await pending; } return new Response("true"); } },
  });
  try {
    const capability = await service.bootstrap(token());
    delay = true;
    const late = service.bootstrap(token());
    await entered;
    service.logoutCapability(capability);
    release();
    await assert.rejects(late);
  } finally { service.close(); await rm(dir, { recursive: true, force: true }); }
});

test("manual sync downloads hosted records and uploads local records after consent", async () => {
  const { SqliteWorkoutStore, principalDbPath } = await import("@agent-fit-trace/store");
  const { validateWorkoutRecord } = await import("@agent-fit-trace/core");
  const { loadFixture } = await import("./helpers.ts");
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-roundtrip-"));
  try {
    const history = (await loadFixture<unknown[]>("history-strength.json")).map(item => validateWorkoutRecord(item).record);
    const local = new SqliteWorkoutStore(principalDbPath(dir, "account"));
    await local.import(history[0]);
    local.close();
    const remote = [history[1]];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method !== "POST") return new Response(JSON.stringify({ data: remote }), { status: 200 });
      const record = JSON.parse(String(init.body)).record;
      remote.push(record);
      return new Response(JSON.stringify({ data: { record, duplicate: false, warnings: [] } }), { status: 201 });
    };
    const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier, fetchImpl });
    try {
      const cap = await service.bootstrap(token());
      await service.consent(token(), cap, "https://api.test/api/v1");
      const result = await service.run(token(), cap);
      assert.equal(result.status, "done", JSON.stringify(result));
      assert.equal(result.counts.pulled, 1);
      assert.equal(result.counts.pushed, 1);
      const after = new SqliteWorkoutStore(principalDbPath(dir, "account"));
      try { assert.equal((await after.all()).length, 2); } finally { after.close(); }
      assert.equal(remote.length, 2);
      const again = await service.run(token(), cap);
      assert.equal(again.counts.pulled, 0);
      assert.equal(again.counts.pushed, 0);
    } finally { service.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("logout fences a verification begun before logout but completed afterward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-late-auth-"));
  try {
    let delay = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const verifier = { async verify() { if (delay) { delay = false; await held; } return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier });
    const cap = await service.bootstrap(token());
    await service.consent(token(), cap, "https://api.test/api/v1");
    delay = true;
    const late = service.status(token(), cap);
    service.logoutCapability(cap);
    release();
    await assert.rejects(late);
    await assert.rejects(() => service.bootstrap(token()));
    const next = token("00000000-0000-0000-0000-000000000002");
    const nextCap = await service.bootstrap(next);
    assert.equal((await service.status(next, nextCap)).enabled, true);
    service.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("logout aborts an in-flight upload and suppresses later requests", async () => {
  const { SqliteWorkoutStore, principalDbPath } = await import("@agent-fit-trace/store");
  const { validateWorkoutRecord } = await import("@agent-fit-trace/core");
  const { loadFixture } = await import("./helpers.ts");
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-abort-"));
  try {
    const store = new SqliteWorkoutStore(principalDbPath(dir, "account"));
    const history = (await loadFixture<unknown[]>("history-strength.json")).map(item => validateWorkoutRecord(item).record);
    await store.import(history[0]);
    await store.import(history[1]);
    store.close();
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    let posts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method !== "POST") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      posts++;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier, fetchImpl });
    const cap = await service.bootstrap(token());
    await service.consent(token(), cap, "https://api.test/api/v1");
    const run = service.run(token(), cap);
    await sending;
    service.logoutCapability(cap);
    assert.notEqual((await run).status, "done");
    assert.equal(posts, 1);
    service.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("verified capability can revoke a session without a live Auth request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-capability-"));
  try {
    let authAvailable = true;
    const verifier = { async verify() { if (!authAvailable) throw new Error("Auth unavailable"); return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier });
    const cap = await service.bootstrap(token());
    authAvailable = false;
    service.logoutCapability(cap);
    assert.throws(() => service.logoutCapability(cap));
    authAvailable = true;
    await assert.rejects(() => service.bootstrap(token()));
    service.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("guest import previews conflicts, preserves originals, and never uploads during import", async () => {
  const { SqliteWorkoutStore, principalDbPath } = await import("@agent-fit-trace/store");
  const { validateWorkoutRecord } = await import("@agent-fit-trace/core");
  const { loadFixture } = await import("./helpers.ts");
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-guest-import-"));
  try {
    const records = (await loadFixture<unknown[]>("history-strength.json")).map(item => validateWorkoutRecord(item).record);
    const guest = new SqliteWorkoutStore(principalDbPath(dir, "guest"));
    await guest.import(records[0]); await guest.import(records[1]); guest.close();
    const account = new SqliteWorkoutStore(principalDbPath(dir, "account"));
    const conflict = structuredClone(records[1]); conflict.exercises[0].sets[0].weight = 123;
    await account.import(conflict); account.close();
    let requests = 0;
    const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier, fetchImpl: async () => { requests++; throw new Error("unexpected network"); } });
    try {
      const cap = await service.bootstrap(token());
      const preview = await service.previewGuest(token(), cap);
      assert.equal(preview.copies, 1); assert.equal(preview.conflicts, 1);
      const result = await service.importGuest(token(), cap, preview.fingerprint);
      assert.equal(result.copied, 1); assert.equal(result.conflicts, 1); assert.equal(requests, 0);
      const afterGuest = new SqliteWorkoutStore(principalDbPath(dir, "guest"));
      const afterAccount = new SqliteWorkoutStore(principalDbPath(dir, "account"));
      assert.equal((await afterGuest.all()).length, 2);
      assert.deepEqual((await afterAccount.all()).find(item => item.id === conflict.id), conflict);
      afterGuest.close(); afterAccount.close();
      await assert.rejects(() => service.importGuest(token(), cap, preview.fingerprint));
    } finally { service.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bootstrap begun before logout cannot activate another session after logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-sync-late-bootstrap-"));
  try {
    let delay = false;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const verifier = { async verify() { if (delay) { delay = false; await pending; } return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier });
    try {
      const cap = await service.bootstrap(token());
      delay = true;
      const late = service.bootstrap(token("00000000-0000-0000-0000-000000000002"));
      service.logoutCapability(cap);
      release();
      await assert.rejects(late);
    } finally { service.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("network dispatch rejects an expired or replaced lease after the runner's earlier check", async (t) => {
  const { SqliteWorkoutStore, principalDbPath } = await import("@agent-fit-trace/store");
  const { WorkoutSyncRepository } = await import("../server/workoutSyncRepository.ts");
  const { validateWorkoutRecord } = await import("@agent-fit-trace/core");
  const { loadFixture } = await import("./helpers.ts");
  for (const scenario of ["expired", "replaced"] as const) {
    await t.test(scenario, async (subtest) => {
      const dir = await mkdtemp(join(tmpdir(), "fit-trace-dispatch-fence-"));
      try {
        const record = validateWorkoutRecord(await loadFixture("valid-strength.json")).record;
        const store = new SqliteWorkoutStore(principalDbPath(dir, "account"));
        await store.import(record);
        store.close();
        let requests = 0;
        const fetchImpl: typeof fetch = async (_input, init) => {
          requests++;
          if (init?.method === "POST") throw new Error("A stale run attempted an upload.");
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        };
        const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
        const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier, fetchImpl });
        try {
          const cap = await service.bootstrap(token());
          await service.consent(token(), cap, "https://api.test/api/v1");
          const original = WorkoutSyncRepository.prototype.isSyncEnabled;
          let checks = 0;
          subtest.mock.method(WorkoutSyncRepository.prototype, "isSyncEnabled", async function (this: InstanceType<typeof WorkoutSyncRepository>, scope: SyncScope) {
            const enabled = await original.call(this, scope);
            if (++checks === 2) {
              // After the runner checked the lease and consent but before its
              // token await resumes, make this worker's lease stale.
              const db = (this as unknown as { store: InstanceType<typeof SqliteWorkoutStore> }).store.db;
              db.exec(scenario === "expired"
                ? "UPDATE sync_lease SET expires_at = '2000-01-01T00:00:00.000Z'"
                : "UPDATE sync_lease SET owner = 'replacement', generation = generation + 1");
            }
            return enabled;
          });
          const result = await service.run(token(), cap);
          assert.notEqual(result.status, "done");
          assert.equal(checks, 2);
          assert.equal(requests, 1, "only the initial GET was dispatched");
        } finally { service.close(); }
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});

test("verified bearer revocation survives restart and leaves a later session untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-bearer-revoke-"));
  try {
    const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
    const options = { syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier };
    const oldToken = token();
    const newToken = token("00000000-0000-0000-0000-000000000002");
    const first = new WorkoutSyncService(options);
    const oldCap = await first.bootstrap(oldToken);
    first.close(); // Simulate losing all renderer and daemon capabilities.
    const second = new WorkoutSyncService(options);
    try {
      await second.revokeVerifiedSession(oldToken);
      await assert.rejects(() => second.bootstrap(oldToken));
      const newCap = await second.bootstrap(newToken);
      // A delayed old-session logout must not clear the new session.
      await second.revokeVerifiedSession(oldToken);
      assert.equal((await second.status(newToken, newCap)).enabled, false);
      assert.throws(() => second.logoutCapability(oldCap));
    } finally { second.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a late bearer verification cannot revoke a newer session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-late-bearer-revoke-"));
  try {
    let delay = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const verifier = { async verify() { if (delay) { delay = false; await held; } return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier });
    try {
      const old = token();
      const next = token("00000000-0000-0000-0000-000000000002");
      const cap = await service.bootstrap(old);
      delay = true;
      const late = service.revokeVerifiedSession(old);
      const nextCap = await service.transition(next, cap);
      release();
      await late;
      assert.equal((await service.status(next, nextCap)).enabled, false);
      await assert.rejects(() => service.bootstrap(old));
    } finally { service.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("verified bearer logout aborts a sent upload without claiming it did not commit", async () => {
  const { SqliteWorkoutStore, principalDbPath } = await import("@agent-fit-trace/store");
  const { validateWorkoutRecord } = await import("@agent-fit-trace/core");
  const { loadFixture } = await import("./helpers.ts");
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-bearer-abort-"));
  try {
    const store = new SqliteWorkoutStore(principalDbPath(dir, "account"));
    await store.import(validateWorkoutRecord(await loadFixture("valid-strength.json")).record);
    store.close();
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    let posts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method !== "POST") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      posts++;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier, fetchImpl });
    try {
      const cap = await service.bootstrap(token());
      await service.consent(token(), cap, "https://api.test/api/v1");
      const run = service.run(token(), cap);
      await sending;
      await service.revokeVerifiedSession(token());
      assert.notEqual((await run).status, "done");
      assert.equal(posts, 1); // A dispatched POST's remote commit is unknowable here.
    } finally { service.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("verified logout fences a session even if it never bootstrapped sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-never-active-revoke-"));
  try {
    const verifier = { async verify() { return { id: "account", isAnonymous: false }; } };
    const service = new WorkoutSyncService({ syncAuth: syncAuthFixture, dataDir: dir, supabaseUrl: "https://auth.test", endpoint: "https://api.test/api/v1", verifier });
    try {
      await service.revokeVerifiedSession(token());
      await assert.rejects(() => service.bootstrap(token()));
      const newSession = token("00000000-0000-0000-0000-000000000002");
      assert.ok(await service.bootstrap(newSession));
    } finally { service.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
