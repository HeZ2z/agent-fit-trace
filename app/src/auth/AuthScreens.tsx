import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext.tsx";
import { clearExplicitSignOut, consumeReturnTarget, saveReturnTarget } from "./returnTarget.ts";
import {
  clearAuthHash,
  clearRecoveryToken,
  isEmailVerificationType,
  isPasswordSetupType,
  loadRecoveryToken,
  parseAuthCallbackHash,
  requestPasswordReset,
  saveRecoveryToken,
  updatePassword,
} from "./supabaseAuth.ts";
import { useI18n } from "../i18n/useI18n.ts";

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
    guestSignInCaptchaRequired,
    status,
    user,
    authError,
    publicConfig,
    configError,
    authSurface,
  } = useAuth();
  const { t } = useI18n();
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
      setError(caught instanceof Error ? caught.message : t("Sign-in failed."));
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
      setError(caught instanceof Error ? caught.message : t("Guest sign-in failed."));
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

  if (status === "loading") {
    return <section aria-label={t("Loading")}><p>{t("Loading…")}</p></section>;
  }

  // Guest-local has no identity provider at all: the sign-in form, the reset
  // link, and the guest entry button would all submit against the empty
  // Supabase config fields. Render the truthful unconfigured state instead of
  // any submittable form.
  if (authSurface === "guest-local") {
    return (
      <section className="auth-screen" aria-labelledby="signin-heading">
        <h1 id="signin-heading">{t("Sign in")}</h1>
        <div className="validation-summary" role="alert">
          <p>
            {t(
              "Sign-in is not configured on this deployment. This daemon runs in local guest mode, so there is no account sign-in.",
            )}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-screen" aria-labelledby="signin-heading">
      <h1 id="signin-heading">{t("Sign in")}</h1>
      <p>
        {t(
          "Accounts are invite-only. If you were invited, sign in with your email and password below; there is no public registration. Workout tracking is available as a guest when the deployment enables guest access.",
        )}
      </p>
      {configError !== null ? (
        <div className="validation-summary" role="alert">
          <p>{t("Login is unavailable: the server did not provide its public configuration.")}</p>
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
            {t(
              "Signing in to an account replaces this browser session. Guest workouts are not merged or transferred.",
            )}
          </p>
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="signin-email">{t("Email")}</label>
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
          <label htmlFor="signin-password">{t("Password")}</label>
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
          {pending ? t("Signing in…") : t("Sign in")}
        </button>
      </form>
      <p>
        <Link to="/forgot-password">{t("Forgot your password?")}</Link>
      </p>
      {authSurface === "daemon-optional" ? (
        <section className="signin-guest">
          <p>{t("Your local guest workouts remain on this machine and are not transferred or uploaded when you sign in.")}</p>
          <Link to="/">{t("Return to local guest")}</Link>
        </section>
      ) : <section className="signin-guest" aria-labelledby="guest-signin-heading">
        <h2 id="guest-signin-heading">{t("Guest access")}</h2>
        <p>
          {t("Guest data is tied to this browser and cannot be merged into an account later.")}
        </p>
        {guestSignInCaptchaRequired ? (
          <p>
            {t(
              "Guest sign-in requires CAPTCHA on this deployment. This app does not yet include a CAPTCHA widget, so guest entry is disabled rather than sending a request that cannot pass.",
            )}
          </p>
        ) : guestSignInEnabled !== true ? (
          <p>
            {configError !== null
              ? t("Guest sign-in is unavailable because login configuration failed to load.")
              : t("Guest sign-in is not enabled on this deployment.")}
          </p>
        ) : null}
        {signedInAsAccount ? (
          <p>
            {t(
              "Sign out before starting a guest session; an account is never replaced by guest data.",
            )}
          </p>
        ) : null}
        <button type="button" onClick={onGuest} disabled={guestDisabled}>
          {t("Continue as guest")}
        </button>
      </section>}
    </section>
  );
}

export function ForgotPasswordScreen() {
  const { publicConfig } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (publicConfig === null) {
      setError(t("Login is unavailable: the server did not provide its public configuration."));
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
      setError(caught instanceof Error ? caught.message : t("Could not send the reset email."));
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <section className="auth-screen" aria-labelledby="forgot-sent-heading">
        <h1 id="forgot-sent-heading">{t("Check your email")}</h1>
        <p>
          {t(
            "If an account exists for {email}, a password-reset link is on its way. The link expires — use it promptly, then choose a new password.",
            { email },
          )}
        </p>
        <p>
          <Link to="/login">{t("Back to sign in")}</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="auth-screen" aria-labelledby="forgot-heading">
      <h1 id="forgot-heading">{t("Reset your password")}</h1>
      <p>{t("Enter your account email and we will send you a reset link.")}</p>
      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="forgot-email">{t("Email")}</label>
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
          {pending ? t("Sending…") : t("Send reset link")}
        </button>
      </form>
      <p>
        <Link to="/login">{t("Back to sign in")}</Link>
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
  const { publicConfig, configError, session, pendingGuestUpgrade, finishGuestUpgrade, authSurface } =
    useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configPending = publicConfig === null && configError === null;
  const configFailed = publicConfig === null && configError !== null;
  // A verified upgrade is a signed-in account without a password yet. The
  // callback stored this marker only after same-UID/verified-email checks;
  // password setup is the last step, and the marker is not cleared before it.
  const upgradePending = pendingGuestUpgrade !== null && pendingGuestUpgrade.verified;
  const upgradeSessionMatches =
    pendingGuestUpgrade !== null &&
    upgradePending &&
    session !== null &&
    session.user.id === pendingGuestUpgrade.userId;

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
          ? t("Login is unavailable: the server did not provide its public configuration.")
          : t("Still loading configuration. Wait a moment and try again."),
      );
      return;
    }
    let accessToken: string | null;
    let upgradeUserId: string | null = null;
    if (upgradePending) {
      if (!upgradeSessionMatches || session === null || pendingGuestUpgrade === null) {
        setError(
          t(
            "Open this page in the tab where the email was verified. Your current session was not changed.",
          ),
        );
        return;
      }
      accessToken = session.accessToken;
      upgradeUserId = pendingGuestUpgrade.userId;
    } else {
      accessToken = resolveResetToken();
    }
    if (accessToken === null) {
      setError(t("This reset link is invalid or expired. Request a new one."));
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
      if (upgradePending && upgradeUserId !== null) {
        // The update response can arrive after a switch/logout. Re-fetch and
        // require the same UID + pending confirmed email before clearing the
        // marker or navigating; a failed check leaves the pending state.
        const finished = await finishGuestUpgrade(upgradeUserId);
        if (!finished) {
          setError(
            t(
              "The password was saved, but this session changed before the upgrade could be confirmed. The pending upgrade was kept; reopen this tab to finish.",
            ),
          );
          return;
        }
      }
      clearRecoveryToken();
      clearAuthHash();
      if (upgradePending) {
        // Password setup is the final upgrade step; only now is the pending
        // marker cleared. The account already kept the guest's same UID.
        navigate("/", { replace: true });
      } else {
        navigate("/login", { replace: true });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not update the password."));
    } finally {
      setPending(false);
    }
  }

  // Guest-local has no identity provider: a password reset or first-password
  // setup would target an auth host that does not exist on this deployment
  // (the empty Supabase config fields). Render the truthful unconfigured
  // state instead of a submittable form.
  if (authSurface === "guest-local") {
    return (
      <section className="auth-screen" aria-labelledby="reset-heading">
        <h1 id="reset-heading">{t("Choose a new password")}</h1>
        <div className="validation-summary" role="alert">
          <p>
            {t(
              "Password reset is not configured on this deployment. This daemon runs in local guest mode, so there is no account password to reset.",
            )}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-screen" aria-labelledby="reset-heading">
      <h1 id="reset-heading">
        {upgradePending ? t("Finish your account setup") : t("Choose a new password")}
      </h1>
      {upgradePending ? (
        <p>
          {t(
            "Your email is verified and this guest session now has an account. Set a password to finish. Your existing workout history stays attached to this same user; nothing is merged into another account.",
          )}
        </p>
      ) : (
        <p>{t("Invited users set their first password here as well as password resets.")}</p>
      )}
      {configPending ? <p>{t("Loading configuration…")}</p> : null}
      {configFailed ? (
        <div className="validation-summary" role="alert">
          <p>{t("Login is unavailable: the server did not provide its public configuration.")}</p>
          <p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>{" "}
            <Link to="/forgot-password">Request a new link</Link>
          </p>
        </div>
      ) : null}
      {upgradePending && !upgradeSessionMatches ? (
        <div className="validation-summary" role="alert">
          <p>
            {t(
              "This verified upgrade belongs to the tab that started it. Open this page in that tab; your current session was not changed.",
            )}
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
          <label htmlFor="reset-password">{t("New password")}</label>
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
          {pending
            ? t("Updating…")
            : upgradePending
              ? t("Set password")
              : t("Update password")}
        </button>
      </form>
    </section>
  );
}

/**
 * Handles Auth redirects (`/auth/callback`): implicit-hash invite/recovery
 * sessions route to `/reset-password` for password creation; anything else
 * goes home. The hash is consumed into tab-scoped storage and stripped from
 * the URL before navigating. Email-change callbacks go through the same-UID
 * pending-upgrade verifier and require the Auth server; invite/recovery only
 * hand off the token locally.
 */
export function AuthCallbackScreen() {
  const { completeGuestUpgrade } = useAuth();
  const { t } = useI18n();
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
      setError(t("This link is invalid or expired. Request a new one or sign in."));
      setPending(false);
      return;
    }

    // Email-change/confirmation callbacks are only applied through the
    // same-UID pending-upgrade verifier. The token is stripped from the URL
    // immediately either way; it is never handed to the ordinary
    // recovery-token flow.
    if (isEmailVerificationType(hashSession.type)) {
      clearAuthHash();
      void completeGuestUpgrade(hashSession).then(
        () => {
          setPending(false);
          navigate("/reset-password", { replace: true });
        },
        (caught: unknown) => {
          setPending(false);
          setError(
            caught instanceof Error
              ? caught.message
              : t(
                  "This verification link could not be applied. Your current session was not changed.",
                ),
          );
        },
      );
      return;
    }

    if (hashSession.accessToken !== "") saveRecoveryToken(hashSession.accessToken);
    clearAuthHash();
    setPending(false);
    // Invite and recovery links create a password through the same reset form.
    if (isPasswordSetupType(hashSession.type)) navigate("/reset-password", { replace: true });
    else navigate("/", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="auth-screen" aria-labelledby="callback-heading">
      <h1 id="callback-heading">{t("Finishing sign-in…")}</h1>
      {pending ? <p>{t("Verifying your link.")}</p> : null}
      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
          <p>
            <Link to="/login">{t("Back to sign in")}</Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}
