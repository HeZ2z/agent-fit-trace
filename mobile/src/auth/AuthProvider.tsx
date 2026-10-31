import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";

import { readSupabaseAuthConfig } from "./authConfig";
import {
  AuthError,
  authRefreshTimerDelayMs,
  isSessionExpired,
  isTransientAuthError,
  nextAuthRefreshRetry,
  toAuthError,
  validateSignInInput,
  type AuthRefreshRetry,
  type AuthStatus,
  type SupabaseAuthConfig,
  type SupabaseAuthUser,
  type SupabaseSession,
} from "./authModel";
import {
  readStoredAuthSession,
  revokeStoredSession,
  saveNewStoredSession,
} from "./sessionStore";
import { refreshStoredSession } from "./sessionRefresh";
import {
  fetchAuthUser,
  signInWithPassword,
  signOut as signOutRequest,
} from "./supabaseAuth";

/**
 * Account state for the mobile app.
 *
 * Guest/local-only stays the default: nothing here touches the workout store,
 * starts a sync, or calls a cloud coach. The provider only owns the signed-in
 * identity — sign-in, session restore/refresh, sign-out and the token storage
 * handoff — so a later slice can consume `session` to enable those features.
 */

export interface AuthContextValue {
  status: AuthStatus;
  session: SupabaseSession | null;
  user: SupabaseAuthUser | null;
  /** Last auth failure (restore/refresh/sign-in), redacted and localizable. */
  error: AuthError | null;
  /** False when the public Supabase env is missing; local-only still works. */
  isConfigured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Refresh the access token once; true when a new session was applied. */
  refresh: () => Promise<boolean>;
  /** Current access token for a future authenticated transport (null if none). */
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Resolve the public env once per mount. Missing values are a state, not a
  // crash; `unconfigured` is reported while the rest of the app stays usable.
  const [config] = useState<SupabaseAuthConfig | null>(() => readSupabaseAuthConfig());
  const [status, setStatus] = useState<AuthStatus>(
    config === null ? "unconfigured" : "loading",
  );
  const [session, setSession] = useState<SupabaseSession | null>(null);
  const [error, setError] = useState<AuthError | null>(null);
  // Transient scheduled-refresh failures keep one bounded-backoff retry timer
  // alive until a refresh succeeds or the identity/foreground resets it.
  const [refreshRetry, setRefreshRetry] = useState<AuthRefreshRetry | null>(null);

  const sessionRef = useRef<SupabaseSession | null>(null);
  // Bumped by every sign-in/sign-out/unmount so late async work cannot replace
  // a newer identity. `attemptRef` does the same for concurrent sign-in clicks.
  const generationRef = useRef(0);
  // Shared with headless runtimes through SQLite; SecureStore alone cannot
  // distinguish a late refresh from credentials revoked by another runtime.
  const sessionGenerationRef = useRef(0);
  const attemptRef = useRef(0);
  const refreshInflightRef = useRef<Promise<boolean> | null>(null);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);

  const applySession = useCallback((next: SupabaseSession | null): void => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  // Restore once on boot. A non-expired session is used immediately; an
  // expired one is refreshed before it is reported signed-in. Transient
  // failures surface `error` without deleting the stored session, so a later
  // launch can retry instead of losing the refresh token.
  useEffect(() => {
    if (config === null) {
      setStatus("unconfigured");
      return;
    }
    let cancelled = false;
    const generation = generationRef.current;
    void (async () => {
      try {
        const stored = await readStoredAuthSession();
        if (cancelled || generation !== generationRef.current) return;
        if (stored === null) {
          setStatus("signed-out");
          return;
        }
        sessionGenerationRef.current = stored.generation;
        if (!isSessionExpired(stored.session)) {
          applySession(stored.session);
          setStatus("signed-in");
          setError(null);
          setRefreshRetry(null);
          return;
        }
        const refreshed = await refreshStoredSession(config, stored);
        if (cancelled || generation !== generationRef.current) return;
        if (refreshed === null) {
          const latest = await readStoredAuthSession();
          if (latest === null) {
            setStatus("signed-out");
          } else if (latest.generation !== stored.generation || latest.session.refreshToken !== stored.session.refreshToken) {
            sessionGenerationRef.current = latest.generation;
            applySession(latest.session);
            setStatus("signed-in");
            setError(null);
          } else {
            applySession(null);
            setError(new AuthError("network"));
            setStatus("error");
            setRefreshRetry((previous) => nextAuthRefreshRetry(previous));
          }
          return;
        }
        sessionGenerationRef.current = refreshed.generation;
        applySession(refreshed.session);
        setStatus("signed-in");
        setError(null);
        setRefreshRetry(null);
      } catch (cause) {
        if (cancelled || generation !== generationRef.current) return;
        const nextError = toAuthError(cause);
        setError(nextError);
        if (isTransientAuthError(nextError)) {
          // Keep the stored session for a later retry; this boot cannot use it.
          applySession(null);
          setStatus("error");
          return;
        }
        applySession(null);
        setStatus("signed-out");
        void revokeStoredSession(sessionGenerationRef.current).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession, config]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      if (config === null) {
        const unconfigured = new AuthError("unconfigured");
        setError(unconfigured);
        throw unconfigured;
      }
      const validated = validateSignInInput(email, password);
      if (!validated.ok) {
        const invalid = new AuthError(validated.code);
        setError(invalid);
        throw invalid;
      }
      const attempt = attemptRef.current + 1;
      attemptRef.current = attempt;
      setError(null);
      try {
        const tokenSession = await signInWithPassword(config, validated.email, password);
        // Only the verified user endpoint may populate the account identity;
        // token-grant user objects are not authoritative.
        const verified = await fetchAuthUser(config, tokenSession.accessToken);
        if (attempt !== attemptRef.current) return;
        const next: SupabaseSession = { ...tokenSession, user: verified };
        const authGeneration = await saveNewStoredSession(next);
        generationRef.current += 1;
        sessionGenerationRef.current = authGeneration;
        refreshInflightRef.current = null;
        applySession(next);
        setStatus("signed-in");
        setError(null);
        setRefreshRetry(null);
      } catch (cause) {
        const nextError = toAuthError(cause);
        if (attempt === attemptRef.current) setError(nextError);
        throw nextError;
      }
    },
    [applySession, config],
  );

  const signOut = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    // Clear the local identity first: a failed network logout must never keep
    // the previous account's tokens (or UI) alive.
    generationRef.current += 1;
    attemptRef.current += 1;
    refreshInflightRef.current = null;
    applySession(null);
    setError(null);
    setRefreshRetry(null);
    setStatus(config === null ? "unconfigured" : "signed-out");
    await revokeStoredSession().catch(() => undefined);
    if (current !== null && config !== null) {
      try {
        await signOutRequest(config, current.accessToken);
      } catch {
        // Local sign-out is already complete; the server token expires on its own.
      }
    }
  }, [applySession, config]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current;
    if (config === null || current === null) return false;
    const inflight = refreshInflightRef.current;
    if (inflight !== null) return inflight;

    const generation = generationRef.current;
    const refreshToken = current.refreshToken;
    let task!: Promise<boolean>;
    task = (async (): Promise<boolean> => {
      try {
        const refreshed = await refreshStoredSession(config, {
          session: current,
          generation: sessionGenerationRef.current,
        });
        // A sign-out/account change may have landed while the grant was in
        // flight; never apply stale credentials to the new identity.
        if (generation !== generationRef.current) return false;
        const latest = sessionRef.current;
        if (latest === null || latest.refreshToken !== refreshToken) return false;
        if (refreshed === null) {
          const stored = await readStoredAuthSession();
          if (stored === null) {
            generationRef.current += 1;
            applySession(null);
            setStatus("signed-out");
            return false;
          }
          sessionGenerationRef.current = stored.generation;
          if (stored.session.refreshToken !== refreshToken) {
            applySession(stored.session);
            setStatus("signed-in");
            setError(null);
            setRefreshRetry(null);
            return true;
          }
          if (isSessionExpired(latest)) setStatus("error");
          setRefreshRetry((previous) => nextAuthRefreshRetry(previous));
          return false;
        }
        sessionGenerationRef.current = refreshed.generation;
        applySession(refreshed.session);
        setStatus("signed-in");
        setError(null);
        setRefreshRetry(null);
        return true;
      } catch (cause) {
        if (generation !== generationRef.current) return false;
        const latest = sessionRef.current;
        if (latest === null || latest.refreshToken !== refreshToken) return false;
        const nextError = toAuthError(cause);
        setError(nextError);
        if (isTransientAuthError(nextError)) {
          // Keep a still-valid token; only an expired one degrades to `error`.
          // Either way, schedule the next bounded-backoff retry so the app
          // recovers by itself once connectivity returns.
          if (isSessionExpired(latest)) setStatus("error");
          setRefreshRetry((previous) => nextAuthRefreshRetry(previous));
          return false;
        }
        generationRef.current += 1;
        applySession(null);
        setRefreshRetry(null);
        setStatus("signed-out");
        void revokeStoredSession(sessionGenerationRef.current).catch(() => undefined);
        return false;
      } finally {
        if (refreshInflightRef.current === task) refreshInflightRef.current = null;
      }
    })();
    refreshInflightRef.current = task;
    return task;
  }, [applySession, config]);

  // The AppState handler and the timer always call the latest refresh closure.
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Refresh proactively before expiry so a later authenticated request never
  // has to use a stale token. A temporary failure keeps ONE bounded-backoff
  // retry timer scheduled, including after the token expires and `status`
  // degrades to `error`, so the app recovers without backgrounding or
  // re-login. A definitive failure still signs out in `refresh`.
  useEffect(() => {
    const delay = authRefreshTimerDelayMs(status, session, refreshRetry);
    if (delay === null) return;
    const timer = setTimeout(() => {
      void refreshRef.current();
    }, delay);
    return () => clearTimeout(timer);
  }, [refreshRetry, session, status]);

  // Mobile timers are throttled/suspended in the background; re-check expiry
  // when the app returns to the foreground. A foreground event also resets the
  // transient-failure backoff, so a recovered connection starts fresh.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      setRefreshRetry(null);
      const current = sessionRef.current;
      if (current !== null && isSessionExpired(current)) void refreshRef.current();
    });
    return () => subscription.remove();
  }, []);

  // Unmount invalidates any in-flight restore/refresh so a late response cannot
  // write state after the provider is gone.
  useEffect(
    () => () => {
      generationRef.current += 1;
      refreshInflightRef.current = null;
    },
    [],
  );

  const getAccessToken = useCallback((): string | null => {
    return sessionRef.current?.accessToken ?? null;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      error,
      isConfigured: config !== null,
      signIn,
      signOut,
      refresh,
      getAccessToken,
    }),
    [config, error, getAccessToken, refresh, session, signIn, signOut, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside an AuthProvider.");
  return value;
}
