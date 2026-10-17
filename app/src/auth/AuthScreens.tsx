import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext.tsx";
import { clearExplicitSignOut, consumeReturnTarget, saveReturnTarget } from "./returnTarget.ts";
import {
  clearAuthHash,
  clearRecoveryToken,
  isPasswordSetupType,
  loadRecoveryToken,
  parseAuthCallbackHash,
  requestPasswordReset,
  saveRecoveryToken,
  updatePassword,
} from "./supabaseAuth.ts";

/**
 * Invite-only login UI. There is intentionally no sign-up form: registration
 * is disabled in Supabase (`enable_signup = false` locally and "Allow new
 * users to sign up" OFF in production) and accounts are created by invitation.
 */

export function SignInScreen() {
  const {
    signIn,
    signInAsGuest,
    guestSignInEnabled,
    status,
    user,
    authError,
    publicConfig,
    configError,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [guestPending, setGuestPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Remember where the user was when this gate appeared so a successful
  // sign-in returns there. The sanitizer rejects auth screens, so landing on
  // `/login` itself never stores a loop.
  useEffect(() => {
    saveReturnTarget(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);

  // Explicit sign-out clears its own target but keeps a short marker so the
  // protected gate cannot immediately re-capture the page being left. Once the
  // /login route has committed, release it so a later intentional visit to
  // that same page is captured normally.
  useEffect(() => {
    if (location.pathname !== "/login") return;
    const timer = window.setTimeout(clearExplicitSignOut, 0);
    return () => window.clearTimeout(timer);
  }, [location.pathname]);

  function returnAfterSignIn(): void {
    // Consume only after a successful sign-in: a failed attempt must keep the
    // target for the next try. Success also ends any explicit-sign-out
    // suppression so later deep links are captured normally.
    clearExplicitSignOut();
    navigate(consumeReturnTarget() ?? "/", { replace: true });
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      returnAfterSignIn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  async function onGuest(): Promise<void> {
    setGuestPending(true);
    setError(null);
    try {
      await signInAsGuest();
      returnAfterSignIn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Guest sign-in failed.");
    } finally {
      setGuestPending(false);
    }
  }

  // Only a verified guest (`isAnonymous === true`) triggers the replacement
  // warning; unclassified users are neither accounts nor guests.
  const signedInAsGuest = status === "signed-in" && user?.isAnonymous === true;
  const signedInAsAccount = status === "signed-in" && user?.isAnonymous === false;
  const guestDisabled =
    guestPending ||
    pending ||
    signedInAsGuest ||
    signedInAsAccount ||
    publicConfig === null ||
    guestSignInEnabled !== true;

  return (
    <section aria-labelledby="signin-heading">
      <h1 id="signin-heading">Sign in</h1>
      <p>
        Workout tracking is invite-only. If you were invited, sign in with your email and
        password below. There is no public registration — new accounts are created by
        invitation only.
      </p>
      {configError !== null ? (
        <div className="validation-summary" role="alert">
          <p>Login is unavailable: the server did not provide its public configuration.</p>
        </div>
      ) : null}
      {(error ?? authError?.message) !== null && (error ?? authError?.message) !== undefined ? (
        <div className="validation-summary" role="alert">
          <p>{error ?? authError?.message}</p>
        </div>
      ) : null}
      {signedInAsGuest ? (
        <div className="validation-warnings" role="note">
          <p>
            Signing in to an account replaces this browser session. Guest workouts are not
            merged or transferred.
          </p>
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button type="submit" disabled={pending || publicConfig === null}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <section className="signin-guest" aria-labelledby="guest-signin-heading">
        <h2 id="guest-signin-heading">Guest access</h2>
        <p>
          Guest data is tied to this browser and cannot be merged into an account later.
        </p>
        {guestSignInEnabled !== true ? (
          <p>
            {configError !== null
              ? "Guest sign-in is unavailable because login configuration failed to load."
              : "Guest sign-in is not enabled on this deployment."}
          </p>
        ) : null}
        {signedInAsAccount ? (
          <p>Sign out before starting a guest session; an account is never replaced by guest data.</p>
        ) : null}
        <button type="button" onClick={onGuest} disabled={guestDisabled}>
          Continue as guest
        </button>
      </section>
    </section>
  );
}

export function ForgotPasswordScreen() {
  const { publicConfig } = useAuth();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (publicConfig === null) {
      setError("Login is unavailable: the server did not provide its public configuration.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await requestPasswordReset(
        {
          supabaseUrl: publicConfig.supabaseUrl,
          publishableKey: publicConfig.supabasePublishableKey,
        },
        email.trim(),
        `${window.location.origin}/auth/callback`,
      );
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the reset email.");
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <section aria-labelledby="forgot-sent-heading">
        <h1 id="forgot-sent-heading">Check your email</h1>
        <p>
          If an account exists for {email}, a password-reset link is on its way. The link
          expires — use it promptly, then choose a new password.
        </p>
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="forgot-heading">
      <h1 id="forgot-heading">Reset your password</h1>
      <p>Enter your account email and we will send you a reset link.</p>
      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <button type="submit" disabled={pending || publicConfig === null}>
          {pending ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </section>
  );
}

/**
 * Resolve the password-setup token: the URL hash first (consumed into
 * tab-scoped storage + in-page memory and stripped from the address bar),
 * then the stored handoff. Tokens are never read from the query string.
 * The hash is consumed eagerly (see `ResetPasswordScreen` mount effect) so a
 * slow public config never leaves the token lingering in the address bar.
 */
function resolveResetToken(): string | null {
  const hashToken = parseAuthCallbackHash(window.location.hash)?.accessToken ?? null;
  if (hashToken !== null && hashToken !== "") {
    // Consume the hash immediately so the token never lingers in the URL
    // (history, screenshots, or referrers).
    saveRecoveryToken(hashToken);
    clearAuthHash();
    return hashToken;
  }
  const stored = loadRecoveryToken();
  if (stored !== null && stored !== "") return stored;
  return null;
}

export function ResetPasswordScreen() {
  const { publicConfig, configError } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configPending = publicConfig === null && configError === null;
  const configFailed = publicConfig === null && configError !== null;

  // Consume any direct `#access_token=…` hash on mount so the token leaves
  // the address bar immediately, even while the public config is still
  // loading. The stored handoff (or in-memory fallback) serves the submit.
  useEffect(() => {
    resolveResetToken();
  }, []);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (publicConfig === null) {
      setError(
        configError !== null
          ? "Login is unavailable: the server did not provide its public configuration."
          : "Still loading configuration. Wait a moment and try again.",
      );
      return;
    }
    const accessToken = resolveResetToken();
    if (accessToken === null) {
      setError("This reset link is invalid or expired. Request a new one.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await updatePassword(
        {
          supabaseUrl: publicConfig.supabaseUrl,
          publishableKey: publicConfig.supabasePublishableKey,
        },
        accessToken,
        password,
      );
      clearRecoveryToken();
      clearAuthHash();
      navigate("/login", { replace: true });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update the password.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="reset-heading">
      <h1 id="reset-heading">Choose a new password</h1>
      <p>Invited users set their first password here as well as password resets.</p>
      {configPending ? <p>Loading configuration…</p> : null}
      {configFailed ? (
        <div className="validation-summary" role="alert">
          <p>Login is unavailable: the server did not provide its public configuration.</p>
          <p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>{" "}
            <Link to="/forgot-password">Request a new link</Link>
          </p>
        </div>
      ) : null}
      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="reset-password">New password</label>
          <input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button type="submit" disabled={pending || publicConfig === null}>
          {pending ? "Updating…" : "Update password"}
        </button>
      </form>
    </section>
  );
}

/**
 * Handles Auth redirects (`/auth/callback`): implicit-hash invite/recovery
 * sessions route to `/reset-password` for password creation; anything else
 * goes home. The hash is consumed into tab-scoped storage and stripped from
 * the URL before navigating. No network or public config is needed — the
 * password is set on `/reset-password`, which reads the handed-off token.
 */
export function AuthCallbackScreen() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  // StrictMode double-invokes this effect on one mount: the first run
  // consumes the hash (stores the token, strips it from the URL), so the
  // second run must not re-read the now-empty hash and report the just
  // consumed link as expired.
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    const hashSession = parseAuthCallbackHash(window.location.hash);
    if (hashSession === null) {
      setError("This link is invalid or expired. Request a new one or sign in.");
      setPending(false);
      return;
    }
    if (hashSession.accessToken !== "") saveRecoveryToken(hashSession.accessToken);
    clearAuthHash();
    setPending(false);
    // Both invite and recovery links create a password through the same
    // reset form; other types (e.g. email confirmation) go home.
    if (isPasswordSetupType(hashSession.type)) navigate("/reset-password", { replace: true });
    else navigate("/", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-labelledby="callback-heading">
      <h1 id="callback-heading">Finishing sign-in…</h1>
      {pending ? <p>Verifying your link.</p> : null}
      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
          <p>
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}
