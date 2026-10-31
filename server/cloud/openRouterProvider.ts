/**
 * Bounded native-`fetch` OpenRouter chat-completions provider.
 *
 * Official docs (fetched 2026-10-17): tool calls are OpenAI-compatible, the
 * tools array is repeated on every request, `parallel_tool_calls: false`
 * forces one call at a time, and non-streaming responses carry `usage`.
 *
 * Safety properties:
 * - the endpoint is the fixed official chat-completions URL;
 * - only the two deterministic read-only tools are offered; unknown tools are
 *   refused before execution;
 * - the model's text is only `text_delta`; an `analysis_result` can only come
 *   from the deterministic `analyze_progress` tool result, re-validated here;
 * - steps, total tokens, and wall-clock time are enforced by this code;
 * - there is no automatic retry. A transport failure after the acceptance
 *   marker is `ProviderAcceptanceUnknownError`, never a resubmission.
 */
import { COACHED_TOOL_NAMES, parseAnalysisResult } from "@agent-fit-trace/api-contracts";
import type { CoachingEventPayload } from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import {
  createSnapshotDomainExecutor,
  DomainToolError,
} from "../coaching/readOnlyDomainExecutor.ts";
import type { SnapshotDomainExecutor } from "../coaching/readOnlyDomainExecutor.ts";
import type { OpenRouterConfig } from "./config.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "./config.ts";
import type { CloudUsage } from "./repository.ts";

/**
 * The provider rejected a request without accepting it.
 *
 * `accepted` is false only when no earlier step in this run was accepted. A
 * 4xx on a LATER step (after a successful tool call) is not proof that the
 * earlier generation was free; callers must settle the carried usage and keep
 * the reservation. `usage` holds the known/accepted usage at the failure.
 */
export class ProviderNotAcceptedError extends Error {
  readonly accepted: boolean;
  readonly usage?: CloudUsage;
  readonly generationId?: string;

  constructor(
    message: string,
    options: { accepted?: boolean; usage?: CloudUsage; generationId?: string } = {},
  ) {
    super(message);
    this.name = "ProviderNotAcceptedError";
    this.accepted = options.accepted === true;
    if (options.usage !== undefined) this.usage = options.usage;
    if (options.generationId !== undefined) this.generationId = options.generationId;
  }
}

/** The request may have been accepted/billed; never auto-retry. */
export class ProviderAcceptanceUnknownError extends Error {
  readonly usage?: CloudUsage;
  readonly generationId?: string;
  readonly accepted: boolean;
  readonly dispatched: boolean;

  constructor(
    message = "Provider acceptance could not be confirmed.",
    options: {
      usage?: CloudUsage;
      generationId?: string;
      accepted?: boolean;
      dispatched?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ProviderAcceptanceUnknownError";
    if (options.usage !== undefined) this.usage = options.usage;
    if (options.generationId !== undefined) this.generationId = options.generationId;
    this.accepted = options.accepted === true;
    this.dispatched = options.dispatched === true;
  }
}

/** Accepted, then failed without a usable analysis. Safe to settle+terminate. */
export class ProviderRunFailedError extends Error {
  readonly code: string;
  readonly usage: CloudUsage;
  readonly generationId?: string;

  constructor(code: string, message: string, usage: CloudUsage, generationId?: string) {
    super(message);
    this.name = "ProviderRunFailedError";
    this.code = code;
    this.usage = usage;
    if (generationId !== undefined) this.generationId = generationId;
  }
}

/** Accepted, but the model requested a tool outside the coached allowlist. */
export class ProviderToolRefusedError extends ProviderRunFailedError {
  constructor(tool: string, usage: CloudUsage, generationId?: string) {
    super("TOOL_REFUSED", `tool ${JSON.stringify(tool).slice(0, 80)} is not allowlisted for coached runs`, usage, generationId);
    this.name = "ProviderToolRefusedError";
  }
}

/** Cancellation was observed before another provider request. */
export class ProviderCancelledError extends Error {
  readonly usage: CloudUsage;
  readonly generationId?: string;
  /** True if any provider fetch already happened in this attempt. */
  readonly dispatched: boolean;

  constructor(usage: CloudUsage, generationId: string | undefined, dispatched: boolean) {
    super("Provider work was cancelled before the next request.");
    this.name = "ProviderCancelledError";
    this.usage = usage;
    if (generationId !== undefined) this.generationId = generationId;
    this.dispatched = dispatched;
  }
}

/** A pre-fetch authorization check denied the next provider step. */
export class ProviderStepRefusedError extends Error {
  readonly reason: string;
  readonly usage: CloudUsage;
  readonly generationId?: string;
  readonly dispatched: boolean;

  constructor(reason: string, usage: CloudUsage, generationId: string | undefined, dispatched: boolean) {
    super("The durable pre-fetch authorization refused another provider request.");
    this.name = "ProviderStepRefusedError";
    this.reason = reason;
    this.usage = usage;
    if (generationId !== undefined) this.generationId = generationId;
    this.dispatched = dispatched;
  }
}

/** The durable lease/fence was lost while this worker was working. */
export class ProviderOwnershipLostError extends Error {
  readonly usage: CloudUsage;
  readonly generationId?: string;

  constructor(usage: CloudUsage, generationId: string | undefined) {
    super("The provider run no longer owns its durable lease.");
    this.name = "ProviderOwnershipLostError";
    this.usage = usage;
    if (generationId !== undefined) this.generationId = generationId;
  }
}

export interface ProviderStepDecision {
  allowed: boolean;
  cancelled?: boolean;
  terminal?: boolean;
  reason?: string;
}

/** Worst-case finite budget for one provider HTTP request. */
export interface ProviderStepBudget {
  tokens: number;
  requests: number;
}

import { composeCoachPrompt } from "./conversationContext.ts";
import type { CloudConversationTurn } from "./conversationContext.ts";

export interface ProviderRunInput {
  runId: string;
  prompt: string;
  conversationContext?: readonly CloudConversationTurn[];
  records: WorkoutRecord[];
  onAccepted(info: { generationId?: string; usage?: CloudUsage }): Promise<void>;
  onEvent(payload: CoachingEventPayload): Promise<void>;
  /**
   * Durable authorisation immediately before EVERY provider HTTP request.
   * The callback performs the lease/generation/cancellation/account/quota
   * checks and records the first actual fetch. It must never perform a
   * provider call itself and must not implicitly retry. The finite budget is
   * the worst-case token/request charge this step may incur.
   */
  beforeProviderRequest(budget?: ProviderStepBudget): Promise<ProviderStepDecision>;
}

export interface ProviderSuccess {
  status: "completed";
  usage: CloudUsage;
  generationId?: string;
}

export interface OpenRouterProviderOptions {
  config: OpenRouterConfig;
  fetchImpl?: typeof fetch;
  executorFactory?: (records: WorkoutRecord[]) => SnapshotDomainExecutor;
  now?: () => number;
}

export interface CloudCoachingProvider {
  run(input: ProviderRunInput): Promise<ProviderSuccess>;
}

const SYSTEM_PROMPT = [
  "You are Fit Trace's read-only training analyst.",
  "You may call only get_training_history and analyze_progress, and both are already bound to one immutable snapshot of the athlete's records.",
  "You must call analyze_progress before you finish; its deterministic result is the only analysis the product accepts.",
  "Never invent records, never claim to write or confirm a plan, and never ask for files, shell access, or network access.",
  "After the tool result, answer the athlete in plain text using only that analysis.",
].join(" ");

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_training_history",
      description: "Read a bounded page of the pinned training snapshot.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string", description: "Inclusive ISO date (YYYY-MM-DD)." },
          to: { type: "string", description: "Inclusive ISO date (YYYY-MM-DD)." },
          exercise: { type: "string", description: "Only records containing this exercise." },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0, maximum: 100000 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_progress",
      description: "Run the deterministic progress analysis over the pinned snapshot.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string", description: "Inclusive ISO date (YYYY-MM-DD)." },
          to: { type: "string", description: "Inclusive ISO date (YYYY-MM-DD)." },
          exercises: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
          },
        },
      },
    },
  },
] as const;

interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
}

interface ParsedCompletion {
  id?: string;
  content: string;
  toolCalls: OpenRouterToolCall[];
  usage: CloudUsage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUsage(value: unknown): CloudUsage {
  if (!isObject(value)) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      known: false,
      knownTokens: 0,
      knownPromptTokens: 0,
      knownCompletionTokens: 0,
      complete: false,
    };
  }
  const prompt = typeof value.prompt_tokens === "number" ? value.prompt_tokens : 0;
  const completion = typeof value.completion_tokens === "number" ? value.completion_tokens : 0;
  const total = typeof value.total_tokens === "number" ? value.total_tokens : prompt + completion;
  const cost = typeof value.cost === "number" ? value.cost : undefined;
  const known = total > 0 || prompt > 0 || completion > 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    known,
    knownTokens: known ? total : 0,
    knownPromptTokens: known ? prompt : 0,
    knownCompletionTokens: known ? completion : 0,
    complete: known,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

function parseCompletion(value: unknown): ParsedCompletion {
  if (!isObject(value)) throw new ProviderAcceptanceUnknownError("Provider returned a non-object body.");
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isObject(choices[0])) {
    throw new ProviderAcceptanceUnknownError("Provider returned no completion choice.");
  }
  const choice = choices[0];
  const message = isObject(choice.message) ? choice.message : null;
  if (message === null) {
    throw new ProviderAcceptanceUnknownError("Provider returned no assistant message.");
  }
  const content = typeof message.content === "string" ? message.content : "";
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: OpenRouterToolCall[] = [];
  for (const raw of rawCalls) {
    if (!isObject(raw) || typeof raw.id !== "string" || !isObject(raw.function)) {
      throw new ProviderAcceptanceUnknownError("Provider returned a malformed tool call.");
    }
    if (typeof raw.function.name !== "string" || typeof raw.function.arguments !== "string") {
      throw new ProviderAcceptanceUnknownError("Provider returned malformed tool arguments.");
    }
    toolCalls.push({
      id: raw.id,
      type: "function",
      function: { name: raw.function.name, arguments: raw.function.arguments },
    });
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    content,
    toolCalls,
    usage: readUsage(value.usage),
  };
}

function addUsage(a: CloudUsage, b: CloudUsage): CloudUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    // `knownTokens` only accumulates authoritative provider figures so a
    // partial settlement never charges local estimates.
    knownTokens: (a.knownTokens ?? (a.known === false ? 0 : a.totalTokens))
      + (b.knownTokens ?? (b.known === false ? 0 : b.totalTokens)),
    knownPromptTokens: (a.knownPromptTokens ?? (a.known === false ? 0 : a.promptTokens))
      + (b.knownPromptTokens ?? (b.known === false ? 0 : b.promptTokens)),
    knownCompletionTokens:
      (a.knownCompletionTokens ?? (a.known === false ? 0 : a.completionTokens))
      + (b.knownCompletionTokens ?? (b.known === false ? 0 : b.completionTokens)),
    known: a.known !== false && b.known !== false,
    complete: a.complete !== false && b.complete !== false && a.known !== false && b.known !== false,
    ...(a.costUsd === undefined && b.costUsd === undefined
      ? {}
      : { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }),
  };
}

function safeCode(error: unknown): string {
  return error instanceof DomainToolError ? "TOOL_ARGUMENTS" : "TOOL_FAILED";
}

/** Conservative local estimate: at most ~4 UTF-16 chars per token. */
function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 4);
}

const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

/**
 * Read a provider response with a hard byte cap. `Response.json()` and
 * `text()` are unbounded, and Content-Length can be absent or lie, so the
 * stream itself is metered and cancelled on overflow.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new ProviderAcceptanceUnknownError("Provider response exceeded the safe size limit.");
    }
  }
  if (response.body === null) {
    throw new ProviderAcceptanceUnknownError("Provider returned an unreadable body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel("provider response too large");
        throw new ProviderAcceptanceUnknownError("Provider response exceeded the safe size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderAcceptanceUnknownError("Provider returned an unreadable body.");
  }
}

export function createOpenRouterProvider(options: OpenRouterProviderOptions): CloudCoachingProvider {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = OPENROUTER_CHAT_COMPLETIONS_URL;
  const executorFactory = options.executorFactory ?? createSnapshotDomainExecutor;
  const now = options.now ?? Date.now;

  return {
    async run(input: ProviderRunInput): Promise<ProviderSuccess> {
      const executor = executorFactory(input.records);
      const messages: OpenRouterMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: composeCoachPrompt(input.prompt, executor.recordCount, input.conversationContext),
        },
      ];
      const deadline = now() + config.timeoutMs;
      let usage: CloudUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        known: true,
        knownTokens: 0,
        knownPromptTokens: 0,
        knownCompletionTokens: 0,
        complete: true,
      };
      let generationId: string | undefined;
      let accepted = false;
      let dispatched = false;
      let hasAnalysis = false;
      const callIds = new Set<string>();

      for (let step = 0; step < config.maxSteps; step += 1) {
        if (now() >= deadline) {
          throw accepted
            ? new ProviderAcceptanceUnknownError("Provider call exceeded the configured timeout.", {
                usage,
                ...(generationId === undefined ? {} : { generationId }),
                accepted,
                dispatched,
              })
            : new ProviderNotAcceptedError("Provider call timed out before dispatch.");
        }

        // Token counts can only be estimated locally (multibyte text is not
        // chars/4). The byte cap below is strict; provider-returned usage is
        // authoritative for settlement, and missing usage is never fabricated
        // into a billed zero.
        const estimatedInput = estimateTokens(messages);
        const remainingTokens = config.maxTokens - usage.totalTokens - estimatedInput;
        if (remainingTokens <= 0) {
          // Before any provider acceptance this is a local refusal, so the
          // reservation can be refunded. After acceptance it is a billed run.
          if (!accepted) {
            throw new ProviderNotAcceptedError(
              "Configured token budget cannot cover another provider step.",
            );
          }
          throw new ProviderRunFailedError(
            "TOKEN_BUDGET",
            "Configured token budget cannot cover another provider step.",
            usage,
            generationId,
          );
        }
        const maxCompletion = Math.max(1, Math.min(remainingTokens, config.maxTokensPerStep));
        const requestBody = JSON.stringify({
          model: config.model,
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_tokens: maxCompletion,
          stream: false,
        });
        if (new TextEncoder().encode(requestBody).byteLength > config.maxInputBytes) {
          if (!accepted) {
            throw new ProviderNotAcceptedError(
              "The repeated provider context exceeds the configured input byte limit.",
            );
          }
          throw new ProviderRunFailedError(
            "INPUT_BUDGET",
            "The repeated provider context exceeds the configured input byte limit.",
            usage,
            generationId,
          );
        }

        // Recheck the durable lease, cancellation, account, and quota after
        // every await and immediately before every actual fetch. The finite
        // worst-case token charge is committed atomically by the database.
        const decision = await input.beforeProviderRequest({
          tokens: estimatedInput + maxCompletion,
          requests: 1,
        });
        if (!decision.allowed) {
          if (decision.cancelled === true) {
            throw new ProviderCancelledError(usage, generationId, dispatched);
          }
          if (decision.terminal === true) {
            throw new ProviderOwnershipLostError(usage, generationId);
          }
          throw new ProviderStepRefusedError(
            decision.reason ?? "step-refused",
            usage,
            generationId,
            dispatched,
          );
        }

        let response: Response;
        try {
          dispatched = true;
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: requestBody,
            signal: AbortSignal.timeout(Math.max(1, Math.min(config.timeoutMs, deadline - now()))),
          });
        } catch {
          throw new ProviderAcceptanceUnknownError(
            dispatched
              ? "Provider transport failed after dispatch."
              : "Provider transport outcome is unknown.",
            {
              usage,
              ...(generationId === undefined ? {} : { generationId }),
              accepted,
              dispatched,
            },
          );
        }

        if (!response.ok) {
          // 429/5xx may have reached the model: acceptance is unknown.
          if (response.status === 429 || response.status >= 500) {
            throw new ProviderAcceptanceUnknownError("Provider returned a transient server error.", {
              usage,
              ...(generationId === undefined ? {} : { generationId }),
              accepted,
              dispatched: true,
            });
          }
          // A 4xx on the FIRST request proves nothing was accepted. A 4xx on
          // a later request does not free the earlier accepted generation:
          // carry the usage and let the worker settle/retain the reservation.
          throw new ProviderNotAcceptedError(`Provider rejected the request with HTTP ${response.status}.`, {
            accepted,
            usage,
            ...(generationId === undefined ? {} : { generationId }),
          });
        }

        let completion: ParsedCompletion;
        try {
          const body = await readBoundedJson(response);
          completion = parseCompletion(body);
        } catch (error) {
          if (error instanceof ProviderAcceptanceUnknownError) {
            throw new ProviderAcceptanceUnknownError(error.message, {
              usage,
              ...(generationId === undefined ? {} : { generationId }),
              accepted,
              dispatched: true,
            });
          }
          throw error;
        }
        const reportedUsage =
          completion.usage.known !== false
            ? completion.usage
            : {
                // Local stopping estimate only; `known: false` prevents it from
                // being settled as an actual provider charge.
                promptTokens: estimatedInput,
                completionTokens: estimateTokens(completion.content),
                totalTokens: estimatedInput + estimateTokens(completion.content),
                known: false,
                knownTokens: 0,
                knownPromptTokens: 0,
                knownCompletionTokens: 0,
                complete: false,
              };
        usage = addUsage(usage, reportedUsage);
        if (completion.id !== undefined) generationId = completion.id;
        if (!accepted) {
          accepted = true;
          // Durable acceptance marker BEFORE any tool execution or further
          // provider step. A storage failure here leaves acceptance unknown.
          try {
            await input.onAccepted({
              ...(generationId === undefined ? {} : { generationId }),
              usage,
            });
          } catch {
            throw new ProviderAcceptanceUnknownError(
              "Provider was accepted but the acceptance marker could not be stored.",
              {
                usage,
                ...(generationId === undefined ? {} : { generationId }),
                accepted: true,
                dispatched: true,
              },
            );
          }
        }
        if (usage.totalTokens > config.maxTokens) {
          throw new ProviderRunFailedError("TOKEN_BUDGET", "Configured token budget was exceeded.", usage, generationId);
        }

        if (completion.content !== "") {
          await input.onEvent({ type: "text_delta", delta: completion.content });
        }

        if (completion.toolCalls.length === 0) {
          if (!hasAnalysis) {
            throw new ProviderRunFailedError(
              "ANALYSIS_REQUIRED",
              "The model finished without a deterministic analysis result.",
              usage,
              generationId,
            );
          }
          return {
            status: "completed",
            usage,
            ...(generationId === undefined ? {} : { generationId }),
          };
        }

        // parallel_tool_calls is false, but process defensively in order and
        // refuse any call that is not exactly one of the two coached tools.
        const assistantMessage: OpenRouterMessage = {
          role: "assistant",
          content: completion.content === "" ? null : completion.content,
          tool_calls: completion.toolCalls,
        };
        messages.push(assistantMessage);

        for (const call of completion.toolCalls) {
          if (!(COACHED_TOOL_NAMES as readonly string[]).includes(call.function.name)) {
            await input.onEvent({
              type: "run_error",
              code: "TOOL_REFUSED",
              message: `tool ${JSON.stringify(call.function.name).slice(0, 80)} is not allowlisted for coached runs`,
            });
            throw new ProviderToolRefusedError(call.function.name, usage, generationId);
          }
          if (callIds.has(call.id)) {
            throw new ProviderRunFailedError("TOOL_CALL_DUPLICATE", "The model repeated a tool call id.", usage, generationId);
          }
          callIds.add(call.id);
          await input.onEvent({ type: "tool_start", tool: call.function.name, callId: call.id });

          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments) as unknown;
          } catch {
            await input.onEvent({
              type: "tool_end",
              tool: call.function.name,
              callId: call.id,
              ok: false,
              error: "tool arguments are not valid JSON",
            });
            throw new ProviderRunFailedError("TOOL_ARGUMENTS", "Tool arguments were not valid JSON.", usage, generationId);
          }

          let toolResult: unknown;
          try {
            if (call.function.name === "get_training_history") {
              toolResult = executor.getTrainingHistory(args);
            } else {
              const analysis = executor.analyze(args);
              // The deterministic executor already re-parsed the shared
              // contract; validate once more so model text can never become
              // an analysis result.
              toolResult = parseAnalysisResult(analysis);
              hasAnalysis = true;
            }
          } catch (error) {
            const code = safeCode(error);
            await input.onEvent({
              type: "tool_end",
              tool: call.function.name,
              callId: call.id,
              ok: false,
              error: code === "TOOL_ARGUMENTS" ? "tool arguments are invalid" : "tool execution failed",
            });
            throw new ProviderRunFailedError(code, "A deterministic coached tool failed.", usage, generationId);
          }

          await input.onEvent({
            type: "tool_end",
            tool: call.function.name,
            callId: call.id,
            ok: true,
            summary: call.function.name === "analyze_progress" ? "deterministic analysis" : "snapshot history page",
          });
          if (call.function.name === "analyze_progress") {
            await input.onEvent({ type: "analysis_result", result: toolResult as ReturnType<typeof parseAnalysisResult> });
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          });
        }
      }

      if (!accepted) {
        throw new ProviderNotAcceptedError("The configured maximum number of provider steps was reached.");
      }
      throw new ProviderRunFailedError(
        "MAX_STEPS",
        "The configured maximum number of provider steps was reached.",
        usage,
        generationId,
      );
    },
  };
}

export { OPENROUTER_CHAT_COMPLETIONS_URL };
