import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentOptions, StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { COACHED_TOOL_NAMES, type CoachingEventPayload } from "@agent-fit-trace/api-contracts";
import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  ProviderAcceptanceUnknownError,
  ProviderCancelledError,
  ProviderNotAcceptedError,
  ProviderRunFailedError,
  ProviderToolRefusedError,
} from "../server/cloud/openRouterProvider.ts";
import { createPiAgentProvider } from "../server/cloud/piAgentProvider.ts";
import { createCloudOutboxWorker } from "../server/cloud/outboxWorker.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL, type OpenRouterConfig } from "../server/cloud/config.ts";
import { FakeCloudDatabase } from "./cloudFakes.ts";

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

interface ChatChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function sseResponse(chunks: unknown[], status = 200): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function textAndUsage(text: string, id: string, usage: ChatChunk["usage"]): ChatChunk[] {
  return [
    {
      id,
      model: "test/model",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id,
      model: "test/model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(usage === undefined ? {} : { usage }),
    },
  ];
}

function toolCallAndUsage(
  name: string,
  args: string,
  callId: string,
  id: string,
  usage: ChatChunk["usage"],
): ChatChunk[] {
  return [
    {
      id,
      model: "test/model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: callId, type: "function", function: { name, arguments: args } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      model: "test/model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      ...(usage === undefined ? {} : { usage }),
    },
  ];
}

interface FakeFetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

function fakeFetch(
  handler: (call: FakeFetchCall, index: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: FakeFetchCall = {
      url: String(url),
      init: init ?? {},
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function providerInput(overrides: Record<string, unknown> = {}) {
  const events: CoachingEventPayload[] = [];
  const accepted: Array<{ generationId?: string; usage?: unknown }> = [];
  const timeline: string[] = [];
  const authorizations: unknown[] = [];
  return {
    events,
    accepted,
    timeline,
    authorizations,
    input: {
      runId: "run-1",
      prompt: "Review my bench press.",
      records: [workout()],
      onAccepted: async (info: { generationId?: string; usage?: unknown }) => {
        timeline.push("accepted");
        accepted.push(info);
      },
      onEvent: async (payload: CoachingEventPayload) => {
        timeline.push(`event:${payload.type}`);
        events.push(payload);
      },
      beforeProviderRequest: async (budget?: unknown) => {
        timeline.push("authorize");
        authorizations.push(budget);
        return { allowed: true };
      },
      ...overrides,
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("pi-agent: happy path runs the real loop, emits bounded events, and settles provider usage", async () => {
  const analysisCall = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  const final = textAndUsage("Bench press is progressing steadily.", "gen-2", {
    prompt_tokens: 150,
    completion_tokens: 30,
    total_tokens: 180,
  });
  const { fetchImpl, calls } = fakeFetch((_call, index) =>
    sseResponse(index === 0 ? analysisCall : final),
  );
  let captured: AgentOptions | undefined;
  const provider = createPiAgentProvider({
    config: CONFIG,
    fetchImpl,
    agentFactory: (options) => {
      captured = options;
      return new Agent(options);
    },
  });
  const { input, events, accepted, timeline } = providerInput();
  const result = await provider.run(input);

  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, {
    promptTokens: 250,
    completionTokens: 50,
    totalTokens: 300,
    known: true,
    knownTokens: 300,
    knownPromptTokens: 250,
    knownCompletionTokens: 50,
    complete: true,
  });
  assert.equal(result.generationId, "gen-2");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, OPENROUTER_CHAT_COMPLETIONS_URL);
    assert.equal(call.body?.model, "test/model");
    assert.equal(call.body?.stream, true);
    assert.ok(Number(call.body?.max_completion_tokens) <= CONFIG.maxTokensPerStep);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), "Bearer test-openrouter-key");
  }

  // The DB gate runs before every wire request and is charged a finite budget.
  assert.equal(timeline.filter((entry) => entry === "authorize").length, 2);
  assert.ok(timeline.indexOf("authorize") < timeline.indexOf("event:text_delta"));
  // Acceptance is marked before tool execution.
  assert.equal(accepted.length, 1);
  assert.ok(timeline.indexOf("accepted") < timeline.indexOf("event:tool_start"));
  assert.equal((accepted[0]?.usage as { totalTokens: number }).totalTokens, 120);
  assert.equal(accepted[0]?.generationId, "gen-1");

  const toolStart = events.find((event) => event.type === "tool_start");
  assert.ok(toolStart?.type === "tool_start");
  assert.equal(toolStart.tool, "analyze_progress");
  assert.equal(toolStart.callId, "call-1");
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd?.type === "tool_end" && toolEnd.ok === true);
  assert.equal(toolEnd.callId, "call-1");
  const analysis = events.find((event) => event.type === "analysis_result");
  assert.ok(analysis?.type === "analysis_result");
  assert.deepEqual(analysis.result, analyzeProgress([workout()]));
  const deltas = events.flatMap((event) =>
    event.type === "text_delta" ? [event.delta] : [],
  );
  assert.ok(deltas.join("").includes("progressing steadily"));
  assert.ok(!events.some((event) => event.type === "run_error"));

  // The embedded loop is exactly the two deterministic read-only tools and the
  // run id is the pi session id.
  assert.ok(captured !== undefined);
  assert.equal(captured?.sessionId, "run-1");
  assert.equal(captured?.toolExecution, "sequential");
  assert.equal(captured?.initialState?.model?.id, "test/model");
  assert.deepEqual(
    captured?.initialState?.tools?.map((tool) => tool.name),
    [...COACHED_TOOL_NAMES],
  );
  assert.match(captured?.initialState?.systemPrompt ?? "", /read-only training analyst/);
});

test("pi-agent: tool execution and the next request wait for the acceptance write", async () => {
  const analysisCall = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  const final = textAndUsage("Bench press is progressing steadily.", "gen-2", {
    prompt_tokens: 150,
    completion_tokens: 30,
    total_tokens: 180,
  });
  const { fetchImpl, calls } = fakeFetch((_call, index) =>
    sseResponse(index === 0 ? analysisCall : final),
  );
  const harness = providerInput();
  let releaseAcceptance: (() => void) | undefined;
  const acceptanceGate = new Promise<void>((resolve) => {
    releaseAcceptance = resolve;
  });
  harness.input.onAccepted = async () => {
    harness.timeline.push("accepted-start");
    await acceptanceGate;
    harness.timeline.push("accepted-end");
  };

  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const runPromise = provider.run(harness.input);
  await waitUntil(() => harness.timeline.includes("accepted-start"));

  // The durable acceptance write is held open: no tool may execute and no
  // second paid provider request may start before it completes.
  assert.equal(harness.events.some((event) => event.type === "tool_start"), false);
  assert.equal(calls.length, 1);

  releaseAcceptance?.();
  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);

  const acceptedEnd = harness.timeline.indexOf("accepted-end");
  const toolStart = harness.timeline.indexOf("event:tool_start");
  assert.ok(acceptedEnd >= 0);
  assert.ok(toolStart > acceptedEnd, "tool execution must start after the acceptance write resolves");
});

test("pi-agent: a failed acceptance write stops before tool execution and stays acceptance-unknown", async () => {
  const analysisCall = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  const { fetchImpl, calls } = fakeFetch(() => sseResponse(analysisCall));
  const harness = providerInput();
  harness.input.onAccepted = async () => {
    harness.timeline.push("accepted-failed");
    throw new Error("acceptance write failed");
  };
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });

  await assert.rejects(
    provider.run(harness.input),
    (error: unknown) =>
      error instanceof ProviderAcceptanceUnknownError &&
      error.accepted === true &&
      error.dispatched === true &&
      error.usage?.totalTokens === 120,
  );
  assert.equal(calls.length, 1);
  assert.equal(harness.events.some((event) => event.type === "tool_start"), false);
  assert.equal(harness.events.some((event) => event.type === "terminal"), false);
});

test("pi-agent: a denied pre-fetch step never reaches the wire", async () => {
  const { fetchImpl, calls } = fakeFetch(() => sseResponse([]));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input, accepted } = providerInput({
    beforeProviderRequest: async () => ({ allowed: false, cancelled: true }),
  });
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderCancelledError && error.dispatched === false && error.usage.totalTokens === 0,
  );
  assert.equal(calls.length, 0);
  assert.equal(accepted.length, 0);
});

test("pi-agent: a terminal pre-fetch step reports ownership loss", async () => {
  const { fetchImpl, calls } = fakeFetch(() => sseResponse([]));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input } = providerInput({
    beforeProviderRequest: async () => ({ allowed: false, terminal: true }),
  });
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof Error && error.name === "ProviderOwnershipLostError",
  );
  assert.equal(calls.length, 0);
});

test("pi-agent: transport failure after dispatch is acceptance-unknown and is never retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error("socket closed");
  }) as typeof fetch;
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input, accepted } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderAcceptanceUnknownError &&
      error.dispatched === true &&
      error.accepted === false,
  );
  assert.equal(calls, 1);
  assert.equal(accepted.length, 0);
});

test("pi-agent: a first-request HTTP 400 is proven not-accepted", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response("bad request", { status: 400 }));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderNotAcceptedError && error.accepted === false,
  );
  assert.equal(calls.length, 1);
});

test("pi-agent: HTTP 429 is acceptance-unknown and is never retried", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response("rate limited", { status: 429 }));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderAcceptanceUnknownError,
  );
  assert.equal(calls.length, 1);
});

test("pi-agent: max steps after acceptance is a billed run failure", async () => {
  const analysis = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  const history = toolCallAndUsage("get_training_history", "{}", "call-2", "gen-2", {
    prompt_tokens: 120,
    completion_tokens: 20,
    total_tokens: 140,
  });
  const { fetchImpl, calls } = fakeFetch((_call, index) =>
    sseResponse(index === 0 ? analysis : history),
  );
  const provider = createPiAgentProvider({
    config: { ...CONFIG, maxSteps: 2 },
    fetchImpl,
  });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderRunFailedError &&
      error.code === "MAX_STEPS" &&
      error.usage.totalTokens === 260,
  );
  assert.equal(calls.length, 2, "the third request must be refused before dispatch");
});

test("pi-agent: timeout after acceptance is acceptance-unknown, not a refund", async () => {
  const analysis = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  let clock = Date.parse("2026-10-17T12:00:00.000Z");
  const { fetchImpl, calls } = fakeFetch(() => {
    // The first response consumes the whole wall-clock budget before the loop
    // asks for another provider request.
    clock += CONFIG.timeoutMs;
    return sseResponse(analysis);
  });
  const provider = createPiAgentProvider({
    config: CONFIG,
    fetchImpl,
    now: () => clock,
  });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderAcceptanceUnknownError && error.usage?.totalTokens === 120,
  );
  assert.equal(calls.length, 1);
});

test("pi-agent: aborting an in-flight stream on timeout maps to acceptance-unknown", async () => {
  const streamFn: StreamFn = async (model, context, options) => {
    assert.ok((context.systemPrompt ?? "").includes("read-only training analyst"));
    const userMessage = context.messages.find((message) => message.role === "user");
    assert.ok(
      userMessage !== undefined &&
        typeof userMessage.content === "string" &&
        userMessage.content.includes("Pinned snapshot: 1 workout record(s)."),
    );
    await options?.onPayload?.(
      { model: model.id, messages: context.messages, max_tokens: 64, stream: true },
      model,
    );
    const stream = new AssistantMessageEventStream();
    const aborted: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      timestamp: Date.now(),
    };
    const finish = (): void => {
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end();
    };
    if (options?.signal?.aborted === true) finish();
    else options?.signal?.addEventListener("abort", finish, { once: true });
    return stream;
  };
  let authorizations = 0;
  const provider = createPiAgentProvider({
    config: { ...CONFIG, timeoutMs: 40 },
    streamFn,
  });
  const { input } = providerInput({
    beforeProviderRequest: async () => {
      authorizations += 1;
      return { allowed: true };
    },
  });
  const started = Date.now();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderAcceptanceUnknownError && error.dispatched === true,
  );
  assert.equal(authorizations, 1);
  assert.ok(Date.now() - started >= 20);
});

test("pi-agent: unknown tool calls are refused before any tool start", async () => {
  const forbidden = toolCallAndUsage("delete_everything", "{}", "call-evil", "gen-1", {
    prompt_tokens: 90,
    completion_tokens: 10,
    total_tokens: 100,
  });
  const { fetchImpl, calls } = fakeFetch(() => sseResponse(forbidden));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input, events, accepted } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderToolRefusedError && error.usage.totalTokens === 100,
  );
  assert.equal(calls.length, 1);
  assert.equal(accepted.length, 1);
  assert.ok(!events.some((event) => event.type === "tool_start"));
  assert.ok(!events.some((event) => event.type === "tool_end"));
});

test("pi-agent: invalid deterministic tool arguments stop the run with the builtin taxonomy", async () => {
  const invalid = toolCallAndUsage(
    "analyze_progress",
    '{"from":"not-a-date"}',
    "call-bad",
    "gen-1",
    { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 },
  );
  const { fetchImpl } = fakeFetch(() => sseResponse(invalid));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input, events } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderRunFailedError && error.code === "TOOL_ARGUMENTS",
  );
  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd?.type === "tool_end" && toolEnd.ok === false);
  assert.equal(toolEnd.error, "tool arguments are invalid");
});

test("pi-agent: missing provider usage stays accounting-unknown", async () => {
  const analysis = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", undefined);
  const final = textAndUsage("Done.", "gen-2", undefined);
  const { fetchImpl, calls } = fakeFetch((_call, index) =>
    sseResponse(index === 0 ? analysis : final),
  );
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input, accepted } = providerInput();
  const result = await provider.run(input);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.known, false);
  assert.equal(result.usage.complete, false);
  assert.ok(result.usage.totalTokens > 0, "local stopping estimate is retained");
  assert.equal(accepted.length, 1);
  assert.equal((accepted[0]?.usage as { known: boolean }).known, false);
  assert.equal(calls.length, 2);
});

test("pi-agent: finishes without a deterministic analysis are refused", async () => {
  const final = textAndUsage("All good!", "gen-1", {
    prompt_tokens: 50,
    completion_tokens: 10,
    total_tokens: 60,
  });
  const { fetchImpl } = fakeFetch(() => sseResponse(final));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderRunFailedError && error.code === "ANALYSIS_REQUIRED",
  );
});

test("pi-agent: an oversized streamed response is rejected by the metered reader", async () => {
  const fetchImpl = (async () =>
    new Response("x".repeat(1_000_001), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });
  const { input } = providerInput();
  await assert.rejects(
    provider.run(input),
    (error: unknown) => error instanceof ProviderAcceptanceUnknownError,
  );
});

test("pi-agent: oversized input is refused before the durable gate and dispatch", async () => {
  const { fetchImpl, calls } = fakeFetch(() => sseResponse([]));
  const provider = createPiAgentProvider({
    config: { ...CONFIG, maxInputBytes: 512 },
    fetchImpl,
  });
  const { input, authorizations } = providerInput({ prompt: "你".repeat(800) });
  await assert.rejects(
    provider.run(input),
    (error: unknown) =>
      error instanceof ProviderNotAcceptedError && error.accepted === false,
  );
  assert.equal(calls.length, 0);
  assert.equal(authorizations.length, 0, "a local byte refusal must not charge a step");
});

test("pi-agent: the outbox worker settles completion through the unchanged accounting hooks", async () => {
  const analysis = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  const final = textAndUsage("Progress looks steady.", "gen-2", {
    prompt_tokens: 150,
    completion_tokens: 30,
    total_tokens: 180,
  });
  const { fetchImpl } = fakeFetch((_call, index) => sseResponse(index === 0 ? analysis : final));
  const provider = createPiAgentProvider({ config: CONFIG, fetchImpl });

  const db = new FakeCloudDatabase();
  const request = db.requestRepository();
  const session = await request.createSession("sess-1");
  const snapshot = await request.createSnapshot([workout()], {});
  const submitted = await request.submitRun({
    runId: "run-worker",
    sessionId: session.id,
    prompt: "Review my bench press.",
    idempotencyKey: "idem-pi",
    snapshot: {
      snapshotId: snapshot.snapshotId,
      source: snapshot.source,
      accountId: snapshot.accountId,
    },
  });
  const worker = createCloudOutboxWorker({
    repository: db.workerRepository(),
    provider,
    enabled: true,
    workerId: "worker-1",
    leaseMs: 60_000,
    batch: 1,
  });

  const tick = await worker.tick();
  assert.equal(tick.completed, 1);
  const run = db.getRun(submitted.run.id);
  assert.equal(run.status, "completed");
  assert.equal(run.providerAcceptedAt !== undefined, true);
  assert.equal(db.ledger.get(submitted.run.id)?.totalTokens, 300);
  assert.equal(db.reservedCount, 0);
  assert.ok(
    db.getEvents(submitted.run.id).some(
      (envelope) => envelope.event.type === "analysis_result",
    ),
  );
});

test("pi-agent: a known OpenRouter id uses the pi-ai catalog model metadata", async () => {
  const analysis = toolCallAndUsage("analyze_progress", "{}", "call-1", "gen-1", {
    prompt_tokens: 60,
    completion_tokens: 10,
    total_tokens: 70,
  });
  const final = textAndUsage("Catalog path works.", "gen-2", {
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
  });
  const { fetchImpl, calls } = fakeFetch((_call, index) =>
    sseResponse(index === 0 ? analysis : final),
  );
  const provider = createPiAgentProvider({
    config: { ...CONFIG, model: "openai/gpt-4o-mini", maxTokensPerStep: 1_024 },
    fetchImpl,
  });
  const { input } = providerInput();
  const result = await provider.run(input);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.totalTokens, 160);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0]?.body?.model, "openai/gpt-4o-mini");
});
