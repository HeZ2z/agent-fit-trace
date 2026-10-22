import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import type { WorkoutRecord } from "@agent-fit-trace/core";
import { validateWorkoutRecord } from "@agent-fit-trace/core";
import type { CloudCoachingProvider, ProviderRunInput, ProviderSuccess } from "../server/cloud/openRouterProvider.ts";
import {
  ProviderAcceptanceUnknownError,
  ProviderCancelledError,
  ProviderNotAcceptedError,
  ProviderRunFailedError,
} from "../server/cloud/openRouterProvider.ts";
import { createCloudOutboxWorker } from "../server/cloud/outboxWorker.ts";
import type { CloudUsage } from "../server/cloud/repository.ts";
import { FakeCloudDatabase } from "./cloudFakes.ts";

function record(): WorkoutRecord {
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

async function seedRun(
  db: FakeCloudDatabase,
  key = "idem-1",
): Promise<{ runId: string; request: ReturnType<FakeCloudDatabase["requestRepository"]> }> {
  const request = db.requestRepository();
  const session = await request.createSession("sess-1");
  const snapshot = await request.createSnapshot([record()], {});
  const submitted = await request.submitRun({
    runId: `run-${key}`,
    sessionId: session.id,
    prompt: "Analyse bench press.",
    idempotencyKey: key,
    snapshot: {
      snapshotId: snapshot.snapshotId,
      source: snapshot.source,
      accountId: snapshot.accountId,
    },
  });
  return { runId: submitted.run.id, request };
}

function usage(total: number): CloudUsage {
  return {
    promptTokens: total - 20,
    completionTokens: 20,
    totalTokens: total,
    known: true,
  };
}

function makeWorker(
  db: FakeCloudDatabase,
  provider: CloudCoachingProvider,
  enabled = true,
) {
  return createCloudOutboxWorker({
    repository: db.workerRepository(),
    provider,
    enabled,
    workerId: "worker-1",
    leaseMs: 60_000,
    batch: 4,
  });
}

const successProvider: CloudCoachingProvider = {
  async run(input: ProviderRunInput): Promise<ProviderSuccess> {
    await input.beforeProviderRequest();
    await input.onAccepted({ generationId: "gen-1", usage: usage(145) });
    await input.onEvent({ type: "text_delta", delta: "done" });
    return { status: "completed", usage: usage(145), generationId: "gen-1" };
  },
};

test("worker: success settles once and releases the completed reservation", async () => {
  const db = new FakeCloudDatabase();
  const { runId } = await seedRun(db);
  const worker = makeWorker(db, successProvider);

  const first = await worker.tick();
  assert.equal(first.completed, 1);
  assert.equal(db.getRun(runId).status, "completed");
  assert.equal(db.ledger.size, 1);
  assert.equal(db.ledger.get(runId)?.totalTokens, 145);
  assert.equal(db.reservedCount, 0);

  const second = await worker.tick();
  assert.equal(second.claimed, 0);
  assert.equal(db.ledger.size, 1);
});

test("worker: cancellation after first completion stops before second fetch and stays unconfirmed", async () => {
  const db = new FakeCloudDatabase();
  const { runId, request } = await seedRun(db, "cancel");
  let providerCalls = 0;
  const provider: CloudCoachingProvider = {
    async run(input) {
      providerCalls += 1;
      const first = await input.beforeProviderRequest();
      assert.equal(first.allowed, true);
      await input.onAccepted({ generationId: "gen-cancel", usage: usage(145) });
      // The user cancels after the provider accepted/completed one step.
      await request.cancelRun(runId, "stop now");
      const second = await input.beforeProviderRequest();
      assert.equal(second.cancelled, true);
      throw new ProviderCancelledError(usage(145), "gen-cancel", true);
    },
  };
  const worker = makeWorker(db, provider);
  const result = await worker.tick();

  assert.equal(providerCalls, 1);
  assert.equal(result.unconfirmed, 1);
  const run = db.getRun(runId);
  assert.equal(run.status, "unconfirmed");
  assert.equal(run.terminationConfirmed, false);
  assert.equal(run.reservationReleased, false);
  assert.equal(db.reservedCount, 1);
  assert.equal(db.ledger.get(runId)?.totalTokens, 145);
  const terminal = db.getEvents(runId).at(-1);
  assert.equal(terminal?.event.type, "terminal");
  assert.ok(terminal?.event.type === "terminal" && terminal.event.status !== "cancelled");
});

test("worker: lease expiry at settlement writes nothing and later reaps unconfirmed", async () => {
  const db = new FakeCloudDatabase();
  const { runId } = await seedRun(db, "lease");
  const provider: CloudCoachingProvider = {
    async run(input) {
      await input.beforeProviderRequest();
      await input.onAccepted({ generationId: "gen-lease", usage: usage(145) });
      db.expireLease(runId);
      return { status: "completed", usage: usage(145), generationId: "gen-lease" };
    },
  };
  const worker = makeWorker(db, provider);
  const first = await worker.tick();
  assert.equal(first.failed, 1, "lease loss is not retried inside the tick");
  assert.equal(db.ledger.size, 0);
  assert.equal(db.getRun(runId).status, "running");

  const second = await worker.tick();
  assert.equal(second.claimed, 0);
  const run = db.getRun(runId);
  assert.equal(run.status, "unconfirmed");
  assert.equal(run.reservationReleased, false);
  assert.equal(db.reservedCount, 1);
  assert.equal(db.outboxFor(runId).status, "dead");
  const terminal = db.getEvents(runId).at(-1);
  assert.ok(terminal?.event.type === "terminal" && terminal.event.status === "failed");
  assert.match(terminal?.event.type === "terminal" ? (terminal.event.reason ?? "") : "", /unconfirmed/);
});

test("worker: acceptance-unknown never redispatches or refunds, even on later ticks", async () => {
  const db = new FakeCloudDatabase();
  const { runId } = await seedRun(db, "unknown");
  let calls = 0;
  const provider: CloudCoachingProvider = {
    async run(input) {
      calls += 1;
      await input.beforeProviderRequest();
      await input.onAccepted({ generationId: "gen-unknown", usage: usage(30) });
      throw new ProviderAcceptanceUnknownError("transport outcome unknown");
    },
  };
  const worker = makeWorker(db, provider);
  const first = await worker.tick();
  assert.equal(first.unconfirmed, 1);
  assert.equal(db.getRun(runId).status, "unconfirmed");
  assert.equal(db.reservedCount, 1);

  const second = await worker.tick();
  assert.equal(second.claimed, 0);
  assert.equal(calls, 1, "no provider re-dispatch");
  assert.equal(db.outboxFor(runId).status, "dead");
});

test("worker: unknown later-step usage retains the possibly-billed remainder", async () => {
  const db = new FakeCloudDatabase({ perRunTokenBudget: 10_000 });
  const { runId } = await seedRun(db, "unknown-later");
  const firstStepUsage: CloudUsage = {
    promptTokens: 80,
    completionTokens: 20,
    totalTokens: 100,
    known: true,
    complete: true,
  };
  const provider: CloudCoachingProvider = {
    async run(input) {
      await input.beforeProviderRequest();
      await input.onAccepted({ generationId: "gen-later", usage: firstStepUsage });
      // A second request was dispatched and timed out. Its billing outcome is
      // unknown, so the first step's complete usage must not unlock a refund
      // of the whole allocation.
      throw new ProviderAcceptanceUnknownError("second provider step timed out", {
        usage: firstStepUsage,
        generationId: "gen-later",
        accepted: true,
        dispatched: true,
      });
    },
  };
  const worker = makeWorker(db, provider);
  const result = await worker.tick();
  assert.equal(result.unconfirmed, 1);
  const run = db.getRun(runId);
  assert.equal(run.status, "unconfirmed");
  assert.equal(run.reservationReleased, false);
  assert.equal(run.budgetReleased, false);
  // The known first step is charged, but the rest of the allocation stays
  // reserved for the possibly-billed later step.
  assert.equal(db.ledger.get(runId)?.totalTokens, 100);
  assert.equal(db.ledger.get(runId)?.complete, false);
  assert.equal(db.tokensReserved, 9_900);
});

test("worker: definitive provider rejection refunds and terminates failed", async () => {
  const db = new FakeCloudDatabase();
  const { runId } = await seedRun(db, "reject");
  const provider: CloudCoachingProvider = {
    async run(input) {
      await input.beforeProviderRequest();
      throw new ProviderNotAcceptedError("HTTP 400");
    },
  };
  const worker = makeWorker(db, provider);
  const result = await worker.tick();
  assert.equal(result.failed, 1);
  const run = db.getRun(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.terminationConfirmed, true);
  assert.equal(run.reservationReleased, true);
  assert.equal(db.reservedCount, 0);
});

test("worker: accepted run failure settles usage but retains the reservation", async () => {
  const db = new FakeCloudDatabase();
  const { runId } = await seedRun(db, "accepted-fail");
  const provider: CloudCoachingProvider = {
    async run(input) {
      await input.beforeProviderRequest();
      await input.onAccepted({ generationId: "gen-fail", usage: usage(90) });
      throw new ProviderRunFailedError("ANALYSIS_REQUIRED", "no analysis", usage(90), "gen-fail");
    },
  };
  const worker = makeWorker(db, provider);
  const result = await worker.tick();
  assert.equal(result.failed, 1);
  const run = db.getRun(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.reservationReleased, false);
  assert.equal(db.ledger.get(runId)?.totalTokens, 90);
  assert.equal(db.reservedCount, 1);
});

test("worker: missing usage is never settled as actual billed zero", async () => {
  const db = new FakeCloudDatabase();
  const { runId } = await seedRun(db, "no-usage");
  const unknownUsage: CloudUsage = {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    known: false,
  };
  const provider: CloudCoachingProvider = {
    async run(input) {
      await input.beforeProviderRequest();
      await input.onAccepted({ usage: unknownUsage });
      return { status: "completed", usage: unknownUsage };
    },
  };
  const worker = makeWorker(db, provider);
  const result = await worker.tick();
  assert.equal(result.completed, 1);
  assert.equal(db.getRun(runId).status, "completed");
  assert.equal(db.ledger.size, 0, "accounting stays pending, no fabricated charge");
});

test("worker: kill switch claims nothing", async () => {
  const db = new FakeCloudDatabase();
  await seedRun(db, "kill");
  const worker = makeWorker(db, successProvider, false);
  const result = await worker.tick();
  assert.equal(result.disabled, true);
  assert.equal(result.claimed, 0);
  assert.equal(db.outboxFor("run-kill").status, "pending");
});

/** Run a throwaway ESM script in a child so process liveness is observable. */
function runNodeModule(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("worker loop: the referenced poll timer keeps an idle standalone process alive", async () => {
  // A real child process makes the assertion about liveness: with an unref'd
  // polling timer, an empty tick leaves no handle and the process exits before
  // the second tick. The fake tick returns no jobs and aborts after three, so
  // only the loop's own timer can keep it alive.
  const moduleUrl = new URL("../server/cloud/outboxWorker.ts", import.meta.url).href;
  const script = `
    import { runCloudWorkerLoop } from ${JSON.stringify(moduleUrl)};
    const controller = new AbortController();
    let ticks = 0;
    const empty = {
      disabled: false, claimed: 0, completed: 0, failed: 0, cancelled: 0, unconfirmed: 0,
    };
    await runCloudWorkerLoop({
      tick: async () => {
        ticks += 1;
        console.log("tick:" + ticks);
        if (ticks === 3) controller.abort();
        return empty;
      },
      pollMs: 100,
      signal: controller.signal,
    });
    console.log("done");
  `;
  const result = await runNodeModule(script);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    (result.stdout.match(/^tick:/gm) ?? []).length,
    3,
    `expected three empty ticks, got: ${result.stdout}${result.stderr}`,
  );
  assert.match(result.stdout, /^done$/m);
});
