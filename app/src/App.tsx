import { useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { SessionDraftProvider } from "./state/SessionDraftContext.tsx";
import { WorkoutStoreProvider } from "./state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import { HttpFitTraceClient } from "./api/httpFitTraceClient.ts";
import { LOCAL_DEV_BYPASS_OWNER, LocalFitTraceClient } from "./api/localFitTraceClient.ts";
import { currentRuntimeMode, isCoachVisible } from "./api/runtimeMode.ts";
import { HistoryScreen } from "./screens/HistoryScreen.tsx";
import { WorkoutEditorScreen } from "./screens/WorkoutEditorScreen.tsx";
import { WorkoutSummaryScreen } from "./screens/WorkoutSummaryScreen.tsx";
import { AnalysisScreen } from "./screens/AnalysisScreen.tsx";
import { PlanScreen } from "./screens/PlanScreen.tsx";
import { CoachScreen } from "./screens/CoachScreen.tsx";
import { MeScreen } from "./screens/MeScreen.tsx";
import { CoachSettingsScreen } from "./screens/CoachSettingsScreen.tsx";
import { CoachDiscoveryProvider } from "./coaching/CoachDiscoveryContext.tsx";
import { OAuthConsentScreen } from "./screens/OAuthConsentScreen.tsx";
import { AuthProvider, useAuth } from "./auth/AuthContext.tsx";
import {
  AuthCallbackScreen,
  ForgotPasswordScreen,
  ResetPasswordScreen,
  SignInScreen,
} from "./auth/AuthScreens.tsx";
import {
  isEmailVerificationType,
  isPasswordSetupType,
  parseAuthCallbackHash,
} from "./auth/supabaseAuth.ts";
import { useI18n } from "./i18n/useI18n.ts";

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
  // App already rejects an invalid runtime before providers mount; this helper
  // must still use the same central resolver (never its own env parsing).
  return currentRuntimeMode().mode === "http";
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
 * request; local mode stays on browser storage. The draft provider is keyed by
 * the signed-in user id and wraps the workout store, so a logout or account
 * change remounts both and clears the previous user's records/analysis caches
 * and draft callbacks — no flash of the old account's data.
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
  // Every account/guest identity gets its own provider instance. Local
  // storage is owner-namespaced by the same verified id; the explicit dev
  // bypass (no session) uses one fixed, clearly-labelled namespace.
  const ownerId = user?.id ?? LOCAL_DEV_BYPASS_OWNER;
  const httpClient = useMemo(
    () => new HttpFitTraceClient({ getAccessToken }),
    [getAccessToken],
  );
  const localClient = useMemo(
    () => new LocalFitTraceClient(undefined, ownerId),
    [ownerId],
  );
  // Every client mode gets the same owner-scoped draft storage. The provider is
  // keyed by the owner here (instead of on the store) so an account change
  // remounts the whole subtree: workout records, analysis caches and the
  // previous owner's in-memory draft handlers all go with it.
  const store =
    clientProp !== undefined ? (
      <WorkoutStoreProvider client={clientProp}>{children}</WorkoutStoreProvider>
    ) : isHttpMode() ? (
      <WorkoutStoreProvider client={httpClient}>{children}</WorkoutStoreProvider>
    ) : (
      <WorkoutStoreProvider client={localClient}>{children}</WorkoutStoreProvider>
    );
  return (
    <SessionDraftProvider key={ownerId} ownerId={ownerId}>
      {store}
    </SessionDraftProvider>
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
 * Protected screens require a validated session in every mode (HTTP and
 * browser-local). Local mode is a storage backend, not an auth bypass. The
 * only exception is the explicit development-only `legacyLoopback` opt-in for
 * the unauthenticated loopback dev API.
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
  const { status, publicConfig, configError, authError, refresh, retrySyncTransition } = useAuth();
  const { t } = useI18n();
  if (isLegacyLoopbackAllowed(legacyLoopback)) {
    return <ProtectedContent client={client}>{children}</ProtectedContent>;
  }
  if (status === "loading") {
    // A transient Auth outage keeps the loading gate with a retry instead
    // of signing out: the stored session is preserved (see AuthProvider).
    if (authError !== null && authError.code === "SYNC_TRANSITION_UNCONFIRMED") {
      return <section aria-labelledby="sync-transition-heading">
        <h1 id="sync-transition-heading">{t("Sync identity change was not confirmed")}</h1>
        <p role="alert">{authError.message}</p>
        <p>{t("Sync remains unavailable until the daemon confirms the change.")}</p>
        {retrySyncTransition
          ? <button type="button" onClick={() => void retrySyncTransition()}>{t("Retry")}</button>
          : <button type="button" onClick={() => window.location.reload()}>{t("Reload")}</button>}
      </section>;
    }
    if (authError !== null && authError.code === "AUTH_UNAVAILABLE") {
      return (
        <section aria-labelledby="auth-retry-heading">
          <h1 id="auth-retry-heading">{t("Sign-in is unavailable")}</h1>
          <p role="alert">{authError.message}</p>
          <button type="button" onClick={() => void refresh()}>
            {t("Retry")}
          </button>
        </section>
      );
    }
    return (
      <section aria-label={t("Loading")}>
        <p>{t("Loading…")}</p>
      </section>
    );
  }
  if (publicConfig === null) {
    return (
      <section aria-labelledby="auth-unavailable-heading">
        <h1 id="auth-unavailable-heading">{t("Login is unavailable")}</h1>
        <p role="alert">
          {configError !== null
            ? t("The server did not provide its public configuration.")
            : t("Authentication is not configured.")}
        </p>
      </section>
    );
  }
  if (status === "signed-out") return <SignInScreen />;
  return <ProtectedContent client={client}>{children}</ProtectedContent>;
}

/**
 * True when a root-URL hash looks like an Auth redirect: an invite/recovery
 * password-setup session or a guest email-change verification session. The
 * callback screen applies email changes only through the same-UID pending
 * upgrade check. Never matches ordinary fragment hashes (`#section`) — tokens
 * are only ever read from the hash, never the query string.
 */
function isRootAuthHash(hash: string): boolean {
  const session = parseAuthCallbackHash(hash);
  if (session !== null) {
    return isPasswordSetupType(session.type) || isEmailVerificationType(session.type);
  }
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment === "") return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(fragment);
  } catch {
    return false;
  }
  // A bare `?code=…` PKCE link is not consumed here (implicit-hash flow
  // only); the callback screen reports it as invalid/expired.
  if (params.get("code") !== null) return true;
  const type = params.get("type");
  return isPasswordSetupType(type) || isEmailVerificationType(type) || params.get("error") !== null;
}

function RootRoute({ legacyLoopback, client }: { legacyLoopback?: boolean; client?: FitTraceClient }) {
  // Default Supabase invite/recovery links land on `/` (Site URL is the app
  // origin): when the router location hash carries an invite/recovery
  // session, route to the callback screen — ahead of the sign-in gate and
  // any existing session — so users can set their password without editing
  // the address. The callback consumes the hash into the tab-scoped token
  // handoff and strips it from the URL before navigating to
  // `/reset-password` via router replace (so the manual replaceState never
  // stays out of sync with the router location). Local mode (and ordinary
  // non-auth hashes) never enters this path.
  // Reading useLocation() here (inside BrowserRouter) keeps the branch
  // router-aware: later navigations re-evaluate instead of reusing a stale
  // window.location.hash snapshot from the first render.
  const location = useLocation();
  // Local mode now performs the same auth bootstrap/validation as HTTP, so
  // invite/recovery links must work there too (except for the explicit
  // unauthenticated dev bypass).
  const bypass = isLegacyLoopbackAllowed(legacyLoopback);
  const rootIsAuthCallback = !bypass && isRootAuthHash(location.hash);
  if (rootIsAuthCallback) return <AuthCallbackScreen />;
  return (
    <RequireAuth legacyLoopback={legacyLoopback} client={client}>
      <HistoryScreen />
    </RequireAuth>
  );
}

function AppRoutes({ legacyLoopback, client }: { legacyLoopback?: boolean; client?: FitTraceClient }) {
  const bypass = isLegacyLoopbackAllowed(legacyLoopback);
  return (
    // ONE discovery provider for the whole app: `bootstrap` mints a capability
    // and the daemon caps them per account (5) and in total, so a per-screen
    // second bootstrap would both waste a slot and risk showing two different
    // answers for the same machine.
    <CoachDiscoveryProvider>
      <BrowserRouter>
        <Routes>
        <Route element={<Layout legacyLoopback={bypass} />}>
          <Route path="/" element={<RootRoute legacyLoopback={legacyLoopback} client={client} />} />
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
          <Route
            path="/me"
            element={
              <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                <MeScreen />
              </RequireAuth>
            }
          />
          <Route
            path="/coach"
            element={
              isCoachVisible() ? (
                <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                  <CoachScreen />
                </RequireAuth>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/coach/settings"
            element={
              isCoachVisible() ? (
                <RequireAuth legacyLoopback={legacyLoopback} client={client}>
                  <CoachSettingsScreen />
                </RequireAuth>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="/login" element={<SignInScreen />} />
          <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
          <Route path="/reset-password" element={<ResetPasswordScreen />} />
          <Route path="/auth/callback" element={<AuthCallbackScreen />} />
          {/*
            Remote-MCP OAuth consent. Registered as a sibling of the auth
            screens and OUTSIDE `RequireAuth`/`ProtectedContent` on purpose:
            the screen owns its own signed-out prompt, because the shared gate
            signs in through `returnTarget.ts` and then navigates away from the
            requested URL — which would drop the `authorization_id` that the
            Supabase OAuth server put in this redirect. It also has to render
            when the public config cannot load, so a failure here is never a
            silent blank page.
          */}
          <Route path="/oauth/consent" element={<OAuthConsentScreen />} />
        </Route>
        </Routes>
      </BrowserRouter>
    </CoachDiscoveryProvider>
  );
}

export default function App({ client, legacyLoopback }: AppProps = {}) {
  const runtime = currentRuntimeMode();
  const { t } = useI18n();
  if (runtime.error !== null) {
    // Fail closed before AuthProvider/protected providers mount: a production
    // build in local/default/unknown mode must show a configuration error,
    // never a quiet local fallback with unauthenticated data access.
    return (
      <main className="app-shell" aria-labelledby="runtime-config-heading">
        <h1 id="runtime-config-heading">{t("Configuration error")}</h1>
        <p role="alert">{runtime.error}</p>
      </main>
    );
  }
  const bypass = isLegacyLoopbackAllowed(legacyLoopback);
  return (
    <AuthProvider skipBootstrap={bypass} skipValidation={bypass}>
      <AppRoutes legacyLoopback={legacyLoopback} client={client} />
    </AuthProvider>
  );
}
