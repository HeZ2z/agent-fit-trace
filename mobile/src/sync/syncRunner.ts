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
 * An access token alone is not enough to identify the run's owner: the app
 * session can switch accounts while a request is pending. The caller pins the
 * originating user id and access token, binds that token to the client, and
 * supplies the live identity. The runner compares the two before every write
 * and stops with an `auth` failure rather than writing to whoever is signed in
 * now. Tokens travel only inside the injected client's request path; this
 * module never stores, logs, or includes one in a result.
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
  /**
   * Remote client for this run. The caller binds it to
   * `account.accessToken` (see `WorkoutSyncClient.withAccessToken`) so no
   * request can resolve a newer session token mid-run.
   */
  client: SyncRunRemoteClient;
  /** Account identity pinned when the user started this run. */
  account: SyncRunAccount;
  /**
   * Live identity for the screen that started the run. It is compared with
   * {@link RunWorkoutSyncOptions.account} before every write; a sign-out,
   * account switch, token change, or screen unmount stops the run with an
   * `auth` failure instead of writing under stale or foreign credentials.
   */
  getCurrentAccount: () => SyncRunAccount | Promise<SyncRunAccount>;
}

/** User id and access token pinned for one sync run. */
export interface SyncRunAccount {
  /** Signed-in user id; missing/blank fails closed before any read. */
  readonly userId: string | null | undefined;
  /** Access token; missing/blank fails closed before any read. */
  readonly accessToken: string | null | undefined;
}

function hasAccessToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.trim() !== "";
}

function hasAccountId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.trim() !== "";
}

/** True only when the live identity is still exactly the pinned identity. */
function sameAccount(pinned: SyncRunAccount, current: SyncRunAccount): boolean {
  return (
    hasAccountId(pinned.userId) &&
    current.userId === pinned.userId &&
    hasAccessToken(pinned.accessToken) &&
    current.accessToken === pinned.accessToken
  );
}

/**
 * Stop the run if the account/token it started under is no longer current.
 *
 * Returns `null` when the next write may proceed, or the state with an `auth`
 * failure when the live identity changed or could not be read. It is checked
 * immediately before every write, so an in-flight request finishes under the
 * pinned token while no later request is issued.
 */
async function stopIfAccountChanged(
  options: RunWorkoutSyncOptions,
  state: SyncRunAccumulator,
): Promise<SyncRunAccumulator | null> {
  let current: SyncRunAccount;
  try {
    current = await options.getCurrentAccount();
  } catch {
    return recordSyncFailure(state, "auth");
  }
  return sameAccount(options.account, current) ? null : recordSyncFailure(state, "auth");
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
  if (
    !hasAccountId(options.account.userId) ||
    !hasAccessToken(options.account.accessToken)
  ) {
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
    const stopped = await stopIfAccountChanged(options, state);
    if (stopped !== null) return completeSyncRun(stopped);
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
  // unrelated local-only records are still pushed once each. A later failure
  // or an account change stops new uploads but still runs that pairing read, so
  // conflicts already found are returned instead of disappearing with the run.
  const pushConflicts: WorkoutRecord[] = [];
  for (const record of plan.toPush) {
    const stopped = await stopIfAccountChanged(options, state);
    if (stopped !== null) {
      state = stopped;
      break;
    }
    try {
      await options.client.createRemoteWorkout(record);
      state = recordPushedRecord(state);
    } catch (error) {
      if (classifySyncFailure(error) === "conflict") {
        pushConflicts.push(record);
        continue;
      }
      state = recordSyncFailure(state, classifySyncFailure(error));
      break;
    }
  }

  if (pushConflicts.length > 0) {
    state = await collectPushConflicts(options.client, pushConflicts, state);
  }

  return completeSyncRun(state);
}
