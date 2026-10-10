import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";

const navLinks = [
  { to: "/", label: "History" },
  { to: "/workout/new", label: "Log Workout" },
  { to: "/analysis", label: "Analysis" },
  { to: "/plan", label: "Plan" },
];

function AccountArea() {
  const { status, user, signOutSession } = useAuth();
  const navigate = useNavigate();
  if (status === "signed-in" && user !== null) {
    return (
      <div className="account-area" aria-label="Account">
        <span className="history-summary">{user.email ?? user.id}</span>{" "}
        <button
          type="button"
          onClick={() => {
            void signOutSession().then(() => navigate("/login", { replace: true }));
          }}
        >
          Sign out
        </button>
      </div>
    );
  }
  return null;
}

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">pi-fit-trace</span>
        <nav aria-label="Primary">
          <ul className="nav-list">
            {navLinks.map((link) => (
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
      <AuthOutageNotice />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
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
