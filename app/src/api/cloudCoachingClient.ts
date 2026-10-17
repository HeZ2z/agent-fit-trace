import {
  API_ERROR_CODES,
  ApiError,
  MalformedResponseError,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  NetworkError,
  parseCloudCancelRunResult,
  parseCloudCapabilities,
  parseCloudCreateSessionInput,
  parseCloudReadRunResult,
  parseCloudSubmitRunResult,
  parseCoachingSession,
  parseSnapshotCreateResult,
  parseSnapshotFilter,
  parseSubmitCoachingRunInput,
  utf8ByteLength,
} from "@pi-fit-trace/api-contracts";
import type {
  CloudCancelRunResult,
  CloudCapabilities,
  CloudReadRunResult,
  CloudSubmitRunResult,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingStreamIdentity,
  SubmitCoachingRunInput,
} from "@pi-fit-trace/api-contracts";
import {
  assertSseContentType,
  cancelReaderBestEffort,
  parseSseBlock,
  takeSseFrames,
} from "../api/coachingClient.ts";

/**
 * Same-origin browser client for the SHARED cloud coaching routes
 * (`/api/v1/coaching/cloud/*`).
 *
 * Transport only:
 * - bearer-only auth; the server derives formal-account eligibility and quota
 *   from the verified token (nothing in this client can assert either).
 * - exactly one HTTP attempt per call, with the caller's idempotency key sent
 *   verbatim. No automatic fallback to local or a second POST.
 * - the cloud event endpoint is replay-only SSE split into bounded long-poll
 *   pages. A page that ends before the terminal is a normal boundary: the
 *   client automatically GETs the next page from the consumed cursor (bounded
 *   backoff and tail budget, never a second POST). A network/HTTP failure or
 *   the tail budget expiring remains an honest disconnect, never completion.
 */

export interface CloudTailOptions {
  /** Delay before re-GETing the same run after a successful page boundary. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Hard cap for one subscription; a normal 15s server page keeps polling. */
  maxTailMs?: number;
}

export interface CloudCoachingClientOptions {
  /** Same-origin base only (`"/api/v1"` default). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => string | null | Promise<string | null>;
  /** Tests may shorten the abortable tail backoff. */
  tail?: CloudTailOptions;
}

/** Error bodies are diagnostics only; never buffer an unbounded hostile body. */
const MAX_CLOUD_ERROR_BODY_BYTES = 64 * 1024;
/** Non-SSE JSON responses are small; cap them too instead of `response.text()`. */
const MAX_CLOUD_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_TAIL_INITIAL_BACKOFF_MS = 250;
const DEFAULT_TAIL_MAX_BACKOFF_MS = 5_000;
const DEFAULT_TAIL_MAX_MS = 30 * 60_000;

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function assertSameOriginBase(baseUrl: string): void {
  if (baseUrl === "") return;
  if (
    baseUrl.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(baseUrl) ||
    !baseUrl.startsWith("/") ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    baseUrl.includes("\\")
  ) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: "Cloud coaching client baseUrl must stay same-origin (\"\" or a root-relative path).",
    });
  }
}

function readData(parsed: unknown): unknown {
  if (!isObject(parsed) || !("data" in parsed)) {
    throw new MalformedResponseError("data", "is missing");
  }
  return parsed.data;
}

function toApiError(parsed: unknown, status: number): ApiError {
  const body = isObject(parsed) ? parsed.error : undefined;
  if (isObject(body) && typeof body.code === "string" && typeof body.message === "string") {
    const details =
      body.details !== undefined
        ? body.details
        : isObject(parsed) && "data" in parsed
          ? parsed.data
          : undefined;
    return new ApiError({ code: body.code, message: body.message, details, status });
  }
  return new ApiError({
    code: API_ERROR_CODES.API_ERROR,
    message: `Server responded with status ${status} and a malformed error body.`,
    status,
  });
}

/** Read at most MAX_CLOUD_ERROR_BODY_BYTES from an error response. */
async function readBoundedErrorBody(response: Response, signal: AbortSignal): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let bytes = 0;
  const onAbort = (): void => cancelReaderBestEffort(reader);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        text += decoder.decode();
        break;
      }
      const remaining = MAX_CLOUD_ERROR_BODY_BYTES - bytes;
      if (read.value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(read.value.subarray(0, remaining));
        break;
      }
      bytes += read.value.byteLength;
      text += decoder.decode(read.value, { stream: true });
      if (bytes >= MAX_CLOUD_ERROR_BODY_BYTES) break;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    cancelReaderBestEffort(reader);
  }
  return text;
}

/**
 * Read a non-SSE response with a hard byte cap. `response.text()` would buffer
 * an unbounded body from a buggy or hostile upstream, including on the error
 * path. Anything over the cap is a malformed response, never parsed.
 */
async function readBoundedJsonBody(response: Response, limit: number): Promise<string> {
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
        throw new MalformedResponseError(
          "(root)",
          `response body exceeds the ${String(limit)}-byte limit`,
        );
      }
      bytes += read.value.byteLength;
      text += decoder.decode(read.value, { stream: true });
    }
  } finally {
    cancelReaderBestEffort(reader);
  }
  return text;
}

function assertFromSeq(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: "`fromSeq` must be a safe non-negative integer (last consumed seq + 1).",
    });
  }
  return value;
}

export class CloudCoachingClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken?: () => string | null | Promise<string | null>;
  private readonly tailInitialBackoffMs: number;
  private readonly tailMaxBackoffMs: number;
  private readonly tailMaxMs: number;

  constructor({
    baseUrl = "/api/v1",
    fetchImpl = fetch,
    getAccessToken,
    tail,
  }: CloudCoachingClientOptions = {}) {
    assertSameOriginBase(baseUrl);
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
    this.tailInitialBackoffMs = positiveMs(
      tail?.initialBackoffMs,
      DEFAULT_TAIL_INITIAL_BACKOFF_MS,
    );
    this.tailMaxBackoffMs = Math.max(
      this.tailInitialBackoffMs,
      positiveMs(tail?.maxBackoffMs, DEFAULT_TAIL_MAX_BACKOFF_MS),
    );
    this.tailMaxMs = positiveMs(tail?.maxTailMs, DEFAULT_TAIL_MAX_MS);
  }

  /** Cloud routes need only the bearer; there is no capability bootstrap. */
  get isBootstrapped(): boolean {
    return true;
  }

  async bootstrap(): Promise<{ capability: string; expiresInMs: number }> {
    return { capability: "", expiresInMs: 0 };
  }

  /** No capability exists to leak on account switch. */
  capabilitySnapshot(): string | null {
    return null;
  }

  discardCredentials(): void {
    // The bearer is resolved per request from the account-bound provider.
  }

  async readCapabilities(): Promise<CloudCapabilities> {
    return this.request(
      "/coaching/cloud/capabilities",
      { capability: null },
      parseCloudCapabilities,
    );
  }

  async createSession(id?: string): Promise<{ id: string }> {
    const body = parseCloudCreateSessionInput(id === undefined ? undefined : { id });
    return this.request(
      "/coaching/cloud/sessions",
      { method: "POST", jsonBody: body, capability: null },
      parseCoachingSession,
    );
  }

  async readSession(id: string): Promise<{ id: string }> {
    assertNonBlank(id, "sessionId");
    return this.request(
      `/coaching/cloud/sessions/${encodeURIComponent(id)}`,
      { capability: null },
      parseCoachingSession,
    );
  }

  async createSnapshot(filter?: { from?: string; to?: string }): Promise<CoachingDataSnapshot> {
    const body = parseSnapshotFilter(filter ?? {});
    return this.request(
      "/coaching/cloud/snapshots",
      { method: "POST", jsonBody: body, capability: null },
      parseSnapshotCreateResult,
    );
  }

  async submitRun(input: SubmitCoachingRunInput): Promise<CloudSubmitRunResult> {
    // Reuse the shared handle-only guard. Backend fields are deliberately not
    // forwarded: the cloud route is already the cloud backend.
    const parsed = parseSubmitCoachingRunInput(input);
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
        capability: null,
      },
      parseCloudSubmitRunResult,
    );
  }

  async readRun(runId: string): Promise<CloudReadRunResult> {
    assertNonBlank(runId, "runId");
    return this.request(
      `/coaching/cloud/runs/${encodeURIComponent(runId)}`,
      { capability: null },
      parseCloudReadRunResult,
    );
  }

  async cancelRun(
    runId: string,
    reason?: string,
    cleanup?: { accessToken?: string | null; capability?: string | null },
  ): Promise<CloudCancelRunResult> {
    assertNonBlank(runId, "runId");
    return this.request(
      `/coaching/cloud/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        jsonBody: reason === undefined ? {} : { reason },
        capability: null,
        ...(cleanup?.accessToken !== undefined
          ? { accessTokenOverride: cleanup.accessToken }
          : {}),
      },
      parseCloudCancelRunResult,
    );
  }

  /** The cloud route has no per-client logout; the bearer teardown belongs to auth. */
  async logout(): Promise<{ loggedOut: boolean }> {
    return { loggedOut: true };
  }

  /**
   * Fetch-SSE tail for one cloud run.
   *
   * The server exposes a bounded long-poll page (15s or terminal). A page that
   * ends without the terminal is a NORMAL boundary, not a user-visible
   * disconnect: this client automatically GETs the next page from
   * `lastConsumed + 1` with abortable exponential backoff, up to a hard tail
   * time budget. It never POSTs again. Frames are parsed incrementally with a
   * 1 MiB frame / 4 MiB body bound, so a hostile or truncated stream cannot be
   * buffered as one unverified text lump.
   */
  subscribeRunEvents(
    input: { runId: string; sessionId: string; fromSeq?: number },
    onEvent: (envelope: CoachingEventEnvelope) => void,
    options?: { signal?: AbortSignal },
  ): { close(): void; done: Promise<{ aborted: boolean; lastConsumed: number }> } {
    const runId = assertNonBlank(input.runId, "runId");
    const sessionId = assertNonBlank(input.sessionId, "sessionId");
    const fromSeq = assertFromSeq(input.fromSeq);
    const expected: CoachingStreamIdentity = { sessionId, runId };
    const controller = new AbortController();
    const externalSignal = options?.signal;
    let settled = false;
    let lastConsumed = fromSeq - 1;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let resolveDone!: (result: { aborted: boolean; lastConsumed: number }) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<{ aborted: boolean; lastConsumed: number }>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const settleOk = (result: { aborted: boolean; lastConsumed: number }): void => {
      if (settled) return;
      settled = true;
      resolveDone(result);
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
      settleOk({ aborted: true, lastConsumed });
    };
    const onExternalAbort = (): void => close();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        close();
        return { close, done };
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    done.catch(() => {});

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

    /** Read one bounded page and fold contiguous envelopes. */
    const readPage = async (
      response: Response,
      cursor: number,
    ): Promise<{ terminated: boolean }> => {
      const body = response.body;
      if (body === null) {
        throw new MalformedResponseError("events", "SSE response has no body");
      }
      const reader = body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let totalBytes = 0;
      let expectedSeq = cursor;
      let terminated = false;

      const deliverBlock = (block: string): void => {
        if (settled || terminated || controller.signal.aborted) return;
        const envelope = parseSseBlock(block, expected);
        if (envelope === null) return;
        if (envelope.seq < expectedSeq) return;
        if (envelope.seq > expectedSeq) {
          throw new MalformedResponseError(
            "events",
            `gap: expected seq ${String(expectedSeq)} but received ${String(envelope.seq)} (refetch from firstSeq; never skip)`,
          );
        }
        onEvent(envelope);
        lastConsumed = envelope.seq;
        expectedSeq = envelope.seq + 1;
        if (envelope.event.type === "terminal") terminated = true;
      };

      const drainFrames = (flush: boolean): void => {
        const taken = takeSseFrames(buffer);
        buffer = taken.rest;
        for (const frame of taken.frames) {
          if (utf8ByteLength(frame.block) + frame.delimiterBytes > MAX_COACHING_SSE_FRAME_BYTES) {
            throw new MalformedResponseError("events", "SSE frame exceeds the size limit");
          }
        }
        if (flush) {
          if (buffer !== "" && utf8ByteLength(buffer) > MAX_COACHING_SSE_FRAME_BYTES) {
            throw new MalformedResponseError("events", "SSE frame exceeds the size limit");
          }
          const blocks = taken.frames.map((frame) => frame.block);
          if (buffer !== "") blocks.push(buffer);
          buffer = "";
          for (const block of blocks) {
            deliverBlock(block);
            if (settled || terminated || controller.signal.aborted) return;
          }
          return;
        }
        if (utf8ByteLength(buffer) > MAX_COACHING_SSE_FRAME_BYTES) {
          throw new MalformedResponseError("events", "SSE frame exceeds the size limit");
        }
        for (const frame of taken.frames) {
          deliverBlock(frame.block);
          if (settled || terminated || controller.signal.aborted) return;
        }
      };

      try {
        for (;;) {
          const read = await reader.read();
          if (settled || controller.signal.aborted) return { terminated };
          if (read.done) {
            buffer += decoder.decode();
            drainFrames(true);
            return { terminated };
          }
          totalBytes += read.value.byteLength;
          if (totalBytes > MAX_COACHING_SSE_TOTAL_BYTES) {
            throw new MalformedResponseError("events", "SSE body exceeds the size limit");
          }
          buffer += decoder.decode(read.value, { stream: true });
          drainFrames(false);
          if (settled || terminated || controller.signal.aborted) return { terminated };
        }
      } finally {
        cancelReaderBestEffort(reader);
        if (activeReader === reader) activeReader = null;
      }
    };

    void (async (): Promise<void> => {
      try {
        let accessToken: string | null;
        try {
          accessToken = this.getAccessToken === undefined ? null : await this.getAccessToken();
        } catch (error) {
          if (controller.signal.aborted || settled) finishAborted();
          else settleError(error);
          return;
        }
        if (settled || controller.signal.aborted) {
          finishAborted();
          return;
        }
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (accessToken !== null && accessToken !== "") {
          headers.authorization = `Bearer ${accessToken}`;
        }
        const startedAt = Date.now();
        let cursor = fromSeq;
        let backoff = this.tailInitialBackoffMs;
        for (;;) {
          if (settled || controller.signal.aborted) {
            finishAborted();
            return;
          }
          if (Date.now() - startedAt >= this.tailMaxMs) {
            settleError(
              new NetworkError(
                "Cloud coaching tail exceeded its time budget before the terminal event. Reconnect to resume.",
              ),
            );
            return;
          }
          let response: Response;
          try {
            response = await this.fetchImpl(
              `${this.baseUrl}/coaching/cloud/runs/${encodeURIComponent(
                runId,
              )}/events?fromSeq=${String(cursor)}`,
              { method: "GET", headers, signal: controller.signal, redirect: "error" },
            );
          } catch (error) {
            if (controller.signal.aborted || settled) finishAborted();
            else settleError(new NetworkError(undefined, { cause: error }));
            return;
          }
          if (settled || controller.signal.aborted) {
            finishAborted();
            return;
          }
          if (!isOkStatus(response.status)) {
            let text = "";
            try {
              text = await readBoundedErrorBody(response, controller.signal);
            } catch {
              // Fall through with an empty body.
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              parsed = undefined;
            }
            settleError(toApiError(parsed, response.status));
            return;
          }
          try {
            assertSseContentType(response);
          } catch (error) {
            settleError(error);
            return;
          }
          const before = lastConsumed;
          const page = await readPage(response, cursor);
          if (settled || controller.signal.aborted) {
            finishAborted();
            return;
          }
          if (page.terminated) {
            settleOk({ aborted: false, lastConsumed });
            return;
          }
          // Successful page boundary (server 15s deadline / page limit):
          // continue the SAME run automatically. Never mint a new POST.
          cursor = lastConsumed + 1;
          if (lastConsumed > before) backoff = this.tailInitialBackoffMs;
          if (Date.now() - startedAt >= this.tailMaxMs) {
            settleError(
              new NetworkError(
                "Cloud coaching tail exceeded its time budget before the terminal event. Reconnect to resume.",
              ),
            );
            return;
          }
          await sleep(backoff);
          backoff = Math.min(backoff * 2, this.tailMaxBackoffMs);
        }
      } catch (error) {
        if (controller.signal.aborted || settled) finishAborted();
        else settleError(error);
      } finally {
        detach();
      }
    })();

    function finishAborted(): void {
      settleOk({ aborted: true, lastConsumed });
    }

    return { close, done };
  }

  private async request<T>(
    path: string,
    opts: {
      method?: string;
      jsonBody?: unknown;
      capability: null;
      accessTokenOverride?: string | null;
    },
    parse: (data: unknown) => T,
  ): Promise<T> {
    const accessToken =
      opts.accessTokenOverride !== undefined
        ? opts.accessTokenOverride
        : this.getAccessToken === undefined
          ? null
          : await this.getAccessToken();
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.jsonBody !== undefined) headers["content-type"] = "application/json";
    if (accessToken !== null && accessToken !== "") {
      headers.authorization = `Bearer ${accessToken}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: opts.method,
        headers,
        body: opts.jsonBody === undefined ? undefined : JSON.stringify(opts.jsonBody),
        redirect: "error",
      });
    } catch (error) {
      throw new NetworkError(undefined, { cause: error });
    }
    let text: string;
    try {
      text = await readBoundedJsonBody(
        response,
        isOkStatus(response.status) ? MAX_CLOUD_JSON_BODY_BYTES : MAX_CLOUD_ERROR_BODY_BYTES,
      );
    } catch (error) {
      if (!isOkStatus(response.status)) throw toApiError(undefined, response.status);
      if (error instanceof MalformedResponseError) throw error;
      throw new NetworkError("Network response body could not be read.", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (isOkStatus(response.status)) {
        throw new MalformedResponseError("(root)", "is not valid JSON");
      }
      throw toApiError(undefined, response.status);
    }
    if (!isOkStatus(response.status)) throw toApiError(parsed, response.status);
    return parse(readData(parsed));
  }
}

function assertNonBlank(value: string, field: string): string {
  if (value.trim() === "") {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: `\`${field}\` must be a non-blank string.`,
    });
  }
  return value;
}
