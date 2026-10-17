/**
 * Durable cloud coaching persistence seam.
 *
 * Two repositories exist because the trust boundaries differ:
 * - {@link CloudRequestRepository} is bound to one caller's ephemeral access
 *   token. Every method is an RPC; RLS and the caller's `auth.uid()` decide
 *   ownership. No service-role key is present in this path.
 * - {@link CloudWorkerRepository} is the worker-only path, authenticated with
 *   the service key. It claims leased outbox jobs, appends events with a
 *   generation fence, and settles usage exactly once.
 *
 * `supabaseCoachingRepository.ts` implements both with native `fetch`.
 * `tests/cloudFakes.ts` implements both in memory so the worker and HTTP
 * handler can be exercised without a database.
 */
import type { CoachingDataSnapshot, CoachingEventEnvelope, CoachingEventPayload } from "@pi-fit-trace/api-contracts";
import { CLOUD_BACKEND_ID, CLOUD_RUNTIME_ID } from "@pi-fit-trace/api-contracts";
import type { CloudCoachingRun, CloudRunStatus } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { stableStringify } from "@pi-fit-trace/core";

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export interface CloudAccountState {
  accountId: string;
  isAnonymous: boolean;
  quotaConfigured: boolean;
  /** False unless the quota has a finite token/request budget configured. */
  budgetConfigured: boolean;
  /** Database-owned global provider kill switch. Missing/false is off. */
  providerEnabled: boolean;
  concurrentLimit: number;
  reservedCount: number;
  tokensRemaining: number;
  tokensReserved: number;
  perRunTokenBudget: number;
  perStepTokenBudget: number;
  perRunRequestLimit: number;
}

export interface CloudSessionRecord {
  id: string;
  expiresAt: number;
}

export interface CloudSnapshotRecord {
  snapshotId: string;
  source: string;
  accountId: string;
  recordIds: string[];
  recordCount: number;
  from?: string;
  to?: string;
  records: WorkoutRecord[];
  expiresAt: number;
}

export interface CloudRunRecord {
  id: string;
  sessionId: string;
  accountId: string;
  status: CloudRunStatus;
  idempotencyKey: string;
  requestHash: string;
  prompt: string;
  snapshot: CoachingDataSnapshot;
  /** Retained copy so a dispatched run never depends on snapshot TTL. */
  snapshotRecords: WorkoutRecord[];
  backendId: typeof CLOUD_BACKEND_ID;
  runtimeId: typeof CLOUD_RUNTIME_ID;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  cancelRequestedAt?: string;
  cancelReason?: string;
  providerCallStartedAt?: string;
  /** Set immediately before the first actual provider HTTP request. */
  providerFetchStartedAt?: string;
  providerAcceptedAt?: string;
  providerGenerationId?: string;
  terminationConfirmed: boolean;
  reservationReleased: boolean;
  /** Finite token allocation reserved at submit; 0 means unconfigured. */
  tokenBudget: number;
  /** Finite provider-request allocation reserved at submit. */
  requestBudget: number;
  providerTokensCommitted: number;
  providerRequestsCommitted: number;
  budgetReleased: boolean;
  failure?: { code: string; message: string };
}

export interface CloudUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * False when at least one provider step did not return a usable usage block.
   * Totals then include local estimates for stopping only and MUST NOT be
   * settled as actual billed usage. The default is true for older/in-memory
   * callers.
   */
  known?: boolean;
  /** Authoritative tokens from provider-returned usage only. */
  knownTokens?: number;
  knownPromptTokens?: number;
  knownCompletionTokens?: number;
  /**
   * False when some usage is unknown. Settlement charges `knownTokens` and
   * leaves the rest of the reservation in place. Defaults to true.
   */
  complete?: boolean;
  costUsd?: number;
  generationId?: string;
}

export interface CloudTerminal {
  status: "completed" | "failed" | "cancelled" | "unconfirmed";
  reason?: string;
  failure?: { code: string; message: string };
  terminationConfirmed: boolean;
  /** ONLY true when the provider was never accepted, or termination is proven. */
  releaseReservation: boolean;
  /** Set only with definitive evidence (e.g. provider 4xx) that no call was billed. */
  provenNotAccepted?: boolean;
}

export interface CloudSubmitOutcome {
  run: CloudCoachingRun;
  lastSeq: number;
  replayed: boolean;
}

export interface CloudEventPage {
  events: CoachingEventEnvelope[];
  run: CloudCoachingRun;
  lastSeq: number;
  firstSeq: number;
  expiresAt: number;
}

export interface CloudOutboxJob {
  run: CloudRunRecord;
  leaseGeneration: number;
  attempt: number;
}

export interface CloudProviderCallState {
  started: boolean;
  alreadyStarted?: boolean;
  cancelled?: boolean;
  terminal?: boolean;
}

export interface CloudStartCallResult {
  started: boolean;
  alreadyStarted: boolean;
  cancelled: boolean;
  terminal: boolean;
}

/**
 * Result of the per-fetch authorization RPC. The worker calls this before
 * EVERY provider request: a lease that expired, a newer generation, a
 * cancellation, a guest mutation, or exhausted quota must stop the loop before
 * another paid call.
 */
export interface CloudStepAuthorization {
  allowed: boolean;
  cancelled: boolean;
  terminal: boolean;
  leaseValid: boolean;
  reason?: string;
}

/** Worst-case finite budget for one provider HTTP request. */
export interface CloudStepBudget {
  tokens: number;
  requests: number;
}

export interface CloudAcceptedInfo {
  generationId?: string;
  usage?: CloudUsage;
}

export interface CloudRequestRepository {
  accountState(): Promise<CloudAccountState>;
  createSession(id: string | undefined): Promise<CloudSessionRecord>;
  readSession(id: string): Promise<CloudSessionRecord>;
  createSnapshot(records: WorkoutRecord[], filter: { from?: string; to?: string }): Promise<CloudSnapshotRecord>;
  submitRun(input: {
    runId: string;
    sessionId: string;
    prompt: string;
    idempotencyKey: string;
    snapshot: { snapshotId: string; source: string; accountId: string };
  }): Promise<CloudSubmitOutcome>;
  readRun(runId: string): Promise<{ run: CloudCoachingRun; lastSeq: number; firstSeq: number; expiresAt: number }>;
  readEvents(runId: string, fromSeq: number, limit: number): Promise<CloudEventPage>;
  cancelRun(runId: string, reason?: string): Promise<{ run: CloudCoachingRun; lastSeq: number }>;
}

export interface CloudWorkerRepository {
  claimOutbox(workerId: string, leaseMs: number, limit: number): Promise<CloudOutboxJob[]>;
  markProviderCallStarted(runId: string, generation: number): Promise<CloudStartCallResult>;
  markProviderAccepted(runId: string, generation: number, accepted: CloudAcceptedInfo): Promise<void>;
  /** Durable pre-fetch gate: validates ownership and atomically charges budget. */
  authorizeProviderStep(
    runId: string,
    generation: number,
    budget: CloudStepBudget,
  ): Promise<CloudStepAuthorization>;
  appendEvent(runId: string, generation: number, payload: CoachingEventPayload): Promise<number>;
  terminateRun(runId: string, generation: number, terminal: CloudTerminal): Promise<{ run: CloudRunRecord; lastSeq: number }>;
  settleUsage(runId: string, generation: number, usage: CloudUsage): Promise<{ settled: boolean }>;
  /** Proven-not-accepted refund. Throws when acceptance or termination is unproven. */
  releaseReservation(runId: string, generation: number, provenNotAccepted: boolean): Promise<void>;
}

/** Canonical request identity used by the atomic submit RPC. */
export function canonicalCloudRequest(input: {
  prompt: string;
  snapshot: { snapshotId: string; source: string; accountId: string };
}): Record<string, unknown> {
  return {
    prompt: input.prompt,
    backendId: CLOUD_BACKEND_ID,
    runtimeId: CLOUD_RUNTIME_ID,
    snapshot: {
      snapshotId: input.snapshot.snapshotId,
      source: input.snapshot.source,
      accountId: input.snapshot.accountId,
    },
  };
}

export function canonicalCloudRequestText(input: {
  prompt: string;
  snapshot: { snapshotId: string; source: string; accountId: string };
}): string {
  return stableStringify(canonicalCloudRequest(input));
}

export function toPublicRun(run: CloudRunRecord): CloudCoachingRun {
  const out: CloudCoachingRun = {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    idempotencyKey: run.idempotencyKey,
    prompt: run.prompt,
    snapshot: {
      snapshotId: run.snapshot.snapshotId,
      source: run.snapshot.source,
      accountId: run.snapshot.accountId,
      recordIds: [...run.snapshot.recordIds],
      recordCount: run.snapshot.recordCount,
      ...(run.snapshot.from === undefined ? {} : { from: run.snapshot.from }),
      ...(run.snapshot.to === undefined ? {} : { to: run.snapshot.to }),
    },
    backendId: CLOUD_BACKEND_ID,
    runtimeId: CLOUD_RUNTIME_ID,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    terminationConfirmed: run.terminationConfirmed,
  };
  if (run.cancelRequestedAt !== undefined) out.cancelRequestedAt = run.cancelRequestedAt;
  if (run.failure !== undefined) out.failure = { ...run.failure };
  return out;
}

export function isTerminalCloudStatus(status: CloudRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "unconfirmed";
}

/** Validate a page cursor against the stored log (firstSeq is always 0 here). */
export function assertCloudCursor(lastSeq: number, fromSeq: number): void {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new CloudError("EXPIRED_CURSOR", "Event cursor is invalid; refetch from seq 0.", 410);
  }
  if (fromSeq > lastSeq + 1) {
    throw new CloudError("EXPIRED_CURSOR", "Event cursor is beyond the retained log; refetch from seq 0.", 410);
  }
}
