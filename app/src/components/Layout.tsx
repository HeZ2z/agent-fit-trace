import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { isCoachVisible } from "../api/runtimeMode.ts";
import { CoachingProvider } from "../coaching/CoachingProvider.tsx";
import { BrandMark, PixelIcon } from "./PixelIcon.tsx";
import type { PixelIconName } from "./PixelIcon.tsx";
import { useI18n } from "../i18n/useI18n.ts";

interface NavItem {
  to: string;
  label: string;
  icon: PixelIconName;
}

const baseNavLinks: NavItem[] = [
  { to: "/", label: "History", icon: "history" },
  { to: "/workout/new", label: "Log Workout", icon: "log" },
  { to: "/analysis", label: "Analysis", icon: "analysis" },
  { to: "/plan", label: "Plan", icon: "plan" },
  { to: "/me", label: "Me", icon: "me" },
];

function navLinks(): NavItem[] {
  // The Coach entry is visible where coaching can exist at all: the launcher's
  // local flag and authenticated HTTP deployments. Visible is not available —
  // the screen itself explains backend eligibility (guest/credits/provider).
  if (isCoachVisible()) return [...baseNavLinks, { to: "/coach", label: "Coach", icon: "coach" }];
  return baseNavLinks;
}

/** Brand block shared by the side panel and mobile bar. */
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <>
      <span className="brand-mark">
        <BrandMark />
      </span>
      <span className={compact ? "mobile-brand-copy" : "brand-copy"}>
        <span className={compact ? "mobile-brand-name" : "brand-name"}>FIT TRACE</span>
      </span>
    </>
  );
}

export function Layout({ legacyLoopback = false }: { legacyLoopback?: boolean }) {
  const { t } = useI18n();
  return (
    <CoachingProvider>
      <div className="app-shell">
        <aside className="sidenav" aria-label={t("Workspace")}>
          <div className="brand">
            <Brand />
          </div>
          <nav className="app-nav" aria-label={t("Primary")}>
            <ul className="nav-list">
              {navLinks().map((link) => (
                <li key={link.to}>
                  <NavLink
                    to={link.to}
                    end={link.to === "/"}
                    className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
                  >
                    <PixelIcon name={link.icon} size={22} />
                    <span className="nav-label">{t(link.label)}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div className="workspace">
          <header className="app-header">
            <div className="mobile-brand">
              <Brand compact />
            </div>
          </header>
          {legacyLoopback ? (
            <div className="workspace-notices">
              <div className="validation-warnings" role="status">
                <p>
                  {t(
                    "Development bypass: no account login. Data uses the fixed dev-loopback-bypass namespace in this browser and is not isolated by identity.",
                  )}
                </p>
              </div>
            </div>
          ) : null}
          <AuthOutageNotice />
          <main className="app-main">
            <Outlet />
          </main>
        </div>
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
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  if (status !== "signed-in" || authError?.code !== "AUTH_UNAVAILABLE") return null;
  return (
    <div className="workspace-notices">
      <div className="auth-outage-notice" role="alert">
        <span>{t("Authentication is temporarily unavailable. You stay signed in.")}</span>{" "}
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void refresh().finally(() => setRetrying(false));
          }}
        >
          {retrying ? t("Retrying…") : t("Retry")}
        </button>
      </div>
    </div>
  );
}
