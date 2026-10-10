import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PublicApiConfig } from "@pi-fit-trace/api-contracts";
import { fetchPublicConfig } from "../api/publicConfig.ts";
import {
  AUTH_STORAGE_KEY,
  fetchAuthUser,
  isSessionExpired,
  isTransientAuthError,
  loadStoredSession,
  refreshSession,
  serializeSession,
  signInWithPassword,
  signOut,
} from "./supabaseAuth.ts";
import type { SupabaseAuthUser, SupabaseSession } from "./supabaseAuth.ts";
import { AuthError } from "./supabaseAuth.ts";

export interface AuthContextValue {
  status: "loading" | "signed-out" | "signed-in";
  session: SupabaseSession | null;
  user: SupabaseAuthUser | null;
  publicConfig: PublicApiConfig | null;
  configError: Error | null;
  authError: AuthError | null;
  /** True while a restored session is being validated against the Auth server. */
  validatingSession: boolean;
  /** Current access token for the HTTP credential provider (null when signed out). */
  getAccessToken: () => string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOutSession: () => Promise<void>;
  /** Refresh the session once (used after a 401 on reads; writes never auto-retry). */
  refresh: () => Promise<boolean>;
}

/** localStorage access isolated for tests (jsdom provides it; guard for SSR). */
function readStoredSession(): SupabaseSession | null {
  try {
    return loadStoredSession(globalThis.localStorage?.getItem(AUTH_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

function writeStoredSession(session: SupabaseSession | null): void {
  try {
    if (session === null) globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
    else globalThis.localStorage?.setItem(AUTH_STORAGE_KEY, serializeSession(session));
  } catch {
    // Storage failures must not break auth state; the in-memory session wins.
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Overrides for tests: public config, fetch, and initial session. */
  publicConfig?: PublicApiConfig | null;
  fetchImpl?: typeof fetch;
  initialSession?: SupabaseSession | null;
  skipBootstrap?: boolean;
  /**
   * Skip async session validation (tests + browser-local mode). HTTP
   * production always validates the restored session before leaving
   * `loading`.
   */
  skipValidation?: boolean;
}

function sessionIdentity(session: SupabaseSession | null): string | null {
  return session === null ? null : `${session.user.id}:${session.accessToken}`;
}

export function AuthProvider({
  children,
  publicConfig: publicConfigProp,
  fetchImpl = fetch,
  initialSession,
  skipBootstrap = false,
  skipValidation,
}: AuthProviderProps) {
  const skipAsyncValidation = skipValidation ?? skipBootstrap;
  const [publicConfig, setPublicConfig] = useState<PublicApiConfig | null>(
    publicConfigProp ?? null,
  );
  const [configError, setConfigError] = useState<Error | null>(null);
  const [session, setSession] = useState<SupabaseSession | null>(
    initialSession !== undefined ? initialSession : () => readStoredSession(),
  );
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [bootstrapped, setBootstrapped] = useState(skipBootstrap || publicConfigProp !== undefined);
  // A restored session is untrusted until the Auth server confirms it. While
  // unvalidated the provider reports `loading` so protected screens never
  // flash signed-in state for a revoked token.
  const [validatedIdentity, setValidatedIdentity] = useState<string | null>(
    skipAsyncValidation ? "skipped" : null,
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Generation epoch: every logout/sign-in/account-switch bumps it, and every
  // pending async auth result is ignored unless its generation is still
  // current. This blocks A-refresh-replacing-B and post-logout restores.
  const generationRef = useRef(0);
  const refreshInflightRef = useRef<Promise<boolean> | null>(null);

  const effectiveConfig = publicConfigProp ?? publicConfig;

  /** Keep the ref synchronous with state so same-tick token reads never go stale. */
  const setSessionSync = useCallback((next: SupabaseSession | null): void => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  // Bootstrap the public Supabase config from the server (runtime, not
  // build-time `VITE_*`): the app cannot start a login without it.
  useEffect(() => {
    if (skipBootstrap || publicConfigProp !== undefined) return;
    let cancelled = false;
    const generation = generationRef.current;
    fetchPublicConfig("/api/v1", fetchImpl).then(
      (config) => {
        if (cancelled || generationRef.current !== generation) return;
        setPublicConfig(config);
        setConfigError(null);
        setBootstrapped(true);
      },
      (error: unknown) => {
        if (cancelled || generationRef.current !== generation) return;
        setConfigError(error instanceof Error ? error : new Error(String(error)));
        setBootstrapped(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, publicConfigProp, skipBootstrap]);

  // Persist the session; clearing storage on sign-out is part of the
  // account-change guarantee (no previous user's tokens linger).
  useEffect(() => {
    writeStoredSession(session);
  }, [session]);

  // Cross-tab sign-out: another tab clearing the stored session signs this
  // tab out too (bumping the generation so its pending refreshes are dropped).
  useEffect(() => {
    function onStorage(event: StorageEvent): void {
      if (event.key !== AUTH_STORAGE_KEY) return;
      if (event.newValue !== null) return;
      generationRef.current += 1;
      refreshInflightRef.current = null;
      setSessionSync(null);
      setValidatedIdentity((prev) => (skipAsyncValidation ? prev : null));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setSessionSync, skipAsyncValidation]);

  const getAccessToken = useCallback((): string | null => {
    return sessionRef.current?.accessToken ?? null;
  }, []);

  const applySessionIfCurrent = useCallback(
    (generation: number, refreshToken: string | null, next: SupabaseSession | null): boolean => {
      if (generationRef.current !== generation) return false;
      // Account B must never be overwritten by account A's late refresh: the
      // refresh token still in state must be the one that was refreshed.
      if (next !== null && refreshToken !== null) {
        const current = sessionRef.current;
        if (current !== null && current.refreshToken !== refreshToken) return false;
      }
      setSessionSync(next);
      setValidatedIdentity(next === null ? null : (sessionIdentity(next) ?? "validated"));
      return true;
    },
    [setSessionSync],
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      refreshInflightRef.current = null;
      const resolved = publicConfigProp ?? publicConfig ?? (await fetchPublicConfig("/api/v1", fetchImpl));
      if (generationRef.current !== generation) {
        throw new AuthError("SIGN_IN_FAILED", "Sign-in was superseded.");
      }
      if (publicConfig === null && publicConfigProp === undefined) setPublicConfig(resolved);
      try {
        const next = await signInWithPassword(
          { supabaseUrl: resolved.supabaseUrl, publishableKey: resolved.supabasePublishableKey },
          email,
          password,
          fetchImpl,
        );
        if (generationRef.current !== generation) return;
        setSessionSync(next);
        setValidatedIdentity(sessionIdentity(next) ?? "validated");
        setAuthError(null);
      } catch (error) {
        if (generationRef.current !== generation) return;
        const err =
          error instanceof AuthError ? error : new AuthError("SIGN_IN_FAILED", "Sign-in failed.");
        setAuthError(err);
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchImpl, publicConfig, publicConfigProp],
  );

  const signOutSession = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    const config = publicConfigProp ?? publicConfig;
    // Bump the epoch first so every pending restore/refresh/sign-in is
    // ignored, then clear local state so the previous user's data can never
    // flash, even if the network sign-out fails.
    generationRef.current += 1;
    refreshInflightRef.current = null;
    setSessionSync(null);
    setAuthError(null);
    setValidatedIdentity(null);
    if (current !== null && config !== null) {
      try {
        await signOut(
          { supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey },
          current.accessToken,
          fetchImpl,
        );
      } catch {
        // Local state is already cleared; a server-side failure only means
        // the refresh token may survive server-side until expiry.
      }
    }
  }, [fetchImpl, publicConfig, publicConfigProp, setSessionSync]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current;
    const config = publicConfigProp ?? publicConfig;
    if (current === null || config === null) return false;
    const inflight = refreshInflightRef.current;
    if (inflight !== null) return inflight;
    const generation = generationRef.current;
    const refreshToken = current.refreshToken;
    const task = refreshSession(
      { supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey },
      refreshToken,
      fetchImpl,
    ).then(
      (next) => {
        // Never clear a newer request's entry: only drop the slot when this
        // task is still the inflight one.
        if (refreshInflightRef.current === task) refreshInflightRef.current = null;
        return applySessionIfCurrent(generation, refreshToken, next);
      },
      (error: unknown) => {
        if (refreshInflightRef.current === task) refreshInflightRef.current = null;
        // A failed refresh signs out only when nothing superseded it — and
        // never on transient Auth outages: the session is preserved with a
        // recoverable error so the UI can retry instead of logging out.
        if (generationRef.current !== generation) return false;
        const latest = sessionRef.current;
        if (latest !== null && latest.refreshToken !== refreshToken) return false;
        if (isTransientAuthError(error)) {
          setAuthError(
            error instanceof AuthError
              ? error
              : new AuthError("AUTH_UNAVAILABLE", "The sign-in service is unavailable. Try again.", 503),
          );
          return false;
        }
        const err =
          error instanceof AuthError
            ? error
            : new AuthError("SESSION_EXPIRED", "Your session expired. Please sign in again.");
        setAuthError(err);
        setSessionSync(null);
        setValidatedIdentity(null);
        return false;
      },
    );
    refreshInflightRef.current = task;
    return task;
  }, [applySessionIfCurrent, fetchImpl, publicConfig, publicConfigProp, setSessionSync]);

  // Validate a restored session once the config is known: an expired or
  // revoked token signs out locally instead of failing later on first write.
  // The verified `getUser` response reconciles the stored user (id/email).
  // Transient Auth outages preserve the session with a recoverable
  // `AUTH_UNAVAILABLE` error (retry via `refresh()`) instead of signing out.
  useEffect(() => {
    if (skipAsyncValidation) return;
    const config = publicConfigProp ?? publicConfig;
    const current = session;
    if (!bootstrapped || config === null || current === null) return;
    const identity = sessionIdentity(current);
    if (identity !== null && validatedIdentity === identity) return;
    const generation = generationRef.current;
    // Narrowed copies: the async work below must use these, never the
    // nullable state values (which change across awaits).
    const validatingConfig = config;
    const validatingSessionValue = current;
    let cancelled = false;
    async function validate(): Promise<void> {
      if (isSessionExpired(validatingSessionValue)) {
        // Shared refresh promise: validation and manual refresh() calls
        // coalesce onto one network request.
        await refresh();
        return;
      }
      try {
        const verified = await fetchAuthUser(
          {
            supabaseUrl: validatingConfig.supabaseUrl,
            publishableKey: validatingConfig.supabasePublishableKey,
          },
          validatingSessionValue.accessToken,
          fetchImpl,
        );
        if (cancelled || generationRef.current !== generation) return;
        const latest = sessionRef.current;
        if (latest === null || latest.accessToken !== validatingSessionValue.accessToken) return;
        const reconciled: SupabaseSession = { ...latest, user: verified };
        setSessionSync(reconciled);
        setValidatedIdentity(sessionIdentity(reconciled));
      } catch (error) {
        if (cancelled || generationRef.current !== generation) return;
        // Transient Auth outages must not log the user out: leave the
        // session unvalidated with a recoverable error and let the UI retry.
        if (isTransientAuthError(error)) {
          setAuthError(
            error instanceof AuthError
              ? error
              : new AuthError("AUTH_UNAVAILABLE", "The sign-in service is unavailable. Try again.", 503),
          );
          return;
        }
        // Try one shared refresh before giving up; a failed refresh signs out.
        // refresh() is shared + generation-guarded, so concurrent callers
        // coalesce and a superseded account is never overwritten.
        await refresh();
      }
    }
    void validate();
    return () => {
      cancelled = true;
    };
    // Run once per session/config identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped, effectiveConfig, session, validatedIdentity, skipAsyncValidation]);

  // Proactively refresh the access token before it expires so requests never
  // use a stale token. The timer is keyed by the session identity; any
  // account change clears it via the effect cleanup.
  useEffect(() => {
    if (skipAsyncValidation || session === null) return;
    if (session.expiresAt === 0) return;
    const delay = session.expiresAt - Date.now() - 60_000;
    if (delay <= 0) {
      void refresh();
      return;
    }
    const timer = setTimeout(() => {
      void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [refresh, session, skipAsyncValidation]);

  const configUnavailable =
    bootstrapped && !skipAsyncValidation && (publicConfigProp ?? publicConfig) === null;

  const validatingSession =
    !skipAsyncValidation &&
    !configUnavailable &&
    session !== null &&
    validatedIdentity !== sessionIdentity(session);

  // A missing/failed public config fails closed: report signed-out (the
  // stored session is preserved in state for a later retry once the config
  // loads) instead of holding the loading gate forever on a validation that
  // can never run. `RequireAuth` turns the null config into the
  // login-unavailable notice.
  const status: AuthContextValue["status"] = !bootstrapped
    ? "loading"
    : validatingSession
      ? "loading"
      : session === null || configUnavailable
        ? "signed-out"
        : "signed-in";

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      publicConfig: publicConfigProp ?? publicConfig,
      configError,
      authError,
      validatingSession,
      getAccessToken,
      signIn,
      signOutSession,
      refresh,
    }),
    [
      status,
      session,
      publicConfig,
      publicConfigProp,
      configError,
      authError,
      validatingSession,
      getAccessToken,
      signIn,
      signOutSession,
      refresh,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used within an <AuthProvider>.");
  return value;
}
