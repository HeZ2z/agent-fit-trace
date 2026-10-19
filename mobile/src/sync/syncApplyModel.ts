/**
 * Pure apply/result model for one manual workout sync run.
 *
 * The runner owns network and SQLite I/O; this module owns what a completed
 * step means: how plan results become run counts, how a newly discovered
 * conflict is merged without duplication, how a failure is recorded, and what
 * each of the three user-visible conflict choices is allowed to do.
 *
 * Nothing here writes, deletes, uploads or mutates its inputs. The runner
 * folds steps through these functions, and the sync screen folds conflict
 * acknowledgements through {@link acknowledgeSyncConflict}.
 */

import { stableStringify } from "@pi-fit-trace/core";
import type { SyncConflict, SyncFailureKind, SyncPlan } from "./syncModel.ts";

/** Counts shown in the sync summary. Failed attempts are reported separately. */
export interface SyncRunCounts {
  /** Local-only records the cloud accepted (created or already identical). */
  readonly pushed: number;
  /** Remote-only records applied to the device (inserted or already identical). */
  readonly pulled: number;
  /** Ids already identical on both sides when the run was planned. */
  readonly identical: number;
  /** Same-id/different-content pairs that need an explicit choice. */
  readonly conflicts: number;
}

/** A run either completes, fails part-way, or is stopped before any write. */
export type SyncRunStatus = "done" | "failed" | "aborted";

/**
 * Preflight reasons that stop a run before a single write. A mid-run network
 * failure is reported through `failure` instead, because a pull may already
 * have happened.
 */
export type SyncRunAbortReason = "unauthenticated" | "unconfigured" | "offline";

/** Structured outcome of one manual sync attempt. */
export interface SyncRunResult {
  readonly status: SyncRunStatus;
  /** Classified failure, or `null` when the run completed. */
  readonly failure: SyncFailureKind | null;
  /** Set only when the run was stopped before applying anything. */
  readonly abortReason: SyncRunAbortReason | null;
  readonly counts: SyncRunCounts;
  /** Unresolved conflicts, ascending by id. */
  readonly conflicts: readonly SyncConflict[];
}

/**
 * In-progress accumulator. `failure` is the first classified failure; the
 * runner stops issuing further writes after recording one.
 */
export interface SyncRunAccumulator {
  readonly pushed: number;
  readonly pulled: number;
  readonly identical: number;
  readonly conflicts: readonly SyncConflict[];
  readonly failure: SyncFailureKind | null;
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Start a run from a computed plan; the plan itself is copied, never mutated. */
export function beginSyncRun(plan: SyncPlan): SyncRunAccumulator {
  return {
    pushed: 0,
    pulled: 0,
    identical: plan.identical,
    conflicts: [...plan.conflicts],
    failure: null,
  };
}

/** A remote-only record is now present locally (inserted or identical no-op). */
export function recordPulledRecord(state: SyncRunAccumulator): SyncRunAccumulator {
  return { ...state, pulled: state.pulled + 1 };
}

/** A local-only record is now present in the cloud (created or identical no-op). */
export function recordPushedRecord(state: SyncRunAccumulator): SyncRunAccumulator {
  return { ...state, pushed: state.pushed + 1 };
}

/**
 * Add one conflict discovered while applying the plan. Duplicate ids collapse
 * to the first pair, and the list stays ascending by id for a stable UI.
 */
export function recordSyncConflict(
  state: SyncRunAccumulator,
  conflict: SyncConflict,
): SyncRunAccumulator {
  if (state.conflicts.some((entry) => entry.id === conflict.id)) return state;
  const conflicts = [...state.conflicts, conflict].sort((a, b) =>
    compareIds(a.id, b.id),
  );
  return { ...state, conflicts };
}

/** Record the first classified failure; keeping the first is deterministic. */
export function recordSyncFailure(
  state: SyncRunAccumulator,
  failure: SyncFailureKind,
): SyncRunAccumulator {
  if (state.failure !== null) return state;
  return { ...state, failure };
}

/** Close a run that was allowed to touch storage or network. */
export function completeSyncRun(state: SyncRunAccumulator): SyncRunResult {
  return {
    status: state.failure === null ? "done" : "failed",
    failure: state.failure,
    abortReason: null,
    counts: {
      pushed: state.pushed,
      pulled: state.pulled,
      identical: state.identical,
      conflicts: state.conflicts.length,
    },
    conflicts: state.conflicts,
  };
}

/**
 * Close a run that stopped before any write (missing sign-in, missing config,
 * or the initial read failed). Counts stay zero so the UI cannot imply a
 * partial sync happened.
 */
export function abortSyncRun(
  failure: SyncFailureKind,
  abortReason: SyncRunAbortReason | null = null,
): SyncRunResult {
  return {
    status: "aborted",
    failure,
    abortReason,
    counts: { pushed: 0, pulled: 0, identical: 0, conflicts: 0 },
    conflicts: [],
  };
}

/** The three explicit choices offered for every conflict. */
export const SYNC_CONFLICT_ACTIONS = [
  "keep-cloud",
  "keep-local",
  "export-local",
] as const;

export type SyncConflictAction = (typeof SYNC_CONFLICT_ACTIONS)[number];

/**
 * What a conflict choice may do. Every decision in this slice is device-only:
 * nothing is uploaded, nothing is deleted, and no side can overwrite the
 * other. `export-local` additionally shares the local record as JSON.
 */
export interface SyncConflictDecision {
  readonly action: SyncConflictAction;
  readonly uploadsLocal: false;
  readonly deletesLocal: false;
  readonly localDisposition: "device-only";
  readonly sharesLocal: boolean;
}

/** Describe one user choice; this is the only place its powers are defined. */
export function decideSyncConflict(action: SyncConflictAction): SyncConflictDecision {
  switch (action) {
    case "keep-cloud":
      return {
        action,
        uploadsLocal: false,
        deletesLocal: false,
        localDisposition: "device-only",
        sharesLocal: false,
      };
    case "keep-local":
      return {
        action,
        uploadsLocal: false,
        deletesLocal: false,
        localDisposition: "device-only",
        sharesLocal: false,
      };
    case "export-local":
      return {
        action,
        uploadsLocal: false,
        deletesLocal: false,
        localDisposition: "device-only",
        sharesLocal: true,
      };
  }
}

/**
 * Drop one acknowledged conflict from the current result only.
 *
 * Persistence is deliberately absent: the local record stays immutable, so the
 * next manual sync plans the same conflict again. An unknown or already
 * acknowledged id returns the same result object.
 */
export function acknowledgeSyncConflict(result: SyncRunResult, id: string): SyncRunResult {
  const conflicts = result.conflicts.filter((conflict) => conflict.id !== id);
  if (conflicts.length === result.conflicts.length) return result;
  return {
    ...result,
    conflicts,
    counts: { ...result.counts, conflicts: conflicts.length },
  };
}

/**
 * Canonical JSON of the local side for the Export local action. English data
 * stays canonical; the surrounding share message is translated by the screen.
 */
export function conflictExportJson(conflict: SyncConflict): string {
  return stableStringify(conflict.local);
}
