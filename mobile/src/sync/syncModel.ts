/**
 * Pure sync-plan and failure-classification model for the mobile app.
 *
 * This module imports no React, Expo, DOM, clock or fetch value. The plan is
 * computed from two already-loaded lists of validated workout records and the
 * UI decides what to do with it; this module never writes to either side.
 *
 * Conflict rule (see `docs/api-contract.md`): an id that exists on both sides
 * with different canonical content is never overwritten. The UI may later
 * offer keep-cloud / keep-local-only / export-local, all of which are outside
 * this pure model.
 */

import { API_ERROR_CODES } from "@agent-fit-trace/api-contracts";
import { stableStringify, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import type { AuthStatus } from "../auth/authModel.ts";
import type { SyncConfigStatus } from "./syncConfig.ts";

/** One same-id/different-content pair; both originals are preserved. */
export interface SyncConflict {
  readonly id: string;
  readonly local: WorkoutRecord;
  readonly remote: WorkoutRecord;
}

/** Counts the sync UI needs for its summary row. */
export interface SyncPlanSummary {
  /** Local records the cloud does not have yet. */
  readonly toPush: number;
  /** Cloud records this device does not have yet. */
  readonly toInsertLocal: number;
  /** Ids present on both sides with identical canonical content. */
  readonly identical: number;
  /** Same id, different canonical content; never auto-resolved. */
  readonly conflicts: number;
  /** Distinct workout ids across both lists. */
  readonly total: number;
}

/** Deterministic, write-free description of what an optional sync would do. */
export interface SyncPlan {
  /** Local records absent remotely, ascending by id (never includes conflicts). */
  readonly toPush: WorkoutRecord[];
  /** Remote records absent locally, ascending by id. */
  readonly toInsertLocal: WorkoutRecord[];
  /** Number of ids present on both sides with identical canonical content. */
  readonly identical: number;
  /** Same-id/different-content pairs, ascending by id. */
  readonly conflicts: SyncConflict[];
  readonly summary: SyncPlanSummary;
}

/** UI-facing failure buckets; the i18n layer owns the actual copy. */
export type SyncFailureKind = "offline" | "auth" | "conflict" | "other";

/** A partial remote list is never safe to treat as a completed reconciliation. */
export class IncompleteRemoteWorkoutListError extends Error {
  readonly malformedCount: number;

  constructor(malformedCount: number) {
    super(`Remote workout list is incomplete (${malformedCount} invalid record${malformedCount === 1 ? "" : "s"}).`);
    this.name = "IncompleteRemoteWorkoutListError";
    this.malformedCount = malformedCount;
  }
}

/** Validate the complete collection or fail without returning a partial list. */
export function validateRemoteWorkoutList(
  data: unknown,
  onMalformed?: (notice: { index: number; reason: string }) => void,
): WorkoutRecord[] {
  if (!Array.isArray(data)) throw new TypeError("Remote workout list must be an array.");
  const records: WorkoutRecord[] = [];
  let malformedCount = 0;
  data.forEach((entry, index) => {
    try {
      records.push(validateWorkoutRecord(entry).record);
    } catch (error) {
      malformedCount += 1;
      onMalformed?.({
        index,
        reason: error instanceof Error ? error.message : "Workout record failed validation.",
      });
    }
  });
  if (malformedCount > 0) throw new IncompleteRemoteWorkoutListError(malformedCount);
  return records;
}

/** Ascending id order, independent of locale and input order. */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Index one side by id without mutating it.
 *
 * The local and cloud stores are append-only and idempotent, so two different
 * records under one id inside a single side is a broken input. Failing loudly
 * is safer than silently choosing one and produces a deterministic plan for
 * every valid input.
 */
function indexById(
  records: readonly WorkoutRecord[],
  side: "local" | "remote",
): Map<string, WorkoutRecord> {
  const byId = new Map<string, WorkoutRecord>();
  for (const record of records) {
    if (typeof record.id !== "string" || record.id.trim() === "") {
      throw new TypeError(`${side} workout records must have a non-empty id.`);
    }
    const existing = byId.get(record.id);
    if (existing !== undefined) {
      if (stableStringify(existing) !== stableStringify(record)) {
        throw new TypeError(`${side} contains two different records with id "${record.id}".`);
      }
      // An identical duplicate is already represented once.
      continue;
    }
    byId.set(record.id, record);
  }
  return byId;
}

/**
 * Plan an optional cloud sync.
 *
 * - `toPush` = local ids the cloud does not have.
 * - `toInsertLocal` = cloud ids this device does not have.
 * - `identical` = ids on both sides whose canonical content matches.
 * - `conflicts` = ids on both sides whose canonical content differs.
 *
 * Ordering is ascending by id for every list, so the plan is stable no matter
 * how either input list was sorted. Input arrays and records are never
 * mutated; returned entries reference the supplied records.
 */
export function planSync(
  local: readonly WorkoutRecord[],
  remote: readonly WorkoutRecord[],
): SyncPlan {
  const localById = indexById(local, "local");
  const remoteById = indexById(remote, "remote");

  const toPush: WorkoutRecord[] = [];
  const conflicts: SyncConflict[] = [];
  let identical = 0;

  for (const [id, localRecord] of localById) {
    const remoteRecord = remoteById.get(id);
    if (remoteRecord === undefined) {
      toPush.push(localRecord);
      continue;
    }
    if (stableStringify(localRecord) === stableStringify(remoteRecord)) {
      identical += 1;
      continue;
    }
    conflicts.push({ id, local: localRecord, remote: remoteRecord });
  }

  const toInsertLocal: WorkoutRecord[] = [];
  for (const [id, remoteRecord] of remoteById) {
    if (!localById.has(id)) toInsertLocal.push(remoteRecord);
  }

  toPush.sort((a, b) => compareIds(a.id, b.id));
  toInsertLocal.sort((a, b) => compareIds(a.id, b.id));
  conflicts.sort((a, b) => compareIds(a.id, b.id));

  const total = toPush.length + toInsertLocal.length + identical + conflicts.length;
  return {
    toPush,
    toInsertLocal,
    identical,
    conflicts,
    summary: {
      toPush: toPush.length,
      toInsertLocal: toInsertLocal.length,
      identical,
      conflicts: conflicts.length,
      total,
    },
  };
}

/** Map an HTTP status to the UI failure bucket. */
export function classifySyncStatus(status: number): SyncFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 409) return "conflict";
  return "other";
}

/**
 * Classify a thrown sync failure for UI messaging.
 *
 * Accepts the contract's typed errors (`ApiError`/`NetworkError`), a status
 * number, or any structurally similar thrown value. Order matters: an
 * explicit auth/conflict code wins over a malformed or inconsistent status,
 * then the status is used as a fallback (for example an unreadable 401 body).
 */
export function classifySyncFailure(error: unknown): SyncFailureKind {
  if (typeof error === "number") return classifySyncStatus(error);
  if (typeof error !== "object" || error === null) return "other";

  const shape = error as { code?: unknown; name?: unknown; status?: unknown };
  if (shape.code === API_ERROR_CODES.NETWORK_ERROR || shape.name === "NetworkError") {
    return "offline";
  }
  if (
    shape.code === API_ERROR_CODES.UNAUTHENTICATED ||
    shape.code === API_ERROR_CODES.FORBIDDEN
  ) {
    return "auth";
  }
  if (shape.code === API_ERROR_CODES.CONFLICT) return "conflict";
  if (typeof shape.status === "number") return classifySyncStatus(shape.status);
  return "other";
}

/**
 * True only when this build is configured for cloud sync and a verified
 * account session is available. Guests, loading/error auth states, missing
 * config and invalid config all fail closed.
 */
export function canSync(authStatus: AuthStatus, configStatus: SyncConfigStatus): boolean {
  return authStatus === "signed-in" && configStatus === "configured";
}
