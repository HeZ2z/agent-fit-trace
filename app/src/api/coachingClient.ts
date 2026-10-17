import {
  API_ERROR_CODES,
  ApiError,
  MalformedResponseError,
  NetworkError,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  parseCancelCoachingRunBody,
  parseCancelCoachingRunResult,
  parseCoachingBootstrapResult,
  parseCoachingCapabilityDiscovery,
  parseCoachingEventEnvelope,
  parseCoachingLogoutResult,
  parseCoachingSession,
  parseCreateCoachingSessionInput,
  parseReadCoachingRunResult,
  parseSnapshotCreateResult,
  parseSnapshotFilter,
  parseSubmitCoachingRunInput,
  parseSubmitCoachingRunResult,
  utf8ByteLength,
} from "@pi-fit-trace/api-contracts";
import type {
  CancelCoachingRunResult,
  CoachingBootstrapResult,
  CoachingCapabilityDiscovery,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingLogoutResult,
  CoachingSession,
  CoachingStreamIdentity,
  ReadCoachingRunResult,
  SubmitCoachingRunInput,
  SubmitCoachingRunResult,
} from "@pi-fit-trace/api-contracts";

/**
 * Same-origin browser client for the local coaching HTTP + fetch-SSE API.
 *
 * Transport only — no React state, no UI, no storage.
 * - Same origin only: `baseUrl` is `""` or root-relative; absolute URLs reject.
 * - Bootstrap sends the bearer only and holds the TTL-capped capability in
 *   memory. Other routes require a live capability, else UNAUTHENTICATED.
 * - Exactly one HTTP attempt per call; the caller's `idempotencyKey` is sent
 *   verbatim. Fetches use `redirect: "error"` so the capability header is
 *   never followed cross-origin.
 * - SSE resumes from the caller's last consumed seq + 1 and delivers dense
 *   contiguous seqs only: older duplicates are ignored, a forward gap
 *   rejects (refetch from `firstSeq`, never skip). EOF before the terminal
 *   envelope is a disconnect (NetworkError), not completion.
 */

 /** Must match `CAPABILITY_HEADER` in `server/coaching/coachingServer.ts`. */
export const COACHING_CAPABILITY_HEADER = "x-fit-trace-capability";

const SSE_ACCEPT = "text/event-stream";

export type CoachingAccessTokenProvider = () => string | null | Promise<string | null>;

export interface CoachingClientOptions {
  /** Same-origin base only (`""` default). Absolute URLs reject. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Current bearer per request (awaited); `null` sends no credentials. */
  getAccessToken?: CoachingAccessTokenProvider;
}

export interface CreateCoachingSnapshotFilter {
  from?: string;
  to?: string;
}

export interface SubscribeRunEventsInput {
  runId: string;
  sessionId: string;
  /**
   * First seq still needed: the caller's last CONSUMED seq + 1 (`0` for a
   * fresh subscribe). This is the client's own resume position — never the
   * server's `lastSeq` cursor.
   */
  fromSeq?: number;
}

export interface CoachingEventStreamResult {
  aborted: boolean;
  /** Highest seq delivered to `onEvent` (`fromSeq - 1` when nothing arrived). */
  lastConsumed: number;
}

export interface CoachingEventSubscription {
  /** Detach from the stream (never cancels the run). Idempotent. */
  close(): void;
  done: Promise<CoachingEventStreamResult>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** `baseUrl` stays same-origin: `""` or a root-relative path, never a host. */
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
      message: "Coaching client baseUrl must stay same-origin (\"\" or a root-relative path).",
    });
  }
}

function assertNonBlankId(value: string, field: string): string {
  if (value.trim() === "") {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: `\`${field}\` must be a non-blank string.`,
    });
  }
  return value;
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

/** Unwrap the `{ data }` envelope; anything else cannot be trusted. */
function readData(parsed: unknown): unknown {
  if (!isObject(parsed) || !("data" in parsed)) {
    throw new MalformedResponseError("data", "is missing");
  }
  return parsed.data;
}

/**
 * Turn a non-2xx response into an `ApiError`. The 410 `EXPIRED_CURSOR` shape
 * carries `{ error, data }` — the `data` (current run + `firstSeq`/`lastSeq`
 * retention) is attached as `details` so the caller can refetch from
 * `firstSeq` and re-fold instead of skipping.
 */
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

function assertStreamIdentity(envelope: CoachingEventEnvelope, expected: CoachingStreamIdentity): void {
  if (envelope.sessionId !== expected.sessionId || envelope.runId !== expected.runId) {
    throw new MalformedResponseError("events", "mixed-stream event: sessionId/runId do not match expected stream");
  }
}

/**
 * Extract one SSE frame's `data:` payload. `id:`/`event:`/comment lines are
 * ignored; a frame without `data:` (keepalive/comment) returns `null`.
 * Multi-line data joins with `\n`; only one leading space is stripped.
 */
function extractSseData(block: string): string | null {
  const payloads: string[] = [];
  let hasData = false;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line.startsWith("data:")) continue;
    hasData = true;
    const value = line.slice("data:".length);
    payloads.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (!hasData) return null;
  return payloads.join("\n");
}

/**
 * Split buffered raw SSE text into complete frames. A blank line (two
 * consecutive line breaks) dispatches one frame; the remainder stays pending
 * so a delimiter split across chunks still frames.
 *
 * CRLF counts as ONE line break (atomic): a lone `\r\n` is a line ending,
 * not a blank line. The old `/(?:\r\n|\r|\n){2}/` backtracked and read one
 * CRLF as `\r` + `\n` (two breaks), splitting multiline `data:`/`id:` frames
 * prematurely. This scanner never splits a CRLF pair.
 */
function lengthOfLineBreakAt(value: string, index: number): number {
  if (index >= value.length) return 0;
  if (value[index] === "\r" && value[index + 1] === "\n") return 2;
  if (value[index] === "\r" || value[index] === "\n") return 1;
  return 0;
}

export interface SseFrame {
  /** Frame text WITHOUT its terminating blank line. */
  block: string;
  /**
   * Bytes of the blank-line delimiter that terminated the frame. CR/LF are
   * single-byte ASCII, so the delimiter's code-unit count IS its byte length.
   * Carried so the frame cap can measure the SAME full frame the server writes
   * (payload + delimiter) instead of the block alone.
   */
  delimiterBytes: number;
}

export function takeSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let frameStart = 0;
  let cursor = 0;
  while (cursor < buffer.length) {
    const first = lengthOfLineBreakAt(buffer, cursor);
    if (first === 0) {
      cursor += 1;
      continue;
    }
    const second = lengthOfLineBreakAt(buffer, cursor + first);
    if (second === 0) {
      cursor += first;
      continue;
    }
    // Two consecutive breaks = blank-line delimiter. Defer when the second
    // break is a trailing bare `\r` that may become `\r\n` with the next
    // chunk; emitting now would strand a leading `\n` in `rest`.
    if (cursor + first + second === buffer.length && buffer[buffer.length - 1] === "\r" && second === 1) {
      break;
    }
    const block = buffer.slice(frameStart, cursor);
    // Skip zero-length keepalive pings without emitting empty frames.
    if (block !== "") frames.push({ block, delimiterBytes: first + second });
    cursor += first + second;
    frameStart = cursor;
  }
  return { frames, rest: buffer.slice(frameStart) };
}

/** Split finished SSE text (replay helper): CRLF-aware, keeps a trailing unterminated frame. */
function splitSseText(text: string): string[] {
  const { frames, rest } = takeSseFrames(text);
  const blocks = frames.map((frame) => frame.block);
  if (rest !== "") blocks.push(rest);
  return blocks;
}
/** Parse one raw SSE block (`null` for keepalive/empty frames). */
export function parseSseBlock(block: string, expected: CoachingStreamIdentity): CoachingEventEnvelope | null {
  const payload = extractSseData(block);
  if (payload === null || payload === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload) as unknown;
  } catch {
    throw new MalformedResponseError("events", "contains a non-JSON SSE data frame");
  }
  const envelope = parseCoachingEventEnvelope(raw);
  assertStreamIdentity(envelope, expected);
  return envelope;
}

/**
 * Pure replay helper: fold raw SSE text into deduped, ascending envelopes
 * for one stream. First write wins per `seq`; cross-run frames throw.
 */
export function parseSseEventsText(text: string, expected: CoachingStreamIdentity): CoachingEventEnvelope[] {
  const bySeq = new Map<number, CoachingEventEnvelope>();
  for (const block of splitSseText(text)) {
    const envelope = parseSseBlock(block, expected);
    if (envelope !== null && !bySeq.has(envelope.seq)) bySeq.set(envelope.seq, envelope);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function assertSseContentType(response: Response): void {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new MalformedResponseError("events", "unexpected content-type (expected text/event-stream)");
  }
}

export function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array> | null): void {
  if (reader === null) return;
  try {
    const pending = reader.cancel() as unknown as Promise<void> | void;
    if (pending !== undefined && typeof (pending as Promise<void>).catch === "function") {
      (pending as Promise<void>).catch(() => {});
    }
  } catch {
    // Socket already gone.
  }
  try {
    reader.releaseLock();
  } catch {
    // Best-effort.
  }
}

export class CoachingClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken?: CoachingAccessTokenProvider;
  private capability: string | null = null;
  private capabilityExpiresAt = 0;
  private credentialGeneration = 0;
  private inflightBootstrap: Promise<CoachingBootstrapResult> | null = null;

  constructor({ baseUrl = "", fetchImpl = fetch, getAccessToken }: CoachingClientOptions = {}) {
    assertSameOriginBase(baseUrl);
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
  }

  /** True while a non-expired capability is held (re-bootstrap after). */
  get isBootstrapped(): boolean {
    return this.capability !== null && this.capability !== "" && Date.now() < this.capabilityExpiresAt;
  }

  /** Forget the in-memory capability (account switch / auth outage). */
  discardCredentials(): void {
    this.credentialGeneration += 1;
    this.inflightBootstrap = null;
    this.capability = null;
    this.capabilityExpiresAt = 0;
  }

  /**
   * Non-throwing snapshot of the live capability for account-switch cleanup.
   * Returns `null` when missing/expired so the caller skips server cleanup
   * instead of sending another account's credentials (item 3).
   */
  capabilitySnapshot(): string | null {
    if (this.capability === null || this.capability === "" || Date.now() >= this.capabilityExpiresAt) {
      return null;
    }
    return this.capability;
  }

  private requireCapability(): string {
    if (this.capability === null || this.capability === "" || Date.now() >= this.capabilityExpiresAt) {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Coaching capability is missing or expired; bootstrap again.",
      });
    }
    return this.capability;
  }

  private async request<T>(
    path: string,
    opts: { method?: string; jsonBody?: unknown; capability: string | null; accessTokenOverride?: string | null },
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
    if (accessToken !== null && accessToken !== "") headers.authorization = `Bearer ${accessToken}`;
    // Capabilities travel ONLY in the header — never the query string.
    if (opts.capability !== null && opts.capability !== "") {
      headers[COACHING_CAPABILITY_HEADER] = opts.capability;
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
      text = await response.text();
    } catch (error) {
      throw new NetworkError("Network response body could not be read.", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (isOkStatus(response.status)) throw new MalformedResponseError("(root)", "is not valid JSON");
      throw toApiError(undefined, response.status);
    }
    if (!isOkStatus(response.status)) throw toApiError(parsed, response.status);
    return parse(readData(parsed));
  }

  /**
   * Bearer-only bootstrap; stores the TTL-capped capability in memory.
   * Concurrent calls share one fetch; a discard in flight wins over the late
   * response (nothing stale is stored). Callers must discard/create clients
   * on account switch rather than reusing a capability across identities.
   */
  async bootstrap(): Promise<CoachingBootstrapResult> {
    const pending = this.inflightBootstrap;
    if (pending !== null) return pending;
    const generation = this.credentialGeneration;
    const task = (async (): Promise<CoachingBootstrapResult> => {
      const result = await this.request(
        "/coaching/bootstrap",
        { method: "POST", capability: null },
        parseCoachingBootstrapResult,
      );
      if (this.credentialGeneration === generation) {
        this.capability = result.capability;
        this.capabilityExpiresAt = Date.now() + result.expiresInMs;
      }
      return result;
    })();
    this.inflightBootstrap = task;
    try {
      return await task;
    } finally {
      if (this.inflightBootstrap === task) this.inflightBootstrap = null;
    }
  }

  async createSession(id?: string): Promise<CoachingSession> {
    const body = parseCreateCoachingSessionInput(id === undefined ? undefined : { id });
    return this.request(
      "/coaching/sessions",
      { method: "POST", jsonBody: body, capability: this.requireCapability() },
      parseCoachingSession,
    );
  }

  /**
   * Versioned, server-derived backend/capability discovery for this account.
   * Availability is never asserted by the browser. The launcher may return
   * local-pi plus other local adapters; cloud eligibility is informational
   * here (the shared cloud routes are reached by their own client).
   */
  async discoverBackends(): Promise<CoachingCapabilityDiscovery> {
    return this.request(
      "/coaching/capabilities",
      { capability: this.requireCapability() },
      parseCoachingCapabilityDiscovery,
    );
  }

  /**
   * Read one of the caller's own sessions. Public contract is id-only:
   * ownership is verified server-side, so no `accountId` is returned or
   * trusted here.
   */
  async readSession(id: string): Promise<CoachingSession> {
    assertNonBlankId(id, "sessionId");
    return this.request(
      `/coaching/sessions/${encodeURIComponent(id)}`,
      { capability: this.requireCapability() },
      parseCoachingSession,
    );
  }

  async createSnapshot(filter?: CreateCoachingSnapshotFilter): Promise<CoachingDataSnapshot> {
    const body = parseSnapshotFilter(filter ?? {});
    return this.request(
      "/coaching/snapshots",
      { method: "POST", jsonBody: body, capability: this.requireCapability() },
      parseSnapshotCreateResult,
    );
  }

  /**
   * Submit a run with the CALLER's stable `idempotencyKey` (sent verbatim,
   * single attempt). `201` = created, `200` + `replayed: true` = dedup hit.
   */
  async submitRun(input: SubmitCoachingRunInput): Promise<SubmitCoachingRunResult> {
    const body = parseSubmitCoachingRunInput(input);
    return this.request(
      "/coaching/runs",
      { method: "POST", jsonBody: body, capability: this.requireCapability() },
      parseSubmitCoachingRunResult,
    );
  }

  async readRun(runId: string): Promise<ReadCoachingRunResult> {
    assertNonBlankId(runId, "runId");
    return this.request(
      `/coaching/runs/${encodeURIComponent(runId)}`,
      { capability: this.requireCapability() },
      parseReadCoachingRunResult,
    );
  }

  /** The run id travels in the path; the body carries only `{ reason? }`. */
  async cancelRun(
    runId: string,
    reason?: string,
    cleanup?: { accessToken?: string | null; capability?: string | null },
  ): Promise<CancelCoachingRunResult> {
    assertNonBlankId(runId, "runId");
    const body = parseCancelCoachingRunBody(reason === undefined ? undefined : { reason });
    const capability =
      cleanup?.capability !== undefined ? (cleanup.capability ?? "") : this.requireCapability();
    if (capability === "") {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Coaching capability is missing or expired; bootstrap again.",
      });
    }
    return this.request(
      `/coaching/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        jsonBody: body,
        capability,
        ...(cleanup?.accessToken !== undefined ? { accessTokenOverride: cleanup.accessToken } : {}),
      },
      parseCancelCoachingRunResult,
    );
  }

  /**
   * Cancel own active runs and invalidate own sessions server-side, then
   * forget the in-memory capability even when the call fails (stale caps
   * must never survive logout or account switch). Pass the captured cleanup
   * credentials so an account-switch logout never sends the new account's
   * bearer for the old account (item 3).
   */
  async logout(cleanup?: { accessToken?: string | null; capability?: string | null }): Promise<CoachingLogoutResult> {
    try {
      const capability =
        cleanup?.capability !== undefined ? (cleanup.capability ?? "") : this.requireCapability();
      if (capability === "") {
        throw new ApiError({
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Coaching capability is missing or expired; bootstrap again.",
        });
      }
      return await this.request(
        "/coaching/logout",
        {
          method: "POST",
          capability,
          ...(cleanup?.accessToken !== undefined ? { accessTokenOverride: cleanup.accessToken } : {}),
        },
        parseCoachingLogoutResult,
      );
    } finally {
      this.discardCredentials();
    }
  }

  /**
   * Fetch-SSE tail for one run. `fromSeq` is the caller's last consumed seq
   * + 1 (`0` fresh) — never the server cursor. Contiguous seqs deliver in
   * order; older duplicates are ignored and a forward gap rejects so the
   * caller refetches from `firstSeq` instead of skipping. The terminal
   * envelope freezes the stream; EOF before it is a disconnect. Abort via
   * `signal` or `close()` detaches only — the run keeps going server-side.
   */
  subscribeRunEvents(
    input: SubscribeRunEventsInput,
    onEvent: (envelope: CoachingEventEnvelope) => void,
    options?: { signal?: AbortSignal },
  ): CoachingEventSubscription {
    const runId = assertNonBlankId(input.runId, "runId");
    const sessionId = assertNonBlankId(input.sessionId, "sessionId");
    const fromSeq = assertFromSeq(input.fromSeq);
    const expected: CoachingStreamIdentity = { sessionId, runId };
    const capability = this.requireCapability();
    const externalSignal = options?.signal;

    const controller = new AbortController();
    let settled = false;
    let terminated = false;
    let expectedSeq = fromSeq;
    let lastConsumed = fromSeq - 1;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let settleDone!: (result: CoachingEventStreamResult) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<CoachingEventStreamResult>((resolve, reject) => {
      settleDone = resolve;
      rejectDone = reject;
    });
    const finishOk = (result: CoachingEventStreamResult): void => {
      if (settled) return;
      settled = true;
      settleDone(result);
    };
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectDone(error);
    };
    const detach = (reader: ReadableStreamDefaultReader<Uint8Array> | null): void => {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      if (activeReader !== null && (reader === null || reader === activeReader)) activeReader = null;
      cancelReaderBestEffort(reader);
    };
    const onExternalAbort = (): void => {
      controller.abort();
      cancelReaderBestEffort(activeReader);
      // Settle fast even while token/fetch/read is pending; the tail loop
      // observes `settled` and delivers nothing further.
      finishOk({ aborted: true, lastConsumed });
    };

    const subscription: CoachingEventSubscription = {
      close: () => {
        controller.abort();
        cancelReaderBestEffort(activeReader);
        if (!settled) finishOk({ aborted: true, lastConsumed });
      },
      done,
    };
    done.catch(() => {});
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        finishOk({ aborted: true, lastConsumed });
        return subscription;
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    void (async (): Promise<void> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        let accessToken: string | null;
        try {
          accessToken = this.getAccessToken === undefined ? null : await this.getAccessToken();
        } catch (error) {
          if (controller.signal.aborted || settled) finishOk({ aborted: true, lastConsumed });
          else finishError(error);
          return;
        }
        if (settled || controller.signal.aborted) {
          finishOk({ aborted: true, lastConsumed });
          return;
        }
        const headers: Record<string, string> = {
          accept: SSE_ACCEPT,
          [COACHING_CAPABILITY_HEADER]: capability,
        };
        if (accessToken !== null && accessToken !== "") headers.authorization = `Bearer ${accessToken}`;
        let response: Response;
        try {
          response = await this.fetchImpl(
            `${this.baseUrl}/coaching/runs/${encodeURIComponent(runId)}/events?fromSeq=${fromSeq}`,
            { method: "GET", headers, signal: controller.signal, redirect: "error" },
          );
        } catch (error) {
          if (controller.signal.aborted || settled) finishOk({ aborted: true, lastConsumed });
          else finishError(new NetworkError(undefined, { cause: error }));
          return;
        }
        if (settled || controller.signal.aborted) {
          finishOk({ aborted: true, lastConsumed });
          return;
        }
        if (!isOkStatus(response.status)) {
          let text = "";
          try {
            text = await response.text();
          } catch {
            // Fall through with an empty body.
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = undefined;
          }
          finishError(toApiError(parsed, response.status));
          return;
        }
        try {
          assertSseContentType(response);
        } catch (error) {
          finishError(error);
          return;
        }
        const body = response.body;
        if (body === null) {
          finishError(new MalformedResponseError("events", "SSE response has no body"));
          return;
        }
        reader = body.getReader();
        activeReader = reader;
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let totalBytes = 0;

        const deliverBlock = (block: string): void => {
          if (settled || terminated || controller.signal.aborted) return;
          let envelope: CoachingEventEnvelope | null;
          try {
            envelope = parseSseBlock(block, expected);
          } catch (error) {
            finishError(error);
            return;
          }
          if (envelope === null) return;
          if (envelope.seq < expectedSeq) return;
          if (envelope.seq > expectedSeq) {
            finishError(
              new MalformedResponseError(
                "events",
                `gap: expected seq ${expectedSeq} but received ${envelope.seq} (refetch from firstSeq; never skip)`,
              ),
            );
            return;
          }
          try {
            onEvent(envelope);
          } catch (error) {
            finishError(error);
            return;
          }
          lastConsumed = envelope.seq;
          expectedSeq = envelope.seq + 1;
          if (envelope.event.type === "terminal") {
            terminated = true;
            finishOk({ aborted: false, lastConsumed });
          }
        };

        const drainFrames = (flush: boolean): void => {
          const taken = takeSseFrames(buffer);
          buffer = taken.rest;
          const rejectOversizeFrame = (): void => {
            finishError(new MalformedResponseError("events", "SSE frame exceeds the size limit"));
          };
          // The cap measures the SAME full frame the server writes: payload +
          // delimiter (metadata included).
          for (const frame of taken.frames) {
            if (utf8ByteLength(frame.block) + frame.delimiterBytes > MAX_COACHING_SSE_FRAME_BYTES) {
              rejectOversizeFrame();
              return;
            }
          }
          if (flush) {
            // A trailing unterminated block is bounded as a frame too.
            if (buffer !== "" && utf8ByteLength(buffer) > MAX_COACHING_SSE_FRAME_BYTES) {
              rejectOversizeFrame();
              return;
            }
            const blocks = taken.frames.map((frame) => frame.block);
            if (buffer !== "") blocks.push(buffer);
            buffer = "";
            for (const block of blocks) {
              deliverBlock(block);
              if (settled) return;
            }
            return;
          }
          // Pending partial frame: bound the ACTUAL buffered bytes. The exact
          // full-frame check above (block + measured delimiter) validates the
          // frame once its delimiter completes; adding the delimiter
          // unconditionally here over-counted, because `buffer` may already hold
          // part of it (a frame split immediately before its final newline) and
          // falsely rejected an exact-limit frame. A delimiter only ever ADDS
          // bytes, so any pending buffer already over the frame budget can never
          // become a valid frame — a safe early bound.
          if (utf8ByteLength(buffer) > MAX_COACHING_SSE_FRAME_BYTES) {
            rejectOversizeFrame();
            return;
          }
          for (const frame of taken.frames) {
            deliverBlock(frame.block);
            if (settled) return;
          }
        };

        for (;;) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (error) {
            if (controller.signal.aborted || settled) finishOk({ aborted: true, lastConsumed });
            else finishError(new NetworkError("Coaching event stream was interrupted.", { cause: error }));
            break;
          }
          if (settled) break;
          if (controller.signal.aborted) {
            finishOk({ aborted: true, lastConsumed });
            break;
          }
          if (read.done) {
            buffer += decoder.decode();
            drainFrames(true);
            if (settled) break;
            if (terminated) {
              finishOk({ aborted: false, lastConsumed });
            } else {
              finishError(new NetworkError("Coaching event stream ended before the terminal event (disconnected)."));
            }
            break;
          }
          totalBytes += read.value.byteLength;
          if (totalBytes > MAX_COACHING_SSE_TOTAL_BYTES) {
            finishError(new MalformedResponseError("events", "SSE body exceeds the size limit"));
            break;
          }
          buffer += decoder.decode(read.value, { stream: true });
          if (utf8ByteLength(buffer) > MAX_COACHING_SSE_TOTAL_BYTES) {
            finishError(new MalformedResponseError("events", "SSE frame exceeds the size limit"));
            break;
          }
          drainFrames(false);
          if (settled) break;
        }
      } catch (error) {
        if (controller.signal.aborted || settled) finishOk({ aborted: true, lastConsumed });
        else finishError(error);
      } finally {
        detach(reader);
      }
    })();

    return subscription;
  }
}
