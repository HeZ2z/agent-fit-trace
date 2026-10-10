import { useMemo } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { WorkoutStoreProvider } from "./state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { HttpFitTraceClient } from "./api/httpFitTraceClient.ts";
import { HistoryScreen } from "./screens/HistoryScreen.tsx";
import { WorkoutEditorScreen } from "./screens/WorkoutEditorScreen.tsx";
import { WorkoutSummaryScreen } from "./screens/WorkoutSummaryScreen.tsx";
import { AnalysisScreen } from "./screens/AnalysisScreen.tsx";
import { PlanScreen } from "./screens/PlanScreen.tsx";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import {
  AuthCallbackScreen,
  ForgotPasswordScreen,
  ResetPasswordScreen,
  SignInScreen,
} from "./auth/AuthScreens.tsx";

export interface AppProps {
  /** Optional client for tests; defaults to the mode-aware client. */
  client?: FitTraceClient;
  /**
   * Explicit opt-in to the unauthenticated loopback UI (development/tests
   * only). Production HTTP mode never uses this: protected screens stay
   * gated on the session, and a missing/failed public config fails closed.
   */
  legacyLoopback?: boolean;
}

function isHttpMode(): boolean {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env?.VITE_FIT_TRACE_MODE === "http";
}

/** Development-only escape hatch for the unauthenticated loopback dev API. */
export function isLegacyLoopbackAllowed(explicitProp?: boolean): boolean {
  // Never allowed in production builds — not even via the explicit prop.
  if (!import.meta.env.DEV) return false;
  if (explicitProp === true) return true;
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env?.VITE_FIT_TRACE_LEGACY_LOOPBACK === "1";
}

/**
 * Mode-aware client: HTTP mode attaches the current session token per
 * request; local mode stays on browser storage. The provider is keyed by the
 * signed-in user id so a logout or account change remounts the workout store
 * and clears the previous user's records/analysis caches — no flash of the
 * old account's data.
 *
 * This provider must only mount inside the auth gate (see `ProtectedContent`
 * below): mounting it earlier would dispatch history reads with an
 * unverified restored token.
 */
function AuthenticatedWorkoutProvider({
  client: clientProp,
  children,
}: {
  client?: FitTraceClient;
  children: React.ReactNode;
}) {
  const { getAccessToken, user } = useAuth();
  const httpClient = useMemo(
    () => new HttpFitTraceClient({ getAccessToken }),
    [getAccessToken],
  );
  if (clientProp !== undefined) {
    return <WorkoutStoreProvider client={clientProp}>{children}</WorkoutStoreProvider>;
  }
  if (!isHttpMode()) return <WorkoutStoreProvider>{children}</WorkoutStoreProvider>;
  return (
    <WorkoutStoreProvider key={user?.id ?? "signed-out"} client={httpClient}>
      {children}
    </WorkoutStoreProvider>
  );
}

/** Protected content: the workout store mounts only after the session is validated. */
function ProtectedContent({
  client,
  children,
}: {
  client?: FitTraceClient;
  children: React.ReactNode;
}) {
  return (
    <AuthenticatedWorkoutProvider client={client}>{children}</AuthenticatedWorkoutProvider>
  );
}

/**
 * In HTTP mode, protected screens require a validated session. A missing or
 * failed public config fails closed (login-unavailable notice, never the
 * protected content). The only exception is the explicit development-only
 * `legacyLoopback` opt-in for the unauthenticated loopback dev API.
 */
function RequireAuth({
  children,
  legacyLoopback,
  client,
}: {
  children: React.ReactNode;
  legacyLoopback?: boolean;
  client?: FitTraceClient;
}) {
  const { status, publicConfig, configError, authError, refresh } = useAuth();
  // Local mode and the explicit development-only loopback opt-in need no
  // session, but screens still need the workout store — provide it directly
  // without the auth gate.
  if (!isHttpMode()) return <ProtectedContent client={client}>{children}</ProtectedContent>;
  if (isLegacyLoopbackAllowed(legacyLoopback)) {
    return <ProtectedContent client={client}>{children}</ProtectedContent>;
  }
  if (status === "loading") {
    // A transient Auth outage keeps the loading gate with a retry instead
    // of signing out: the stored session is preserved (see AuthProvider).
    if (authError !== null && authError.code === "AUTH_UNAVAILABLE") {
      return (
        <section aria-labelledby="auth-retry-heading">
          <h1 id="auth-retry-heading">Sign-in is unavailable</h1>
          <p role="alert">{authError.message}</p>
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </section>
      );
    }
    return (
      <section aria-label="Loading">
        <p>Loading…</p>
      </section>
    );
  }
  if (publicConfig === null) {
    return (
      <section aria-labelledby="auth-unavailable-heading">
        <h1 id="auth-unavailable-heading">Login is unavailable</h1>
        <p role="alert">
          {configError !== null
            ? "The server did not provide its public configuration."
            : "Authentication is not configured."}
        </p>
      </section>
    );
  }
  if (status === "signed-out") return <SignInScreen />;
  return <ProtectedContent client={client}>{children}</ProtectedContent>;
}

function AppRoutes({ legacyLoopback, client }: { legacyLoopback?: boolean; client?: FitTraceClient }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route
            path="/"
            element={
              <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                <HistoryScreen />
              </RequireAuth>
            }
          />
          <Route
            path="/workout/new"
            element={
              <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                <WorkoutEditorScreen />
              </RequireAuth>
            }
          />
          <Route
            path="/workout/:id"
            element={
              <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                <WorkoutSummaryScreen />
              </RequireAuth>
            }
          />
          <Route
            path="/analysis"
            element={
              <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                <AnalysisScreen />
              </RequireAuth>
            }
          />
          <Route
            path="/plan"
            element={
              <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                <PlanScreen />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<SignInScreen />} />
          <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
          <Route path="/reset-password" element={<ResetPasswordScreen />} />
          <Route path="/auth/callback" element={<AuthCallbackScreen />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default function App({ client, legacyLoopback }: AppProps = {}) {
  return (
    <AuthProvider skipBootstrap={!isHttpMode()}>
      <AppRoutes legacyLoopback={legacyLoopback} client={client} />
    </AuthProvider>
  );
}
