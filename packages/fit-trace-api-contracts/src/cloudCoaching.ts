/**
 * Durable cloud coaching contract.
 *
 * This is intentionally separate from the local coaching contract in
 * `coaching.ts`: a hosted run has durable lifecycle states that the local
 * in-memory service does not have (`dispatching`, `cancelling`,
 * `unconfirmed`). The event envelope is shared, so a client can fold cloud
 * events with the same `replayRunState` helper.
 *
 * Server rule: none of these shapes grant entitlement. `accountId` in a
 * snapshot reference is checked against the verified principal; quota and
 * formal-account classification are always resolved server-side.
 */
import { MalformedResponseError } from "./errors.ts";
import type {
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingSnapshotReference,
} from "./coaching.ts";
import { COACHED_TOOL_NAMES, parseCoachingEventEnvelope } from "./coaching.ts";

export const CLOUD_RUN_STATUSES = [
  "queued",
  "dispatching",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  /**
   * The provider may have accepted the request but the server cannot prove a
   * terminal state (crash after the acceptance marker, transport failure, or
   * unconfirmed cancellation). The quota reservation is retained and the run
   * is never automatically re-dispatched.
   */
  "unconfirmed",
] as const;

export type CloudRunStatus = (typeof CLOUD_RUN_STATUSES)[number];

export function isCloudTerminalStatus(status: CloudRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "unconfirmed";
}

export const CLOUD_BACKEND_ID = "cloud-default" as const;
export const CLOUD_RUNTIME_ID = "hosted-sdk" as const;

/** Stable error codes returned by cloud routes (details of the public error). */
export const CLOUD_ERROR_CODES = {
  CLOUD_DISABLED: "CLOUD_DISABLED",
  PROVIDER_UNCONFIGURED: "PROVIDER_UNCONFIGURED",
  ACCOUNT_NOT_FORMAL: "ACCOUNT_NOT_FORMAL",
  QUOTA_NOT_CONFIGURED: "QUOTA_NOT_CONFIGURED",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SNAPSHOT_NOT_FOUND: "SNAPSHOT_NOT_FOUND",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  EXPIRED_CURSOR: "EXPIRED_CURSOR",
  EXECUTION_UNCONFIRMED: "EXECUTION_UNCONFIRMED",
  TOOL_REFUSED: "TOOL_REFUSED",
  PROVIDER_NOT_ACCEPTED: "PROVIDER_NOT_ACCEPTED",
  LEASE_LOST: "LEASE_LOST",
  KILL_SWITCH: "KILL_SWITCH",
} as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES];

/** Client-visible cloud run. Never includes provider keys, service keys, or raw provider payloads. */
export interface CloudCoachingRun {
  id: string;
  sessionId: string;
  status: CloudRunStatus;
  idempotencyKey: string;
  prompt: string;
  snapshot: CoachingDataSnapshot;
  backendId: typeof CLOUD_BACKEND_ID;
  runtimeId: typeof CLOUD_RUNTIME_ID;
  createdAt: string;
  updatedAt: string;
  cancelRequestedAt?: string;
  /** True only when the server has provider/local evidence that execution stopped. */
  terminationConfirmed: boolean;
  failure?: { code: string; message: string };
}

export interface CloudSubmitRunInput {
  sessionId: string;
  prompt: string;
  idempotencyKey: string;
  snapshot: CoachingSnapshotReference;
}

export interface CloudSubmitRunResult {
  run: CloudCoachingRun;
  lastSeq: number;
  replayed: boolean;
}

export interface CloudReadRunResult {
  run: CloudCoachingRun;
  lastSeq: number;
  firstSeq: number;
  expiresAt: number;
}

export interface CloudReadEventsResult {
  events: CoachingEventEnvelope[];
  run: CloudCoachingRun;
  lastSeq: number;
  firstSeq: number;
  expiresAt: number;
}

export interface CloudCancelRunResult {
  run: CloudCoachingRun;
  lastSeq: number;
}

/** Truthful server-derived cloud availability for the verified caller. */
export interface CloudCapabilities {
  enabled: boolean;
  providerConfigured: boolean;
  /** Database-owned global provider switch. False means no paid step runs. */
  providerEnabled: boolean;
  accountFormal: boolean;
  quotaConfigured: boolean;
  /** True only when finite token, step, and request budgets are configured. */
  budgetConfigured: boolean;
  concurrentLimit: number;
  reservedCount: number;
  tokensRemaining: number;
  tokensReserved: number;
  perRunTokenBudget: number;
  perStepTokenBudget: number;
  perRunRequestLimit: number;
  tools: string[];
  maxSteps: number;
  maxTokens: number;
  timeoutMs: number;
}

const MAX_ID_LENGTH = 256;
const MAX_PROMPT_LENGTH = 64 * 1024;

function fail(field: string, reason: string): never {
  throw new MalformedResponseError(field, reason);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonBlank(value: unknown, field: string, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.trim() === "") fail(field, "must be a non-blank string");
  if (value.length > maxLength) fail(field, `must be at most ${maxLength} characters`);
  return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return assertNonBlank(value, field);
}

/**
 * Response-side optional fields: Postgres JSON encodes an absent value as
 * `null`, not as a missing key. Normalize only `null`; any non-null value is
 * still validated exactly as before.
 */
function assertNullableOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertNonBlank(value, field);
}

function assertSafeInt(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    fail(field, `must be a safe integer >= ${min}`);
  }
  return value;
}

/** Guard a cloud submit body. Snapshot handles only: records/counts are server-resolved. */
export function parseCloudSubmitRunInput(value: unknown): CloudSubmitRunInput {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!isObject(value.snapshot)) fail("snapshot", "must be an object");
  if ("records" in value.snapshot || "recordIds" in value.snapshot || "recordCount" in value.snapshot) {
    fail("snapshot", "must be a snapshot handle only: records are server-resolved");
  }
  return {
    sessionId: assertNonBlank(value.sessionId, "sessionId"),
    prompt: assertNonBlank(value.prompt, "prompt", MAX_PROMPT_LENGTH),
    idempotencyKey: assertNonBlank(value.idempotencyKey, "idempotencyKey"),
    snapshot: {
      snapshotId: assertNonBlank(value.snapshot.snapshotId, "snapshot.snapshotId"),
      source: assertNonBlank(value.snapshot.source, "snapshot.source"),
      accountId: assertNonBlank(value.snapshot.accountId, "snapshot.accountId"),
    },
  };
}

/** Guard a cloud session create body (`{ id? }`; absent/empty body means auto-id). */
export function parseCloudCreateSessionInput(value: unknown): { id?: string } {
  if (value === undefined) return {};
  if (!isObject(value)) fail("(root)", "must be an object");
  if (value.id === undefined) return {};
  return { id: assertNonBlank(value.id, "id") };
}

/** Guard a cloud snapshot create body (`{ from?, to? }`). Date validity is core-owned. */
export function parseCloudCreateSnapshotInput(value: unknown): { from?: string; to?: string } {
  if (value === undefined) return {};
  if (!isObject(value)) fail("(root)", "must be an object");
  const out: { from?: string; to?: string } = {};
  const from = assertOptionalString(value.from, "from");
  const to = assertOptionalString(value.to, "to");
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

export function parseCloudCancelInput(value: unknown): { reason?: string } {
  if (value === undefined) return {};
  if (!isObject(value)) fail("(root)", "must be an object");
  if (value.reason === undefined) return {};
  return { reason: assertNonBlank(value.reason, "reason") };
}

function parseRunSnapshot(value: unknown): CoachingDataSnapshot {
  if (!isObject(value)) fail("snapshot", "must be an object");
  if (!Array.isArray(value.recordIds)) fail("snapshot.recordIds", "must be an array");
  const recordIds = value.recordIds.map((entry, index) =>
    assertNonBlank(entry, `snapshot.recordIds[${index}]`),
  );
  const recordCount = assertSafeInt(value.recordCount, "snapshot.recordCount", 0);
  if (recordCount !== recordIds.length) fail("snapshot.recordCount", "must equal recordIds.length");
  const snapshot: CoachingDataSnapshot = {
    snapshotId: assertNonBlank(value.snapshotId, "snapshot.snapshotId"),
    source: assertNonBlank(value.source, "snapshot.source"),
    accountId: assertNonBlank(value.accountId, "snapshot.accountId"),
    recordIds,
    recordCount,
  };
  const from = assertNullableOptionalString(value.from, "snapshot.from");
  const to = assertNullableOptionalString(value.to, "snapshot.to");
  if (from !== undefined) snapshot.from = from;
  if (to !== undefined) snapshot.to = to;
  return snapshot;
}

/** Guard a cloud run. Used by the app client and by handler tests. */
export function parseCloudCoachingRun(value: unknown): CloudCoachingRun {
  if (!isObject(value)) fail("(root)", "must be an object");
  const status = assertNonBlank(value.status, "status");
  if (!(CLOUD_RUN_STATUSES as readonly string[]).includes(status)) {
    fail("status", `must be one of ${CLOUD_RUN_STATUSES.join(", ")}`);
  }
  if (value.backendId !== CLOUD_BACKEND_ID) fail("backendId", `must be ${CLOUD_BACKEND_ID}`);
  if (value.runtimeId !== CLOUD_RUNTIME_ID) fail("runtimeId", `must be ${CLOUD_RUNTIME_ID}`);
  const run: CloudCoachingRun = {
    id: assertNonBlank(value.id, "id"),
    sessionId: assertNonBlank(value.sessionId, "sessionId"),
    status: status as CloudRunStatus,
    idempotencyKey: assertNonBlank(value.idempotencyKey, "idempotencyKey"),
    prompt: assertNonBlank(value.prompt, "prompt", MAX_PROMPT_LENGTH),
    snapshot: parseRunSnapshot(value.snapshot),
    backendId: CLOUD_BACKEND_ID,
    runtimeId: CLOUD_RUNTIME_ID,
    createdAt: assertNonBlank(value.createdAt, "createdAt"),
    updatedAt: assertNonBlank(value.updatedAt, "updatedAt"),
    terminationConfirmed: value.terminationConfirmed === true,
  };
  if (value.terminationConfirmed !== undefined && typeof value.terminationConfirmed !== "boolean") {
    fail("terminationConfirmed", "must be a boolean");
  }
  const cancelRequestedAt = assertNullableOptionalString(value.cancelRequestedAt, "cancelRequestedAt");
  if (cancelRequestedAt !== undefined) run.cancelRequestedAt = cancelRequestedAt;
  if (value.failure !== undefined && value.failure !== null) {
    if (!isObject(value.failure)) fail("failure", "must be an object");
    run.failure = {
      code: assertNonBlank(value.failure.code, "failure.code"),
      message: assertNonBlank(value.failure.message, "failure.message"),
    };
  }
  return run;
}

export function parseCloudSubmitRunResult(value: unknown): CloudSubmitRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (typeof value.replayed !== "boolean") fail("replayed", "must be a boolean");
  return {
    run: parseCloudCoachingRun(value.run),
    lastSeq: assertSafeInt(value.lastSeq, "lastSeq", -1),
    replayed: value.replayed,
  };
}

export function parseCloudReadRunResult(value: unknown): CloudReadRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  return {
    run: parseCloudCoachingRun(value.run),
    lastSeq: assertSafeInt(value.lastSeq, "lastSeq", -1),
    firstSeq: assertSafeInt(value.firstSeq, "firstSeq", 0),
    expiresAt: assertSafeInt(value.expiresAt, "expiresAt", 0),
  };
}

export function parseCloudReadEventsResult(value: unknown): CloudReadEventsResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!Array.isArray(value.events)) fail("events", "must be an array");
  return {
    events: value.events.map((entry, index) => {
      try {
        return parseCoachingEventEnvelope(entry);
      } catch (error) {
        if (error instanceof MalformedResponseError) fail(`events[${index}]`, error.message);
        throw error;
      }
    }),
    run: parseCloudCoachingRun(value.run),
    lastSeq: assertSafeInt(value.lastSeq, "lastSeq", -1),
    firstSeq: assertSafeInt(value.firstSeq, "firstSeq", 0),
    expiresAt: assertSafeInt(value.expiresAt, "expiresAt", 0),
  };
}

export function parseCloudCancelRunResult(value: unknown): CloudCancelRunResult {
  if (!isObject(value)) fail("(root)", "must be an object");
  return {
    run: parseCloudCoachingRun(value.run),
    lastSeq: assertSafeInt(value.lastSeq, "lastSeq", -1),
  };
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "must be a boolean");
  return value;
}

/**
 * Guard the server-derived cloud availability response.
 *
 * Availability is never inferred from the presence of this payload: a client
 * still must name the cloud backend explicitly and the server re-checks the
 * verified account, provider, and quota on every run submission.
 */
export function parseCloudCapabilities(value: unknown): CloudCapabilities {
  if (!isObject(value)) fail("(root)", "must be an object");
  if (!Array.isArray(value.tools)) fail("tools", "must be an array");
  const tools = value.tools.map((entry, index) => {
    const name = assertNonBlank(entry, `tools[${index}]`);
    if (!(COACHED_TOOL_NAMES as readonly string[]).includes(name)) {
      fail(`tools[${index}]`, `must be a read-only coached tool (${COACHED_TOOL_NAMES.join(", ")})`);
    }
    return name;
  });
  return {
    enabled: assertBoolean(value.enabled, "enabled"),
    providerConfigured: assertBoolean(value.providerConfigured, "providerConfigured"),
    providerEnabled: assertBoolean(value.providerEnabled, "providerEnabled"),
    accountFormal: assertBoolean(value.accountFormal, "accountFormal"),
    quotaConfigured: assertBoolean(value.quotaConfigured, "quotaConfigured"),
    budgetConfigured: assertBoolean(value.budgetConfigured, "budgetConfigured"),
    concurrentLimit: assertSafeInt(value.concurrentLimit, "concurrentLimit", 0),
    reservedCount: assertSafeInt(value.reservedCount, "reservedCount", 0),
    tokensRemaining: assertSafeInt(value.tokensRemaining, "tokensRemaining", 0),
    tokensReserved: assertSafeInt(value.tokensReserved, "tokensReserved", 0),
    perRunTokenBudget: assertSafeInt(value.perRunTokenBudget, "perRunTokenBudget", 0),
    perStepTokenBudget: assertSafeInt(value.perStepTokenBudget, "perStepTokenBudget", 0),
    perRunRequestLimit: assertSafeInt(value.perRunRequestLimit, "perRunRequestLimit", 0),
    tools,
    maxSteps: assertSafeInt(value.maxSteps, "maxSteps", 0),
    maxTokens: assertSafeInt(value.maxTokens, "maxTokens", 0),
    timeoutMs: assertSafeInt(value.timeoutMs, "timeoutMs", 0),
  };
}
