/**
 * Persistence for the single unfinished workout-session draft.
 *
 * A draft is device-local and temporary: it holds mid-edit input that may not
 * pass record validation yet, so it is decoded with the shared structure-only
 * payload (never the strict record validator) and restored as-is.
 *
 * Keys are scoped per account so one account can never read, overwrite or
 * discard another account's draft on a shared browser profile. Logout or an
 * account switch therefore needs no migration: the previous owner's key simply
 * stops being addressed. Only one draft can exist per owner, matching the
 * product decision that one session is edited at a time.
 *
 * Error contract: a missing key is `null`, a corrupt/unreadable payload throws
 * the shared `SessionDraftCorruptionError` (`CORRUPT_DRAFT`), and storage
 * failures propagate untouched. Callers must offer an explicit discard rather
 * than repairing or silently deleting a draft, because the payload version has
 * no migration path.
 */

import { decodeSessionDraft, encodeSessionDraft } from "@agent-fit-trace/workout-session";
import type { SessionDraft } from "@agent-fit-trace/workout-session";
import type { StorageAdapter } from "./adapter.ts";

/**
 * Owner-scoped namespace. The `v1` here versions the key layout, not the draft
 * payload (`SessionDraft.version`); the two layers stay orthogonal.
 */
const SESSION_DRAFT_KEY_PREFIX = "agent-fit-trace:session-draft:v1:owner:";

/** Storage key for one verified owner's single draft. */
export function sessionDraftKey(ownerId: string): string {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new TypeError("ownerId must be a non-empty string");
  }
  return `${SESSION_DRAFT_KEY_PREFIX}${encodeURIComponent(ownerId)}`;
}

/**
 * Read and decode the owner's draft, or `null` when none is stored.
 *
 * Corruption (invalid JSON, unsupported payload version, wrong shape) throws
 * the shared `SessionDraftCorruptionError`; storage errors are never converted
 * into "no draft", so a failed read cannot be mistaken for an empty one.
 */
export function loadSessionDraft(adapter: StorageAdapter, ownerId: string): SessionDraft | null {
  const raw = adapter.read(sessionDraftKey(ownerId));
  if (raw === null) return null;
  return decodeSessionDraft(raw);
}

/** Persist exactly one draft for the owner, replacing any previous one. */
export function saveSessionDraft(
  adapter: StorageAdapter,
  draft: SessionDraft,
  ownerId: string,
): void {
  adapter.write(sessionDraftKey(ownerId), encodeSessionDraft(draft));
}

/** Forget the owner's draft (successful save, explicit discard, or sign-out). */
export function clearSessionDraft(adapter: StorageAdapter, ownerId: string): void {
  adapter.remove(sessionDraftKey(ownerId));
}
