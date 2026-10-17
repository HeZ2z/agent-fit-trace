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
import type { AuthPrincipal } from "@pi-fit-trace/api-contracts";
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
} from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { assertOrderedDateRange, filterRecords, ValidationError, validateWorkoutRecord } from "@pi-fit-trace/core";
import { extractBearerToken } from "../auth/verifier.ts";
import type { TokenVerifier } from "../auth/verifier.ts";
import { DEFAULT_MAX_BODY_BYTES } from "../authenticatedHandler.ts";
import type { WorkoutSource } from "../coaching/coachingService.ts";
import { WorkoutSourceUnavailable } from "../coaching/coachingService.ts";
import type { CloudRequestRepository } from "./repository.ts";
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
          providerConfigured: options.providerConfigured,
          accountFormal: state.isAnonymous === false,
          quotaConfigured: state.quotaConfigured,
          concurrentLimit: state.concurrentLimit,
          reservedCount: state.reservedCount,
          tools: [...COACHED_TOOL_NAMES],
          ...options.providerLimits,
        });
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
        if (!options.providerConfigured) {
          return errorResponse(
            CLOUD_ERROR_CODES.PROVIDER_UNCONFIGURED,
            "Cloud coaching is not configured on this server.",
            503,
          );
        }
        const input = parseCloudSubmitRunInput(parseJson(request.body, maxBodyBytes));
        if (input.snapshot.accountId !== principal.id) {
          return errorResponse(API_ERROR_CODES.FORBIDDEN, "Snapshot is not bound to this account.", 403);
        }
        const runId = `run-${globalThis.crypto.randomUUID()}`;
        const result = await repository.submitRun({
          runId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          idempotencyKey: input.idempotencyKey,
          snapshot: input.snapshot,
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
          return await replaySse(repository, runId, fromSeq, sse, now, sleep);
        }
        return ok(await repository.readEvents(runId, fromSeq, sse.pageLimit));
      }

      return errorResponse(API_ERROR_CODES.API_ERROR, `No route for ${method} ${pathname}.`, 404);
    } catch (error) {
      return mapError(error);
    }
  };
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
        return {
          status: 200,
          body,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        };
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
  return {
    status: 200,
    body,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  };
}
