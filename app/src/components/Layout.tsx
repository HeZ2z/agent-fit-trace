import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { saveReturnTarget } from "../auth/returnTarget.ts";
import { isCoachingEnabled } from "../api/runtimeMode.ts";
import { CoachingProvider } from "../coaching/CoachingProvider.tsx";
import { useCoach } from "../coaching/useCoach.ts";

const baseNavLinks = [
  { to: "/", label: "History" },
  { to: "/workout/new", label: "Log Workout" },
  { to: "/analysis", label: "Analysis" },
  { to: "/plan", label: "Plan" },
];

function navLinks() {
  // The Coach entry is launcher-gated: only the explicit same-origin runtime
  // flag shows it, so the App never advertises a fake cloud coach.
  if (isCoachingEnabled()) return [...baseNavLinks, { to: "/coach", label: "Coach" }];
  return baseNavLinks;
}

function AccountArea() {
  const { status, user, signOutSession } = useAuth();
  const coach = useCoach();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmingGuestSignOut, setConfirmingGuestSignOut] = useState(false);
  if (status !== "signed-in" || user === null) return null;

  // `isAnonymous === true` is the only verified guest signal. `false` is a
  // verified account and `undefined` is not classified yet, so neither may be
  // presented as a guest.
  if (user.isAnonymous === true) {
    return (
      <div className="account-area account-guest" aria-label="Account">
        <p>
          <span className="account-guest-label">Guest</span>
          {" · "}
          Your workouts are not linked to an account.
        </p>
        <p>
          Guest data is tied to this browser and is not linked to an account. Signing out
          or clearing site data may lose it, and signing in does not transfer it.
        </p>
        {confirmingGuestSignOut ? (
          <>
            <p>
              Signing out removes this browser&rsquo;s guest session. These guest workouts
              may be lost and cannot be guaranteed recoverable.
            </p>
            <div className="account-guest-actions">
              <button
                type="button"
                onClick={() => {
                  // Same ordering as an account sign-out: tear the coach down
                  // while the credentials are still live, then clear the
                  // session and leave for the sign-in screen.
                  coach.teardown();
                  void signOutSession();
                  navigate("/login", { replace: true });
                }}
              >
                Sign out and lose guest access
              </button>
              <button type="button" onClick={() => setConfirmingGuestSignOut(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="account-guest-actions">
            <button
              type="button"
              onClick={() => {
                // Keep the guest's current page as the post-account-sign-in
                // target; /login itself is not a legal return target.
                saveReturnTarget(`${location.pathname}${location.search}`);
                navigate("/login");
              }}
            >
              Sign in to an account
            </button>
            <button type="button" onClick={() => setConfirmingGuestSignOut(true)}>
              Sign out guest
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="account-area" aria-label="Account">
      <span className="history-summary">{user.email ?? user.id}</span>{" "}
      <button
        type="button"
        onClick={() => {
          // Tear down the account-level coach with A's still-live credentials
          // BEFORE the auth session is cleared (the gate then unmounts the
          // Coach, so its own effects can never observe the transition). The
          // owner is the same instance for the whole account, mounted or not.
          coach.teardown();
          void signOutSession();
          navigate("/login", { replace: true });
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export function Layout({ legacyLoopback = false }: { legacyLoopback?: boolean }) {
  return (
    <CoachingProvider>
      <div className="app-shell">
        <header className="app-header">
          <span className="app-title">agent-fit-trace</span>
          <nav aria-label="Primary">
            <ul className="nav-list">
              {navLinks().map((link) => (
                <li key={link.to}>
                  <NavLink
                    to={link.to}
                    end={link.to === "/"}
                    className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
                  >
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <AccountArea />
        </header>
        {legacyLoopback ? (
          <div className="validation-warnings" role="status">
            <p>
              Development bypass: no account login. Data uses the fixed
              dev-loopback-bypass namespace in this browser and is not isolated by
              identity.
            </p>
          </div>
        ) : null}
        <AuthOutageNotice />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </CoachingProvider>
  );
}

/**
 * Signed-in recovery entry: while a transient Auth outage keeps the session,
 * the loading gate (with its own Retry) is not shown — this short notice
 * with a manual retry is. It shares the single-flight `refresh()` with the
 * automatic backoff timer, so concurrent retries never double-dispatch.
 */
function AuthOutageNotice() {
  const { status, authError, refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);
  if (status !== "signed-in" || authError?.code !== "AUTH_UNAVAILABLE") return null;
  return (
    <div className="auth-outage-notice" role="alert">
      <span>Authentication is temporarily unavailable. You stay signed in.</span>{" "}
      <button
        type="button"
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          void refresh().finally(() => setRetrying(false));
        }}
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
