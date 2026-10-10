import { stableStringify } from "@pi-fit-trace/core";
import type { WorkoutRecord } from "@pi-fit-trace/core";

/**
 * Deterministic workout IDs.
 *
 * The id is derived purely from record content: no clock, no randomness, no
 * counter. Re-saving or re-exporting identical content therefore yields the
 * same id, which is what makes the app layer idempotent. `id` and
 * `schema_version` are excluded before hashing, since both are assigned by the
 * store rather than authored by the user.
 */

/** FNV-1a (32-bit) over the canonical string form of the record. */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Build the canonical content form of a record, excluding store-assigned fields. */
function canonicalContent(input: WorkoutRecord): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...input };
  delete clone.id;
  delete clone.schema_version;
  return clone;
}

/** Derive a stable id (`wkt_<date>_<session_type>_<hash>`) from record content. */
export function deriveWorkoutId(input: WorkoutRecord): string {
  const hash = fnv1aHash(stableStringify(canonicalContent(input)));
  return `wkt_${input.date}_${input.session_type}_${hash}`;
}
