/**
 * Cloud coaching provider that runs pi's real agent loop in-process.
 *
 * `@earendil-works/pi-agent-core`'s `Agent` drives the conversation, executes
 * the tools, and streams lifecycle events. This module is only the hosting
 * adapter: it keeps every durable accounting hook from the builtin provider and
 * owns the wire, budget, and taxonomy decisions.
 *
 * Safety properties (mirrors `openRouterProvider.ts`):
 * - only the two deterministic read-only tools exist, bound to this run's
 *   pinned snapshot; unknown/non-allowlisted tools are refused before they run;
 * - the system prompt and every tool result are authored here, so no builtin
 *   pi file/shell/network tools, extensions, or skills are loaded;
 * - the durable `beforeProviderRequest` gate runs from `onPayload`, which
 *   pi-ai calls after the request body is assembled and immediately before the
 *   HTTP request: the exact serialized payload is byte-checked first, and the
 *   gate is awaited after every local bound and before every wire request;
 * - acceptance is marked after the first usable assistant response and before
 *   tool execution, exactly like the builtin loop;
 * - usage comes only from provider-returned figures; missing usage stays
 *   explicitly unknown and is never settled as a fabricated zero;
 * - provider retries are disabled (`maxRetries: 0`); a transport failure after
 *   the fetch marker is acceptance-unknown and is never resubmitted;
 * - terminal and `run_error` events are owned by the worker, not this module.
 *
 * Model selection: the OpenRouter catalog from pi-ai is authoritative when it
 * contains the configured model id. Otherwise an explicit
 * `openai-completions` model entry is built from bounded, self-derived
 * metadata: the catalog is trusted to describe context/price metadata for
 * known ids, but an unknown id gets conservative local bounds instead of a
 * guessed catalog row. The API key is passed explicitly to the stream function
 * (`apiKey` option), so pi-ai never resolves credentials from `~/.pi` or
 * ambient environment.
 *
 * See `docs/adr/0002-cloud-pi-agent-runtime.md`.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Provider,
  SimpleStreamOptions,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { COACHED_TOOL_NAMES, parseAnalysisResult } from "@agent-fit-trace/api-contracts";
import type { CoachingEventPayload } from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { isCoachedToolAllowed } from "../coaching/coachedToolPolicy.ts";
import {
  createSnapshotDomainExecutor,
  DomainToolError,
} from "../coaching/readOnlyDomainExecutor.ts";
import type { SnapshotDomainExecutor } from "../coaching/readOnlyDomainExecutor.ts";
import type { OpenRouterConfig } from "./config.ts";
import { OPENROUTER_BASE_URL } from "./config.ts";
import {
  ProviderAcceptanceUnknownError,
  ProviderCancelledError,
  ProviderNotAcceptedError,
  ProviderOwnershipLostError,
  ProviderRunFailedError,
  ProviderStepRefusedError,
  ProviderToolRefusedError,
} from "./openRouterProvider.ts";
import type {
  CloudCoachingProvider,
  ProviderRunInput,
  ProviderSuccess,
} from "./openRouterProvider.ts";
import type { CloudUsage } from "./repository.ts";

/** Same text the builtin loop sends so coached behavior does not drift. */
const SYSTEM_PROMPT = [
  "You are Fit Trace's read-only training analyst.",
  "You may call only get_training_history and analyze_progress, and both are already bound to one immutable snapshot of the athlete's records.",
  "You must call analyze_progress before you finish; its deterministic result is the only analysis the product accepts.",
  "Never invent records, never claim to write or confirm a plan, and never ask for files, shell access, or network access.",
  "After the tool result, answer the athlete in plain text using only that analysis.",
].join(" ");

/** Hard cap for one provider response body, mirroring the builtin reader. */
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

/** Keep one `text_delta` payload well below the durable event byte cap. */
const MAX_TEXT_DELTA_BYTES = 8 * 1024;

/** Fail closed rather than append an unbounded run transcript. */
const MAX_ASSISTANT_TEXT_BYTES = 256 * 1024;

/** Known-empty accumulator before any provider-returned usage arrives. */
const INITIAL_USAGE: CloudUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  known: true,
  knownTokens: 0,
  knownPromptTokens: 0,
  knownCompletionTokens: 0,
  complete: true,
};

const HISTORY_TOOL_SCHEMA = Type.Object(
  {
    from: Type.Optional(Type.String({ description: "Inclusive ISO date (YYYY-MM-DD)." })),
    to: Type.Optional(Type.String({ description: "Inclusive ISO date (YYYY-MM-DD)." })),
    exercise: Type.Optional(Type.String({ description: "Only records containing this exercise." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

const ANALYSIS_TOOL_SCHEMA = Type.Object(
  {
    from: Type.Optional(Type.String({ description: "Inclusive ISO date (YYYY-MM-DD)." })),
    to: Type.Optional(Type.String({ description: "Inclusive ISO date (YYYY-MM-DD)." })),
    exercises: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 20,
        description: "Restrict the deterministic analysis to these exercise names.",
      }),
    ),
  },
  { additionalProperties: false },
);

type OpenRouterPiApi = "anthropic-messages" | "openai-completions";
type OpenRouterPiModel = Model<OpenRouterPiApi>;

/** The minimal surface of `Agent` this adapter uses; injectable for tests. */
export interface PiAgentLike {
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void;
  prompt(message: AgentMessage): Promise<void>;
  abort(): void;
}

export interface PiAgentProviderOptions {
  config: OpenRouterConfig;
  fetchImpl?: typeof fetch;
  executorFactory?: (records: WorkoutRecord[]) => SnapshotDomainExecutor;
  now?: () => number;
  /** Test seam: replaces the pi-ai stream function (must honor onPayload). */
  streamFn?: StreamFn;
  /** Test seam: replaces `new Agent(...)`. */
  agentFactory?: (options: AgentOptions) => PiAgentLike;
}

interface RequestState {
  status?: number;
  ok?: boolean;
  streamOverflow?: boolean;
  requestOverflow?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Conservative local estimate: at most ~4 UTF-16 chars per token. */
function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 4);
}

/**
 * Estimate the prompt side of a provider payload without counting transport
 * field names. Tools and the system prompt are included because they are part
 * of what the provider bills.
 */
function estimatePayloadInput(payload: unknown): number {
  if (!isObject(payload)) return estimateTokens(payload);
  const parts: unknown[] = [];
  if (payload.system !== undefined) parts.push(payload.system);
  if (payload.systemPrompt !== undefined) parts.push(payload.systemPrompt);
  if (Array.isArray(payload.messages)) parts.push(payload.messages);
  if (Array.isArray(payload.tools)) parts.push(payload.tools);
  return parts.length === 0 ? estimateTokens(payload) : estimateTokens(parts);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Clamp the provider's own output-token field to the locally authorised
 * maximum. An unknown payload/max-token shape is refused rather than sent
 * uncapped.
 */
function clampPayloadMaxTokens(
  payload: unknown,
  maxCompletion: number,
): { ok: true; payload: unknown | undefined } | { ok: false } {
  if (!isObject(payload)) return { ok: false };
  const field =
    typeof payload.max_tokens === "number"
      ? "max_tokens"
      : typeof payload.max_completion_tokens === "number"
        ? "max_completion_tokens"
        : typeof payload.max_output_tokens === "number"
          ? "max_output_tokens"
          : undefined;
  if (field === undefined) return { ok: false };
  const current = payload[field] as number;
  if (current <= maxCompletion) return { ok: true, payload: undefined };
  return { ok: true, payload: { ...payload, [field]: maxCompletion } };
}

function readDeclaredLength(response: Response): number | null {
  const declared = response.headers.get("content-length");
  if (declared === null) return null;
  const value = Number(declared);
  return Number.isFinite(value) ? value : null;
}

/**
 * Wrap the provider response body so the byte cap is enforced while the SDK
 * streams, not after it has already buffered the body. `Content-Length` is used
 * only as an early check because it can be absent or lie.
 */
function meterResponseBody(
  response: Response,
  state: RequestState,
  maxBytes: number,
): Response {
  if (response.body === null || response.status === 204 || response.status === 205 || response.status === 304) {
    return response;
  }
  const reader = response.body.getReader();
  let total = 0;
  let finished = false;
  const metered = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (finished) return;
      try {
        const next = await reader.read();
        if (next.done) {
          finished = true;
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > maxBytes) {
          finished = true;
          state.streamOverflow = true;
          await reader.cancel("provider response too large").catch(() => undefined);
          controller.error(new Error("provider response exceeded the safe size limit"));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        finished = true;
        controller.error(new Error("provider response body could not be read"));
      }
    },
    async cancel(reason): Promise<void> {
      finished = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(metered, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Bound the request body before it leaves the process and meter the response
 * body on the wire. The payload byte cap is also checked exactly in the
 * `onPayload` gate; this is the last line of defence for a payload the SDK
 * might serialise differently.
 */
function createBoundedFetch(
  baseFetch: typeof fetch,
  maxRequestBytes: number,
  state: RequestState,
): typeof fetch {
  return async (input, init) => {
    const body = init?.body;
    if (body !== null && body !== undefined) {
      const bytes =
        typeof body === "string"
          ? byteLength(body)
          : body instanceof Uint8Array
            ? body.byteLength
            : body instanceof ArrayBuffer
              ? body.byteLength
              : ArrayBuffer.isView(body)
                ? body.byteLength
                : null;
      if (bytes === null || bytes > maxRequestBytes) {
        // The gate already authorised this step, so the conservative outcome is
        // "may have been billed", never a refund. This path should be
        // unreachable because `onPayload` checks the same payload first.
        state.requestOverflow = true;
        throw new Error("provider request body exceeded the configured input byte limit");
      }
    }
    const response = await baseFetch(input, init);
    state.status = response.status;
    state.ok = response.ok;
    const declared = readDeclaredLength(response);
    if (declared !== null && declared > MAX_PROVIDER_RESPONSE_BYTES) {
      state.streamOverflow = true;
      throw new Error("provider response exceeded the safe size limit");
    }
    return meterResponseBody(response, state, MAX_PROVIDER_RESPONSE_BYTES);
  };
}

function addUsage(a: CloudUsage, b: CloudUsage): CloudUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    // `knownTokens` only accumulates authoritative provider figures so a
    // partial settlement never charges local estimates.
    knownTokens:
      (a.knownTokens ?? (a.known === false ? 0 : a.totalTokens)) +
      (b.knownTokens ?? (b.known === false ? 0 : b.totalTokens)),
    knownPromptTokens:
      (a.knownPromptTokens ?? (a.known === false ? 0 : a.promptTokens)) +
      (b.knownPromptTokens ?? (b.known === false ? 0 : b.promptTokens)),
    knownCompletionTokens:
      (a.knownCompletionTokens ?? (a.known === false ? 0 : a.completionTokens)) +
      (b.knownCompletionTokens ?? (b.known === false ? 0 : b.completionTokens)),
    known: a.known !== false && b.known !== false,
    complete: a.complete !== false && b.complete !== false && a.known !== false && b.known !== false,
    ...(a.costUsd === undefined && b.costUsd === undefined
      ? {}
      : { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }),
  };
}

/**
 * Map pi-ai usage to the cloud accounting shape.
 *
 * pi-ai derives `Usage.cost` locally from catalog prices, so it is deliberately
 * not treated as provider-returned cost. Missing usage becomes a local stopping
 * estimate with `known: false`; it can never be settled as a charge.
 */
function mapPiUsage(
  usage: Usage | undefined,
  estimatedInput: number,
  estimatedCompletion: number,
): CloudUsage {
  const promptTokens = usage === undefined ? 0 : usage.input + usage.cacheRead + usage.cacheWrite;
  const completionTokens = usage === undefined ? 0 : usage.output;
  const totalTokens =
    usage === undefined ? 0 : usage.totalTokens > 0 ? usage.totalTokens : promptTokens + completionTokens;
  const known = usage !== undefined && (totalTokens > 0 || promptTokens > 0 || completionTokens > 0);
  if (!known) {
    const estimateTotal = estimatedInput + estimatedCompletion;
    return {
      promptTokens: estimatedInput,
      completionTokens: estimatedCompletion,
      totalTokens: estimateTotal,
      known: false,
      knownTokens: 0,
      knownPromptTokens: 0,
      knownCompletionTokens: 0,
      complete: false,
    };
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    known: true,
    knownTokens: totalTokens,
    knownPromptTokens: promptTokens,
    knownCompletionTokens: completionTokens,
    complete: true,
  };
}

/** Split assistant text into bounded, surrogate-pair-safe wire chunks. */
function splitText(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).byteLength;
    if (current !== "" && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isUsableModel(model: OpenRouterPiModel): boolean {
  if (model.api !== "openai-completions" && model.api !== "anthropic-messages") return false;
  if (!model.input.includes("text")) return false;
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return false;
  if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0) return false;
  return [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(
    (rate) => Number.isFinite(rate) && rate >= 0,
  );
}

/**
 * Prefer the pi-ai OpenRouter catalog row: it carries provider-verified API and
 * context metadata. Unknown ids get an explicit, conservative
 * `openai-completions` entry derived only from our own enforced bounds; model
 * pricing is irrelevant because pi-computed cost is never settled.
 */
function resolvePiModel(config: OpenRouterConfig): {
  provider: Provider<OpenRouterPiApi>;
  model: OpenRouterPiModel;
} {
  const provider = openrouterProvider();
  const catalog = provider.getModels().find((entry) => entry.id === config.model);
  if (catalog !== undefined) {
    if (!isUsableModel(catalog)) {
      throw new Error("Configured OpenRouter model has unusable pi model metadata.");
    }
    return { provider, model: catalog };
  }
  const explicit: Model<"openai-completions"> = {
    id: config.model,
    name: `${config.model} (explicit openai-completions)`,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: false,
    input: ["text"],
    // pi-computed cost is never settled, so zero rates cannot become a charge.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Context is bounded by the request-byte cap this adapter enforces. Bytes
    // are an upper bound on tokens, so this can never overstate the window.
    contextWindow: Math.max(32_768, config.maxInputBytes),
    maxTokens: config.maxTokensPerStep,
  };
  if (!isUsableModel(explicit)) {
    throw new Error("Configured OpenRouter model produced unusable explicit model metadata.");
  }
  return { provider, model: explicit };
}

function validateConfig(config: OpenRouterConfig): void {
  if (config.apiKey.trim() === "" || config.model.trim() === "") {
    throw new Error("Cloud pi-agent provider requires an OpenRouter key and model.");
  }
  for (const value of [
    config.maxSteps,
    config.maxTokens,
    config.maxTokensPerStep,
    config.maxInputBytes,
    config.timeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Cloud pi-agent provider received an invalid provider bound.");
    }
  }
}

function createTools(
  executor: SnapshotDomainExecutor,
  toolFailures: Map<string, "TOOL_ARGUMENTS" | "TOOL_FAILED">,
): AgentTool[] {
  const history: AgentTool = {
    name: "get_training_history",
    label: "Get training history",
    description: "Read a bounded page of the pinned training snapshot.",
    parameters: HISTORY_TOOL_SCHEMA,
    execute: async (toolCallId, params) => {
      try {
        const page = executor.getTrainingHistory(params);
        return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
      } catch (error) {
        toolFailures.set(toolCallId, error instanceof DomainToolError ? "TOOL_ARGUMENTS" : "TOOL_FAILED");
        // Fixed text only: raw domain/validation errors can carry data values.
        throw new Error(
          error instanceof DomainToolError ? "tool arguments are invalid" : "tool execution failed",
        );
      }
    },
  };
  const analysis: AgentTool = {
    name: "analyze_progress",
    label: "Analyze progress",
    description: "Run the deterministic progress analysis over the pinned snapshot.",
    parameters: ANALYSIS_TOOL_SCHEMA,
    execute: async (toolCallId, params) => {
      try {
        const result = parseAnalysisResult(executor.analyze(params));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        toolFailures.set(toolCallId, error instanceof DomainToolError ? "TOOL_ARGUMENTS" : "TOOL_FAILED");
        throw new Error(
          error instanceof DomainToolError ? "tool arguments are invalid" : "tool execution failed",
        );
      }
    },
  };
  return [history, analysis];
}

export function createPiAgentProvider(options: PiAgentProviderOptions): CloudCoachingProvider {
  const { config } = options;
  validateConfig(config);
  const fetchImpl = options.fetchImpl ?? fetch;
  const executorFactory = options.executorFactory ?? createSnapshotDomainExecutor;
  const now = options.now ?? Date.now;
  const agentFactory =
    options.agentFactory ?? ((agentOptions: AgentOptions): PiAgentLike => new Agent(agentOptions));
  const { provider, model } = resolvePiModel(config);

  return {
    async run(input: ProviderRunInput): Promise<ProviderSuccess> {
      let executor: SnapshotDomainExecutor;
      try {
        executor = executorFactory(input.records);
      } catch {
        // The snapshot is server-derived and validated upstream. If it cannot be
        // prepared, no provider request was dispatched, so this is a safe
        // proven-not-accepted refusal.
        throw new ProviderNotAcceptedError("The pinned snapshot could not be prepared.");
      }

      const deadline = now() + config.timeoutMs;
      const toolFailures = new Map<string, "TOOL_ARGUMENTS" | "TOOL_FAILED">();
      const callIds = new Set<string>();
      let usage: CloudUsage = INITIAL_USAGE;
      let accepted = false;
      let dispatched = false;
      let requestsAllowed = 0;
      let generationId: string | undefined;
      let hasAnalysis = false;
      let failure: Error | undefined;
      let timedOut = false;
      let emittedTextBytes = 0;
      let lastEstimatedInput = 0;
      let currentRequest: RequestState | undefined;

      function fail(error: Error): never {
        failure ??= error;
        throw error;
      }

      function acceptance(options: { includeUsage: boolean }): {
        accepted: boolean;
        dispatched: boolean;
        usage?: CloudUsage;
        generationId?: string;
      } {
        return {
          accepted,
          dispatched,
          ...(options.includeUsage ? { usage } : {}),
          ...(generationId === undefined ? {} : { generationId }),
        };
      }

      async function emit(payload: CoachingEventPayload): Promise<void> {
        try {
          await input.onEvent(payload);
        } catch {
          throw fail(
            new ProviderAcceptanceUnknownError("Provider events could not be stored.", {
              ...acceptance({ includeUsage: true }),
              accepted: true,
              dispatched: true,
            }),
          );
        }
      }

      async function emitText(text: string): Promise<void> {
        if (text === "") return;
        const bytes = byteLength(text);
        if (emittedTextBytes + bytes > MAX_ASSISTANT_TEXT_BYTES) {
          throw fail(
            new ProviderRunFailedError(
              "OUTPUT_BUDGET",
              "The model produced more assistant text than the safe limit.",
              usage,
              generationId,
            ),
          );
        }
        emittedTextBytes += bytes;
        for (const chunk of splitText(text, MAX_TEXT_DELTA_BYTES)) {
          await emit({ type: "text_delta", delta: chunk });
        }
      }

      /**
       * Approximate the request error the stream reported. HTTP status and
       * body-level failures are recorded by the request-scoped fetch wrapper
       * because pi-ai normalises them into an error assistant message.
       */
      function streamFailure(): Error {
        if (timedOut) {
          if (dispatched) {
            return new ProviderAcceptanceUnknownError("Provider call exceeded the configured timeout.", {
              ...acceptance({ includeUsage: true }),
              accepted: true,
              dispatched: true,
            });
          }
          return new ProviderNotAcceptedError("Provider call timed out before dispatch.");
        }
        const state = currentRequest;
        if (state?.requestOverflow === true) {
          return new ProviderAcceptanceUnknownError(
            "The request payload exceeded the configured input byte limit before dispatch.",
            {
              ...acceptance({ includeUsage: true }),
              accepted,
              dispatched: true,
            },
          );
        }
        if (state?.streamOverflow === true) {
          return new ProviderAcceptanceUnknownError("Provider response exceeded the safe size limit.", {
            ...acceptance({ includeUsage: true }),
            accepted,
            dispatched: true,
          });
        }
        if (state?.status !== undefined) {
          if (!state.ok) {
            if (state.status === 429 || state.status >= 500) {
              return new ProviderAcceptanceUnknownError("Provider returned a transient server error.", {
                ...acceptance({ includeUsage: true }),
                accepted,
                dispatched: true,
              });
            }
            return new ProviderNotAcceptedError(
              `Provider rejected the request with HTTP ${state.status}.`,
              acceptance({ includeUsage: true }),
            );
          }
          return new ProviderAcceptanceUnknownError("Provider response could not be read.", {
            ...acceptance({ includeUsage: true }),
            accepted,
            dispatched: true,
          });
        }
        return new ProviderAcceptanceUnknownError(
          dispatched ? "Provider transport failed after dispatch." : "Provider transport outcome is unknown.",
          {
            ...acceptance({ includeUsage: true }),
            accepted,
            dispatched,
          },
        );
      }

      async function handleMessageEnd(message: AgentMessage): Promise<void> {
        if (message.role !== "assistant") return;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          if (failure !== undefined) return;
          // Partial provider usage on a failed stream is still authoritative for
          // the tokens the provider already reported.
          if (message.usage !== undefined) {
            usage = addUsage(usage, mapPiUsage(message.usage, lastEstimatedInput, 0));
          }
          if (message.responseId !== undefined) generationId = message.responseId;
          failure = streamFailure();
          return;
        }

        const estimatedCompletion = estimateTokens(message.content);
        usage = addUsage(usage, mapPiUsage(message.usage, lastEstimatedInput, estimatedCompletion));
        if (message.responseId !== undefined) generationId = message.responseId;

        if (!accepted) {
          accepted = true;
          try {
            await input.onAccepted({
              ...(generationId === undefined ? {} : { generationId }),
              usage,
            });
          } catch {
            throw fail(
              new ProviderAcceptanceUnknownError(
                "Provider was accepted but the acceptance marker could not be stored.",
                {
                  usage,
                  ...(generationId === undefined ? {} : { generationId }),
                  accepted: true,
                  dispatched: true,
                },
              ),
            );
          }
        }
        if (usage.totalTokens > config.maxTokens) {
          throw fail(
            new ProviderRunFailedError(
              "TOKEN_BUDGET",
              "Configured token budget was exceeded.",
              usage,
              generationId,
            ),
          );
        }

        await emitText(assistantText(message));

        // Refuse before pi's tool preflight runs, so an unknown tool never
        // produces a start event. Duplicate ids are also caught here.
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          if (!isCoachedToolAllowed(block.name)) {
            throw fail(new ProviderToolRefusedError(block.name, usage, generationId));
          }
          if (callIds.has(block.id)) {
            throw fail(
              new ProviderRunFailedError(
                "TOOL_CALL_DUPLICATE",
                "The model repeated a tool call id.",
                usage,
                generationId,
              ),
            );
          }
          callIds.add(block.id);
        }
      }

      async function handleToolStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): Promise<void> {
        if (failure !== undefined) return;
        // Defence in depth: `handleMessageEnd` refuses unknown names before
        // preflight, but never emit a start for an unapproved tool.
        if (!isCoachedToolAllowed(event.toolName)) {
          throw fail(new ProviderToolRefusedError(event.toolName, usage, generationId));
        }
        await emit({ type: "tool_start", tool: event.toolName, callId: event.toolCallId });
      }

      async function handleToolEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>): Promise<void> {
        if (failure !== undefined) return;
        if (event.isError) {
          const code = toolFailures.get(event.toolCallId) ?? "TOOL_ARGUMENTS";
          await emit({
            type: "tool_end",
            tool: event.toolName,
            callId: event.toolCallId,
            ok: false,
            error: code === "TOOL_ARGUMENTS" ? "tool arguments are invalid" : "tool execution failed",
          });
          // The builtin loop stops on a deterministic tool failure rather than
          // asking the model to retry, so the same taxonomy is preserved here.
          throw fail(
            new ProviderRunFailedError(
              code,
              "A deterministic coached tool failed.",
              usage,
              generationId,
            ),
          );
        }
        if (!isCoachedToolAllowed(event.toolName)) {
          throw fail(new ProviderToolRefusedError(event.toolName, usage, generationId));
        }
        if (event.toolName === "analyze_progress") {
          let result: ReturnType<typeof parseAnalysisResult>;
          try {
            result = parseAnalysisResult(
              isObject(event.result) ? (event.result as { details?: unknown }).details : undefined,
            );
          } catch {
            await emit({
              type: "tool_end",
              tool: event.toolName,
              callId: event.toolCallId,
              ok: false,
              error: "deterministic analysis failed validation",
            });
            throw fail(
              new ProviderRunFailedError(
                "ANALYSIS_INVALID",
                "The deterministic analysis result failed validation.",
                usage,
                generationId,
              ),
            );
          }
          hasAnalysis = true;
          await emit({
            type: "tool_end",
            tool: event.toolName,
            callId: event.toolCallId,
            ok: true,
            summary: "deterministic analysis",
          });
          await emit({ type: "analysis_result", result });
          return;
        }
        await emit({
          type: "tool_end",
          tool: event.toolName,
          callId: event.toolCallId,
          ok: true,
          summary: "snapshot history page",
        });
      }

      async function handleAgentEvent(event: AgentEvent): Promise<void> {
        switch (event.type) {
          case "message_end":
            await handleMessageEnd(event.message);
            return;
          case "tool_execution_start":
            await handleToolStart(event);
            return;
          case "tool_execution_end":
            await handleToolEnd(event);
            return;
          default:
            return;
        }
      }

      /**
       * Durable per-request gate. pi-ai calls `onPayload` with the exact request
       * body after it is assembled and before any HTTP request. Local bounds
       * are checked first so a refusal never writes the fetch marker; the
       * database gate is then awaited immediately before the wire request.
       */
      async function beforeProviderRequest(payload: unknown): Promise<unknown | undefined> {
        if (requestsAllowed >= config.maxSteps) {
          const message = "The configured maximum number of provider steps was reached.";
          throw fail(
            accepted
              ? new ProviderRunFailedError("MAX_STEPS", message, usage, generationId)
              : new ProviderNotAcceptedError(message),
          );
        }
        if (now() >= deadline) {
          throw fail(
            accepted
              ? new ProviderAcceptanceUnknownError("Provider call exceeded the configured timeout.", {
                  ...acceptance({ includeUsage: true }),
                  accepted: true,
                  dispatched: true,
                })
              : new ProviderNotAcceptedError("Provider call timed out before dispatch."),
          );
        }

        const estimatedInput = estimatePayloadInput(payload);
        const remainingTokens = config.maxTokens - usage.totalTokens - estimatedInput;
        if (remainingTokens <= 0) {
          const message = "Configured token budget cannot cover another provider step.";
          throw fail(
            accepted
              ? new ProviderRunFailedError("TOKEN_BUDGET", message, usage, generationId)
              : new ProviderNotAcceptedError(message),
          );
        }
        const maxCompletion = Math.max(1, Math.min(remainingTokens, config.maxTokensPerStep));

        const capped = clampPayloadMaxTokens(payload, maxCompletion);
        if (!capped.ok) {
          const message = "The provider request exposed no output-token cap.";
          throw fail(
            accepted
              ? new ProviderRunFailedError("OUTPUT_BUDGET", message, usage, generationId)
              : new ProviderNotAcceptedError(message),
          );
        }
        const finalPayload = capped.payload ?? payload;
        let serialized: string;
        try {
          serialized = JSON.stringify(finalPayload);
        } catch {
          const message = "The provider request could not be serialized.";
          throw fail(
            accepted
              ? new ProviderRunFailedError("INPUT_BUDGET", message, usage, generationId)
              : new ProviderNotAcceptedError(message),
          );
        }
        if (byteLength(serialized) > config.maxInputBytes) {
          const message = "The repeated provider context exceeds the configured input byte limit.";
          throw fail(
            accepted
              ? new ProviderRunFailedError("INPUT_BUDGET", message, usage, generationId)
              : new ProviderNotAcceptedError(message),
          );
        }

        let decision;
        try {
          decision = await input.beforeProviderRequest({
            tokens: estimatedInput + maxCompletion,
            requests: 1,
          });
        } catch (error) {
          // Storage/lease failures are not provider taxonomy. Re-surface them
          // unchanged so the worker's unknown-error path keeps the run
          // unconfirmed instead of refunding.
          throw fail(error instanceof Error ? error : new Error("Provider step authorization failed."));
        }
        if (!decision.allowed) {
          if (decision.cancelled === true) {
            throw fail(new ProviderCancelledError(usage, generationId, dispatched));
          }
          if (decision.terminal === true) {
            throw fail(new ProviderOwnershipLostError(usage, generationId));
          }
          throw fail(
            new ProviderStepRefusedError(
              decision.reason ?? "step-refused",
              usage,
              generationId,
              dispatched,
            ),
          );
        }

        requestsAllowed += 1;
        // The fetch is about to start; from here a failure is acceptance
        // unknown, never a proven-not-accepted refund.
        dispatched = true;
        lastEstimatedInput = estimatedInput;
        return capped.payload;
      }

      const underlyingStreamFn: StreamFn =
        options.streamFn ??
        ((streamModel, context, streamOptions) =>
          provider.streamSimple(streamModel as OpenRouterPiModel, context, streamOptions));

      const streamFn: StreamFn = async (
        streamModel: Model<Api>,
        context: Context,
        streamOptions?: SimpleStreamOptions,
      ) => {
        const requestState: RequestState = {};
        currentRequest = requestState;
        const requestFetch = createBoundedFetch(fetchImpl, config.maxInputBytes, requestState);
        const remainingMs = Math.max(1, Math.min(config.timeoutMs, deadline - now()));
        const boundedOptions: SimpleStreamOptions = {
          ...(streamOptions ?? {}),
          apiKey: config.apiKey,
          fetch: requestFetch,
          maxRetries: 0,
          maxRetryDelayMs: 0,
          maxTokens: config.maxTokensPerStep,
          timeoutMs: remainingMs,
          onPayload: (payload) => beforeProviderRequest(payload),
        };
        try {
          return await underlyingStreamFn(streamModel, context, boundedOptions);
        } catch (error) {
          if (failure !== undefined) throw failure;
          if (dispatched) {
            throw fail(
              new ProviderAcceptanceUnknownError("Provider transport failed before a response was read.", {
                ...acceptance({ includeUsage: true }),
                accepted,
                dispatched: true,
              }),
            );
          }
          throw error instanceof Error ? error : new Error("Provider request could not be created.");
        }
      };

      const agent = agentFactory({
        initialState: {
          systemPrompt: SYSTEM_PROMPT,
          model,
          thinkingLevel: "off",
          tools: createTools(executor, toolFailures),
        },
        streamFn,
        toolExecution: "sequential",
        sessionId: input.runId,
        maxRetryDelayMs: 0,
      });
      const unsubscribe = agent.subscribe((event) => handleAgentEvent(event));
      const timer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, config.timeoutMs);

      const userMessage: AgentMessage = {
        role: "user",
        content: `${input.prompt}\n\nPinned snapshot: ${executor.recordCount} workout record(s). Use analyze_progress before answering.`,
        timestamp: now(),
      };

      try {
        await agent.prompt(userMessage);
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }

      if (failure !== undefined) throw failure;
      if (timedOut) {
        throw dispatched
          ? new ProviderAcceptanceUnknownError("Provider call exceeded the configured timeout.", {
              ...acceptance({ includeUsage: true }),
              accepted,
              dispatched: true,
            })
          : new ProviderNotAcceptedError("Provider call timed out before dispatch.");
      }
      if (!hasAnalysis) {
        if (!accepted) {
          throw new ProviderNotAcceptedError("The provider run ended without an accepted response.");
        }
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
    },
  };
}
