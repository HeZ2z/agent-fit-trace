/**
 * In-memory durable cloud models used only by focused tests.
 *
 * These fakes deliberately mirror the SQL invariants (lease generation,
 * fetch-before-call marker, dense events, settle-once, cancellation unknown)
 * so handler/worker tests exercise the TypeScript seams without claiming a
 * database guarantee. The opt-in `supabaseIntegration.test.ts` suite is the
 * only place real RLS/RPC behavior is asserted.
 */
import assert from "node:assert/strict";
import type {
  CloudCoachingRun,
  CoachingEventEnvelope,
  CoachingEventPayload,
} from "@agent-fit-trace/api-contracts";
import { CLOUD_BACKEND_ID, CLOUD_RUNTIME_ID } from "@agent-fit-trace/api-contracts";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { stableStringify } from "@agent-fit-trace/core";
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
} from "../server/cloud/repository.ts";
import {
  CloudError,
  assertCloudCursor,
  canonicalCloudRequestText,
  toPublicRun,
} from "../server/cloud/repository.ts";

interface FakeOutbox {
  status: "pending" | "leased" | "done" | "dead";
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  leaseGeneration: number;
  availableAt: number;
}

const DEFAULT_ACCOUNT = "user-1";

export interface FakeCloudOptions {
  now?: () => number;
  accountId?: string;
  isAnonymous?: boolean;
  concurrentLimit?: number;
  tokensLimit?: number;
  perRunTokenBudget?: number;
  perStepTokenBudget?: number;
  perRunRequestLimit?: number;
}

export class FakeCloudDatabase {
  readonly accountId: string;
  isAnonymous: boolean;
  quotaConfigured = true;
  providerEnabled = true;
  concurrentLimit: number;
  reservedCount = 0;
  tokensLimit: number;
  tokensUsed = 0;
  tokensReserved = 0;
  perRunTokenBudget: number;
  perStepTokenBudget: number;
  perRunRequestLimit: number;
  nowMs: number;
  readonly sessions = new Map<string, CloudSessionRecord & { ownerId: string }>();
  readonly snapshots = new Map<string, CloudSnapshotRecord>();
  readonly runs = new Map<string, CloudRunRecord>();
  readonly events = new Map<string, CoachingEventEnvelope[]>();
  readonly ledger = new Map<string, CloudUsage>();
  readonly outbox = new Map<string, FakeOutbox>();
  readonly requestKeys = new Map<string, string>();

  constructor(options: FakeCloudOptions = {}) {
    this.accountId = options.accountId ?? DEFAULT_ACCOUNT;
    this.isAnonymous = options.isAnonymous ?? false;
    this.concurrentLimit = options.concurrentLimit ?? 20;
    this.tokensLimit = options.tokensLimit ?? 1_000_000;
    this.perRunTokenBudget = options.perRunTokenBudget ?? 10_000;
    this.perStepTokenBudget = options.perStepTokenBudget ?? 4_096;
    this.perRunRequestLimit = options.perRunRequestLimit ?? 8;
    this.nowMs = options.now?.() ?? Date.parse("2026-10-17T12:00:00.000Z");
  }

  now(): number {
    return this.nowMs;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  iso(ms = this.nowMs): string {
    return new Date(ms).toISOString();
  }

  setAccount(input: {
    isAnonymous?: boolean;
    quotaConfigured?: boolean;
    concurrentLimit?: number;
    providerEnabled?: boolean;
  }): void {
    if (input.isAnonymous !== undefined) this.isAnonymous = input.isAnonymous;
    if (input.quotaConfigured !== undefined) this.quotaConfigured = input.quotaConfigured;
    if (input.concurrentLimit !== undefined) this.concurrentLimit = input.concurrentLimit;
    if (input.providerEnabled !== undefined) this.providerEnabled = input.providerEnabled;
  }

  budgetConfigured(): boolean {
    return (
      this.quotaConfigured &&
      Number.isFinite(this.tokensLimit) &&
      this.perRunTokenBudget > 0 &&
      this.perStepTokenBudget > 0 &&
      this.perRunRequestLimit > 0
    );
  }

  getRun(runId: string): CloudRunRecord {
    const run = this.runs.get(runId);
    assert.ok(run, `missing fake run ${runId}`);
    return run;
  }

  getEvents(runId: string): CoachingEventEnvelope[] {
    return this.events.get(runId) ?? [];
  }

  outboxFor(runId: string): FakeOutbox {
    const outbox = this.outbox.get(runId);
    assert.ok(outbox, `missing fake outbox ${runId}`);
    return outbox;
  }

  expireLease(runId: string): void {
    const outbox = this.outboxFor(runId);
    outbox.leaseUntil = this.nowMs - 1;
  }

  requestRepository(accountId = this.accountId): CloudRequestRepository {
    return makeRequestRepository(this, accountId);
  }

  workerRepository(): CloudWorkerRepository {
    return makeWorkerRepository(this);
  }

  accountState(): CloudAccountState {
    return {
      accountId: this.accountId,
      isAnonymous: this.isAnonymous,
      quotaConfigured: this.quotaConfigured,
      budgetConfigured: this.budgetConfigured(),
      providerEnabled: this.providerEnabled,
      concurrentLimit: this.concurrentLimit,
      reservedCount: this.reservedCount,
      tokensRemaining: Math.max(this.tokensLimit - this.tokensUsed - this.tokensReserved, 0),
      tokensReserved: this.tokensReserved,
      perRunTokenBudget: this.perRunTokenBudget,
      perStepTokenBudget: this.perStepTokenBudget,
      perRunRequestLimit: this.perRunRequestLimit,
    };
  }
}

function requireAccount(db: FakeCloudDatabase, accountId: string): void {
  if (accountId !== db.accountId) {
    throw new CloudError("ACCOUNT_NOT_FORMAL", "Cloud coaching requires a formal account.", 403);
  }
  if (db.isAnonymous) {
    throw new CloudError("ACCOUNT_NOT_FORMAL", "Cloud coaching requires a formal account.", 403);
  }
}

function cloneRun(run: CloudRunRecord): CloudRunRecord {
  return structuredClone(run);
}

function publicRun(run: CloudRunRecord): CloudCoachingRun {
  return toPublicRun(cloneRun(run));
}

function makeRequestRepository(
  db: FakeCloudDatabase,
  accountId: string,
): CloudRequestRepository {
  function ownedRun(runId: string): CloudRunRecord {
    const run = db.runs.get(runId);
    if (run === undefined || run.accountId !== accountId) {
      throw new CloudError("RUN_NOT_FOUND", "Cloud coaching run not found.", 404);
    }
    return run;
  }

  function replayExisting(input: {
    sessionId: string;
    prompt: string;
    idempotencyKey: string;
    snapshot: { snapshotId: string; source: string; accountId: string };
  }): CloudSubmitOutcome | null {
    const canonical = canonicalCloudRequestText({
      prompt: input.prompt,
      snapshot: input.snapshot,
    });
    const replayKey = `${accountId}|${input.sessionId}|${input.idempotencyKey}`;
    const existingId = db.requestKeys.get(replayKey);
    if (existingId === undefined) return null;
    const existing = db.runs.get(existingId);
    assert.ok(existing);
    if (existing.requestHash !== canonical) {
      throw new CloudError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different content.",
        409,
      );
    }
    return {
      run: publicRun(existing),
      lastSeq: (db.events.get(existing.id)?.at(-1)?.seq ?? -1),
      replayed: true,
    };
  }

  return {
    async accountState(): Promise<CloudAccountState> {
      if (accountId !== db.accountId) {
        throw new CloudError("ACCOUNT_NOT_FORMAL", "Cloud coaching requires a formal account.", 403);
      }
      return {
        accountId: db.accountId,
        isAnonymous: db.isAnonymous,
        quotaConfigured: db.quotaConfigured,
        budgetConfigured: db.budgetConfigured(),
        providerEnabled: db.providerEnabled,
        concurrentLimit: db.concurrentLimit,
        reservedCount: db.reservedCount,
        tokensRemaining: Math.max(db.tokensLimit - db.tokensUsed - db.tokensReserved, 0),
        tokensReserved: db.tokensReserved,
        perRunTokenBudget: db.perRunTokenBudget,
        perStepTokenBudget: db.perStepTokenBudget,
        perRunRequestLimit: db.perRunRequestLimit,
      };
    },

    async createSession(id): Promise<CloudSessionRecord> {
      requireAccount(db, accountId);
      const sessionId = id ?? `sess-${db.sessions.size + 1}`;
      const existing = db.sessions.get(sessionId);
      if (existing !== undefined && existing.ownerId !== accountId) {
        throw new CloudError("SESSION_NOT_FOUND", "Cloud coaching session not found.", 404);
      }
      const session = {
        id: sessionId,
        ownerId: accountId,
        expiresAt: db.nowMs + 30 * 60 * 1000,
      };
      db.sessions.set(sessionId, session);
      return { id: session.id, expiresAt: session.expiresAt };
    },

    async readSession(id): Promise<CloudSessionRecord> {
      requireAccount(db, accountId);
      const session = db.sessions.get(id);
      if (session === undefined || session.ownerId !== accountId) {
        throw new CloudError("SESSION_NOT_FOUND", "Cloud coaching session not found.", 404);
      }
      return { id: session.id, expiresAt: session.expiresAt };
    },

    async createSnapshot(records, filter): Promise<CloudSnapshotRecord> {
      requireAccount(db, accountId);
      const snapshotId = `snap-${db.snapshots.size + 1}`;
      const recordIds = records.map((record) => record.id).sort();
      const snapshot: CloudSnapshotRecord = {
        snapshotId,
        source: "authenticated-store",
        accountId,
        recordIds,
        recordCount: recordIds.length,
        ...(filter.from === undefined ? {} : { from: filter.from }),
        ...(filter.to === undefined ? {} : { to: filter.to }),
        records: structuredClone(records),
        expiresAt: db.nowMs + 30 * 60 * 1000,
      };
      db.snapshots.set(snapshotId, snapshot);
      return structuredClone(snapshot);
    },

    async findRunByKey(input): Promise<CloudSubmitOutcome | null> {
      requireAccount(db, accountId);
      return replayExisting(input);
    },

    async submitRun(input): Promise<CloudSubmitOutcome> {
      requireAccount(db, accountId);
      const replay = replayExisting(input);
      if (replay !== null) return replay;
      const canonical = canonicalCloudRequestText({
        prompt: input.prompt,
        snapshot: input.snapshot,
      });
      const replayKey = `${accountId}|${input.sessionId}|${input.idempotencyKey}`;
      const session = db.sessions.get(input.sessionId);
      if (session === undefined || session.ownerId !== accountId || session.expiresAt <= db.nowMs) {
        throw new CloudError("SESSION_NOT_FOUND", "Cloud coaching session not found.", 404);
      }
      const snapshot = db.snapshots.get(input.snapshot.snapshotId);
      if (
        snapshot === undefined ||
        snapshot.accountId !== accountId ||
        snapshot.expiresAt <= db.nowMs ||
        snapshot.source !== input.snapshot.source
      ) {
        throw new CloudError("SNAPSHOT_NOT_FOUND", "Snapshot not found or expired.", 404);
      }
      if (!db.quotaConfigured || !db.budgetConfigured()) {
        throw new CloudError("QUOTA_NOT_CONFIGURED", "Cloud coaching quota is not configured.", 403);
      }
      if (!db.providerEnabled) {
        throw new CloudError("CLOUD_DISABLED", "Cloud coaching is not enabled on this server.", 503);
      }
      if (
        db.reservedCount >= Math.min(db.concurrentLimit, 20) ||
        db.reservedCount >= 20
      ) {
        throw new CloudError("QUOTA_EXHAUSTED", "No cloud coaching capacity is available.", 429);
      }
      if (db.tokensUsed + db.tokensReserved + db.perRunTokenBudget > db.tokensLimit) {
        throw new CloudError("QUOTA_EXHAUSTED", "No cloud coaching token budget is available.", 429);
      }

      const run: CloudRunRecord = {
        id: input.runId,
        sessionId: input.sessionId,
        accountId,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        requestHash: canonical,
        prompt: input.prompt,
        snapshot: {
          snapshotId: snapshot.snapshotId,
          source: snapshot.source,
          accountId,
          recordIds: [...snapshot.recordIds],
          recordCount: snapshot.recordCount,
          ...(snapshot.from === undefined ? {} : { from: snapshot.from }),
          ...(snapshot.to === undefined ? {} : { to: snapshot.to }),
        },
        snapshotRecords: structuredClone(snapshot.records),
        backendId: CLOUD_BACKEND_ID,
        runtimeId: CLOUD_RUNTIME_ID,
        createdAt: db.iso(),
        updatedAt: db.iso(),
        expiresAt: db.nowMs + 30 * 60 * 1000,
        terminationConfirmed: false,
        reservationReleased: false,
        tokenBudget: db.perRunTokenBudget,
        requestBudget: db.perRunRequestLimit,
        providerTokensCommitted: 0,
        providerRequestsCommitted: 0,
        budgetReleased: false,
      };
      db.runs.set(run.id, run);
      db.events.set(run.id, []);
      db.outbox.set(run.id, {
        status: "pending",
        attempts: 0,
        leaseGeneration: 0,
        availableAt: db.nowMs,
      });
      db.requestKeys.set(replayKey, run.id);
      db.reservedCount += 1;
      db.tokensReserved += db.perRunTokenBudget;
      return { run: publicRun(run), lastSeq: -1, replayed: false };
    },

    async readRun(runId) {
      requireAccount(db, accountId);
      const run = ownedRun(runId);
      return {
        run: publicRun(run),
        lastSeq: (db.events.get(run.id)?.at(-1)?.seq ?? -1),
        firstSeq: 0,
        expiresAt: run.expiresAt,
      };
    },

    async readEvents(runId, fromSeq, limit): Promise<CloudEventPage> {
      requireAccount(db, accountId);
      const run = ownedRun(runId);
      const all = db.events.get(run.id) ?? [];
      const lastSeq = all.at(-1)?.seq ?? -1;
      assertCloudCursor(lastSeq, fromSeq);
      return {
        events: structuredClone(all.filter((event) => event.seq >= fromSeq).slice(0, limit)),
        run: publicRun(run),
        lastSeq,
        firstSeq: 0,
        expiresAt: run.expiresAt,
      };
    },

    async cancelRun(runId, reason) {
      requireAccount(db, accountId);
      const run = ownedRun(runId);
      const all = db.events.get(run.id) ?? [];
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
        return { run: publicRun(run), lastSeq: all.at(-1)?.seq ?? -1 };
      }
      const cancelReason = reason ?? "cancel requested";
      if (run.providerFetchStartedAt === undefined) {
        const seq = (all.at(-1)?.seq ?? -1) + 1;
        all.push(envelope(run, seq, { type: "terminal", status: "cancelled", reason: cancelReason }));
        db.events.set(run.id, all);
        run.status = "cancelled";
        run.cancelRequestedAt = db.iso();
        run.cancelReason = cancelReason;
        run.terminationConfirmed = true;
        if (!run.reservationReleased) {
          run.reservationReleased = true;
          db.reservedCount = Math.max(db.reservedCount - 1, 0);
        }
        if (!run.budgetReleased) {
          run.budgetReleased = true;
          db.tokensReserved = Math.max(db.tokensReserved - run.tokenBudget, 0);
        }
        const outbox = db.outboxFor(run.id);
        outbox.status = "done";
        return { run: publicRun(run), lastSeq: seq };
      }
      run.cancelRequestedAt ??= db.iso();
      run.cancelReason ??= cancelReason;
      run.status = "cancelling";
      run.updatedAt = db.iso();
      return { run: publicRun(run), lastSeq: all.at(-1)?.seq ?? -1 };
    },
  };
}

function envelope(
  run: CloudRunRecord,
  seq: number,
  event: CoachingEventPayload,
): CoachingEventEnvelope {
  return {
    protocolVersion: 1,
    sessionId: run.sessionId,
    runId: run.id,
    seq,
    event,
  };
}

function makeWorkerRepository(db: FakeCloudDatabase): CloudWorkerRepository {
  function claimOne(workerId: string, leaseMs: number): CloudOutboxJob | undefined {
    for (const [runId, outbox] of db.outbox) {
      const run = db.runs.get(runId);
      if (run === undefined) continue;
      if (outbox.status === "leased" && (outbox.leaseUntil ?? 0) <= db.nowMs) {
        if (run.providerFetchStartedAt !== undefined) {
          if (!["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
            const all = db.events.get(runId) ?? [];
            const seq = (all.at(-1)?.seq ?? -1) + 1;
            all.push(
              envelope(run, seq, {
                type: "terminal",
                status: "failed",
                reason: "execution unconfirmed: provider acceptance cannot be proven",
              }),
            );
            db.events.set(runId, all);
          }
          run.status = "unconfirmed";
          run.failure ??= {
            code: "EXECUTION_UNCONFIRMED",
            message: "Provider acceptance is unconfirmed.",
          };
          run.terminationConfirmed = false;
          run.reservationReleased = false;
          outbox.status = "dead";
        } else {
          run.providerCallStartedAt = undefined;
          run.providerTokensCommitted = 0;
          run.providerRequestsCommitted = 0;
          run.status = run.cancelRequestedAt === undefined ? "queued" : "cancelling";
          outbox.status = "pending";
          outbox.leaseOwner = undefined;
          outbox.leaseUntil = undefined;
          outbox.availableAt = db.nowMs;
        }
      }
      if (outbox.status !== "pending") continue;
      if (run.status !== "queued" && run.status !== "cancelling") continue;
      if (run.providerFetchStartedAt !== undefined) continue;
      outbox.status = "leased";
      outbox.leaseOwner = workerId;
      outbox.leaseUntil = db.nowMs + leaseMs;
      outbox.leaseGeneration += 1;
      outbox.attempts += 1;
      run.updatedAt = db.iso();
      return {
        run: cloneRun(run),
        leaseGeneration: outbox.leaseGeneration,
        attempt: outbox.attempts,
      };
    }
    return undefined;
  }

  function requireLease(runId: string, generation: number): { run: CloudRunRecord; outbox: FakeOutbox } {
    const run = db.runs.get(runId);
    const outbox = db.outbox.get(runId);
    if (run === undefined || outbox === undefined) {
      throw new CloudError("RUN_NOT_FOUND", "Cloud coaching run not found.", 404);
    }
    if (
      outbox.leaseOwner === undefined ||
      outbox.leaseGeneration !== generation ||
      (outbox.leaseUntil ?? 0) <= db.nowMs
    ) {
      throw new CloudError("LEASE_LOST", "Worker lease was superseded; no write was applied.", 409);
    }
    return { run, outbox };
  }

  return {
    async claimOutbox(workerId, leaseMs, limit): Promise<CloudOutboxJob[]> {
      const jobs: CloudOutboxJob[] = [];
      for (let index = 0; index < Math.max(limit, 1); index += 1) {
        const job = claimOne(workerId, leaseMs);
        if (job === undefined) break;
        jobs.push(job);
      }
      return jobs;
    },

    async markProviderCallStarted(runId, generation): Promise<CloudStartCallResult> {
      const { run } = requireLease(runId, generation);
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
        return { started: false, alreadyStarted: false, cancelled: false, terminal: true };
      }
      if (run.cancelRequestedAt !== undefined) {
        return { started: false, alreadyStarted: false, cancelled: true, terminal: false };
      }
      if (run.providerCallStartedAt !== undefined) {
        return { started: false, alreadyStarted: true, cancelled: false, terminal: false };
      }
      run.providerCallStartedAt = db.iso();
      run.status = "dispatching";
      run.updatedAt = db.iso();
      return { started: true, alreadyStarted: false, cancelled: false, terminal: false };
    },

    async markProviderAccepted(runId, generation, accepted: CloudAcceptedInfo): Promise<void> {
      const { run } = requireLease(runId, generation);
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) return;
      if (run.providerFetchStartedAt === undefined) {
        throw new CloudError("INVALID_TRANSITION", "Provider call did not start.", 409);
      }
      run.providerAcceptedAt ??= db.iso();
      run.providerGenerationId ??= accepted.generationId;
      run.status = run.cancelRequestedAt === undefined ? "running" : "cancelling";
      run.updatedAt = db.iso();
    },

    async authorizeProviderStep(runId, generation, budget): Promise<CloudStepAuthorization> {
      const { run } = requireLease(runId, generation);
      const refuse = (reason: string, cancelled = false, terminal = false): CloudStepAuthorization => ({
        allowed: false,
        cancelled,
        terminal,
        leaseValid: true,
        reason,
      });
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
        return {
          allowed: false,
          cancelled: false,
          terminal: true,
          leaseValid: false,
          reason: "terminal",
        };
      }
      if (run.cancelRequestedAt !== undefined) return refuse("cancel-requested", true);
      if (run.providerCallStartedAt === undefined) return refuse("call-not-started");
      if (!db.providerEnabled) return refuse("global-disabled");
      if (db.isAnonymous || !db.quotaConfigured) {
        return refuse(db.isAnonymous ? "account-not-formal" : "quota-not-configured");
      }
      if (!db.budgetConfigured() || run.tokenBudget <= 0 || run.requestBudget <= 0) {
        return refuse("budget-not-configured");
      }
      if (budget.tokens <= 0 || budget.requests < 1) return refuse("invalid-step-budget");
      if (budget.tokens > db.perStepTokenBudget) return refuse("step-budget-exceeded");
      if (run.providerTokensCommitted + budget.tokens > run.tokenBudget) {
        return refuse("token-budget-exhausted");
      }
      if (run.providerRequestsCommitted + budget.requests > run.requestBudget) {
        return refuse("request-budget-exhausted");
      }
      if (db.tokensUsed + db.tokensReserved > db.tokensLimit) {
        return refuse("quota-exhausted");
      }
      run.providerFetchStartedAt ??= db.iso();
      run.providerTokensCommitted += budget.tokens;
      run.providerRequestsCommitted += budget.requests;
      run.status = "dispatching";
      run.updatedAt = db.iso();
      return { allowed: true, cancelled: false, terminal: false, leaseValid: true };
    },

    async appendEvent(runId, generation, payload): Promise<number> {
      const { run } = requireLease(runId, generation);
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
        throw new CloudError("TERMINAL", "Run is already terminal.", 409);
      }
      if (payload.type === "terminal") {
        throw new CloudError("INVALID_TRANSITION", "Terminal events are written by terminateRun.", 409);
      }
      const all = db.events.get(run.id) ?? [];
      const seq = (all.at(-1)?.seq ?? -1) + 1;
      all.push(envelope(run, seq, payload));
      db.events.set(run.id, all);
      run.status =
        run.cancelRequestedAt !== undefined
          ? "cancelling"
          : run.status === "queued"
            ? "running"
            : run.status;
      run.updatedAt = db.iso();
      return seq;
    },

    async terminateRun(
      runId,
      generation,
      terminal: CloudTerminal,
    ): Promise<{ run: CloudRunRecord; lastSeq: number }> {
      const { run, outbox } = requireLease(runId, generation);
      const all = db.events.get(run.id) ?? [];
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
        return { run: cloneRun(run), lastSeq: all.at(-1)?.seq ?? -1 };
      }
      let status = terminal.status;
      let confirmed = terminal.terminationConfirmed;
      let release = terminal.releaseReservation;
      const wasReleased = run.reservationReleased;
      const wasBudgetReleased = run.budgetReleased;

      if (
        run.cancelRequestedAt !== undefined &&
        (status === "completed" || status === "failed")
      ) {
        if (run.providerFetchStartedAt !== undefined && terminal.provenNotAccepted !== true) {
          status = "unconfirmed";
        } else {
          status = "cancelled";
          confirmed = true;
          release = true;
        }
      }
      if (
        status === "cancelled" &&
        run.providerFetchStartedAt !== undefined &&
        terminal.provenNotAccepted !== true
      ) {
        status = "unconfirmed";
        confirmed = false;
        release = false;
      }
      if (status === "unconfirmed") {
        confirmed = false;
        release = false;
      }

      const seq = (all.at(-1)?.seq ?? -1) + 1;
      all.push(
        envelope(run, seq, {
          type: "terminal",
          status: status === "unconfirmed" ? "failed" : status,
          reason:
            status === "unconfirmed"
              ? "execution unconfirmed"
              : (terminal.reason ?? ""),
        }),
      );
      db.events.set(run.id, all);
      run.status = status;
      run.terminationConfirmed = confirmed;
      run.failure = terminal.failure;
      run.updatedAt = db.iso();
      if (release && !wasReleased) {
        run.reservationReleased = true;
        db.reservedCount = Math.max(db.reservedCount - 1, 0);
      }
      // Budget is refunded only when no provider fetch could have billed, or
      // explicitly proven-not-accepted. Known settlement releases the rest.
      const releaseBudget =
        (status === "cancelled" && run.providerFetchStartedAt === undefined) ||
        terminal.provenNotAccepted === true;
      if (releaseBudget && !wasBudgetReleased) {
        run.budgetReleased = true;
        db.tokensReserved = Math.max(db.tokensReserved - run.tokenBudget, 0);
      }
      outbox.status = status === "unconfirmed" ? "dead" : "done";
      return { run: cloneRun(run), lastSeq: seq };
    },

    async settleUsage(runId, generation, usage): Promise<{ settled: boolean }> {
      if (db.ledger.has(runId)) return { settled: false };
      const { run } = requireLease(runId, generation);
      if (["completed", "failed", "cancelled", "unconfirmed"].includes(run.status)) {
        return { settled: false };
      }
      const charge = Math.max(usage.totalTokens, 0);
      const complete = usage.complete !== false;
      db.ledger.set(runId, structuredClone(usage));
      db.tokensUsed += charge;
      db.tokensReserved = complete
        ? Math.max(db.tokensReserved - run.tokenBudget, 0)
        : Math.max(db.tokensReserved - Math.min(run.tokenBudget, charge), 0);
      if (complete) run.budgetReleased = true;
      return { settled: true };
    },

    async releaseReservation(runId, generation, provenNotAccepted): Promise<void> {
      const { run } = requireLease(runId, generation);
      if (run.reservationReleased && run.budgetReleased) return;
      if (run.providerAcceptedAt !== undefined) {
        throw new CloudError("REFUND_UNPROVEN", "Cannot refund an accepted run.", 409);
      }
      if (run.providerFetchStartedAt !== undefined && !provenNotAccepted) {
        throw new CloudError("REFUND_UNPROVEN", "Cannot refund unproven provider work.", 409);
      }
      if (!run.reservationReleased) {
        run.reservationReleased = true;
        db.reservedCount = Math.max(db.reservedCount - 1, 0);
      }
      if (!run.budgetReleased) {
        run.budgetReleased = true;
        db.tokensReserved = Math.max(db.tokensReserved - run.tokenBudget, 0);
      }
    },
  };
}

export function makeMeaningfulRun(db: FakeCloudDatabase, runId: string): CloudRunRecord {
  return db.getRun(runId);
}

export function stableJson(value: unknown): string {
  return stableStringify(value);
}
