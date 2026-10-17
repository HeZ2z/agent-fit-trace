import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PublicApiConfig } from "@pi-fit-trace/api-contracts";
import { fetchPublicConfig } from "../api/publicConfig.ts";
import { markExplicitSignOut } from "./returnTarget.ts";
import {
  clearPendingGuestUpgrade,
  loadPendingGuestUpgrade,
  normalizeGuestUpgradeEmail,
  savePendingGuestUpgrade,
} from "./guestUpgrade.ts";
import type { PendingGuestUpgrade } from "./guestUpgrade.ts";
import {
  AUTH_STORAGE_KEY,
  beginGuestUpgrade as beginGuestUpgradeRequest,
  fetchAuthUser,
  isEmailVerificationType,
  isSessionExpired,
  isTransientAuthError,
  loadStoredSession,
  refreshSession,
  serializeSession,
  signInAnonymously,
  signInWithPassword,
  signOut,
} from "./supabaseAuth.ts";
import type { CallbackSession, SupabaseAuthUser, SupabaseSession } from "./supabaseAuth.ts";
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
  /**
   * Create (or reuse) a verified anonymous guest session. Single-flight:
   * concurrent calls share one request. A failed attempt leaves any existing
   * verified session untouched. Guests are never cloud-eligible.
   */
  signInAsGuest: () => Promise<void>;
  signOutSession: () => Promise<void>;
  /** Refresh the session once (used after a 401 on reads; writes never auto-retry). */
  refresh: () => Promise<boolean>;
  /** Re-read `/auth/v1/user` for the current session (classification + email). */
  refreshVerifiedUser: () => Promise<SupabaseAuthUser | null>;
  /** Deployment readiness for guest entry (`public-config` explicit true only). */
  guestSignInEnabled: boolean;
  /**
   * True when the deployment requires CAPTCHA for guest entry. This client has
   * no CAPTCHA widget, so guest entry fails closed instead of sending a
   * request that cannot pass.
   */
  guestSignInCaptchaRequired: boolean;
  /** Deployment readiness for invited guest upgrades (default false). */
  guestUpgradeEnabled: boolean;
  /** Tab-scoped pending upgrade; pending until callback verification. */
  pendingGuestUpgrade: PendingGuestUpgrade | null;
  /**
   * Request an invited email change on the current verified guest session.
   * An identical pending target is a no-op unless `{ resend: true }` is passed
   * by an explicit user action.
   */
  beginGuestUpgrade: (email: string, options?: { resend?: boolean }) => Promise<void>;
  /**
   * Apply the callback only when its token verifies the same UID, a
   * non-anonymous user, and the pending confirmed email. Never replaces a
   * different current identity, and never reports success for a pending email.
   */
  completeGuestUpgrade: (callback: CallbackSession) => Promise<PendingGuestUpgrade>;
  /**
   * After password setup, re-fetch `/auth/v1/user`, require the same expected
   * UID plus the pending confirmed email, and only then clear the marker.
   * Returns false (and keeps the pending marker) if the identity changed.
   */
  finishGuestUpgrade: (expectedUserId: string) => Promise<boolean>;
}

/** localStorage access isolated for tests (jsdom provides it; guard for SSR). */
function readStoredSession(): SupabaseSession | null {
  try {
    return loadStoredSession(globalThis.localStorage?.getItem(AUTH_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * Unverified guest credentials are kept separately from the authoritative
 * session until `GET /auth/v1/user` succeeds. They survive a reload so a
 * transient verification outage can be retried without creating a second
 * anonymous user.
 */
const GUEST_CANDIDATE_STORAGE_KEY = "pi-fit-trace:auth:v1:guest-candidate";

function readStoredGuestCandidate(): SupabaseSession | null {
  try {
    return loadStoredSession(globalThis.localStorage?.getItem(GUEST_CANDIDATE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

function writeStoredGuestCandidate(session: SupabaseSession | null): void {
  try {
    if (session === null) globalThis.localStorage?.removeItem(GUEST_CANDIDATE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(GUEST_CANDIDATE_STORAGE_KEY, serializeSession(session));
  } catch {
    // Storage failures only cost reload recovery; in-memory state still wins.
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

/**
 * Bounded backoff for transient refresh retries: 5s, 10s, 20s, 40s, then
 * capped at 60s. Only the credential refresh is retried — never a workout
 * read or write.
 */
const REFRESH_RETRY_BASE_MS = 5_000;
const REFRESH_RETRY_CAP_MS = 60_000;

function refreshRetryDelayMs(failures: number): number {
  const shift = Math.min(Math.max(failures - 1, 0), 4);
  return Math.min(REFRESH_RETRY_BASE_MS * 2 ** shift, REFRESH_RETRY_CAP_MS);
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
    initialSession !== undefined
      ? initialSession
      : () => readStoredSession() ?? readStoredGuestCandidate(),
  );
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [pendingGuestUpgrade, setPendingGuestUpgrade] = useState<PendingGuestUpgrade | null>(
    () => loadPendingGuestUpgrade(),
  );
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
  // Attempt epoch: bumped by every password/guest sign-in. An attempt only
  // applies its result while it is still the newest attempt, so a slow first
  // click can never replace a later identity (or a logout).
  const authAttemptRef = useRef(0);
  // Upgrade initiation epoch: clearing the marker or completing an upgrade
  // invalidates a late response so it cannot write state for a newer identity.
  const upgradeAttemptRef = useRef(0);
  // Serialize the Auth mutation. Identical concurrent requests share this
  // promise; a different target while one is in flight is rejected instead of
  // sending a second PUT that could race the server's email_change target.
  const upgradeInflightRef = useRef<{
    email: string;
    attempt: number;
    promise: Promise<void>;
  } | null>(null);
  // Single-flight slot for guest creation: repeated clicks share one network
  // request, so a double click cannot create two anonymous users.
  const guestInflightRef = useRef<Promise<void> | null>(null);
  // Guest credentials that exist server-side but are not yet verified. Kept in
  // a ref for same-mount retries and mirrored to storage for reload retries.
  const guestCandidateRef = useRef<SupabaseSession | null>(readStoredGuestCandidate());
  const refreshInflightRef = useRef<Promise<boolean> | null>(null);
  // Bounded retry state for transient refresh failures. The timer only ever
  // re-runs the credential refresh; logout, sign-in/account-switch, and
  // unmount clear it, and a fired task never clears a newer one (id check).
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerIdRef = useRef(0);
  const transientFailuresRef = useRef(0);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);

  const effectiveConfig = publicConfigProp ?? publicConfig;

  /** Keep the ref synchronous with state so same-tick token reads never go stale. */
  const setSessionSync = useCallback((next: SupabaseSession | null): void => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const clearGuestCandidate = useCallback((): void => {
    guestCandidateRef.current = null;
    writeStoredGuestCandidate(null);
  }, []);

  const clearGuestUpgrade = useCallback((): void => {
    // Invalidate any in-flight initiation as part of clearing. This keeps a
    // late G response from restoring a pending marker after logout/switch.
    upgradeAttemptRef.current += 1;
    upgradeInflightRef.current = null;
    clearPendingGuestUpgrade();
    setPendingGuestUpgrade(null);
  }, []);

  /** Cancel a pending refresh retry and invalidate its fired task, if any. */
  const clearRefreshRetry = useCallback(() => {
    retryTimerIdRef.current += 1;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  /** Reset the backoff (on success, logout, or account change). */
  const resetRefreshRetry = useCallback(() => {
    transientFailuresRef.current = 0;
    clearRefreshRetry();
  }, [clearRefreshRetry]);

  /** Schedule the next credential-only retry with bounded exponential backoff. */
  const scheduleRefreshRetry = useCallback(() => {
    transientFailuresRef.current += 1;
    const delay = refreshRetryDelayMs(transientFailuresRef.current);
    const generation = generationRef.current;
    const id = retryTimerIdRef.current + 1;
    retryTimerIdRef.current = id;
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    const timer = setTimeout(() => {
      // A superseded task must never clear or fire for a newer schedule.
      if (retryTimerIdRef.current !== id) return;
      if (retryTimerRef.current === timer) retryTimerRef.current = null;
      if (generationRef.current !== generation) return;
      if (sessionRef.current === null) return;
      // Shared single-flight refresh: a manual retry coalesces onto the
      // same network request instead of dispatching a second one.
      void refreshRef.current();
    }, delay);
    retryTimerRef.current = timer;
  }, []);

  // Bootstrap the public Supabase config from the server (runtime, not
  // build-time `VITE_*`): the app cannot start a login without it. This fetch
  // is independent of the session generation epoch — a cross-tab sign-out (or
  // any auth task) must never discard the config response, or bootstrap would
  // hang in `loading` forever. Only the effect-local `cancelled` flag (config
  // override / unmount / StrictMode remount) drops a stale response. Auth
  // tasks keep their own generation guards below.
  useEffect(() => {
    if (skipBootstrap || publicConfigProp !== undefined) return;
    let cancelled = false;
    fetchPublicConfig("/api/v1", fetchImpl).then(
      (config) => {
        if (cancelled) return;
        setPublicConfig(config);
        setConfigError(null);
        setBootstrapped(true);
      },
      (error: unknown) => {
        if (cancelled) return;
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

  // Cross-tab identity changes: another tab signing in, switching accounts, or
  // refreshing replaces the stored session here too. A non-null value is
  // untrusted until this tab revalidates it against `/auth/v1/user`; the
  // generation bump drops any refresh/validation still running for the old
  // identity. Same-tab writes never fire this event.
  useEffect(() => {
    function onStorage(event: StorageEvent): void {
      if (event.key !== AUTH_STORAGE_KEY) return;
      if (event.newValue === null) {
        generationRef.current += 1;
        refreshInflightRef.current = null;
        resetRefreshRetry();
        clearGuestCandidate();
        clearGuestUpgrade();
        setSessionSync(null);
        setValidatedIdentity((prev) => (skipAsyncValidation ? prev : null));
        return;
      }
      const next = loadStoredSession(event.newValue);
      if (next === null) return;
      const current = sessionRef.current;
      if (current !== null && sessionIdentity(current) === sessionIdentity(next)) return;
      generationRef.current += 1;
      refreshInflightRef.current = null;
      resetRefreshRetry();
      clearGuestCandidate();
      clearGuestUpgrade();
      setSessionSync(next);
      setAuthError(null);
      setValidatedIdentity((prev) => (skipAsyncValidation ? prev : null));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [
    clearGuestCandidate,
    clearGuestUpgrade,
    resetRefreshRetry,
    setSessionSync,
    skipAsyncValidation,
  ]);

  // A pending upgrade belongs to exactly one guest identity. Any logout,
  // account switch, or cross-tab identity replacement drops it instead of
  // letting a later callback attach to a different user.
  useEffect(() => {
    if (pendingGuestUpgrade === null) return;
    if (session === null || session.user.id !== pendingGuestUpgrade.userId) {
      clearGuestUpgrade();
    }
  }, [clearGuestUpgrade, pendingGuestUpgrade, session]);

  // Unmount invalidates in-flight refreshes (generation bump) and clears a
  // pending retry timer, so a late 503/network failure can never schedule
  // new retries in the background. StrictMode-safe: the simulated
  // unmount/remount runs effects fresh and the second mount captures the new
  // generation for its own retries.
  useEffect(
    () => () => {
      generationRef.current += 1;
      refreshInflightRef.current = null;
      clearRefreshRetry();
    },
    [clearRefreshRetry],
  );

  const getAccessToken = useCallback((): string | null => {
    return sessionRef.current?.accessToken ?? null;
  }, []);

  const applySessionIfCurrent = useCallback(
    (
      generation: number,
      refreshToken: string | null,
      next: SupabaseSession | null,
      validated = true,
    ): boolean => {
      if (generationRef.current !== generation) return false;
      // Account B must never be overwritten by account A's late refresh: the
      // refresh token still in state must be the one that was refreshed.
      if (next !== null && refreshToken !== null) {
        const current = sessionRef.current;
        if (current !== null && current.refreshToken !== refreshToken) return false;
      }
      setSessionSync(next);
      setValidatedIdentity(
        next === null ? null : validated ? (sessionIdentity(next) ?? "validated") : null,
      );
      if (next !== null && validated) clearGuestCandidate();
      return true;
    },
    [clearGuestCandidate, setSessionSync],
  );

  const resolveConfig = useCallback(async (): Promise<PublicApiConfig> => {
    const resolved = publicConfigProp ?? publicConfig ?? (await fetchPublicConfig("/api/v1", fetchImpl));
    if (publicConfig === null && publicConfigProp === undefined) setPublicConfig(resolved);
    return resolved;
  }, [fetchImpl, publicConfig, publicConfigProp]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const attempt = authAttemptRef.current + 1;
      authAttemptRef.current = attempt;
      // Deliberately do NOT bump the session generation yet: if this account
      // login fails, an already-valid guest session (and its scheduled
      // refresh) must survive untouched. The epoch advances only when the
      // verified replacement session is applied.
      const generation = generationRef.current;
      try {
        const resolved = await resolveConfig();
        if (attempt !== authAttemptRef.current || generationRef.current !== generation) return;
        const tokenSession = await signInWithPassword(
          { supabaseUrl: resolved.supabaseUrl, publishableKey: resolved.supabasePublishableKey },
          email,
          password,
          fetchImpl,
        );
        // Token responses never classify. Only the verified user endpoint is
        // authoritative for is_anonymous (account vs guest).
        const verified = await fetchAuthUser(
          { supabaseUrl: resolved.supabaseUrl, publishableKey: resolved.supabasePublishableKey },
          tokenSession.accessToken,
          fetchImpl,
        );
        if (attempt !== authAttemptRef.current || generationRef.current !== generation) return;
        generationRef.current += 1;
        refreshInflightRef.current = null;
        resetRefreshRetry();
        clearGuestCandidate();
        clearGuestUpgrade();
        const reconciled: SupabaseSession = { ...tokenSession, user: verified };
        setSessionSync(reconciled);
        setValidatedIdentity(sessionIdentity(reconciled) ?? "validated");
        setAuthError(null);
      } catch (error) {
        if (attempt !== authAttemptRef.current || generationRef.current !== generation) return;
        const err =
          error instanceof AuthError ? error : new AuthError("SIGN_IN_FAILED", "Sign-in failed.");
        setAuthError(err);
        throw err;
      }
    },
    [clearGuestCandidate, clearGuestUpgrade, fetchImpl, resolveConfig, resetRefreshRetry, setSessionSync],
  );

  /**
   * Guest sign-in. Guarded by the public deployment capability (default off),
   * shared across concurrent clicks, and applied atomically only while its
   * attempt + generation are current. A failure leaves any existing session
   * intact and never creates a second anonymous user on retry after success.
   */
  const signInAsGuest = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current !== null && current.user.isAnonymous === true) return;
    const candidate = guestCandidateRef.current ?? readStoredGuestCandidate();
    // A guest entry must never overwrite an existing, different identity. The
    // only exception is retrying verification of our own unverified candidate.
    if (current !== null && (candidate === null || current.user.id !== candidate.user.id)) {
      throw new AuthError("GUEST_SIGN_IN_FAILED", "Sign out before starting a guest session.");
    }
    const inflight = guestInflightRef.current;
    if (inflight !== null) return inflight;

    const attempt = authAttemptRef.current + 1;
    authAttemptRef.current = attempt;
    const generation = generationRef.current;
    let task!: Promise<void>;
    task = (async () => {
      try {
        const resolved = await resolveConfig();
        if (attempt !== authAttemptRef.current || generationRef.current !== generation) return;
        if (resolved.guestSignInEnabled !== true || resolved.guestSignInCaptchaRequired === true) {
          throw new AuthError(
            "GUEST_SIGN_IN_DISABLED",
            resolved.guestSignInCaptchaRequired === true
              ? "Guest sessions require CAPTCHA, which this app does not support yet."
              : "Guest sessions are not enabled on this deployment.",
          );
        }
        const config = {
          supabaseUrl: resolved.supabaseUrl,
          publishableKey: resolved.supabasePublishableKey,
        };
        const existingCandidate = guestCandidateRef.current ?? readStoredGuestCandidate();
        let next: SupabaseSession;
        if (existingCandidate !== null) {
          // A previous POST already created this guest; retry only the
          // authoritative verification, never another signup.
          guestCandidateRef.current = existingCandidate;
          try {
            const verified = await fetchAuthUser(config, existingCandidate.accessToken, fetchImpl);
            next = { ...existingCandidate, user: verified };
          } catch (error) {
            if (!isTransientAuthError(error)) {
              // Expired/revoked candidate cannot be verified; forget it so the
              // next explicit guest entry can start cleanly.
              clearGuestCandidate();
              if (
                sessionRef.current !== null &&
                sessionRef.current.user.id === existingCandidate.user.id
              ) {
                setSessionSync(null);
                setValidatedIdentity(null);
              }
            }
            throw error;
          }
        } else {
          next = await signInAnonymously(config, fetchImpl, {
            onCandidate: (created) => {
              if (attempt !== authAttemptRef.current || generationRef.current !== generation) {
                return;
              }
              guestCandidateRef.current = created;
              writeStoredGuestCandidate(created);
            },
          });
        }
        // Re-check guards before replacing identity. Success ends the
        // candidate state: the verified session is now authoritative.
        if (attempt !== authAttemptRef.current || generationRef.current !== generation) return;
        generationRef.current += 1;
        refreshInflightRef.current = null;
        resetRefreshRetry();
        clearGuestCandidate();
        setSessionSync(next);
        setValidatedIdentity(sessionIdentity(next) ?? "validated");
        setAuthError(null);
      } catch (error) {
        if (attempt !== authAttemptRef.current || generationRef.current !== generation) return;
        const err =
          error instanceof AuthError
            ? error
            : new AuthError("GUEST_SIGN_IN_FAILED", "Guest sign-in failed.");
        setAuthError(err);
        throw err;
      } finally {
        if (guestInflightRef.current === task) guestInflightRef.current = null;
      }
    })();
    guestInflightRef.current = task;
    return task;
  }, [clearGuestCandidate, fetchImpl, resetRefreshRetry, resolveConfig, setSessionSync]);

  /**
   * Step 1 of the invited upgrade: request an email change on the current
   * verified guest. The account is NOT upgraded here; the pending target is
   * tab-scoped and only the verified callback can complete it. Repeating the
   * same pending email is idempotent and does not send another email.
   */
  const beginGuestUpgrade = useCallback(
    async (email: string, options: { resend?: boolean } = {}): Promise<void> => {
      const target = normalizeGuestUpgradeEmail(email);
      const resend = options.resend === true;
      if (target === "") {
        const invalid = new AuthError(
          "GUEST_UPGRADE_INVALID_EMAIL",
          "Enter a valid email address.",
        );
        setAuthError(invalid);
        throw invalid;
      }

      if (
        upgradeInflightRef.current !== null &&
        upgradeInflightRef.current.attempt !== upgradeAttemptRef.current
      ) {
        // A switch/logout invalidated the owner; the old request may still be
        // unwinding, but it can no longer block a new identity.
        upgradeInflightRef.current = null;
      }
      const inflight = upgradeInflightRef.current;
      if (inflight !== null) {
        if (inflight.email === target) return inflight.promise;
        throw new AuthError(
          "GUEST_UPGRADE_IN_FLIGHT",
          "Wait for the current verification link request to finish before trying another email.",
        );
      }

      const attempt = upgradeAttemptRef.current + 1;
      upgradeAttemptRef.current = attempt;
      // Snapshot before the first await: a switch/logout during config lookup
      // invalidates this request even if the Auth call later succeeds.
      const generation = generationRef.current;
      const stale = (): boolean =>
        attempt !== upgradeAttemptRef.current || generationRef.current !== generation;

      const task = (async (): Promise<void> => {
        try {
          const current = sessionRef.current;
          if (current === null || current.user.isAnonymous !== true) {
            throw new AuthError(
              "GUEST_UPGRADE_REQUIRES_GUEST",
              "Only a verified guest session can be upgraded.",
            );
          }
          const resolved = await resolveConfig();
          if (stale()) {
            throw new AuthError("GUEST_UPGRADE_SUPERSEDED", "A newer request replaced this one.");
          }
          if (resolved.guestUpgradeEnabled !== true) {
            throw new AuthError(
              "GUEST_UPGRADE_DISABLED",
              "Guest account upgrades are not enabled on this deployment.",
            );
          }
          const latest = sessionRef.current;
          if (
            latest === null ||
            latest.user.id !== current.user.id ||
            latest.user.isAnonymous !== true
          ) {
            throw new AuthError(
              "GUEST_UPGRADE_REQUIRES_GUEST",
              "The guest session changed. Try again.",
            );
          }

          // Same pending target: the link may already have been sent by this
          // tab. Do not duplicate the email unless the user explicitly chose
          // Resend; normal retries stay idempotent.
          const existing = loadPendingGuestUpgrade();
          if (
            !resend &&
            existing !== null &&
            existing.userId === latest.user.id &&
            existing.email === target &&
            !existing.verified
          ) {
            if (!stale()) setPendingGuestUpgrade(existing);
            return;
          }

          const origin = typeof window === "undefined" ? "" : window.location.origin;
          await beginGuestUpgradeRequest(
            {
              supabaseUrl: resolved.supabaseUrl,
              publishableKey: resolved.supabasePublishableKey,
            },
            latest.accessToken,
            target,
            fetchImpl,
            origin === "" ? {} : { emailRedirectTo: `${origin}/auth/callback` },
          );
          if (stale()) {
            throw new AuthError("GUEST_UPGRADE_SUPERSEDED", "A newer request replaced this one.");
          }
          const after = sessionRef.current;
          if (after === null || after.user.id !== latest.user.id) {
            throw new AuthError("GUEST_UPGRADE_FAILED", "The guest session changed. Try again.");
          }

          const pending: PendingGuestUpgrade = {
            userId: after.user.id,
            email: target,
            verified: false,
            startedAt: Date.now(),
          };
          savePendingGuestUpgrade(pending);
          setPendingGuestUpgrade(pending);
          setAuthError(null);
        } catch (error) {
          const err =
            error instanceof AuthError
              ? error
              : new AuthError("GUEST_UPGRADE_FAILED", "Could not start the account upgrade.");
          // A superseded request must never paint an error on the replacement
          // identity or account. The caller may still observe its rejection.
          if (!stale()) setAuthError(err);
          throw err;
        }
      })();

      upgradeInflightRef.current = { email: target, attempt, promise: task };
      try {
        await task;
      } finally {
        if (upgradeInflightRef.current?.promise === task) upgradeInflightRef.current = null;
      }
    },
    [fetchImpl, resolveConfig],
  );

  /**
   * Step 2: verify the callback against the Auth server. The callback token
   * must resolve to the exact pending user id and a non-anonymous,
   * email-confirmed user whose email matches the pending target. A wrong-UID
   * callback leaves the current guest session untouched; a still-pending email
   * is never reported as a completed upgrade.
   */
  const completeGuestUpgrade = useCallback(
    async (callback: CallbackSession): Promise<PendingGuestUpgrade> => {
      const pending = loadPendingGuestUpgrade();
      if (pending === null) {
        throw new AuthError(
          "GUEST_UPGRADE_NOT_PENDING",
          "Open the verification link in the tab where you started the account upgrade.",
        );
      }
      if (!isEmailVerificationType(callback.type)) {
        throw new AuthError("GUEST_UPGRADE_INVALID_CALLBACK", "This link is not an email-change link.");
      }
      if (callback.refreshToken === "") {
        throw new AuthError("GUEST_UPGRADE_INVALID_CALLBACK", "This link is missing its session.");
      }
      const current = sessionRef.current;
      if (current === null || current.user.id !== pending.userId) {
        throw new AuthError(
          "GUEST_UPGRADE_IDENTITY_MISMATCH",
          "This verification link belongs to a different session. Your current session was not changed.",
        );
      }

      const resolved = await resolveConfig();
      if (resolved.guestUpgradeEnabled !== true) {
        throw new AuthError(
          "GUEST_UPGRADE_DISABLED",
          "Guest account upgrades are not enabled on this deployment.",
        );
      }
      const generation = generationRef.current;
      const latest = sessionRef.current;
      if (
        generationRef.current !== generation ||
        latest === null ||
        latest.user.id !== pending.userId
      ) {
        throw new AuthError(
          "GUEST_UPGRADE_IDENTITY_MISMATCH",
          "The current session changed before verification completed.",
        );
      }

      // The only authoritative source for the result is GET /auth/v1/user
      // with the callback access token; hash claims are never trusted.
      const verified = await fetchAuthUser(
        {
          supabaseUrl: resolved.supabaseUrl,
          publishableKey: resolved.supabasePublishableKey,
        },
        callback.accessToken,
        fetchImpl,
      );
      if (verified.id !== pending.userId) {
        throw new AuthError(
          "GUEST_UPGRADE_IDENTITY_MISMATCH",
          "This verification link belongs to a different user. Your current session was not changed.",
        );
      }
      if (verified.isAnonymous !== false) {
        throw new AuthError(
          "GUEST_UPGRADE_NOT_READY",
          "The email is still pending verification. Your guest session is unchanged.",
        );
      }
      const verifiedEmail = normalizeGuestUpgradeEmail(verified.email ?? "");
      if (verifiedEmail === "" || verifiedEmail !== pending.email) {
        throw new AuthError(
          "GUEST_UPGRADE_EMAIL_MISMATCH",
          "The verified email does not match the pending upgrade.",
        );
      }
      if (verified.emailConfirmedAt === undefined) {
        throw new AuthError(
          "GUEST_UPGRADE_EMAIL_UNVERIFIED",
          "The email address is not confirmed yet.",
        );
      }
      if (generationRef.current !== generation) {
        throw new AuthError(
          "GUEST_UPGRADE_IDENTITY_MISMATCH",
          "The current session changed before verification completed.",
        );
      }

      const next: SupabaseSession = {
        accessToken: callback.accessToken,
        refreshToken: callback.refreshToken,
        expiresAt:
          callback.expiresAt > 0 ? callback.expiresAt : Date.now() + 60 * 60 * 1000,
        // Only the verified fields above are accepted into the applied session.
        user: verified,
      };
      // Same user id throughout: this is an in-place account upgrade, never a
      // login switch and never an owner/data migration.
      generationRef.current += 1;
      authAttemptRef.current += 1;
      upgradeAttemptRef.current += 1;
      refreshInflightRef.current = null;
      resetRefreshRetry();
      clearGuestCandidate();
      setSessionSync(next);
      setValidatedIdentity(sessionIdentity(next) ?? "validated");
      setAuthError(null);

      const verifiedPending: PendingGuestUpgrade = { ...pending, verified: true };
      savePendingGuestUpgrade(verifiedPending);
      setPendingGuestUpgrade(verifiedPending);
      return verifiedPending;
    },
    [clearGuestCandidate, fetchImpl, resetRefreshRetry, resolveConfig, setSessionSync],
  );

  /**
   * Re-read `/auth/v1/user` without changing identity or tokens.
   *
   * This is also the original-tab resume path after an email link was opened
   * elsewhere: when the authoritative record is the same UID, non-anonymous,
   * confirmed, and matches the pending target, the pending marker is promoted
   * so the UI can offer password setup. A different UID is never applied.
   */
  const refreshVerifiedUser = useCallback(async (): Promise<SupabaseAuthUser | null> => {
    const generation = generationRef.current;
    const current = sessionRef.current;
    if (current === null) return null;
    const resolved = await resolveConfig();
    if (generationRef.current !== generation) return null;
    const verified = await fetchAuthUser(
      {
        supabaseUrl: resolved.supabaseUrl,
        publishableKey: resolved.supabasePublishableKey,
      },
      current.accessToken,
      fetchImpl,
    );
    if (generationRef.current !== generation) return null;
    // The provider response is authoritative, but it may only refresh the
    // same local identity. A compromised/misrouted response for another UUID
    // must never replace the current session.
    if (verified.id !== current.user.id) return null;
    const latest = sessionRef.current;
    if (
      latest === null ||
      latest.user.id !== current.user.id ||
      latest.accessToken !== current.accessToken
    ) {
      return null;
    }
    const next: SupabaseSession = { ...latest, user: verified };
    setSessionSync(next);
    setValidatedIdentity(sessionIdentity(next) ?? "validated");
    if (verified.isAnonymous !== current.user.isAnonymous) {
      // Classification changed under an in-flight initiation. Invalidate it so
      // a late PUT response cannot overwrite the promoted pending marker.
      upgradeAttemptRef.current += 1;
    }

    const pending = loadPendingGuestUpgrade();
    if (
      pending !== null &&
      pending.userId === verified.id &&
      !pending.verified &&
      verified.isAnonymous === false &&
      verified.emailConfirmedAt !== undefined &&
      normalizeGuestUpgradeEmail(verified.email ?? "") === pending.email
    ) {
      const promoted: PendingGuestUpgrade = { ...pending, verified: true };
      savePendingGuestUpgrade(promoted);
      setPendingGuestUpgrade(promoted);
    }
    return verified;
  }, [fetchImpl, resolveConfig, setSessionSync]);

  /**
   * Final password step guard. The password update itself uses the verified
   * session, but its async response may arrive after a switch/logout. Re-fetch
   * and require the same expected UUID and pending confirmed email before
   * clearing anything, so B's state is never completed/navigated by A.
   */
  const finishGuestUpgrade = useCallback(
    async (expectedUserId: string): Promise<boolean> => {
      const verified = await refreshVerifiedUser();
      if (verified === null || verified.id !== expectedUserId) return false;
      if (verified.isAnonymous !== false || verified.emailConfirmedAt === undefined) return false;
      const latest = sessionRef.current;
      const pending = loadPendingGuestUpgrade();
      if (
        latest === null ||
        latest.user.id !== expectedUserId ||
        pending === null ||
        pending.userId !== expectedUserId ||
        !pending.verified
      ) {
        return false;
      }
      if (normalizeGuestUpgradeEmail(verified.email ?? "") !== pending.email) return false;
      clearGuestUpgrade();
      return true;
    },
    [clearGuestUpgrade, refreshVerifiedUser],
  );

  const signOutSession = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    const config = publicConfigProp ?? publicConfig;
    // Bump the epoch first so every pending restore/refresh/sign-in/guest
    // attempt is ignored, then clear local state so the previous user's data
    // can never flash, even if the network sign-out fails.
    generationRef.current += 1;
    authAttemptRef.current += 1;
    guestInflightRef.current = null;
    guestCandidateRef.current = null;
    writeStoredGuestCandidate(null);
    clearGuestUpgrade();
    refreshInflightRef.current = null;
    resetRefreshRetry();
    markExplicitSignOut(window.location.pathname);
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
  }, [
    clearGuestUpgrade,
    fetchImpl,
    publicConfig,
    publicConfigProp,
    resetRefreshRetry,
    setSessionSync,
  ]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current;
    const config = publicConfigProp ?? publicConfig;
    if (current === null || config === null) return false;
    const inflight = refreshInflightRef.current;
    if (inflight !== null) return inflight;
    const generation = generationRef.current;
    const refreshToken = current.refreshToken;
    let task!: Promise<boolean>;
    task = (async (): Promise<boolean> => {
      try {
        const next = await refreshSession(
          { supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey },
          refreshToken,
          fetchImpl,
        );
        // A logout/account switch may have happened while the token grant was
        // in flight: drop it before spending a verified-user request on a
        // stale identity.
        if (generationRef.current !== generation) return false;
        {
          const latest = sessionRef.current;
          if (latest === null || latest.refreshToken !== refreshToken) return false;
        }
        // Refresh responses carry an unclassified user: only the verified
        // `/auth/v1/user` call may set account vs guest. Reuse the fresh
        // token for that check before releasing the signed-in gate.
        let verified: SupabaseAuthUser;
        try {
          verified = await fetchAuthUser(
            { supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey },
            next.accessToken,
            fetchImpl,
          );
        } catch (error) {
          if (generationRef.current !== generation) return false;
          const latest = sessionRef.current;
          if (latest !== null && latest.refreshToken !== refreshToken) return false;
          if (isTransientAuthError(error)) {
            // The refreshed tokens are usable, but classification is still
            // unknown. Keep the session unvalidated (fail closed) and let the
            // bounded credential retry re-run verification.
            const applied = applySessionIfCurrent(generation, refreshToken, next, false);
            if (applied) {
              setAuthError(
                error instanceof AuthError
                  ? error
                  : new AuthError("AUTH_UNAVAILABLE", "The sign-in service is unavailable. Try again.", 503),
              );
              scheduleRefreshRetry();
            }
            return false;
          }
          throw error;
        }
        const merged: SupabaseSession = { ...next, user: verified };
        const applied = applySessionIfCurrent(generation, refreshToken, merged, true);
        if (applied) {
          // Recovery: backoff resets and a cleared AUTH_UNAVAILABLE lets the
          // outage notice disappear. Later business requests resolve the new
          // token per request — earlier failed calls are never replayed.
          resetRefreshRetry();
          setAuthError((prev) =>
            prev !== null && prev.code === "AUTH_UNAVAILABLE" ? null : prev,
          );
        }
        return applied;
      } catch (error) {
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
          // Keep the session and retry only the credential refresh on a
          // bounded backoff; workout requests are never re-dispatched here.
          scheduleRefreshRetry();
          return false;
        }
        const err =
          error instanceof AuthError
            ? error
            : new AuthError("SESSION_EXPIRED", "Your session expired. Please sign in again.");
        resetRefreshRetry();
        clearGuestCandidate();
        setAuthError(err);
        setSessionSync(null);
        setValidatedIdentity(null);
        return false;
      } finally {
        // Never clear a newer request's entry: only drop the slot when this
        // task is still the inflight one.
        if (refreshInflightRef.current === task) refreshInflightRef.current = null;
      }
    })();
    refreshInflightRef.current = task;
    return task;
  }, [
    applySessionIfCurrent,
    clearGuestCandidate,
    fetchImpl,
    publicConfig,
    publicConfigProp,
    resetRefreshRetry,
    scheduleRefreshRetry,
    setSessionSync,
  ]);

  // The retry timer always calls the latest refresh (stable single-flight).
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

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
        clearGuestCandidate();
      } catch (error) {
        if (cancelled || generationRef.current !== generation) return;
        // Transient Auth outages must not log the user out: leave the
        // session unvalidated with a recoverable error and let the UI retry.
        // A bounded credential-only retry is also scheduled so recovery does
        // not depend on a manual click; refresh() marks a recovered session
        // validated, which releases the loading gate.
        if (isTransientAuthError(error)) {
          setAuthError(
            error instanceof AuthError
              ? error
              : new AuthError("AUTH_UNAVAILABLE", "The sign-in service is unavailable. Try again.", 503),
          );
          scheduleRefreshRetry();
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

  const guestSignInCaptchaRequired =
    effectiveConfig?.guestSignInCaptchaRequired === true;
  // CAPTCHA-enabled deployments fail closed here because this UI has no
  // widget; the transport alone cannot complete that deployment's challenge.
  const guestSignInEnabled =
    effectiveConfig?.guestSignInEnabled === true && !guestSignInCaptchaRequired;
  const guestUpgradeEnabled = effectiveConfig?.guestUpgradeEnabled === true;

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
      signInAsGuest,
      signOutSession,
      refresh,
      refreshVerifiedUser,
      guestSignInEnabled,
      guestSignInCaptchaRequired,
      guestUpgradeEnabled,
      pendingGuestUpgrade,
      beginGuestUpgrade,
      completeGuestUpgrade,
      finishGuestUpgrade,
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
      signInAsGuest,
      signOutSession,
      refresh,
      refreshVerifiedUser,
      guestSignInEnabled,
      guestSignInCaptchaRequired,
      guestUpgradeEnabled,
      pendingGuestUpgrade,
      beginGuestUpgrade,
      completeGuestUpgrade,
      finishGuestUpgrade,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used within an <AuthProvider>.");
  return value;
}
