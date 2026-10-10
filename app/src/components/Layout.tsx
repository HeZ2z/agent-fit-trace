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
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
