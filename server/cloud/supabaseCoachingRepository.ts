/**
 * Native-`fetch` Supabase RPC repository for durable cloud coaching.
 *
 * Two factories:
 * - `createSupabaseCoachingRequestRepository` uses the caller's ephemeral
 *   access token plus the publishable key. Every call is an RPC;
 *   `auth.uid()` + RLS own row access. The service-role key is not accepted
 *   by this factory.
 * - `createSupabaseCoachingWorkerRepository` uses the service-role key. Only
 *   the worker entrypoint constructs it.
 *
 * No raw PostgREST error body is forwarded: known cloud error markers map to
 * sanitized {@link CloudError} codes, everything else is a generic 503.
 */
import {
  parseCloudCancelRunResult,
  parseCloudReadEventsResult,
  parseCloudReadRunResult,
  parseCloudSubmitRunResult,
} from "@agent-fit-trace/api-contracts";
import type {
  CloudCoachingRun,
  CoachingEventPayload,
  CloudRunStatus,
} from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import type {
  CloudAcceptedInfo,
  CloudAccountState,
  CloudEventPage,
  CloudOutboxJob,
  CloudRequestRepository,
  CloudRunRecord,
  CloudSessionRecord,
  CloudSnapshotRecord,
  CloudStartCallResult,
  CloudStepAuthorization,
  CloudSubmitOutcome,
  CloudTerminal,
  CloudUsage,
  CloudWorkerRepository,
} from "./repository.ts";
import { CloudError, assertCloudCursor, toPublicRun } from "./repository.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

export interface SupabaseCoachingRequestOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** The verified caller's current access token. Used ephemerally. */
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SupabaseCoachingWorkerOptions {
  supabaseUrl: string;
  /** Service-role key. Worker only; never construct this in a request handler. */
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readErrorMarker(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;
  const parts = [record.message, record.details, record.hint]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ");
  return parts;
}

function mapRpcError(status: number, body: unknown): CloudError {
  const marker = readErrorMarker(body);
  if (status === 401) {
    return new CloudError("UNAUTHENTICATED", "Invalid or expired bearer token.", 401);
  }
  if (marker.includes("CLOUD_CONFLICT")) {
    return new CloudError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different content.", 409);
  }
  if (marker.includes("CLOUD_SESSION_NOT_FOUND")) {
    return new CloudError("SESSION_NOT_FOUND", "Cloud coaching session not found.", 404);
  }
  if (marker.includes("CLOUD_SNAPSHOT_NOT_FOUND")) {
    return new CloudError("SNAPSHOT_NOT_FOUND", "Snapshot not found or expired.", 404);
  }
  if (marker.includes("CLOUD_RUN_NOT_FOUND")) {
    return new CloudError("RUN_NOT_FOUND", "Cloud coaching run not found.", 404);
  }
  if (marker.includes("CLOUD_ACCOUNT_NOT_FORMAL")) {
    return new CloudError("ACCOUNT_NOT_FORMAL", "Cloud coaching requires a formal account.", 403);
  }
  if (marker.includes("CLOUD_QUOTA_NOT_CONFIGURED")) {
    return new CloudError("QUOTA_NOT_CONFIGURED", "Cloud coaching quota is not configured.", 403);
  }
  if (marker.includes("CLOUD_DISABLED")) {
    return new CloudError("CLOUD_DISABLED", "Cloud coaching is not enabled on this server.", 503);
  }
  if (marker.includes("CLOUD_QUOTA_EXHAUSTED")) {
    return new CloudError("QUOTA_EXHAUSTED", "No cloud coaching capacity is available.", 429);
  }
  if (marker.includes("CLOUD_INVALID") || marker.includes("CLOUD_EVENT_CAP")) {
    return new CloudError(
      "VALIDATION_ERROR",
      "Cloud coaching request is invalid or exceeds a configured bound.",
      400,
    );
  }
  if (marker.includes("CLOUD_REFUND_UNPROVEN")) {
    return new CloudError(
      "REFUND_UNPROVEN",
      "The provider may have accepted the run; its reservation cannot be refunded.",
      409,
    );
  }
  if (marker.includes("CLOUD_TERMINAL")) {
    return new CloudError("RUN_TERMINAL", "The cloud coaching run is already terminal.", 409);
  }
  if (marker.includes("CLOUD_EXPIRED_CURSOR") || marker.includes("CLOUD_CURSOR")) {
    return new CloudError("EXPIRED_CURSOR", "Event cursor is beyond the retained log; refetch from seq 0.", 410);
  }
  if (marker.includes("CLOUD_LEASE_LOST") || marker.includes("CLOUD_GENERATION")) {
    return new CloudError("LEASE_LOST", "Worker lease was superseded; no write was applied.", 409);
  }
  if (marker.includes("CLOUD_NOT_SERVICE")) {
    return new CloudError("FORBIDDEN", "Worker repository requires a service identity.", 403);
  }
  return new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage is temporarily unavailable.", 503);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CloudError("STORAGE_UNAVAILABLE", `Cloud coaching storage returned a malformed ${what}.`, 503);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CloudError("STORAGE_UNAVAILABLE", `Cloud coaching storage returned a malformed ${field}.`, 503);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CloudError("STORAGE_UNAVAILABLE", `Cloud coaching storage returned a malformed ${field}.`, 503);
  }
  return value;
}

function asRunStatus(value: unknown): CloudRunStatus {
  const allowed = new Set([
    "queued",
    "dispatching",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "unconfirmed",
  ]);
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage returned an unknown run status.", 503);
  }
  return value as CloudRunStatus;
}

function parseRunRow(value: unknown): CloudRunRecord {
  const row = asRecord(value, "run");
  const snapshot = asRecord(row.snapshot, "snapshot");
  const recordIdsRaw = snapshot.recordIds;
  if (!Array.isArray(recordIdsRaw) || !recordIdsRaw.every((entry) => typeof entry === "string")) {
    throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage returned a malformed snapshot.", 503);
  }
  const recordsRaw = row.snapshotRecords;
  if (!Array.isArray(recordsRaw)) {
    throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage returned malformed snapshot records.", 503);
  }
  const run: CloudRunRecord = {
    id: asString(row.id, "run.id"),
    sessionId: asString(row.sessionId, "run.sessionId"),
    accountId: asString(row.accountId, "run.accountId"),
    status: asRunStatus(row.status),
    idempotencyKey: asString(row.idempotencyKey, "run.idempotencyKey"),
    requestHash: asString(row.requestHash, "run.requestHash"),
    prompt: asString(row.prompt, "run.prompt"),
    snapshot: {
      snapshotId: asString(snapshot.snapshotId, "snapshot.snapshotId"),
      source: asString(snapshot.source, "snapshot.source"),
      accountId: asString(snapshot.accountId, "snapshot.accountId"),
      recordIds: recordIdsRaw as string[],
      recordCount: asNumber(snapshot.recordCount, "snapshot.recordCount"),
      ...(optionalString(snapshot.from) === undefined ? {} : { from: optionalString(snapshot.from) }),
      ...(optionalString(snapshot.to) === undefined ? {} : { to: optionalString(snapshot.to) }),
    },
    snapshotRecords: recordsRaw as WorkoutRecord[],
    backendId: "cloud-default",
    runtimeId: "hosted-sdk",
    createdAt: asString(row.createdAt, "run.createdAt"),
    updatedAt: asString(row.updatedAt, "run.updatedAt"),
    expiresAt: asNumber(row.expiresAt, "run.expiresAt"),
    terminationConfirmed: row.terminationConfirmed === true,
    reservationReleased: row.reservationReleased === true,
    tokenBudget: row.tokenBudget === undefined ? 0 : asNumber(row.tokenBudget, "run.tokenBudget"),
    requestBudget:
      row.requestBudget === undefined ? 0 : asNumber(row.requestBudget, "run.requestBudget"),
    providerTokensCommitted:
      row.providerTokensCommitted === undefined
        ? 0
        : asNumber(row.providerTokensCommitted, "run.providerTokensCommitted"),
    providerRequestsCommitted:
      row.providerRequestsCommitted === undefined
        ? 0
        : asNumber(row.providerRequestsCommitted, "run.providerRequestsCommitted"),
    budgetReleased: row.budgetReleased === true,
  };
  if (typeof row.cancelRequestedAt === "string") run.cancelRequestedAt = row.cancelRequestedAt;
  if (typeof row.cancelReason === "string") run.cancelReason = row.cancelReason;
  if (typeof row.providerCallStartedAt === "string") run.providerCallStartedAt = row.providerCallStartedAt;
  if (typeof row.providerFetchStartedAt === "string") run.providerFetchStartedAt = row.providerFetchStartedAt;
  if (typeof row.providerAcceptedAt === "string") run.providerAcceptedAt = row.providerAcceptedAt;
  if (typeof row.providerGenerationId === "string") run.providerGenerationId = row.providerGenerationId;
  if (typeof row.failure === "object" && row.failure !== null) {
    const failure = row.failure as Record<string, unknown>;
    if (typeof failure.code === "string" && typeof failure.message === "string") {
      run.failure = { code: failure.code, message: failure.message };
    }
  }
  return run;
}

function readRunEnvelope(value: unknown): { run: CloudCoachingRun; lastSeq: number; firstSeq: number; expiresAt: number } {
  const parsed = parseCloudReadRunResult(value);
  return parsed;
}

function makeRpc(options: {
  supabaseUrl: string;
  token: string;
  apikey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  const url = `${normalizeUrl(options.supabaseUrl)}/rest/v1/rpc/`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (name, args) => {
    let response: Response;
    try {
      response = await fetchImpl(`${url}${name}`, {
        method: "POST",
        headers: {
          apikey: options.apikey,
          Authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage is temporarily unavailable.", 503);
    }
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = undefined;
      }
    }
    if (!response.ok) throw mapRpcError(response.status, body);
    if (body === undefined) {
      throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage returned an unreadable response.", 503);
    }
    return body;
  };
}

function optionalStringParam(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

/** Request-scoped repository bound to the caller's own token. */
export function createSupabaseCoachingRequestRepository(
  options: SupabaseCoachingRequestOptions,
): CloudRequestRepository {
  if (options.accessToken.trim() === "") {
    throw new Error("cloud request repository requires a caller access token");
  }
  const rpc = makeRpc({
    supabaseUrl: options.supabaseUrl,
    apikey: options.publishableKey,
    token: options.accessToken,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  return {
    async accountState(): Promise<CloudAccountState> {
      const value = asRecord(await rpc("coaching_cloud_state", {}), "account state");
      return {
        accountId: asString(value.accountId, "accountId"),
        isAnonymous: value.isAnonymous === true,
        quotaConfigured: value.quotaConfigured === true,
        budgetConfigured: value.budgetConfigured === true,
        providerEnabled: value.providerEnabled === true,
        concurrentLimit: asNumber(value.concurrentLimit, "concurrentLimit"),
        reservedCount: asNumber(value.reservedCount, "reservedCount"),
        // Missing/legacy responses are treated as zero, never as unlimited.
        tokensRemaining:
          value.tokensRemaining === null || value.tokensRemaining === undefined
            ? 0
            : asNumber(value.tokensRemaining, "tokensRemaining"),
        tokensReserved:
          value.tokensReserved === undefined ? 0 : asNumber(value.tokensReserved, "tokensReserved"),
        perRunTokenBudget:
          value.perRunTokenBudget === undefined
            ? 0
            : asNumber(value.perRunTokenBudget, "perRunTokenBudget"),
        perStepTokenBudget:
          value.perStepTokenBudget === undefined
            ? 0
            : asNumber(value.perStepTokenBudget, "perStepTokenBudget"),
        perRunRequestLimit:
          value.perRunRequestLimit === undefined
            ? 0
            : asNumber(value.perRunRequestLimit, "perRunRequestLimit"),
      };
    },

    async createSession(id): Promise<CloudSessionRecord> {
      const value = asRecord(
        await rpc("coaching_create_session", {
          p_id: optionalStringParam(id),
          p_ttl_ms: DEFAULT_SESSION_TTL_MS,
        }),
        "session",
      );
      return {
        id: asString(value.id, "session.id"),
        expiresAt: asNumber(value.expiresAt, "session.expiresAt"),
      };
    },

    async readSession(id): Promise<CloudSessionRecord> {
      const value = asRecord(await rpc("coaching_read_session", { p_id: id }), "session");
      return {
        id: asString(value.id, "session.id"),
        expiresAt: asNumber(value.expiresAt, "session.expiresAt"),
      };
    },

    async createSnapshot(records, filter): Promise<CloudSnapshotRecord> {
      // Records are NOT sent: the RPC reads the caller's own workouts under
      // auth.uid() and returns its authoritative ids/count. `records` remains
      // a local materialization used only by in-memory fakes.
      const value = asRecord(
        await rpc("coaching_create_snapshot", {
          p_snapshot_id: `snap-${globalThis.crypto.randomUUID()}`,
          p_source: "authenticated-store",
          p_from: optionalStringParam(filter.from),
          p_to: optionalStringParam(filter.to),
          p_ttl_ms: DEFAULT_SNAPSHOT_TTL_MS,
        }),
        "snapshot",
      );
      const recordIdsRaw = value.recordIds;
      if (!Array.isArray(recordIdsRaw) || !recordIdsRaw.every((entry) => typeof entry === "string")) {
        throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage returned malformed snapshot ids.", 503);
      }
      return {
        snapshotId: asString(value.snapshotId, "snapshot.snapshotId"),
        source: asString(value.source, "snapshot.source"),
        accountId: asString(value.accountId, "snapshot.accountId"),
        recordIds: recordIdsRaw as string[],
        recordCount: asNumber(value.recordCount, "snapshot.recordCount"),
        ...(filter.from === undefined ? {} : { from: filter.from }),
        ...(filter.to === undefined ? {} : { to: filter.to }),
        records,
        expiresAt: asNumber(value.expiresAt, "snapshot.expiresAt"),
      };
    },

    async findRunByKey(input): Promise<CloudSubmitOutcome | null> {
      const value = await rpc("coaching_find_run", {
        p_session_id: input.sessionId,
        p_idempotency_key: input.idempotencyKey,
        p_prompt: input.prompt,
        p_snapshot_id: input.snapshot.snapshotId,
        p_snapshot_source: input.snapshot.source,
      });
      // `returns jsonb` from a no-row lookup is JSON null.
      if (value === null || value === undefined) return null;
      return parseCloudSubmitRunResult(value);
    },

    async submitRun(input): Promise<CloudSubmitOutcome> {
      const value = await rpc("coaching_submit_run", {
        p_run_id: input.runId,
        p_session_id: input.sessionId,
        p_idempotency_key: input.idempotencyKey,
        p_prompt: input.prompt,
        p_backend_id: "cloud-default",
        p_runtime_id: "hosted-sdk",
        p_snapshot_id: input.snapshot.snapshotId,
        p_snapshot_source: input.snapshot.source,
        p_request: {
          prompt: input.prompt,
          backendId: "cloud-default",
          runtimeId: "hosted-sdk",
          snapshot: {
            snapshotId: input.snapshot.snapshotId,
            source: input.snapshot.source,
            accountId: input.snapshot.accountId,
          },
        },
      });
      return parseCloudSubmitRunResult(value);
    },

    async readRun(runId) {
      return readRunEnvelope(await rpc("coaching_read_run", { p_run_id: runId }));
    },

    async readEvents(runId, fromSeq, limit): Promise<CloudEventPage> {
      const value = await rpc("coaching_read_events", {
        p_run_id: runId,
        p_from_seq: fromSeq,
        p_limit: limit,
      });
      const parsed = parseCloudReadEventsResult(value);
      assertCloudCursor(parsed.lastSeq, fromSeq);
      return parsed;
    },

    async cancelRun(runId, reason) {
      const value = await rpc("coaching_cancel_run", {
        p_run_id: runId,
        p_reason: optionalStringParam(reason),
      });
      return parseCloudCancelRunResult(value);
    },
  };
}

/** Worker-only repository authenticated with the service-role key. */
export function createSupabaseCoachingWorkerRepository(
  options: SupabaseCoachingWorkerOptions,
): CloudWorkerRepository {
  if (options.serviceRoleKey.trim() === "") {
    throw new Error("cloud worker repository requires a service-role key");
  }
  const rpc = makeRpc({
    supabaseUrl: options.supabaseUrl,
    apikey: options.serviceRoleKey,
    token: options.serviceRoleKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  return {
    async claimOutbox(workerId, leaseMs, limit): Promise<CloudOutboxJob[]> {
      const value = await rpc("coaching_claim_outbox", {
        p_worker_id: workerId,
        p_lease_ms: leaseMs,
        p_limit: limit,
      });
      if (!Array.isArray(value)) {
        throw new CloudError("STORAGE_UNAVAILABLE", "Cloud coaching storage returned malformed outbox jobs.", 503);
      }
      return value.map((entry) => {
        const job = asRecord(entry, "outbox job");
        return {
          run: parseRunRow(job.run),
          leaseGeneration: asNumber(job.leaseGeneration, "leaseGeneration"),
          attempt: asNumber(job.attempt, "attempt"),
        };
      });
    },

    async markProviderCallStarted(runId, generation): Promise<CloudStartCallResult> {
      const value = asRecord(
        await rpc("coaching_mark_provider_call", {
          p_run_id: runId,
          p_generation: generation,
        }),
        "provider call state",
      );
      return {
        started: value.started === true,
        alreadyStarted: value.alreadyStarted === true,
        cancelled: value.cancelled === true,
        terminal: value.terminal === true,
      };
    },

    async markProviderAccepted(runId, generation, accepted: CloudAcceptedInfo): Promise<void> {
      await rpc("coaching_mark_provider_accepted", {
        p_run_id: runId,
        p_generation: generation,
        p_generation_id: optionalStringParam(accepted.generationId),
      });
    },

    async authorizeProviderStep(runId, generation, budget): Promise<CloudStepAuthorization> {
      const value = asRecord(
        await rpc("coaching_authorize_provider_step", {
          p_run_id: runId,
          p_generation: generation,
          p_step_tokens: budget.tokens,
          p_step_requests: budget.requests,
        }),
        "provider step authorization",
      );
      return {
        allowed: value.allowed === true,
        cancelled: value.cancelled === true,
        terminal: value.terminal === true,
        leaseValid: value.leaseValid === true,
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      };
    },

    async appendEvent(runId, generation, payload: CoachingEventPayload): Promise<number> {
      const value = asRecord(
        await rpc("coaching_append_event", {
          p_run_id: runId,
          p_generation: generation,
          p_payload: payload,
        }),
        "event",
      );
      return asNumber(value.seq, "event.seq");
    },

    async terminateRun(runId, generation, terminal: CloudTerminal) {
      const value = asRecord(
        await rpc("coaching_terminate_run", {
          p_run_id: runId,
          p_generation: generation,
          p_status: terminal.status,
          p_reason: optionalStringParam(terminal.reason),
          p_failure_code: optionalStringParam(terminal.failure?.code),
          p_failure_message: optionalStringParam(terminal.failure?.message),
          p_termination_confirmed: terminal.terminationConfirmed,
          p_release_reservation: terminal.releaseReservation,
          p_proven_not_accepted: terminal.provenNotAccepted === true,
        }),
        "terminal run",
      );
      return {
        run: parseRunRow(value.run),
        lastSeq: asNumber(value.lastSeq, "lastSeq"),
      };
    },

    async settleUsage(runId, generation, usage: CloudUsage): Promise<{ settled: boolean }> {
      const value = asRecord(
        await rpc("coaching_settle_usage", {
          p_run_id: runId,
          p_generation: generation,
          p_prompt_tokens: usage.promptTokens,
          p_completion_tokens: usage.completionTokens,
          p_total_tokens: usage.totalTokens,
          p_cost_usd: usage.costUsd ?? null,
          p_generation_id: optionalStringParam(usage.generationId),
          p_usage_complete: usage.complete !== false,
        }),
        "usage settlement",
      );
      return { settled: value.settled === true };
    },

    async releaseReservation(runId, generation, provenNotAccepted): Promise<void> {
      await rpc("coaching_release_reservation", {
        p_run_id: runId,
        p_generation: generation,
        p_proven_not_accepted: provenNotAccepted,
      });
    },
  };
}

/** Exported for the HTTP handler's truthful capability response. */
export function publicRun(run: CloudRunRecord): CloudCoachingRun {
  return toPublicRun(run);
}
