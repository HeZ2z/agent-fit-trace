import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { GuestAccountControls } from "../auth/GuestAccountControls.tsx";
import { isCoachVisible } from "../api/runtimeMode.ts";
import { CoachingProvider } from "../coaching/CoachingProvider.tsx";
import { useCoach } from "../coaching/useCoach.ts";

const baseNavLinks = [
  { to: "/", label: "History" },
  { to: "/workout/new", label: "Log Workout" },
  { to: "/analysis", label: "Analysis" },
  { to: "/plan", label: "Plan" },
  { to: "/me", label: "Me" },
];

function navLinks() {
  // The Coach entry is visible where coaching can exist at all: the launcher's
  // local flag and authenticated HTTP deployments. Visible is not available —
  // the screen itself explains backend eligibility (guest/credits/provider).
  if (isCoachVisible()) return [...baseNavLinks, { to: "/coach", label: "Coach" }];
  return baseNavLinks;
}

function AccountArea() {
  const { status, user, signOutSession } = useAuth();
  const coach = useCoach();
  const navigate = useNavigate();
  if (status !== "signed-in" || user === null) return null;

  // `isAnonymous === true` is the only verified guest signal. `false` is a
  // verified account and `undefined` is not classified yet, so neither may be
  // presented as a guest. Account operations live on /me; the header keeps
  // only a badge/link and the safe sign-out.
  if (user.isAnonymous === true) {
    return <GuestAccountControls compact />;
  }

  return (
    <div className="account-area" aria-label="Account">
      <span className="account-badge">Account</span>
      <span className="history-summary">{user.email ?? user.id}</span>{" "}
      <Link className="account-link" to="/me">
        Account details
      </Link>
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
