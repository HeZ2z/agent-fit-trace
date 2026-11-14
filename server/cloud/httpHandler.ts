/**
 * Authenticated HTTP integration for durable cloud coaching.
 *
 * This is a thin transport over the request repository: it verifies the
 * bearer with the shared verifier, asks the DATABASE for the authoritative
 * account classification (`coaching_cloud_state`), and only then calls an
 * RPC. No request body can assert `is_anonymous`, quota, or account id.
 *
 * SSE is replay-only: the handler polls stored `coaching_run_events` until a
 * terminal state or a bounded deadline, then returns the frames it collected.
 * A client resumes with `fromSeq = lastSeq + 1`; the server never invents,
 * skips, or heartbeats events.
 */
import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import {
  API_ERROR_CODES,
  COACHED_TOOL_NAMES,
  CLOUD_ERROR_CODES,
  HTTP_STATUS,
  MalformedResponseError,
  MAX_COACHING_SSE_TOTAL_BYTES,
  encodeCoachingEventFrame,
  isCloudTerminalStatus,
  parseCloudCancelInput,
  parseCloudCreateSessionInput,
  parseCloudCreateSnapshotInput,
  parseCloudSubmitRunInput,
  parseSnapshotFilter,
} from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { assertOrderedDateRange, filterRecords, ValidationError, validateWorkoutRecord } from "@agent-fit-trace/core";
import { extractBearerToken } from "../auth/verifier.ts";
import type { TokenVerifier } from "../auth/verifier.ts";
import { DEFAULT_MAX_BODY_BYTES } from "../authenticatedHandler.ts";
import type { WorkoutSource } from "../coaching/coachingService.ts";
import { WorkoutSourceUnavailable } from "../coaching/coachingService.ts";
import type { CloudEventPage, CloudRequestRepository } from "./repository.ts";
import { CloudError } from "./repository.ts";

const MAX_SNAPSHOT_RECORDS = 5000;

export interface CloudHttpRequest {
  method: string;
  /** Path after `/api/v1`, e.g. `/coaching/cloud/runs`. */
  pathname: string;
  searchParams?: URLSearchParams;
  body?: string;
  authorization?: string;
  accept?: string;
}

export interface CloudHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  /**
   * Progressive response body. When present, `body` is empty and the platform
   * adapter MUST pipe this stream instead of buffering it. Only the replay SSE
   * route uses it; every JSON route remains a single buffered body.
   */
  stream?: ReadableStream<Uint8Array>;
}

export interface CloudSseOptions {
  pollMs: number;
  maxDurationMs: number;
  pageLimit: number;
}

export interface CloudHttpHandlerOptions {
  verifier: TokenVerifier | null;
  /** Built with the caller's token; null means cloud is off/unconfigured. */
  repositoryFor:
    | ((principal: AuthPrincipal, accessToken: string) => CloudRequestRepository)
    | null;
  /** Caller-token workout source for snapshot materialization. */
  source: WorkoutSource | null;
  providerConfigured: boolean;
  providerLimits: { maxSteps: number; maxTokens: number; timeoutMs: number };
  sse?: CloudSseOptions;
  /**
   * Emit SSE frames as they are stored instead of accumulating a page and
   * returning it when the deadline expires. The platform adapter must pipe
   * `CloudHttpResponse.stream` for this to reach a client progressively.
   * Defaults to false so request/response unit tests keep their textual shape.
   */
  streamSse?: boolean;
  maxBodyBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): CloudHttpResponse {
  return {
    status,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  };
}

function ok(data: unknown, status = 200): CloudHttpResponse {
  return json(status, { data });
}

function errorResponse(code: string, message: string, status: number, details?: unknown): CloudHttpResponse {
  return json(status, details === undefined ? { error: { code, message } } : { error: { code, message, details } });
}

function mapError(error: unknown): CloudHttpResponse {
  if (error instanceof CloudError) {
    return errorResponse(error.code, error.message, error.status, error.details);
  }
  if (error instanceof ValidationError) {
    return errorResponse(API_ERROR_CODES.VALIDATION_ERROR, error.message, 400, { issues: error.issues });
  }
  if (error instanceof MalformedResponseError) {
    // Request-shape guards use this error type. Client input is a 400, never
    // an internal error.
    return errorResponse(API_ERROR_CODES.VALIDATION_ERROR, error.message, 400);
  }
  if (error instanceof WorkoutSourceUnavailable) {
    return errorResponse(API_ERROR_CODES.STORAGE_UNAVAILABLE, error.message, 503);
  }
  return errorResponse(API_ERROR_CODES.API_ERROR, "Internal error.", 500);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function parseJson(body: string | undefined, maxBytes: number): unknown {
  if (body === undefined || body === "") return undefined;
  if (byteLength(body) > maxBytes) {
    throw new CloudError(API_ERROR_CODES.VALIDATION_ERROR, `Request body exceeds the ${maxBytes} byte limit.`, 400);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CloudError(API_ERROR_CODES.VALIDATION_ERROR, "Request body is not valid JSON.", 400);
  }
}

function parseFromSeq(params: URLSearchParams): number {
  const raw = params.get("fromSeq");
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CloudError(CLOUD_ERROR_CODES.EXPIRED_CURSOR, "fromSeq must be a non-negative integer.", 410);
  }
  return value;
}

async function resolvePrincipal(
  verifier: TokenVerifier | null,
  authorization: string | undefined,
): Promise<{ principal: AuthPrincipal; token: string }> {
  if (verifier === null) {
    throw new CloudError(API_ERROR_CODES.API_ERROR, "Authentication is not configured.", 500);
  }
  const token = extractBearerToken(authorization);
  if (token === null) {
    throw new CloudError(API_ERROR_CODES.UNAUTHENTICATED, "Missing bearer token.", 401);
  }
  try {
    return { principal: await verifier.verify(token), token };
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(API_ERROR_CODES.UNAUTHENTICATED, "Invalid or expired bearer token.", 401);
  }
}

async function materializeRecords(
  source: WorkoutSource,
  principal: AuthPrincipal,
  token: string,
  filter: { from?: string; to?: string },
): Promise<WorkoutRecord[]> {
  let records: WorkoutRecord[];
  try {
    records = await source.listWorkouts(principal, { bearerToken: token });
  } catch {
    throw new WorkoutSourceUnavailable();
  }
  let scoped: WorkoutRecord[];
  try {
    scoped = filterRecords(records, {
      ...(filter.from === undefined ? {} : { from: filter.from }),
      ...(filter.to === undefined ? {} : { to: filter.to }),
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new CloudError(API_ERROR_CODES.VALIDATION_ERROR, "Invalid snapshot date filter.", 400);
  }
  if (scoped.length > MAX_SNAPSHOT_RECORDS) {
    throw new CloudError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `Requested range contains ${scoped.length} records, exceeding the per-snapshot limit of ${MAX_SNAPSHOT_RECORDS}; narrow from/to and retry.`,
      400,
    );
  }
  return scoped.map((record) => validateWorkoutRecord(record).record);
}

export function createCloudCoachingHandler(
  options: CloudHttpHandlerOptions,
): (request: CloudHttpRequest) => Promise<CloudHttpResponse> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sse = options.sse ?? { pollMs: 1000, maxDurationMs: 15_000, pageLimit: 200 };
  const streamSse = options.streamSse === true;

  return async function handle(request: CloudHttpRequest): Promise<CloudHttpResponse> {
    try {
      const { principal, token } = await resolvePrincipal(options.verifier, request.authorization);
      // Trusted per-request classification first; the DB check below is the
      // second, authoritative gate. Undefined/guest fails closed.
      if (principal.isAnonymous !== false) {
        return errorResponse(
          CLOUD_ERROR_CODES.ACCOUNT_NOT_FORMAL,
          "Guest accounts can use their own local agent only; cloud coaching requires a formal account.",
          403,
        );
      }
      if (options.repositoryFor === null) {
        return errorResponse(CLOUD_ERROR_CODES.CLOUD_DISABLED, "Cloud coaching is not configured on this server.", 503);
      }
      const repository = options.repositoryFor(principal, token);
      const state = await repository.accountState();
      // The DB's `auth.uid()` is authoritative; a mismatch means the request
      // token and the classification disagree and every route fails closed.
      if (state.accountId !== principal.id) {
        return errorResponse(CLOUD_ERROR_CODES.ACCOUNT_NOT_FORMAL, "Cloud coaching requires a formal account.", 403);
      }
      if (state.isAnonymous !== false) {
        return errorResponse(
          CLOUD_ERROR_CODES.ACCOUNT_NOT_FORMAL,
          "Guest accounts can use their own local agent only; cloud coaching requires a formal account.",
          403,
        );
      }

      const pathname = request.pathname;
      const method = request.method.toUpperCase();
      const params = request.searchParams ?? new URLSearchParams();
      const eventsMatch = /^\/coaching\/cloud\/runs\/([^/]+)\/events$/.exec(pathname);
      const cancelMatch = /^\/coaching\/cloud\/runs\/([^/]+)\/cancel$/.exec(pathname);
      const runMatch = /^\/coaching\/cloud\/runs\/([^/]+)$/.exec(pathname);
      const sessionMatch = /^\/coaching\/cloud\/sessions\/([^/]+)$/.exec(pathname);

      if (pathname === "/coaching/cloud/capabilities" && method === "GET") {
        return ok({
          enabled: true,
          // Provider availability is never inferred from concurrency counts.
          // The database must have the global switch on and a finite budget.
          providerConfigured:
            options.providerConfigured && state.providerEnabled && state.budgetConfigured,
          providerEnabled: state.providerEnabled,
          accountFormal: state.isAnonymous === false,
          quotaConfigured: state.quotaConfigured,
          budgetConfigured: state.budgetConfigured,
          concurrentLimit: state.concurrentLimit,
          reservedCount: state.reservedCount,
          tokensRemaining: state.tokensRemaining,
          tokensReserved: state.tokensReserved,
          perRunTokenBudget: state.perRunTokenBudget,
          perStepTokenBudget: state.perStepTokenBudget,
          perRunRequestLimit: state.perRunRequestLimit,
          tools: [...COACHED_TOOL_NAMES],
          ...options.providerLimits,
        });
      }

      const conversationMatch = /^\/coaching\/cloud\/conversations\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
      if (pathname === "/coaching/cloud/conversations" && method === "GET") {
        if (!repository.listConversations) throw new CloudError("STORAGE_UNAVAILABLE", "Conversation history is unavailable.", 503);
        return ok(await repository.listConversations());
      }
      if (pathname === "/coaching/cloud/conversations" && method === "POST") {
        const body = parseJson(request.body, maxBodyBytes);
        if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test((body as {id: string}).id)) throw new CloudError("VALIDATION_ERROR", "Invalid conversation id.", 400);
        if (!repository.createConversation) throw new CloudError("STORAGE_UNAVAILABLE", "Conversation history is unavailable.", 503);
        return ok(await repository.createConversation((body as {id: string}).id), 201);
      }
      if (conversationMatch !== null && method === "DELETE") {
        if (!repository.deleteConversation) throw new CloudError("STORAGE_UNAVAILABLE", "Conversation history is unavailable.", 503);
        return ok(await repository.deleteConversation(conversationMatch[1]!));
      }
      if (conversationMatch !== null && method === "GET") {
        if (!repository.readConversation) throw new CloudError("STORAGE_UNAVAILABLE", "Conversation history is unavailable.", 503);
        return ok(await repository.readConversation(conversationMatch[1]!));
      }

      if (pathname === "/coaching/cloud/sessions" && method === "POST") {
        const parsed = parseCloudCreateSessionInput(parseJson(request.body, maxBodyBytes));
        return ok(await repository.createSession(parsed.id), 201);
      }

      if (sessionMatch !== null && method === "GET") {
        return ok(await repository.readSession(decodeURIComponent(sessionMatch[1] ?? "")));
      }

      if (pathname === "/coaching/cloud/snapshots" && method === "POST") {
        if (options.source === null) {
          return errorResponse(API_ERROR_CODES.STORAGE_UNAVAILABLE, "Workout history is not configured.", 503);
        }
        const filter = parseCloudCreateSnapshotInput(parseJson(request.body, maxBodyBytes));
        try {
          assertOrderedDateRange(filter.from, filter.to);
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          throw new CloudError(API_ERROR_CODES.VALIDATION_ERROR, "Invalid snapshot date filter.", 400);
        }
        let parsedFilter: { from?: string; to?: string };
        try {
          parsedFilter = parseSnapshotFilter(filter);
        } catch (error) {
          throw new CloudError(
            API_ERROR_CODES.VALIDATION_ERROR,
            error instanceof Error ? error.message : "Invalid snapshot date filter.",
            400,
          );
        }
        const records = await materializeRecords(options.source, principal, token, parsedFilter);
        const snapshot = await repository.createSnapshot(records, parsedFilter);
        return ok(
          {
            snapshotId: snapshot.snapshotId,
            source: snapshot.source,
            accountId: snapshot.accountId,
            recordIds: snapshot.recordIds,
            recordCount: snapshot.recordCount,
            ...(snapshot.from === undefined ? {} : { from: snapshot.from }),
            ...(snapshot.to === undefined ? {} : { to: snapshot.to }),
          },
          201,
        );
      }

      if (pathname === "/coaching/cloud/runs" && method === "POST") {
        const input = parseCloudSubmitRunInput(parseJson(request.body, maxBodyBytes));
        if (input.snapshot.accountId !== principal.id) {
          return errorResponse(API_ERROR_CODES.FORBIDDEN, "Snapshot is not bound to this account.", 403);
        }
        // Resolve an already-accepted request BEFORE the new-execution gates.
        // A run whose response was lost must stay recoverable after the
        // operator disables the provider, the budget, or the local adapter;
        // otherwise the browser can never learn the accepted run id.
        const existing = await repository.findRunByKey(input);
        if (existing !== null) {
          return ok(existing, HTTP_STATUS.ok);
        }
        if (!state.providerEnabled) {
          return errorResponse(
            CLOUD_ERROR_CODES.CLOUD_DISABLED,
            "Cloud coaching is not enabled on this server.",
            503,
          );
        }
        if (!state.budgetConfigured) {
          return errorResponse(
            CLOUD_ERROR_CODES.QUOTA_NOT_CONFIGURED,
            "Cloud coaching quota has no finite execution budget configured.",
            403,
          );
        }
        if (!options.providerConfigured) {
          return errorResponse(
            CLOUD_ERROR_CODES.PROVIDER_UNCONFIGURED,
            "Cloud coaching is not configured on this server.",
            503,
          );
        }
        const runId = `run-${globalThis.crypto.randomUUID()}`;
        const result = await repository.submitRun({
          runId,
          ...input,
        });
        return ok(result, result.replayed ? HTTP_STATUS.ok : HTTP_STATUS.created);
      }

      if (runMatch !== null && method === "GET") {
        return ok(await repository.readRun(decodeURIComponent(runMatch[1] ?? "")));
      }

      if (cancelMatch !== null && method === "POST") {
        const parsed = parseCloudCancelInput(parseJson(request.body, maxBodyBytes));
        return ok(await repository.cancelRun(decodeURIComponent(cancelMatch[1] ?? ""), parsed.reason));
      }

      if (eventsMatch !== null && method === "GET") {
        const runId = decodeURIComponent(eventsMatch[1] ?? "");
        const fromSeq = parseFromSeq(params);
        if ((request.accept ?? "").includes("text/event-stream")) {
          return streamSse
            ? await streamSseResponse(repository, runId, fromSeq, sse, now, sleep)
            : await replaySse(repository, runId, fromSeq, sse, now, sleep);
        }
        return ok(await repository.readEvents(runId, fromSeq, sse.pageLimit));
      }

      return errorResponse(API_ERROR_CODES.API_ERROR, `No route for ${method} ${pathname}.`, 404);
    } catch (error) {
      return mapError(error);
    }
  };
}

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // Ask reverse proxies not to accumulate a page before forwarding it.
  "x-accel-buffering": "no",
};

function sseResponse(body: string, stream?: ReadableStream<Uint8Array>): CloudHttpResponse {
  return { status: 200, body, headers: { ...SSE_HEADERS }, ...(stream === undefined ? {} : { stream }) };
}

/**
 * Progressive replay: every stored frame is enqueued as soon as it is read,
 * so the first event reaches the client immediately instead of waiting for the
 * bounded page deadline. The stream still stops at a terminal state, the page
 * deadline, or the total-byte cap; a client resumes from its cursor in every
 * non-terminal case. No heartbeat or invented frame is ever emitted.
 */
async function streamSseResponse(
  repository: CloudRequestRepository,
  runId: string,
  fromSeq: number,
  sse: CloudSseOptions,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<CloudHttpResponse> {
  const deadline = now() + sse.maxDurationMs;
  const encoder = new TextEncoder();
  let cursor = fromSeq;
  let bytes = 0;
  let closed = false;
  // Read the first page BEFORE committing a 200: an invalid/expired cursor or
  // a missing run must reach `mapError` and the client as its structured 410 /
  // 404 JSON. Only failures after headers are committed become stream errors.
  let page: CloudEventPage | null = await repository.readEvents(runId, fromSeq, sse.pageLimit);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        for (;;) {
          if (closed) return;
          if (page === null) {
            if (now() >= deadline) {
              closed = true;
              controller.close();
              return;
            }
            await sleep(sse.pollMs);
            if (closed) return;
            page = await repository.readEvents(runId, cursor, sse.pageLimit);
          }
          const current = page;
          page = null;
          let emitted = false;
          for (const envelope of current.events) {
            if (closed) return;
            const frame = encodeCoachingEventFrame(envelope);
            const frameBytes = byteLength(frame);
            if (bytes + frameBytes > MAX_COACHING_SSE_TOTAL_BYTES) {
              closed = true;
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(frame));
            bytes += frameBytes;
            cursor = envelope.seq + 1;
            emitted = true;
          }
          if (isCloudTerminalStatus(current.run.status) && cursor > current.lastSeq) {
            closed = true;
            controller.close();
            return;
          }
          if (now() >= deadline) {
            closed = true;
            controller.close();
            return;
          }
          // Returning after any emitted frame lets the consumer drain the
          // queue; the next pull continues from the cursor without a delay.
          if (emitted) return;
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        controller.error(error);
      }
    },
    cancel() {
      // Client disconnect: stop polling and drop the upstream work.
      closed = true;
    },
  });

  return sseResponse("", stream);
}

async function replaySse(
  repository: CloudRequestRepository,
  runId: string,
  fromSeq: number,
  sse: CloudSseOptions,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<CloudHttpResponse> {
  const deadline = now() + sse.maxDurationMs;
  let cursor = fromSeq;
  let body = "";
  let bytes = 0;
  for (;;) {
    const page = await repository.readEvents(runId, cursor, sse.pageLimit);
    for (const envelope of page.events) {
      const frame = encodeCoachingEventFrame(envelope);
      const frameBytes = byteLength(frame);
      if (bytes + frameBytes > MAX_COACHING_SSE_TOTAL_BYTES) {
        return sseResponse(body);
      }
      body += frame;
      bytes += frameBytes;
      cursor = envelope.seq + 1;
    }
    if (isCloudTerminalStatus(page.run.status) && cursor > page.lastSeq) break;
    if (now() >= deadline) break;
    // No heartbeat frames: every byte on this stream is a stored event.
    await sleep(sse.pollMs);
  }
  return sseResponse(body);
}
