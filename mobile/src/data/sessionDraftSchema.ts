import { decodeSessionDraft, encodeSessionDraft } from "@agent-fit-trace/workout-session";
import type { SessionDraft } from "@agent-fit-trace/workout-session";

/**
 * Pure row mapping for the single mobile session draft.
 *
 * This module imports no `expo-sqlite`, React, DOM or Node values, so the root
 * `node:test` suite can load it through Node's TypeScript type stripping; the
 * device repository owns every native call. The payload is the shared
 * structure-only draft JSON, never a validated workout record: a draft can be
 * mid-edit (empty date, partial numbers) and must survive a restart.
 *
 * The draft is device-local and owner-scoped: `owner_id` is part of the row
 * key, so one identity can never read or overwrite another identity's draft on
 * the same device.
 */

/** One stored draft row. `payload` is the shared encoded draft. */
export interface SessionDraftRow {
  owner_id: string;
  payload: string;
  updated_at: string;
}

/**
 * Owner id used by a signed-out local user.
 *
 * The mobile guest is a real local identity (unlike the web guest, which gets a
 * Supabase anonymous account), so a stable constant addresses the guest's
 * single draft without inventing an account.
 */
export const LOCAL_GUEST_OWNER_ID = "local-guest";

/**
 * Validate and return an owner id. Callers pass the id straight into SQL, so a
 * blank identity would silently address a shared row.
 */
export function requireSessionDraftOwnerId(ownerId: string): string {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new TypeError("ownerId must be a non-empty string.");
  }
  return ownerId;
}

function requireTimestamp(updatedAt: string): string {
  if (typeof updatedAt !== "string" || updatedAt.trim() === "") {
    throw new TypeError("updatedAt must be a non-empty ISO timestamp.");
  }
  return updatedAt;
}

/**
 * Build the row for one owner's draft. `updatedAt` is supplied by the caller
 * (the repository injects its clock) so this module never reads a clock.
 */
export function toSessionDraftRow(
  ownerId: string,
  draft: SessionDraft,
  updatedAt: string,
): SessionDraftRow {
  return {
    owner_id: requireSessionDraftOwnerId(ownerId),
    payload: encodeSessionDraft(draft),
    updated_at: requireTimestamp(updatedAt),
  };
}

/**
 * Rebuild a draft from its row.
 *
 * The payload is decoded with the shared structure-only decoder, so a corrupt
 * or unsupported payload throws the shared `SessionDraftCorruptionError`
 * (`CORRUPT_DRAFT`) and the caller must offer an explicit discard. A missing or
 * non-string payload is treated as corruption for the same reason: there is no
 * readable draft to restore.
 */
export function fromSessionDraftRow(row: SessionDraftRow): SessionDraft {
  requireSessionDraftOwnerId(row.owner_id);
  requireTimestamp(row.updated_at);
  return decodeSessionDraft(row.payload);
}
