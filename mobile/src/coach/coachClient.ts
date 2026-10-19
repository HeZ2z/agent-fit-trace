import { fetch as expoFetch } from "expo/fetch";
import {
  parseCloudCancelRunResult,
  parseCloudCapabilities,
  parseCloudCreateSessionInput,
  parseCloudReadRunResult,
  parseCloudSubmitRunInput,
  parseCloudSubmitRunResult,
  parseCoachingSession,
  parseSnapshotCreateResult,
  parseSnapshotFilter,
} from "@pi-fit-trace/api-contracts";
import type {
  CloudCancelRunResult,
  CloudCapabilities,
  CloudReadRunResult,
  CloudSubmitRunResult,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  SubmitCoachingRunInput,
} from "@pi-fit-trace/api-contracts";

import { readCoachConfig } from "./coachConfig";
import {
  MAX_COACH_SSE_FRAME_BYTES,
  MAX_COACH_SSE_TOTAL_BYTES,
  CoachError,
  cancelledCoachError,
  coachErrorFromHttp,
  coachUtf8ByteLength,
  isCancelledError,
  parseCoachSseBlock,
  takeCoachSseFrames,
  toCoachError,
  type CoachConfig,
  type CoachStreamIdentity,
} from "./coachModel";

/**
 * Bearer-authenticated transport for the hosted cloud coach
 * (`/api/v1/coaching/cloud/*`, the only mobile coaching backend).
 *
 * Shape mirrors the web `CloudCoachingClient` exactly:
 * - one HTTP attempt per call; caller-supplied idempotency keys are forwarded
 *   verbatim and never auto-retried;
 * - the cloud event endpoint is replay-only SSE split into bounded long-poll
 *   pages. A page that ends without the terminal is a normal boundary: this
 *   client GETs the same run again from `lastConsumed + 1` with bounded
 *   backoff, never a second POST;
 * - a network/HTTP/parse failure before the terminal is a disconnect, never a
 *   completion. The caller keeps the run id and resumes from the same cursor.
 *
 * The module imports `expo/fetch` because React Native's global `fetch` may
 * not expose a readable streaming body. Both JSON and streaming fetches are
 * injectable; tests can avoid the network entirely. Tokens and prompts are
 * never logged or included in an error message.
 */

/** Minimal fetch shape accepted by the client (expo/fetch satisfies it). */
export type CoachFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CoachAccessTokenProvider = () => string | null | Promise<string | null>;

export interface CoachTailOptions {
  /** Delay before re-GETing the same run after a successful page boundary. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Hard cap for one subscription; a normal 15s server page keeps polling. */
  maxTailMs?: number;
}

export interface MobileCloudCoachClientOptions {
  /** Explicit config override (embedding/tests); default reads Expo env. */
  config?: CoachConfig;
  /** Current bearer, e.g. `useAuth().getAccessToken`. */
  getAccessToken?: CoachAccessTokenProvider;
  /** JSON request fetch (injectable for tests). */
  fetchImpl?: CoachFetch;
  /** Streaming fetch; defaults to `expo/fetch`, not the RN global fetch. */
  streamFetchImpl?: CoachFetch;
  tail?: CoachTailOptions;
}

export interface CoachSubscription {
  /** Detach the local stream only; the run keeps executing server-side. */
  close(): void;
  done: Promise<CoachSubscriptionResult>;
}

export interface CoachSubscriptionResult {
  /** True when the caller/external signal closed the stream before terminal. */
  aborted: boolean;
  /** Highest folded seq (`fromSeq - 1` when nothing was folded). */
  lastConsumed: number;
  /** The confirmed terminal envelope, if this subscription observed one. */
  terminal: CoachingEventEnvelope | null;
}

/** Error bodies are diagnostics only; never buffer an unbounded hostile body. */
const MAX_COACH_ERROR_BODY_BYTES = 64 * 1024;
/** Cloud JSON responses are small; `response.text()` would be unbounded. */
const MAX_COACH_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_TAIL_INITIAL_BACKOFF_MS = 250;
const DEFAULT_TAIL_MAX_BACKOFF_MS = 5_000;
const DEFAULT_TAIL_MAX_MS = 30 * 60_000;

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readData(parsed: unknown): unknown {
  if (!isObject(parsed) || !("data" in parsed)) {
    throw new CoachError("malformed", {
      message: "The coaching response is missing its data envelope.",
    });
  }
  return parsed.data;
}

function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
): void {
  if (reader === null) return;
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // The reader may already be closed/errored; there is nothing to release.
  }
}

function assertNonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoachError("validation", {
      message: `\`${field}\` must be a non-blank string.`,
    });
  }
  return value;
}

function assertFromSeq(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoachError("validation", {
      message: "`fromSeq` must be a safe non-negative integer (last consumed seq + 1).",
    });
  }
  return value;
}

function assertEventStream(response: Response): void {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null ||
    contentType.split(";")[0]?.trim().toLowerCase() !== "text/event-stream"
  ) {
    throw new CoachError("malformed", {
      message: "The coaching event response is not an SSE stream.",
    });
  }
}

/** Read a response body with a hard byte cap; over-budget is malformed. */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        text += decoder.decode();
        break;
      }
      if (read.value.byteLength > limit - bytes) {
        throw new CoachError("malformed", {
          message: "The coaching response exceeded the byte limit.",
        });
      }
      bytes += read.value.byteLength;
      text += decoder.decode(read.value, { stream: true });
    }
  } finally {
    cancelReaderBestEffort(reader);
  }
  return text;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await readBoundedBody(response, MAX_COACH_ERROR_BODY_BYTES);
  } catch {
    return "";
  }
}

function parseOptionalJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function defaultJsonFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultStreamFetch(input: string, init?: RequestInit): Promise<Response> {
  return expoFetch(input, init);
}

/** Convert a shared request-shape guard failure into a typed coach error. */
function parseRequest<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof CoachError) throw error;
    throw new CoachError("validation", {
      message: "The coaching request is invalid.",
      cause: error,
    });
  }
}

export class MobileCloudCoachClient {
  readonly config: CoachConfig;
  private readonly apiBaseUrl: string | null;
  private readonly getAccessToken: CoachAccessTokenProvider | undefined;
  private readonly fetchImpl: CoachFetch;
  private readonly streamFetchImpl: CoachFetch;
  private readonly tailInitialBackoffMs: number;
  private readonly tailMaxBackoffMs: number;
  private readonly tailMaxMs: number;

  constructor(options: MobileCloudCoachClientOptions = {}) {
    this.config = options.config === undefined ? readCoachConfig() : options.config;
    this.apiBaseUrl = this.config.configured ? this.config.apiBaseUrl : null;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? defaultJsonFetch;
    this.streamFetchImpl = options.streamFetchImpl ?? defaultStreamFetch;
    this.tailInitialBackoffMs = positiveMs(
      options.tail?.initialBackoffMs,
      DEFAULT_TAIL_INITIAL_BACKOFF_MS,
    );
    this.tailMaxBackoffMs = Math.max(
      this.tailInitialBackoffMs,
      positiveMs(options.tail?.maxBackoffMs, DEFAULT_TAIL_MAX_BACKOFF_MS),
    );
    this.tailMaxMs = positiveMs(options.tail?.maxTailMs, DEFAULT_TAIL_MAX_MS);
  }

  /** False when the build has no valid `EXPO_PUBLIC_FIT_TRACE_API_URL`. */
  get isConfigured(): boolean {
    return this.apiBaseUrl !== null;
  }

  /** Server-derived cloud availability for the signed-in caller. */
  async readCapabilities(): Promise<CloudCapabilities> {
    return this.request(
      "/coaching/cloud/capabilities",
      { method: "GET" },
      parseCloudCapabilities,
    );
  }

  /** Create a coaching session; the returned id is reused for later asks. */
  async createSession(id?: string): Promise<{ id: string }> {
    const body = parseRequest(() =>
      parseCloudCreateSessionInput(id === undefined ? undefined : { id }),
    );
    return this.request(
      "/coaching/cloud/sessions",
      { method: "POST", jsonBody: body },
      parseCoachingSession,
    );
  }

  async readSession(id: string): Promise<{ id: string }> {
    assertNonBlank(id, "sessionId");
    return this.request(
      `/coaching/cloud/sessions/${encodeURIComponent(id)}`,
      { method: "GET" },
      parseCoachingSession,
    );
  }

  /** Materialize the signed-in caller's workouts into a run snapshot handle. */
  async createSnapshot(filter?: {
    from?: string;
    to?: string;
  }): Promise<CoachingDataSnapshot> {
    const body = parseRequest(() => parseSnapshotFilter(filter ?? {}));
    return this.request(
      "/coaching/cloud/snapshots",
      { method: "POST", jsonBody: body },
      parseSnapshotCreateResult,
    );
  }

  /**
   * Submit one run. The caller owns the stable idempotency key: this method
   * makes exactly one attempt and never retries automatically, so an
   * ambiguous failure keeps the same key for an explicit user retry.
   */
  async submitRun(input: SubmitCoachingRunInput): Promise<CloudSubmitRunResult> {
    // The cloud route is already the cloud backend; backend fields are not
    // forwarded (mirrors the web client's restricted payload).
    const parsed = parseRequest(() => parseCloudSubmitRunInput(input));
    return this.request(
      "/coaching/cloud/runs",
      {
        method: "POST",
        jsonBody: {
          sessionId: parsed.sessionId,
          prompt: parsed.prompt,
          idempotencyKey: parsed.idempotencyKey,
          snapshot: parsed.snapshot,
        },
      },
      parseCloudSubmitRunResult,
    );
  }

  async readRun(runId: string): Promise<CloudReadRunResult> {
    assertNonBlank(runId, "runId");
    return this.request(
      `/coaching/cloud/runs/${encodeURIComponent(runId)}`,
      { method: "GET" },
      parseCloudReadRunResult,
    );
  }

  async cancelRun(runId: string, reason?: string): Promise<CloudCancelRunResult> {
    assertNonBlank(runId, "runId");
    return this.request(
      `/coaching/cloud/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", jsonBody: reason === undefined ? {} : { reason } },
      parseCloudCancelRunResult,
    );
  }

  /**
   * Tail one run's replay-only SSE stream from `fromSeq`.
   *
   * Streaming uses `expo/fetch` (or `streamFetchImpl`) so the response body is
   * incrementally readable. Each page is bounded by the shared 1 MiB frame /
   * 4 MiB body budgets; a page boundary is a normal reconnect and continues
   * the SAME run from the consumed cursor. `close()`/an external abort only
   * detaches the stream — it never cancels the server run.
   *
   * Invalid ids throw synchronously; config/auth/network failures reject
   * `done` with a typed {@link CoachError}. Reconnect after `done` rejects with
   * `expired-cursor` should restart from seq `0` (the server never skips).
   */
  subscribeRunEvents(
    input: { runId: string; sessionId: string; fromSeq?: number },
    onEvent: (envelope: CoachingEventEnvelope) => void,
    options: { signal?: AbortSignal } = {},
  ): CoachSubscription {
    const runId = assertNonBlank(input.runId, "runId");
    const sessionId = assertNonBlank(input.sessionId, "sessionId");
    const fromSeq = assertFromSeq(input.fromSeq);
    const expected: CoachStreamIdentity = { sessionId, runId };
    const controller = new AbortController();
    const externalSignal = options.signal;

    let settled = false;
    let lastConsumed = fromSeq - 1;
    let terminal: CoachingEventEnvelope | null = null;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let resolveDone!: (result: CoachSubscriptionResult) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<CoachSubscriptionResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});

    const result = (aborted: boolean): CoachSubscriptionResult => ({
      aborted,
      lastConsumed,
      terminal,
    });
    const settleOk = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      resolveDone(result(aborted));
    };
    const settleError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectDone(error);
    };
    const detach = (): void => {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      cancelReaderBestEffort(activeReader);
      activeReader = null;
    };
    const close = (): void => {
      controller.abort();
      cancelReaderBestEffort(activeReader);
      activeReader = null;
      settleOk(true);
    };
    const onExternalAbort = (): void => close();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        close();
        return { close, done };
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const sleep = async (ms: number): Promise<void> => {
      if (settled || controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    };

    const failGap = (expectedSeq: number, receivedSeq: number): never => {
      throw new CoachError("malformed", {
        message: `The coaching stream skipped from seq ${String(expectedSeq)} to ${String(
          receivedSeq,
        )}; reload from the first seq and re-fold.`,
      });
    };

    /** Read one bounded page and fold contiguous envelopes. */
    const readPage = async (
      response: Response,
      cursor: number,
    ): Promise<CoachingEventEnvelope | null> => {
      const body = response.body;
      if (body === null) {
        throw new CoachError("malformed", {
          message: "The coaching event response has no readable body.",
        });
      }
      const reader = body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let totalBytes = 0;
      let expectedSeq = cursor;
      let pageTerminal: CoachingEventEnvelope | null = null;

      const deliver = (block: string): void => {
        if (settled || controller.signal.aborted || pageTerminal !== null) return;
        if (block.trim() === "") return;
        const envelope = parseCoachSseBlock(block, { expected });
        if (envelope === null) return;
        if (envelope.seq < expectedSeq) return; // replay duplicate
        if (envelope.seq > expectedSeq) {
          failGap(expectedSeq, envelope.seq);
        }
        // Mark consumption only after the caller accepted the event, so a
        // throwing handler cannot make a reconnect skip it.
        onEvent(envelope);
        expectedSeq = envelope.seq + 1;
        lastConsumed = envelope.seq;
        if (envelope.event.type === "terminal") pageTerminal = envelope;
      };

      const drain = (flush: boolean): void => {
        const taken = takeCoachSseFrames(buffer);
        buffer = taken.rest;
        for (const frame of taken.frames) {
          deliver(frame);
          if (settled || controller.signal.aborted || pageTerminal !== null) return;
        }
        if (flush) {
          if (buffer.trim() !== "") {
            const finalBlock = buffer;
            buffer = "";
            deliver(finalBlock);
          }
          return;
        }
        if (coachUtf8ByteLength(buffer) + 2 > MAX_COACH_SSE_FRAME_BYTES) {
          throw new CoachError("malformed", {
            message: "The coaching event frame exceeded the byte limit.",
          });
        }
      };

      try {
        for (;;) {
          const read = await reader.read();
          if (settled || controller.signal.aborted) return pageTerminal;
          if (read.done) {
            buffer += decoder.decode();
            drain(true);
            return pageTerminal;
          }
          totalBytes += read.value.byteLength;
          if (totalBytes > MAX_COACH_SSE_TOTAL_BYTES) {
            throw new CoachError("malformed", {
              message: "The coaching event page exceeded the byte limit.",
            });
          }
          buffer += decoder.decode(read.value, { stream: true });
          drain(false);
          if (settled || controller.signal.aborted || pageTerminal !== null) {
            return pageTerminal;
          }
        }
      } finally {
        cancelReaderBestEffort(reader);
        if (activeReader === reader) activeReader = null;
      }
    };

    void (async (): Promise<void> => {
      try {
        const apiBaseUrl = this.requireApiBase();
        let accessToken: string;
        try {
          accessToken = await this.requireAccessToken();
        } catch (error) {
          if (settled || controller.signal.aborted) {
            settleOk(true);
            return;
          }
          settleError(error);
          return;
        }
        if (settled || controller.signal.aborted) {
          settleOk(true);
          return;
        }
        const headers: Record<string, string> = {
          accept: "text/event-stream",
          authorization: `Bearer ${accessToken}`,
        };
        const startedAt = Date.now();
        let cursor = fromSeq;
        let backoff = this.tailInitialBackoffMs;
        for (;;) {
          if (settled || controller.signal.aborted) {
            settleOk(true);
            return;
          }
          if (Date.now() - startedAt >= this.tailMaxMs) {
            throw new CoachError("timeout", {
              message:
                "The coaching stream ended before the run finished. Reconnect to resume from the last event.",
            });
          }
          let response: Response;
          try {
            response = await this.streamFetchImpl(
              `${apiBaseUrl}/coaching/cloud/runs/${encodeURIComponent(
                runId,
              )}/events?fromSeq=${String(cursor)}`,
              { method: "GET", headers, signal: controller.signal, redirect: "error" },
            );
          } catch (error) {
            if (settled || controller.signal.aborted) {
              settleOk(true);
              return;
            }
            throw isCancelledError(error) ? cancelledCoachError() : toCoachError(error, "network");
          }
          if (settled || controller.signal.aborted) {
            settleOk(true);
            return;
          }
          if (!isOkStatus(response.status)) {
            const text = await readErrorBody(response);
            throw coachErrorFromHttp(response.status, parseOptionalJson(text));
          }
          assertEventStream(response);
          const before = lastConsumed;
          const pageTerminal = await readPage(response, cursor);
          if (settled || controller.signal.aborted) {
            settleOk(true);
            return;
          }
          if (pageTerminal !== null) {
            terminal = pageTerminal;
            settleOk(false);
            return;
          }
          // Successful page boundary (server deadline/page limit): continue
          // the SAME run automatically. Never mint a new POST.
          cursor = lastConsumed + 1;
          if (lastConsumed > before) backoff = this.tailInitialBackoffMs;
          await sleep(backoff);
          backoff = Math.min(backoff * 2, this.tailMaxBackoffMs);
        }
      } catch (error) {
        if (settled || controller.signal.aborted) settleOk(true);
        else settleError(toCoachError(error, "network"));
      } finally {
        detach();
      }
    })();

    return { close, done };
  }

  private requireApiBase(): string {
    if (this.apiBaseUrl === null) throw new CoachError("unconfigured");
    return this.apiBaseUrl;
  }

  private async requireAccessToken(): Promise<string> {
    let accessToken: string | null;
    try {
      accessToken =
        this.getAccessToken === undefined ? null : await this.getAccessToken();
    } catch (error) {
      if (isCancelledError(error)) throw cancelledCoachError();
      // A failed token provider must not surface its raw error (or a token).
      throw new CoachError("unauthenticated", { cause: error });
    }
    if (
      typeof accessToken !== "string" ||
      accessToken.trim() === "" ||
      /[\r\n]/.test(accessToken)
    ) {
      throw new CoachError("unauthenticated");
    }
    return accessToken;
  }

  private async request<T>(
    path: string,
    opts: { method: "GET" | "POST"; jsonBody?: unknown },
    parse: (data: unknown) => T,
  ): Promise<T> {
    const apiBaseUrl = this.requireApiBase();
    const accessToken = await this.requireAccessToken();
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.jsonBody !== undefined) headers["content-type"] = "application/json";
    headers.authorization = `Bearer ${accessToken}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${apiBaseUrl}${path}`, {
        method: opts.method,
        headers,
        ...(opts.jsonBody === undefined ? {} : { body: JSON.stringify(opts.jsonBody) }),
        redirect: "error",
      });
    } catch (error) {
      if (isCancelledError(error)) throw cancelledCoachError();
      throw toCoachError(error, "network");
    }

    if (!isOkStatus(response.status)) {
      const text = await readErrorBody(response);
      throw coachErrorFromHttp(response.status, parseOptionalJson(text));
    }

    let text: string;
    try {
      text = await readBoundedBody(response, MAX_COACH_JSON_BODY_BYTES);
    } catch (error) {
      if (error instanceof CoachError) throw error;
      throw new CoachError("malformed", {
        message: "The coaching response body could not be read.",
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CoachError("malformed", {
        message: "The coaching response is not valid JSON.",
      });
    }
    const data = readData(parsed);
    try {
      return parse(data);
    } catch (error) {
      if (error instanceof CoachError) throw error;
      throw new CoachError("malformed", {
        message: "The coaching response does not match the protocol.",
        cause: error,
      });
    }
  }
}
