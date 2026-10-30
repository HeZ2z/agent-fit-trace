/**
 * Bounded outbox worker for durable cloud coaching runs.
 *
 * Invariants:
 * - a generation fence gates the provider-call marker, every event, usage
 *   settlement, and the terminal write;
 * - the durable pre-fetch authorization runs immediately before EVERY provider
 *   request, so a cancellation or expired lease stops further paid calls;
 * - `provider_fetch_started_at` is written before the first real fetch. A run
 *   with that marker but no recorded outcome is `unconfirmed` and is never
 *   redispatched or refunded automatically;
 * - cancellation after a fetch is never reported as a clean `cancelled`; it is
 *   `unconfirmed`, with the reservation retained;
 * - usage is settled at most once and only by the current lease generation;
 * - the worker claims ONE job per tick. Sequential batch processing would let a
 *   later job's lease expire before it is dispatched.
 */
import { CLOUD_ERROR_CODES } from "@agent-fit-trace/api-contracts";
import type { CloudCoachingProvider } from "./openRouterProvider.ts";
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
  CloudOutboxJob,
  CloudTerminal,
  CloudUsage,
  CloudWorkerRepository,
} from "./repository.ts";
import { CloudError } from "./repository.ts";

export interface CloudOutboxWorkerOptions {
  repository: CloudWorkerRepository;
  provider: CloudCoachingProvider;
  /** Global kill switch. False means the worker claims nothing. */
  enabled: boolean;
  workerId: string;
  leaseMs: number;
  batch: number;
  logger?: (event: string, details?: Record<string, unknown>) => void;
}

export interface CloudWorkerTickResult {
  disabled: boolean;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  unconfirmed: number;
}

export interface CloudOutboxWorker {
  tick(): Promise<CloudWorkerTickResult>;
}

const ZERO_USAGE: CloudUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function safeReason(reason: unknown, fallback: string): string {
  return typeof reason === "string" && reason.trim() !== "" ? reason : fallback;
}

function hasUsage(usage: CloudUsage): boolean {
  return (
    (usage.knownTokens ?? (usage.known === false ? 0 : usage.totalTokens)) > 0 ||
    (usage.known !== false &&
      (usage.promptTokens > 0 || usage.completionTokens > 0 || usage.totalTokens > 0))
  );
}

/** Authoritative tokens that may be charged now; estimates are excluded. */
function settleableUsage(usage: CloudUsage): CloudUsage | null {
  const knownTokens = usage.knownTokens ?? (usage.known === false ? 0 : usage.totalTokens);
  if (knownTokens <= 0) return null;
  const complete = usage.known !== false && usage.complete !== false;
  return {
    promptTokens: usage.knownPromptTokens ?? (usage.known === false ? knownTokens : usage.promptTokens),
    completionTokens:
      usage.knownCompletionTokens ?? (usage.known === false ? 0 : usage.completionTokens),
    totalTokens: knownTokens,
    known: true,
    knownTokens,
    complete,
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(usage.generationId === undefined ? {} : { generationId: usage.generationId }),
  };
}

export function createCloudOutboxWorker(options: CloudOutboxWorkerOptions): CloudOutboxWorker {
  const logger = options.logger ?? (() => undefined);

  async function settle(runId: string, generation: number, usage: CloudUsage): Promise<void> {
    const charge = settleableUsage(usage);
    if (charge === null) {
      // Never write estimated tokens as an actual charge. The run can still
      // terminate; the full reservation remains explicitly accounting-pending.
      logger("usage-accounting-pending", { runId });
      return;
    }
    if (charge.complete === false) {
      logger("usage-accounting-partial", { runId });
    }
    const result = await options.repository.settleUsage(runId, generation, charge);
    if (!result.settled) logger("usage-already-settled", { runId });
  }

  async function terminalForCrashWindow(job: CloudOutboxJob): Promise<void> {
    // A fetch may have been accepted. Never resubmit, never refund, and never
    // pretend the provider is known to have stopped.
    await options.repository.terminateRun(job.run.id, job.leaseGeneration, {
      status: "unconfirmed",
      failure: {
        code: CLOUD_ERROR_CODES.EXECUTION_UNCONFIRMED,
        message: "Provider acceptance is unconfirmed; the run will not be automatically re-dispatched.",
      },
      terminationConfirmed: false,
      releaseReservation: false,
    });
  }

  async function cancelWithoutDispatch(job: CloudOutboxJob): Promise<void> {
    await options.repository.terminateRun(job.run.id, job.leaseGeneration, {
      status: "cancelled",
      reason: safeReason(job.run.cancelReason, "cancel requested"),
      terminationConfirmed: true,
      // No actual provider fetch happened: this is proven-not-accepted.
      releaseReservation: true,
      provenNotAccepted: true,
    });
  }

  async function terminateRefusedBeforeDispatch(
    job: CloudOutboxJob,
    error: ProviderStepRefusedError,
  ): Promise<void> {
    const code =
      error.reason === "global-disabled"
        ? CLOUD_ERROR_CODES.KILL_SWITCH
        : error.reason === "quota-exhausted" ||
            error.reason === "quota-not-configured" ||
            error.reason === "budget-not-configured" ||
            error.reason === "step-budget-exceeded" ||
            error.reason === "token-budget-exhausted" ||
            error.reason === "request-budget-exhausted" ||
            error.reason === "invalid-step-budget"
          ? CLOUD_ERROR_CODES.QUOTA_EXHAUSTED
          : CLOUD_ERROR_CODES.ACCOUNT_NOT_FORMAL;
    await options.repository.terminateRun(job.run.id, job.leaseGeneration, {
      status: "failed",
      reason: `provider step refused: ${error.reason}`,
      failure: { code, message: "The cloud coaching account or quota no longer permits provider work." },
      terminationConfirmed: true,
      releaseReservation: true,
      provenNotAccepted: true,
    });
  }

  async function processJob(job: CloudOutboxJob): Promise<CloudTerminal["status"]> {
    const run = job.run;
    const generation = job.leaseGeneration;

    if (run.providerFetchStartedAt !== undefined || run.providerAcceptedAt !== undefined) {
      // Defensive: this should already have been reaped as unconfirmed.
      await terminalForCrashWindow(job);
      return "unconfirmed";
    }

    if (run.cancelRequestedAt !== undefined || run.status === "cancelling") {
      await cancelWithoutDispatch(job);
      return "cancelled";
    }

    const start = await options.repository.markProviderCallStarted(run.id, generation);
    if (start.terminal) {
      logger("run-terminal-before-call", { runId: run.id });
      return "failed";
    }
    if (start.cancelled) {
      // No fetch happened in this attempt; cancellation is provable.
      await cancelWithoutDispatch(job);
      return "cancelled";
    }
    if (!start.started) {
      // A marker appeared between claim and mark: acceptance is unknown.
      await terminalForCrashWindow(job);
      return "unconfirmed";
    }

    let usage: CloudUsage = ZERO_USAGE;
    let generationId: string | undefined;
    try {
      const result = await options.provider.run({
        runId: run.id,
        prompt: run.prompt,
        ...(run.conversationContext === undefined ? {} : { conversationContext: run.conversationContext }),
        records: run.snapshotRecords,
        async beforeProviderRequest(budget) {
          const authorization = await options.repository.authorizeProviderStep(
            run.id,
            generation,
            budget ?? { tokens: 1, requests: 1 },
          );
          return {
            allowed: authorization.allowed,
            cancelled: authorization.cancelled,
            terminal: authorization.terminal,
            ...(authorization.reason === undefined ? {} : { reason: authorization.reason }),
          };
        },
        async onAccepted(info) {
          generationId = info.generationId ?? generationId;
          if (info.usage !== undefined) usage = info.usage;
          await options.repository.markProviderAccepted(run.id, generation, {
            ...(info.generationId === undefined ? {} : { generationId: info.generationId }),
            ...(info.usage === undefined ? {} : { usage: info.usage }),
          });
        },
        async onEvent(payload) {
          await options.repository.appendEvent(run.id, generation, payload);
        },
      });
      usage = result.usage;
      generationId = result.generationId ?? generationId;
      await settle(run.id, generation, {
        ...usage,
        ...(generationId === undefined ? {} : { generationId }),
      });
      const terminal = await options.repository.terminateRun(run.id, generation, {
        status: "completed",
        reason: "analysis complete",
        terminationConfirmed: true,
        releaseReservation: true,
      });
      return terminal.run.status === "unconfirmed"
        ? "unconfirmed"
        : terminal.run.status === "cancelled"
          ? "cancelled"
          : "completed";
    } catch (error) {
      if (error instanceof CloudError && error.code === CLOUD_ERROR_CODES.LEASE_LOST) {
        // The run is not ours to write. Do not settle or terminate; the next
        // claim/reaper handles it under a new generation.
        logger("lease-lost", { runId: run.id });
        throw error;
      }
      if (error instanceof ProviderOwnershipLostError) {
        // Terminal or fenced by another generation. No write from this worker.
        logger("lease-lost", { runId: run.id, reason: "provider-ownership" });
        return "failed";
      }
      if (error instanceof ProviderCancelledError) {
        if (!error.dispatched) {
          await cancelWithoutDispatch(job);
          return "cancelled";
        }
        // A provider call happened; cancellation cannot prove the provider
        // stopped or whether it billed. Settle known usage, then report
        // `unconfirmed` and retain the reservation.
        if (hasUsage(error.usage)) {
          await settle(run.id, generation, {
            ...error.usage,
            ...(error.generationId === undefined ? {} : { generationId: error.generationId }),
          });
        }
        await terminalForCrashWindow(job);
        return "unconfirmed";
      }
      if (error instanceof ProviderStepRefusedError) {
        if (!error.dispatched) {
          await terminateRefusedBeforeDispatch(job, error);
          return "failed";
        }
        if (hasUsage(error.usage)) {
          await settle(run.id, generation, {
            ...error.usage,
            ...(error.generationId === undefined ? {} : { generationId: error.generationId }),
          });
        }
        await terminalForCrashWindow(job);
        return "unconfirmed";
      }
      if (error instanceof ProviderNotAcceptedError) {
        if (error.accepted) {
          // A 4xx on a later step cannot refund the earlier accepted request.
          // Settle its known usage and retain the reservation.
          if (error.usage !== undefined) {
            await settle(run.id, generation, {
              ...error.usage,
              ...(error.generationId === undefined ? {} : { generationId: error.generationId }),
            });
          }
          const cancelled = run.cancelRequestedAt !== undefined;
          const terminal = await options.repository.terminateRun(run.id, generation, {
            status: cancelled ? "cancelled" : "failed",
            reason: cancelled
              ? "cancel requested"
              : "provider rejected a later step after accepting the run",
            failure: cancelled
              ? undefined
              : {
                  code: CLOUD_ERROR_CODES.PROVIDER_NOT_ACCEPTED,
                  message: "The provider rejected a later step after accepting the run.",
                },
            terminationConfirmed: true,
            releaseReservation: false,
            provenNotAccepted: false,
          });
          return terminal.run.status === "unconfirmed"
            ? "unconfirmed"
            : terminal.run.status === "cancelled"
              ? "cancelled"
              : "failed";
        }
        // A definitive first-request 4xx proves no generation was billed.
        const cancelled = run.cancelRequestedAt !== undefined;
        const terminal = await options.repository.terminateRun(run.id, generation, {
          status: cancelled ? "cancelled" : "failed",
          reason: cancelled ? "cancel requested" : "provider did not accept the request",
          failure: cancelled
            ? undefined
            : {
                code: CLOUD_ERROR_CODES.PROVIDER_NOT_ACCEPTED,
                message: "The provider did not accept the request.",
              },
          terminationConfirmed: true,
          releaseReservation: true,
          provenNotAccepted: true,
        });
        return terminal.run.status === "cancelled" ? "cancelled" : "failed";
      }
      if (error instanceof ProviderAcceptanceUnknownError) {
        // Acceptance is unknown, but any authoritative usage already returned
        // by earlier steps must still be charged. A dispatched step without a
        // usable response may also have been billed, so mark the carried usage
        // incomplete: settlement charges only the known part and retains the
        // rest of the allocation instead of refunding it.
        if (error.usage !== undefined) {
          await settle(run.id, generation, {
            ...error.usage,
            complete: false,
            ...(error.generationId === undefined ? {} : { generationId: error.generationId }),
          });
        }
        await terminalForCrashWindow(job);
        return "unconfirmed";
      }
      if (error instanceof ProviderToolRefusedError || error instanceof ProviderRunFailedError) {
        // The provider accepted at least one request, so usage is billed. Never
        // refund this reservation; settlement is fenced by the same generation.
        await settle(run.id, generation, {
          ...error.usage,
          ...(error.generationId === undefined ? {} : { generationId: error.generationId }),
        });
        const terminal = await options.repository.terminateRun(run.id, generation, {
          status: run.cancelRequestedAt === undefined ? "failed" : "cancelled",
          reason:
            run.cancelRequestedAt === undefined
              ? `provider run failed: ${error.code}`
              : "cancel requested",
          failure:
            run.cancelRequestedAt === undefined
              ? { code: error.code, message: "The provider run did not produce an accepted analysis." }
              : undefined,
          terminationConfirmed: run.cancelRequestedAt === undefined,
          releaseReservation: false,
          provenNotAccepted: false,
        });
        return terminal.run.status === "unconfirmed"
          ? "unconfirmed"
          : terminal.run.status === "cancelled"
            ? "cancelled"
            : "failed";
      }

      // Unknown storage/provider shape after the call marker: acceptance is
      // unproven, so the run is unconfirmed and the reservation is retained.
      logger("run-unconfirmed", {
        runId: run.id,
        error: error instanceof Error ? error.name : "unknown",
      });
      await terminalForCrashWindow(job);
      return "unconfirmed";
    }
  }

  return {
    async tick(): Promise<CloudWorkerTickResult> {
      if (!options.enabled) {
        return { disabled: true, claimed: 0, completed: 0, failed: 0, cancelled: 0, unconfirmed: 0 };
      }
      // Claim ONE job. Processing a batch sequentially can let later leases
      // expire before their first provider request.
      const jobs = await options.repository.claimOutbox(options.workerId, options.leaseMs, 1);
      const result: CloudWorkerTickResult = {
        disabled: false,
        claimed: jobs.length,
        completed: 0,
        failed: 0,
        cancelled: 0,
        unconfirmed: 0,
      };
      for (const job of jobs) {
        try {
          const status = await processJob(job);
          result[status] += 1;
        } catch (error) {
          // Lease fencing/storage failures are never retried inside the same
          // tick; the next claim will reap or reclaim under a new generation.
          logger("job-error", {
            runId: job.run.id,
            error: error instanceof Error ? error.name : "unknown",
          });
          result.failed += 1;
        }
      }
      return result;
    },
  };
}

export interface SleepOptions {
  /**
   * Unref the timer so it never holds the process open (default true). The
   * standalone worker loop opts out because, between empty ticks, its polling
   * timer is the only handle keeping the process alive.
   */
  unref?: boolean;
}

/** Sleep helper. Default timers are unref'd; callers that must keep the loop alive opt in. */
export function sleep(ms: number, signal?: AbortSignal, options: SleepOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (options.unref !== false && typeof timer.unref === "function") timer.unref();
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CloudWorkerLoopOptions {
  tick(): Promise<CloudWorkerTickResult>;
  pollMs: number;
  signal: AbortSignal;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

/**
 * Standalone-worker poll loop. The timer between ticks stays referenced: after
 * an empty tick there may be no HTTP/socket handle left, and an unref'd timer
 * would let the process exit instead of polling again.
 */
export async function runCloudWorkerLoop(options: CloudWorkerLoopOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  while (!options.signal.aborted) {
    try {
      const result = await options.tick();
      if (result.claimed > 0) log("tick", { ...result });
    } catch (error) {
      log("tick-error", { error: error instanceof Error ? error.name : "unknown" });
    }
    if (options.signal.aborted) break;
    try {
      await sleep(options.pollMs, options.signal, { unref: false });
    } catch {
      break;
    }
  }
}

export function safeWorkerReason(reason: unknown, fallback: string): string {
  return safeReason(reason, fallback);
}
