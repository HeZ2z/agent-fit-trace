import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COACHED_TOOL_NAMES,
  type CoachingEventPayload,
} from "@agent-fit-trace/api-contracts";
import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { loadFixture } from "./helpers.ts";
import {
  ProviderAcceptanceUnknownError,
  ProviderCancelledError,
  ProviderNotAcceptedError,
  ProviderRunFailedError,
  ProviderToolRefusedError,
  createOpenRouterProvider,
} from "../server/cloud/openRouterProvider.ts";
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  type OpenRouterConfig,
} from "../server/cloud/config.ts";

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

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function providerInput(
  overrides: Partial<Parameters<ReturnType<typeof createOpenRouterProvider>["run"]>[0]> = {},
) {
  const events: CoachingEventPayload[] = [];
  const accepted: unknown[] = [];
  return {
    events,
    accepted,
    input: {
      runId: "run-1",
      prompt: "Review my bench press.",
      records: [workout()],
      onAccepted: async (info: unknown) => {
        accepted.push(info);
      },
      onEvent: async (payload: CoachingEventPayload) => {
        events.push(payload);
      },
      beforeProviderRequest: async () => ({ allowed: true }),
      ...overrides,
    },
  };
}

test("openrouter: fixed official endpoint, fixture tool flow, text + deterministic analysis", async () => {
  const tool = await loadFixture("cloud/openrouter-analysis-tool.json");
  const final = await loadFixture("cloud/openrouter-final-text.json");
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response(calls.length === 1 ? tool : final);
    }) as typeof fetch,
  });
  const { input, events, accepted } = providerInput({ conversationContext: [{ role: "user", content: "Earlier knee pain" }] });
  const result = await provider.run(input);

  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
  const firstBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.match(JSON.stringify(firstBody.messages), /Earlier knee pain/);
  assert.match(JSON.stringify(firstBody.messages), /untrusted context/);
  assert.equal(firstBody.model, "test/model");
  assert.equal(firstBody.tool_choice, "auto");
  assert.equal(firstBody.parallel_tool_calls, false);
  assert.equal(firstBody.stream, false);
  assert.ok(Number(firstBody.max_tokens) <= CONFIG.maxTokensPerStep);
  assert.deepEqual(
    (firstBody.tools as { function: { name: string } }[]).map((toolDef) => toolDef.function.name),
    [...COACHED_TOOL_NAMES],
  );
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer test-openrouter-key",
  );

  assert.equal(result.status, "completed");
  assert.equal(result.usage.totalTokens, 145 + 202);
  assert.equal(result.usage.known, true);
  assert.equal(accepted.length, 1);
  assert.ok(events.some((event) => event.type === "tool_start" && event.tool === "analyze_progress"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.ok === true));
  const analysis = events.find((event) => event.type === "analysis_result");
  assert.ok(analysis?.type === "analysis_result");
  assert.deepEqual(analysis.result, analyzeProgress([workout()]));
  const text = events.find((event) => event.type === "text_delta");
  assert.ok(text?.type === "text_delta" && text.delta.includes("bench press"));
});

test("openrouter: unknown tool is refused and never executed", async () => {
  const forbidden = await loadFixture("cloud/openrouter-forbidden-tool.json");
  let calls = 0;
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async () => {
      calls += 1;
      return response(forbidden);
    }) as typeof fetch,
  });
  const { input, events } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderToolRefusedError,
  );
  assert.equal(calls, 1);
  assert.ok(events.some((event) => event.type === "run_error" && event.code === "TOOL_REFUSED"));
  assert.ok(!events.some((event) => event.type === "tool_start"));
});

test("openrouter: oversized response is rejected by a metered reader", async () => {
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async () =>
      new Response("x".repeat(1_000_001), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderAcceptanceUnknownError,
  );
});

test("openrouter: multibyte input above the byte cap is refused before any fetch", async () => {
  let calls = 0;
  const provider = createOpenRouterProvider({
    config: { ...CONFIG, maxInputBytes: 512 },
    fetchImpl: (async () => {
      calls += 1;
      return response({});
    }) as typeof fetch,
  });
  const { input } = providerInput({ prompt: "你".repeat(500) });
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderNotAcceptedError && error.accepted === false,
  );
  assert.equal(calls, 0);
});

test("openrouter: missing usage stays accounting-unknown, not a fabricated zero", async () => {
  const tool = await loadFixture("cloud/openrouter-analysis-no-usage.json");
  const final = await loadFixture("cloud/openrouter-final-no-usage.json");
  let calls = 0;
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async () => {
      calls += 1;
      return response(calls === 1 ? tool : final);
    }) as typeof fetch,
  });
  const { input } = providerInput();
  const result = await provider.run(input);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.known, false);
  assert.ok(result.usage.totalTokens > 0, "local stopping estimate is retained");
  assert.equal(calls, 2);
});

test("openrouter: cancellation after the first completion makes no second fetch", async () => {
  const tool = await loadFixture("cloud/openrouter-analysis-tool.json");
  let calls = 0;
  let authorizations = 0;
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async () => {
      calls += 1;
      return response(tool);
    }) as typeof fetch,
  });
  const { input } = providerInput({
    beforeProviderRequest: async () => {
      authorizations += 1;
      return authorizations === 1
        ? { allowed: true }
        : { allowed: false, cancelled: true };
    },
  });
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderCancelledError &&
      error.dispatched === true &&
      error.usage.totalTokens === 145,
  );
  assert.equal(calls, 1, "no paid request may follow the cancellation");
});

test("openrouter: transport failure is acceptance-unknown and is never retried", async () => {
  let calls = 0;
  const provider = createOpenRouterProvider({
    config: CONFIG,
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("socket closed");
    }) as typeof fetch,
  });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderAcceptanceUnknownError,
  );
  assert.equal(calls, 1);
});
