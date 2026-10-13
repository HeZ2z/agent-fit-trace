/**
 * Logout teardown bridge between the Coach screen and the App shell.
 *
 * The Coach screen unmounts when the user navigates away — but its run keeps
 * going server-side, so the shell must still be able to tear it down with the
 * OLD account's captured credentials when the user eventually signs out. This
 * tiny registry therefore RETAINS one account-bound teardown across that
 * unmount (ordinary navigation never cancels the run): it is replaced on the
 * next Coach mount and cleared on sign-out or an account switch.
 *
 * It is intentionally not a general event bus, and never a place to hold a
 * live bearer: the retained teardown reads an account-bound credential snapshot
 * taken while that account was current, so a switched-in account's token is
 * never replayed for the old account's cleanup.
 */

export interface CoachLogoutRetention {
  /** Account the retained credentials belong to; sign-out must match it. */
  accountId: string | null;
  /** Run the retained cancel + logout; safe after unmount (no React state). */
  run(): void;
}

let retained: CoachLogoutRetention | null = null;

/** Retain the current coach's logout teardown, replacing any previous one. */
export function retainCoachLogoutCleanup(entry: CoachLogoutRetention): void {
  retained = entry;
}

/** Drop the retained teardown (sign-out or account switch consumed it). */
export function clearCoachLogoutCleanup(): void {
  retained = null;
}

/**
 * Run (and clear) the retained teardown once. A no-op when nothing is retained,
 * or when the retained credentials belong to a DIFFERENT account than the one
 * signing out — that run is not ours to cancel with these credentials.
 */
export function runCoachLogoutCleanup(accountId?: string | null): void {
  const entry = retained;
  retained = null;
  if (entry === null) return;
  if (accountId !== undefined && entry.accountId !== accountId) return;
  try {
    entry.run();
  } catch {
    // Teardown is best-effort: it must never block the auth sign-out.
  }
}
