/**
 * Tab-scoped handoff for the invited guest -> account upgrade.
 *
 * The value ties the pending email change to the ONE verified guest user that
 * initiated it. It lives in `sessionStorage` (not `localStorage`) so another
 * tab cannot silently adopt the upgrade, and the callback must match both the
 * stored user id and the authoritative user returned by `GET /auth/v1/user`.
 *
 * The stored email is normalized with `trim().toLowerCase()` to match the
 * database's `lower(email)` invite identity. It is only a UI/matching hint;
 * the Auth server response remains authoritative.
 */

export interface PendingGuestUpgrade {
  userId: string;
  email: string;
  /**
   * False after the email-change request (link sent, still pending); true only
   * after the callback token verified as the same UID with a confirmed email.
   * Password setup follows the verified state.
   */
  verified: boolean;
  startedAt: number;
}

export const GUEST_UPGRADE_STORAGE_KEY = "pi-fit-trace:auth:v1:guest-upgrade";

export function normalizeGuestUpgradeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parsePending(raw: string | null): PendingGuestUpgrade | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.userId !== "string" || parsed.userId === "") return null;
    if (typeof parsed.email !== "string") return null;
    const email = normalizeGuestUpgradeEmail(parsed.email);
    if (email === "") return null;
    if (typeof parsed.verified !== "boolean") return null;
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
    return {
      userId: parsed.userId,
      email,
      verified: parsed.verified,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

// In-page fallback for blocked storage, mirroring the recovery-token handoff.
// sessionStorage remains the source of truth whenever it is readable: a new
// provider lifecycle or a storage event must never be masked by stale module
// memory. The tombstone only prevents a failed removeItem from resurrecting a
// cleared value while storage itself is unavailable.
let memoryPending: PendingGuestUpgrade | null = null;
let memoryCleared = false;

function storageRead(): { available: boolean; raw: string | null } {
  try {
    return {
      available: true,
      raw: globalThis.sessionStorage?.getItem(GUEST_UPGRADE_STORAGE_KEY) ?? null,
    };
  } catch {
    return { available: false, raw: null };
  }
}

function storageWrite(value: string | null): boolean {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(GUEST_UPGRADE_STORAGE_KEY);
    else globalThis.sessionStorage?.setItem(GUEST_UPGRADE_STORAGE_KEY, value);
    return true;
  } catch {
    // Tab-storage failures must not break the upgrade; memory still works.
    return false;
  }
}

export function savePendingGuestUpgrade(pending: PendingGuestUpgrade): void {
  const normalized: PendingGuestUpgrade = {
    ...pending,
    email: normalizeGuestUpgradeEmail(pending.email),
  };
  memoryPending = normalized;
  memoryCleared = false;
  storageWrite(JSON.stringify(normalized));
}

export function loadPendingGuestUpgrade(): PendingGuestUpgrade | null {
  const storage = storageRead();
  if (storage.available) return parsePending(storage.raw);
  return memoryCleared ? null : memoryPending;
}

export function clearPendingGuestUpgrade(): void {
  memoryPending = null;
  const wrote = storageWrite(null);
  memoryCleared = !wrote;
}

/** Test-only reset for the in-page fallback/tombstone. */
export function resetPendingGuestUpgradeForTests(): void {
  memoryPending = null;
  memoryCleared = false;
}
