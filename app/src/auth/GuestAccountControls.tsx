import { useId, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext.tsx";
import { saveReturnTarget } from "./returnTarget.ts";
import { useCoach } from "../coaching/useCoach.ts";

/**
 * Reusable guest account controls for the header and the account page.
 *
 * - Upgrade: requests an invited email change on the current guest. It shows
 *   "verification pending" until the callback verifies the same UID and a
 *   confirmed email, then links to password setup. It never claims success
 *   while the email is pending.
 * - Switch: signing in to an existing account is an explicit identity switch
 *   with NO guest-data merge; the sign-in form repeats that warning.
 * - Sign out: keeps the two-step loss warning; a failed account sign-in leaves
 *   this guest session untouched (AuthContext applies identities atomically).
 *
 * The component only renders for a verified guest. Account identity display
 * and account-only actions stay in the surrounding account UI.
 */
export function GuestAccountControls({ compact = false }: { compact?: boolean }) {
  const {
    status,
    user,
    guestUpgradeEnabled,
    pendingGuestUpgrade,
    beginGuestUpgrade,
    refreshVerifiedUser,
    signOutSession,
  } = useAuth();
  const coach = useCoach();
  const navigate = useNavigate();
  const location = useLocation();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  if (status !== "signed-in" || user === null || user.isAnonymous !== true) return null;

  const pending = pendingGuestUpgrade !== null && pendingGuestUpgrade.userId === user.id
    ? pendingGuestUpgrade
    : null;
  const pendingEmail = pending !== null && !pending.verified;

  async function onUpgrade(event: FormEvent): Promise<void> {
    event.preventDefault();
    setRequesting(true);
    setError(null);
    try {
      await beginGuestUpgrade(email);
      setEmail("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the account upgrade.");
    } finally {
      setRequesting(false);
    }
  }

  async function onResend(): Promise<void> {
    if (pending === null) return;
    setResending(true);
    setError(null);
    setCheckMessage(null);
    try {
      // Explicit user action only. The pending marker is preserved on failure,
      // and AuthContext serializes this through the one in-flight mutation.
      await beginGuestUpgrade(pending.email, { resend: true });
      setCheckMessage(`Verification link sent again to ${pending.email}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resend the verification link.");
    } finally {
      setResending(false);
    }
  }

  async function onCheckVerification(): Promise<void> {
    setChecking(true);
    setError(null);
    setCheckMessage(null);
    try {
      const verified = await refreshVerifiedUser();
      // A promoted pending upgrade changes the session to an account, so this
      // guest component unmounts and the password notice takes over. A null
      // result means the identity/token changed underneath us.
      if (verified === null) {
        setCheckMessage("This session changed. Reopen the tab that started the upgrade.");
      } else if (verified.isAnonymous === true) {
        setCheckMessage("Not verified yet. Open the link from the email, then check again.");
      } else if (verified.emailConfirmedAt === undefined) {
        setCheckMessage("The email is not confirmed yet. Check again after opening the link.");
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not check the verification link.",
      );
    } finally {
      setChecking(false);
    }
  }

  function onSwitch(): void {
    // Keep the guest's current page for after the explicit account switch.
    // /login sanitizes the target; failed sign-in leaves this guest session G
    // in place (AuthContext does not bump the identity epoch until verified).
    saveReturnTarget(`${location.pathname}${location.search}`);
    navigate("/login");
  }

  function onSignOut(): void {
    // Tear down the coach with the still-live guest credentials, then clear
    // the session and leave for the sign-in screen.
    coach.teardown();
    void signOutSession();
    navigate("/login", { replace: true });
  }

  return (
    <div
      className={`account-area account-guest${compact ? " account-guest-compact" : ""}`}
      aria-label="Guest account"
    >
      <p>
        <span className="account-guest-label">Guest</span>
        {compact ? null : " · Your workouts are not linked to an account."}
      </p>
      {compact ? null : (
        <p>
          Guest data is tied to this browser. Signing out or clearing site data may lose it;
          signing in to a different account does not transfer it.
        </p>
      )}

      {pendingEmail ? (
        <>
          <p role="status" className="account-guest-pending">
            Verification link sent to <strong>{pending?.email}</strong>. Open it in this tab, or
            open it elsewhere and check verification here. The upgrade is not complete until
            the verified user is re-fetched for the same guest.
          </p>
          <div className="account-guest-actions">
            <button
              type="button"
              onClick={() => void onCheckVerification()}
              disabled={checking || resending}
            >
              {checking ? "Checking…" : "Check verification"}
            </button>
            <button
              type="button"
              onClick={() => void onResend()}
              disabled={resending || checking}
            >
              {resending ? "Resending…" : "Resend verification link"}
            </button>
          </div>
          {checkMessage !== null ? <p role="status">{checkMessage}</p> : null}
        </>
      ) : null}
      {pending?.verified ? (
        <p role="status" className="account-guest-pending">
          Email verified for <strong>{pending.email}</strong>.{" "}
          <Link to="/reset-password">Set a password</Link> to finish the account upgrade.
        </p>
      ) : null}

      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {guestUpgradeEnabled && pending === null ? (
        <details className="guest-upgrade">
          <summary>Upgrade to an account</summary>
          <p>
            Invited emails only. This keeps the same guest identity and attaches its existing
            workouts to the verified account — it does not merge a different account.
          </p>
          <form onSubmit={onUpgrade}>
            <div className="field">
              <label htmlFor={emailId}>Invited email</label>
              <input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button type="submit" disabled={requesting}>
              {requesting ? "Sending link…" : "Send verification link"}
            </button>
          </form>
        </details>
      ) : null}

      {confirmingSignOut ? (
        <>
          <p>
            Signing out removes this browser&rsquo;s guest session. These guest workouts may be
            lost and cannot be guaranteed recoverable from another tab.
          </p>
          <div className="account-guest-actions">
            <button type="button" onClick={onSignOut}>
              Sign out and lose guest access
            </button>
            <button type="button" onClick={() => setConfirmingSignOut(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="account-guest-actions">
          <button type="button" onClick={onSwitch}>
            Sign in to an existing account
          </button>
          <button type="button" onClick={() => setConfirmingSignOut(true)}>
            Sign out guest
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Shown after the verified callback but before password setup succeeds, so a
 * verified-but-passwordless upgrade is never presented as fully finished.
 */
export function GuestUpgradePasswordNotice() {
  const { user, pendingGuestUpgrade } = useAuth();
  if (
    user === null ||
    user.isAnonymous !== false ||
    pendingGuestUpgrade === null ||
    !pendingGuestUpgrade.verified ||
    pendingGuestUpgrade.userId !== user.id
  ) {
    return null;
  }
  return (
    <div className="validation-warnings" role="status">
      <p>
        Email verified for {pendingGuestUpgrade.email}.{" "}
        <Link to="/reset-password">Set a password</Link> to finish the account upgrade.
      </p>
    </div>
  );
}
