/**
 * One manual workout sync run.
 *
 * Sequence: gate on a signed-in token and a configured client, read both
 * sides, compute the pure plan, insert remote-only records locally, then push
 * local-only records to the cloud. Every write is attempted at most once:
 * there is no retry loop, and a failed write stops later writes instead of
 * replaying an ambiguous submit.
 *
 * Conflicts are first-class results, not failures. A record is never updated
 * on either side, so the cloud original always stays intact and the device
 * copy always stays intact. A server-side 409 on push is paired with a fresh
 * cloud read so the UI can still show both originals; that read is not a
 * write retry.
 *
 * Tokens travel only inside the injected client's request path. This module
 * receives a token solely to fail closed when it is missing, never stores it,
 * and never logs it or any workout content.
 */

import { stableStringify } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import {
  abortSyncRun,
  beginSyncRun,
  completeSyncRun,
  recordPulledRecord,
  recordPushedRecord,
  recordSyncConflict,
  recordSyncFailure,
  type SyncRunAccumulator,
  type SyncRunResult,
} from "./syncApplyModel.ts";
import { classifySyncFailure, planSync } from "./syncModel.ts";
import type { SyncFailureKind, SyncPlan } from "./syncModel.ts";
import type { SyncConfig } from "./syncConfig.ts";

/** Outcome of one cloud create; mirrors the client without importing Expo. */
export type SyncRemoteCreateOutcome = "created" | "duplicate";

/** The subset of `WorkoutRepository` the runner needs. */
export interface SyncRunRepository {
  listWorkouts(): Promise<WorkoutRecord[]>;
  saveWorkout(record: WorkoutRecord): Promise<{ created: boolean }>;
  getWorkout(id: string): Promise<WorkoutRecord | null>;
}

/** The subset of `WorkoutSyncClient` the runner needs. */
export interface SyncRunRemoteClient {
  readonly config: SyncConfig;
  listRemoteWorkouts(): Promise<WorkoutRecord[]>;
  createRemoteWorkout(record: WorkoutRecord): Promise<SyncRemoteCreateOutcome>;
}

export interface RunWorkoutSyncOptions {
  repository: SyncRunRepository;
  client: SyncRunRemoteClient;
  /** Current access token; a blank/missing value aborts before any read. */
  accessToken: string | null | undefined;
}

function hasAccessToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.trim() !== "";
}

/** Any network failure is a preflight abort; other read failures are too. */
function abortForFailure(failure: SyncFailureKind): SyncRunResult {
  return abortSyncRun(failure, failure === "offline" ? "offline" : null);
}

function sameRecord(a: WorkoutRecord, b: WorkoutRecord): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Pair a push-time 409 with the current cloud original.
 *
 * The id was local-only when the plan was computed, so the remote record is
 * not in the first list. One extra read finds it; a record that is now
 * identical is a race, not a conflict.
 */
async function collectPushConflicts(
  client: SyncRunRemoteClient,
  localOnly: readonly WorkoutRecord[],
  state: SyncRunAccumulator,
): Promise<SyncRunAccumulator> {
  let refreshed: WorkoutRecord[];
  try {
    refreshed = await client.listRemoteWorkouts();
  } catch (error) {
    return recordSyncFailure(state, classifySyncFailure(error));
  }

  const remoteById = new Map<string, WorkoutRecord>();
  for (const record of refreshed) {
    if (!remoteById.has(record.id)) remoteById.set(record.id, record);
  }

  let next = state;
  for (const localRecord of localOnly) {
    const remoteRecord = remoteById.get(localRecord.id);
    if (remoteRecord === undefined) {
      // A 409 with no visible cloud record cannot be presented safely with
      // both originals; report the classified failure instead of inventing one.
      next = recordSyncFailure(next, "conflict");
      continue;
    }
    if (sameRecord(localRecord, remoteRecord)) {
      next = recordPushedRecord(next);
      continue;
    }
    next = recordSyncConflict(next, {
      id: localRecord.id,
      local: localRecord,
      remote: remoteRecord,
    });
  }
  return next;
}

/**
 * Run one optional, user-initiated sync.
 *
 * Returns a structured result for every expected outcome and never throws for
 * a network/storage/conflict failure. Preflight aborts perform no reads and no
 * writes; a mid-run failure stops further writes and reports what completed.
 */
export async function runWorkoutSync(
  options: RunWorkoutSyncOptions,
): Promise<SyncRunResult> {
  if (!hasAccessToken(options.accessToken)) {
    return abortSyncRun("auth", "unauthenticated");
  }
  if (options.client.config.status !== "configured") {
    return abortSyncRun("other", "unconfigured");
  }

  let local: WorkoutRecord[];
  let remote: WorkoutRecord[];
  try {
    [local, remote] = await Promise.all([
      options.repository.listWorkouts(),
      options.client.listRemoteWorkouts(),
    ]);
  } catch (error) {
    // Both reads start together, but neither has written anything yet.
    return abortForFailure(classifySyncFailure(error));
  }

  let plan: SyncPlan;
  try {
    plan = planSync(local, remote);
  } catch {
    // Inconsistent input lists are a data-integrity problem, not a network one.
    return abortSyncRun("other");
  }

  let state = beginSyncRun(plan);

  // Remote → device. The repository never overwrites; a CONFLICT here is a
  // concurrent local record and is surfaced with both originals.
  for (const record of plan.toInsertLocal) {
    try {
      await options.repository.saveWorkout(record);
      state = recordPulledRecord(state);
    } catch (error) {
      if (classifySyncFailure(error) !== "conflict") {
        state = recordSyncFailure(state, classifySyncFailure(error));
        return completeSyncRun(state);
      }
      let existing: WorkoutRecord | null = null;
      try {
        existing = await options.repository.getWorkout(record.id);
      } catch {
        existing = null;
      }
      if (existing === null) {
        state = recordSyncFailure(state, "conflict");
        return completeSyncRun(state);
      }
      if (sameRecord(existing, record)) {
        state = recordPulledRecord(state);
        continue;
      }
      state = recordSyncConflict(state, {
        id: record.id,
        local: existing,
        remote: record,
      });
    }
  }

  // Device → cloud. A 409 is collected for one pairing read after the loop so
  // unrelated local-only records are still pushed once each.
  const pushConflicts: WorkoutRecord[] = [];
  for (const record of plan.toPush) {
    try {
      await options.client.createRemoteWorkout(record);
      state = recordPushedRecord(state);
    } catch (error) {
      if (classifySyncFailure(error) === "conflict") {
        pushConflicts.push(record);
        continue;
      }
      state = recordSyncFailure(state, classifySyncFailure(error));
      return completeSyncRun(state);
    }
  }

  if (pushConflicts.length > 0) {
    state = await collectPushConflicts(options.client, pushConflicts, state);
  }

  return completeSyncRun(state);
}
