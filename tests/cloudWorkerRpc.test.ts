import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkoutRecord } from "@pi-fit-trace/core";
import { validateWorkoutRecord } from "@pi-fit-trace/core";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../server/cloud/config.ts";
import type { OpenRouterConfig } from "../server/cloud/config.ts";
import { createOpenRouterProvider } from "../server/cloud/openRouterProvider.ts";
import type { CloudCoachingProvider, ProviderRunInput } from "../server/cloud/openRouterProvider.ts";
import { createCloudOutboxWorker } from "../server/cloud/outboxWorker.ts";
import { createSupabaseCoachingWorkerRepository } from "../server/cloud/supabaseCoachingRepository.ts";
import { FakeCloudDatabase } from "./cloudFakes.ts";
import { loadFixture } from "./helpers.ts";

/**
 * Worker + real RPC adapter tests.
 *
 * The worker talks to `createSupabaseCoachingWorkerRepository` (the same code
 * used by the worker entrypoint), and a fake `fetch` implements the actual
 * RPC names/argument shapes with the SQL invariants mirrored by the fake
 * database. This covers claim -> mark call -> authorize step -> accepted ->
 * append -> settle -> terminal, plus cancellation, lease expiry, and reaping
 * without a live database. The opt-in `supabaseIntegration.test.ts` suite is
 * still the place that proves Postgres/RLS execution.
 */

const CONFIG: OpenRouterConfig = {
  apiKey: "test-openrouter-key",
  model: "test/model",
  baseUrl: "https://openrouter.ai/api/v1",
  endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
  maxSteps: 4,
  maxTokens: 2048,
  maxTokensPerStep: 512,
  maxInputBytes: 256 * 1024,
  timeoutMs: 5_000,
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wireRun(db: FakeCloudDatabase, runId: string): unknown {
  return structuredClone(db.getRun(runId));
}

interface RpcHarness {
  fetchImpl: typeof fetch;
  calls: { name: string; args: Record<string, unknown> }[];
}

/** Speak the worker RPC names the Supabase repository actually calls. */
function workerRpcFetch(db: FakeCloudDatabase): RpcHarness {
  const worker = db.workerRepository();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const name = url.slice(url.lastIndexOf("/") + 1);
    const args = (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>) ?? {};
    calls.push({ name, args });
    try {
      switch (name) {
        case "coaching_claim_outbox": {
          const jobs = await worker.claimOutbox(
            String(args.p_worker_id),
            Number(args.p_lease_ms),
            Number(args.p_limit),
          );
          return json(
            200,
            jobs.map((job) => ({
              run: wireRun(db, job.run.id),
              leaseGeneration: job.leaseGeneration,
              attempt: job.attempt,
            })),
          );
        }
        case "coaching_mark_provider_call": {
          return json(
            200,
            await worker.markProviderCallStarted(
              String(args.p_run_id),
              Number(args.p_generation),
            ),
          );
        }
        case "coaching_mark_provider_accepted": {
          await worker.markProviderAccepted(String(args.p_run_id), Number(args.p_generation), {
            ...(typeof args.p_generation_id === "string"
              ? { generationId: args.p_generation_id }
              : {}),
          });
          return json(200, wireRun(db, String(args.p_run_id)));
        }
        case "coaching_authorize_provider_step": {
          return json(
            200,
            await worker.authorizeProviderStep(
              String(args.p_run_id),
              Number(args.p_generation),
              {
                tokens: Number(args.p_step_tokens),
                requests: Number(args.p_step_requests),
              },
            ),
          );
        }
        case "coaching_append_event": {
          const seq = await worker.appendEvent(
            String(args.p_run_id),
            Number(args.p_generation),
            args.p_payload as never,
          );
          return json(200, { seq });
        }
        case "coaching_terminate_run": {
          const result = await worker.terminateRun(
            String(args.p_run_id),
            Number(args.p_generation),
            {
              status: args.p_status as never,
              ...(typeof args.p_reason === "string" ? { reason: args.p_reason } : {}),
              terminationConfirmed: args.p_termination_confirmed === true,
              releaseReservation: args.p_release_reservation === true,
              provenNotAccepted: args.p_proven_not_accepted === true,
              ...(typeof args.p_failure_code === "string"
                ? {
                    failure: {
                      code: args.p_failure_code,
                      message: String(args.p_failure_message ?? ""),
                    },
                  }
                : {}),
            },
          );
          return json(200, {
            run: wireRun(db, result.run.id),
            lastSeq: result.lastSeq,
          });
        }
        case "coaching_settle_usage": {
          return json(
            200,
            await worker.settleUsage(String(args.p_run_id), Number(args.p_generation), {
              promptTokens: Number(args.p_prompt_tokens),
              completionTokens: Number(args.p_completion_tokens),
              totalTokens: Number(args.p_total_tokens),
              known: true,
              complete: args.p_usage_complete === true,
              ...(typeof args.p_cost_usd === "number" ? { costUsd: args.p_cost_usd } : {}),
              ...(typeof args.p_generation_id === "string"
                ? { generationId: args.p_generation_id }
                : {}),
            }),
          );
        }
        case "coaching_release_reservation": {
          await worker.releaseReservation(
            String(args.p_run_id),
            Number(args.p_generation),
            args.p_proven_not_accepted === true,
          );
          return json(200, { released: true });
        }
        default:
          return json(404, { message: "PGRST202 unknown RPC" });
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code === "LEASE_LOST") {
        return json(409, { message: "CLOUD_LEASE_LOST" });
      }
      if (code === "RUN_NOT_FOUND") {
        return json(404, { message: "CLOUD_RUN_NOT_FOUND" });
      }
      return json(400, { message: `CLOUD_${code}` });
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function seedRun(db: FakeCloudDatabase, key = "idem-1"): Promise<string> {
  const request = db.requestRepository();
  const session = await request.createSession("sess-1");
  const snapshot = await request.createSnapshot([workout()], {});
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
  return submitted.run.id;
}

function workerFor(db: FakeCloudDatabase, provider: CloudCoachingProvider, harness: RpcHarness) {
  return createCloudOutboxWorker({
    repository: createSupabaseCoachingWorkerRepository({
      supabaseUrl: "http://db.invalid",
      serviceRoleKey: "service-role-test",
      fetchImpl: harness.fetchImpl,
    }),
    provider,
    enabled: true,
    workerId: "worker-rpc",
    leaseMs: 60_000,
    batch: 1,
  });
}

test("worker RPC: real adapter drives claim -> call -> authorize -> accepted -> append -> settle -> terminal", async () => {
  const db = new FakeCloudDatabase({ perRunTokenBudget: 10_000, perStepTokenBudget: 4_096 });
  const runId = await seedRun(db);
  const harness = workerRpcFetch(db);
  const budgets: number[] = [];
  const provider: CloudCoachingProvider = {
    async run(input: ProviderRunInput) {
      const first = await input.beforeProviderRequest({ tokens: 300, requests: 1 });
      assert.equal(first.allowed, true);
      budgets.push(300);
      await input.onAccepted({ generationId: "gen-rpc", usage: usage(145) });
      await input.onEvent({ type: "text_delta", delta: "done" });
      return { status: "completed", usage: usage(145), generationId: "gen-rpc" };
    },
  };

  const result = await workerFor(db, provider, harness).tick();
  assert.equal(result.completed, 1);
  assert.deepEqual(
    harness.calls.map((call) => call.name),
    [
      "coaching_claim_outbox",
      "coaching_mark_provider_call",
      "coaching_authorize_provider_step",
      "coaching_mark_provider_accepted",
      "coaching_append_event",
      "coaching_settle_usage",
      "coaching_terminate_run",
    ],
  );
  const authorize = harness.calls.find((call) => call.name === "coaching_authorize_provider_step");
  assert.equal(authorize?.args.p_step_tokens, 300);
  assert.equal(authorize?.args.p_step_requests, 1);
  assert.deepEqual(budgets, [300]);
  assert.equal(db.getRun(runId).status, "completed");
  assert.equal(db.ledger.get(runId)?.totalTokens, 145);
  assert.equal(db.reservedCount, 0);
  assert.equal(db.tokensReserved, 0, "known complete settlement releases the whole allocation");
  const settle = harness.calls.find((call) => call.name === "coaching_settle_usage");
  assert.equal(settle?.args.p_usage_complete, true);
});

test("worker RPC: second-step 4xx after acceptance settles known usage and retains the concurrency reservation", async () => {
  const db = new FakeCloudDatabase({ perRunTokenBudget: 10_000, perStepTokenBudget: 4_096 });
  const runId = await seedRun(db, "second-4xx");
  const harness = workerRpcFetch(db);
  const tool = await loadFixture("cloud/openrouter-analysis-tool.json");
  let calls = 0;
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1 ? json(200, tool) : json(400, { error: "bad follow-up" });
    }) as typeof fetch,
  });

  const result = await workerFor(db, provider, harness).tick();
  assert.equal(result.failed, 1);
  const run = db.getRun(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.terminationConfirmed, true);
  assert.equal(run.reservationReleased, false, "an accepted generation is never refunded as free");
  assert.equal(db.reservedCount, 1);
  assert.equal(db.ledger.get(runId)?.totalTokens, 145);
  assert.equal(db.ledger.get(runId)?.complete, true);
  assert.equal(db.tokensUsed, 145);
  const terminal = db.getEvents(runId).at(-1);
  assert.ok(terminal?.event.type === "terminal" && terminal.event.status === "failed");
  assert.match(
    terminal?.event.type === "terminal" ? (terminal.event.reason ?? "") : "",
    /later step/,
  );
});

test("worker RPC: cancellation after acceptance settles usage, makes no second fetch, and stays unconfirmed", async () => {
  const db = new FakeCloudDatabase({ perRunTokenBudget: 10_000, perStepTokenBudget: 4_096 });
  const runId = await seedRun(db, "cancel-rpc");
  const harness = workerRpcFetch(db);
  const request = db.requestRepository();
  let fetches = 0;
  const provider: CloudCoachingProvider = {
    async run(input) {
      const first = await input.beforeProviderRequest({ tokens: 300, requests: 1 });
      assert.equal(first.allowed, true);
      fetches += 1;
      await input.onAccepted({ generationId: "gen-cancel", usage: usage(145) });
      await request.cancelRun(runId, "stop now");
      const second = await input.beforeProviderRequest({ tokens: 300, requests: 1 });
      assert.equal(second.cancelled, true);
      throw new (await import("../server/cloud/openRouterProvider.ts")).ProviderCancelledError(
        usage(145),
        "gen-cancel",
        true,
      );
    },
  };

  const result = await workerFor(db, provider, harness).tick();
  assert.equal(result.unconfirmed, 1);
  assert.equal(fetches, 1);
  const run = db.getRun(runId);
  assert.equal(run.status, "unconfirmed");
  assert.equal(run.terminationConfirmed, false);
  assert.equal(run.reservationReleased, false);
  assert.equal(db.reservedCount, 1);
  assert.equal(db.ledger.get(runId)?.totalTokens, 145);
});

test("worker RPC: expired lease at settlement writes nothing; reaper later marks unconfirmed without a provider call", async () => {
  const db = new FakeCloudDatabase({ perRunTokenBudget: 10_000, perStepTokenBudget: 4_096 });
  const runId = await seedRun(db, "lease-rpc");
  const harness = workerRpcFetch(db);
  let fetches = 0;
  const provider: CloudCoachingProvider = {
    async run(input) {
      fetches += 1;
      const first = await input.beforeProviderRequest({ tokens: 300, requests: 1 });
      assert.equal(first.allowed, true);
      await input.onAccepted({ generationId: "gen-lease", usage: usage(145) });
      db.expireLease(runId);
      return { status: "completed", usage: usage(145), generationId: "gen-lease" };
    },
  };

  const worker = workerFor(db, provider, harness);
  const first = await worker.tick();
  assert.equal(first.failed, 1, "lease loss is not retried in the same tick");
  assert.equal(db.ledger.size, 0);
  assert.equal(db.getRun(runId).status, "running");
  assert.equal(db.tokensReserved, 10_000, "no stale settlement or refund");

  const second = await worker.tick();
  assert.equal(second.claimed, 0);
  assert.equal(fetches, 1, "the reaper never calls the provider");
  const run = db.getRun(runId);
  assert.equal(run.status, "unconfirmed");
  assert.equal(run.reservationReleased, false);
  assert.equal(db.reservedCount, 1);
  assert.equal(db.tokensReserved, 10_000);
  assert.equal(db.outboxFor(runId).status, "dead");
});

function usage(total: number) {
  return {
    promptTokens: total - 20,
    completionTokens: 20,
    totalTokens: total,
    known: true,
    knownTokens: total,
    knownPromptTokens: total - 20,
    knownCompletionTokens: 20,
    complete: true,
  };
}
