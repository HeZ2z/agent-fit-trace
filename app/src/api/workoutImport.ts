import { stableStringify } from "@agent-fit-trace/core";
import type { ValidationWarning, WorkoutRecord } from "@agent-fit-trace/core";
import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import type {
  CreateWorkoutResult,
  FitTraceClient,
  WorkoutImportEntry,
} from "@agent-fit-trace/api-contracts";

/**
 * Sequential workout-backup restore coordinator.
 *
 * The file is parsed and fully validated before this module is reached. This
 * module only previews against current history and submits one record at a
 * time, so the UI can always report a receipt for every original file index.
 * There is deliberately no batch API and no rollback: a backup import is not
 * atomic, and deleting records to fake atomicity would violate append-only
 * history.
 */

export type WorkoutImportItemStatus =
  | "created"
  | "duplicate"
  | "conflict"
  | "failed"
  | "unknown"
  | "not_attempted";

export type WorkoutImportReadback = "present" | "absent" | "unavailable" | null;

export interface WorkoutImportReceiptItem {
  /** Zero-based index in the original backup file. */
  index: number;
  recordId: string;
  status: WorkoutImportItemStatus;
  readback: WorkoutImportReadback;
  error: string | null;
}

export interface WorkoutImportReceipt {
  items: WorkoutImportReceiptItem[];
  counts: Record<WorkoutImportItemStatus, number>;
  /** True when a conflict/failure/unknown stopped the remaining submissions. */
  stopped: boolean;
  cancelled: boolean;
  /** The owner/client changed while importing; the caller must drop the result. */
  invalidated: boolean;
}

export interface WorkoutImportPreview {
  entries: readonly WorkoutImportEntry[];
  warnings: ValidationWarning[];
  /** Number of unique ids that will be submitted (identical file repeats merged). */
  totalEntries: number;
  /** Number of source records including identical repeats. */
  totalIndexes: number;
  newIds: string[];
  duplicateIds: string[];
  conflictIds: string[];
  /** False when current history has a conflicting id; confirm must be blocked. */
  canConfirm: boolean;
}

export interface WorkoutImportRunOptions {
  client: FitTraceClient;
  entries: readonly WorkoutImportEntry[];
  /** Current history used to skip already-present identical records. */
  existing: readonly WorkoutRecord[];
  /** Re-checked before every write and after every async completion. */
  isCurrent?: () => boolean;
  /** Stops only records that have not been submitted yet. */
  isCancelled?: () => boolean;
}

function emptyCounts(): Record<WorkoutImportItemStatus, number> {
  return {
    created: 0,
    duplicate: 0,
    conflict: 0,
    failed: 0,
    unknown: 0,
    not_attempted: 0,
  };
}

function recordById(records: readonly WorkoutRecord[]): Map<string, WorkoutRecord> {
  return new Map(records.map((record) => [record.id, record]));
}

/**
 * Compare the parsed file with current history.
 *
 * Identical ids are duplicates (no write needed). The same id with different
 * canonical content is a conflict and blocks confirmation entirely. This
 * preflight is advisory: the per-record server idempotency/conflict contract
 * remains the authority at submit time.
 */
export function previewWorkoutImport(
  parsed: {
    entries: readonly WorkoutImportEntry[];
    warnings: readonly ValidationWarning[];
  },
  existing: readonly WorkoutRecord[],
): WorkoutImportPreview {
  const byId = recordById(existing);
  const newIds: string[] = [];
  const duplicateIds: string[] = [];
  const conflictIds: string[] = [];
  let totalIndexes = 0;

  for (const entry of parsed.entries) {
    totalIndexes += entry.indexes.length;
    const current = byId.get(entry.record.id);
    if (current === undefined) {
      newIds.push(entry.record.id);
    } else if (stableStringify(current) === stableStringify(entry.record)) {
      duplicateIds.push(entry.record.id);
    } else {
      conflictIds.push(entry.record.id);
    }
  }

  return {
    entries: parsed.entries,
    warnings: [...parsed.warnings],
    totalEntries: parsed.entries.length,
    totalIndexes,
    newIds,
    duplicateIds,
    conflictIds,
    // An empty backup is an explicit no-op, not a confirmable import.
    canConfirm: parsed.entries.length > 0 && conflictIds.length === 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Errors that prove the server rejected the write without applying it. */
function isDefiniteRejection(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.code === API_ERROR_CODES.CONFLICT) return true;
    if (
      error.code === API_ERROR_CODES.VALIDATION_ERROR ||
      error.code === API_ERROR_CODES.UNAUTHENTICATED ||
      error.code === API_ERROR_CODES.FORBIDDEN ||
      error.code === API_ERROR_CODES.NOT_FOUND
    ) {
      return true;
    }
    // MALFORMED_RESPONSE is deliberately never definite: the transport can
    // fail while decoding a response for a write the server already committed.
    // It is handled as ambiguous (read back and stop later submissions).
    if (error.code === API_ERROR_CODES.MALFORMED_RESPONSE) return false;
    if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      // 408/429 may be retried after the server already committed; be careful.
      return error.status !== 408 && error.status !== 429;
    }
  }
  return false;
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === API_ERROR_CODES.CONFLICT;
}

/**
 * Execute an already-previewed import sequentially (concurrency 1).
 *
 * Every original file index gets exactly one receipt item, including merged
 * identical duplicates and records never submitted because of cancel/stop.
 * A network failure or ambiguous server error is `unknown`; the coordinator
 * reads history back and only downgrades it to `duplicate` when the canonical
 * record is actually present. It never fabricates a `created` result.
 */
export async function runWorkoutImport(
  options: WorkoutImportRunOptions,
): Promise<WorkoutImportReceipt> {
  const { client, entries, existing } = options;
  const isCurrent = options.isCurrent ?? (() => true);
  const isCancelled = options.isCancelled ?? (() => false);
  const byId = recordById(existing);

  const receiptByIndex = new Map<number, WorkoutImportReceiptItem>();
  for (const entry of entries) {
    for (const index of entry.indexes) {
      receiptByIndex.set(index, {
        index,
        recordId: entry.record.id,
        status: "not_attempted",
        readback: null,
        error: null,
      });
    }
  }

  let stopped = false;
  let cancelled = false;
  let invalidated = false;

  const mark = (entry: WorkoutImportEntry, next: Partial<WorkoutImportReceiptItem>): void => {
    for (const index of entry.indexes) {
      const item = receiptByIndex.get(index);
      if (item !== undefined) Object.assign(item, next);
    }
  };

  /**
   * One write covers every merged index of an entry. The first index owns the
   * truthful outcome; the later indexes are the same already-present record,
   * so they are `duplicate` rather than additional fabricated creations.
   */
  const markCreated = (entry: WorkoutImportEntry): void => {
    entry.indexes.forEach((index, position) => {
      const item = receiptByIndex.get(index);
      if (item === undefined) return;
      Object.assign(item, {
        status: position === 0 ? "created" : "duplicate",
        readback: null,
        error: null,
      });
    });
  };

  /**
   * Resolve a write whose outcome is ambiguous. The server may have committed
   * before the transport failed or returned an untrustworthy response. Read
   * the canonical record back; never fabricate `created` from an unknown.
   */
  const resolveAmbiguous = async (
    entry: WorkoutImportEntry,
    reason: string,
  ): Promise<"stop" | "invalidated"> => {
    let readback: WorkoutImportReadback = "unavailable";
    try {
      const loaded = await client.listWorkouts();
      if (!isCurrent()) return "invalidated";
      const found = loaded.find((record) => record.id === entry.record.id);
      if (found === undefined) {
        readback = "absent";
      } else if (stableStringify(found) === stableStringify(entry.record)) {
        // The ambiguous write did commit. Report the truthful outcome and
        // still stop: the user should review the batch before submitting more.
        mark(entry, { status: "duplicate", readback: "present" });
        stopped = true;
        return "stop";
      } else {
        mark(entry, {
          status: "conflict",
          readback: "present",
          error: "Readback found this id with different content.",
        });
        stopped = true;
        return "stop";
      }
    } catch {
      readback = "unavailable";
    }
    if (!isCurrent()) return "invalidated";
    mark(entry, {
      status: "unknown",
      readback,
      error: `${reason} The write may have been saved; reload and retry the same file.`,
    });
    stopped = true;
    return "stop";
  };

  for (const entry of entries) {
    if (stopped) break;
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    if (!isCurrent()) {
      invalidated = true;
      break;
    }

    const current = byId.get(entry.record.id);
    if (current !== undefined) {
      if (stableStringify(current) === stableStringify(entry.record)) {
        mark(entry, { status: "duplicate" });
        continue;
      }
      mark(entry, { status: "conflict", error: "This id already exists with different content." });
      stopped = true;
      break;
    }

    let result: CreateWorkoutResult;
    try {
      result = await client.createWorkout(entry.record);
    } catch (error) {
      if (!isCurrent()) {
        invalidated = true;
        break;
      }
      if (isConflict(error)) {
        mark(entry, { status: "conflict", error: errorMessage(error) });
        stopped = true;
        break;
      }
      if (isDefiniteRejection(error)) {
        mark(entry, { status: "failed", error: errorMessage(error) });
        stopped = true;
        break;
      }

      const outcome = await resolveAmbiguous(entry, errorMessage(error));
      if (outcome === "invalidated") invalidated = true;
      break;
    }

    if (!isCurrent()) {
      invalidated = true;
      break;
    }

    // A successful transport is not enough: the returned record must be the
    // same canonical id/content that was submitted. A contradictory response
    // is ambiguous, so read back instead of claiming `created`.
    if (
      result.record.id !== entry.record.id ||
      stableStringify(result.record) !== stableStringify(entry.record)
    ) {
      const outcome = await resolveAmbiguous(
        entry,
        "The server response does not match the submitted record.",
      );
      if (outcome === "invalidated") invalidated = true;
      break;
    }

    if (result.duplicate) {
      mark(entry, { status: "duplicate" });
    } else {
      markCreated(entry);
    }
  }

  if (stopped || cancelled || invalidated) {
    // Remaining items already carry `not_attempted`.
  }

  const items = [...receiptByIndex.values()].sort((a, b) => a.index - b.index);
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;

  return { items, counts, stopped, cancelled, invalidated };
}
