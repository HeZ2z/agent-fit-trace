import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  OAuthConsentError,
  fetchOAuthAuthorization,
  isValidAuthorizationId,
  submitOAuthConsent,
} from "../auth/oauthConsent.ts";
import type { OAuthAuthorizationRequest } from "../auth/oauthConsent.ts";
import { useI18n } from "../i18n/useI18n.ts";

/**
 * Remote-MCP OAuth consent screen (`/oauth/consent?authorization_id=<uuid>`).
 *
 * Supabase's OAuth server redirects the browser here after a remote MCP client
 * starts an authorization. The screen shows who is asking (client name and
 * URI), which scopes it wants, and where the user will be sent afterwards;
 * Approve/Deny then posts the decision and follows ONLY the `redirect_url` the
 * server returns (see `oauthConsent.ts` — no URL is ever built here).
 *
 * Guardrails kept on purpose:
 * - The details live in component state only: loaded per mount, dropped on
 *   unmount, never in module globals or storage.
 * - A decision is single-flight: the in-flight ref (not just the disabled
 *   attribute) blocks a second POST from a double click or double submit.
 * - A missing/invalid/expired `authorization_id` is a rendered error, never a
 *   crash and never a request to a guessed path.
 */

/** Auth/session failures are already fixed, redacted strings (never a body). */
function messageFor(error: unknown, fallback: string): string {
  if (error instanceof OAuthConsentError) return error.message;
  return fallback;
}

/**
 * Signed-out gate for the consent route.
 *
 * The shared `SignInScreen` is not reused here: it stores its post-login
 * target through `returnTarget.ts`, whose allow-list is a closed set of app
 * routes that deliberately excludes this one, and its success path navigates
 * away to that target. Keeping the form inline leaves the consent URL (and its
 * `authorization_id`) exactly as the OAuth server sent it, so signing in
 * continues the same request instead of replaying a rewritten one.
 */
function ConsentSignIn() {
  const { signIn, publicConfig, authSurface, configError } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (authSurface === "guest-local") {
    return (
      <div className="validation-summary" role="alert">
        <p>
          {t(
            "This deployment has no account sign-in, so remote app authorization is unavailable.",
          )}
        </p>
      </div>
    );
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // The provider commits the session; this screen re-renders signed-in and
      // the effect above loads the details for the SAME authorization id.
      await signIn(email.trim(), password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Sign-in failed."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p>
        {t(
          "Sign in to review this authorization request. The request stays open on this page.",
        )}
      </p>
      {configError !== null ? (
        <div className="validation-summary" role="alert">
          <p>{t("Login is unavailable: the server did not provide its public configuration.")}</p>
        </div>
      ) : null}
      {error !== null ? (
        <div className="validation-summary" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="consent-email">{t("Email")}</label>
          <input
            id="consent-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="consent-password">{t("Password")}</label>
          <input
            id="consent-password"
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
    </>
  );
}

export function OAuthConsentScreen() {
  const { status, authSurface, publicConfig, session } = useAuth();
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const authorizationId = searchParams.get("authorization_id") ?? "";

  const [details, setDetails] = useState<OAuthAuthorizationRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deciding, setDeciding] = useState<null | "approve" | "deny">(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // The decision is recorded; the browser is leaving for the client callback.
  const [redirecting, setRedirecting] = useState(false);

  // Synchronous single-flight lock: React state updates are batched, so the
  // disabled attribute alone cannot stop a double click from dispatching two
  // consents in the same tick.
  const decisionInFlight = useRef(false);
  const accessToken = session?.accessToken ?? null;
  const canLoad =
    status === "signed-in" &&
    authSurface !== "guest-local" &&
    publicConfig !== null &&
    accessToken !== null &&
    isValidAuthorizationId(authorizationId);

  // Load once per mount/identity; a stale response from an unmounted screen (or
  // from a superseded identity) is dropped instead of written into state.
  useEffect(() => {
    if (!canLoad || publicConfig === null || accessToken === null) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDetails(null);
    fetchOAuthAuthorization(
      {
        supabaseUrl: publicConfig.supabaseUrl,
        publishableKey: publicConfig.supabasePublishableKey,
      },
      authorizationId,
      accessToken,
    ).then(
      (loaded) => {
        if (cancelled) return;
        setDetails(loaded);
        setLoading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setDetails(null);
        setLoadError(messageFor(error, t("Could not load this authorization request.")));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // `t` is stable per language; re-running on a language switch would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad, authorizationId, accessToken, publicConfig]);

  const decide = useCallback(
    async (action: "approve" | "deny"): Promise<void> => {
      // The lock is never released after a recorded decision: the consent is
      // single-use, and a browser that is slow to unload must not be able to
      // post a second one from the same screen.
      if (decisionInFlight.current) return;
      if (publicConfig === null || accessToken === null) return;
      decisionInFlight.current = true;
      setDeciding(action);
      setDecisionError(null);
      let redirectUrl: string;
      try {
        redirectUrl = await submitOAuthConsent(
          {
            supabaseUrl: publicConfig.supabaseUrl,
            publishableKey: publicConfig.supabasePublishableKey,
          },
          authorizationId,
          accessToken,
          action,
        );
      } catch (error) {
        // Nothing was recorded: release the lock so the user can retry.
        decisionInFlight.current = false;
        setDeciding(null);
        setDecisionError(messageFor(error, t("Could not record your decision. Try again.")));
        return;
      }
      setRedirecting(true);
      // The ONLY destination this screen will ever follow: the URL the server
      // returned for this decision. No client-side construction.
      window.location.assign(redirectUrl);
    },
    [accessToken, authorizationId, publicConfig, t],
  );

  // Missing or malformed id: state the problem, do not call the server.
  if (!isValidAuthorizationId(authorizationId)) {
    return (
      <section className="auth-screen" aria-labelledby="oauth-consent-heading">
        <h1 id="oauth-consent-heading">{t("Authorize an app")}</h1>
        <div className="validation-summary" role="alert">
          <p>
            {t(
              "This consent link is missing a valid authorization request. Return to the app that asked for access and start again.",
            )}
          </p>
        </div>
      </section>
    );
  }

  const heading = (
    <h1 id="oauth-consent-heading">{t("Authorize an app")}</h1>
  );

  if (status === "loading") {
    return (
      <section className="auth-screen" aria-label={t("Loading")}>
        <p>{t("Loading…")}</p>
      </section>
    );
  }

  if (status !== "signed-in") {
    return (
      <section className="auth-screen" aria-labelledby="oauth-consent-heading">
        {heading}
        <ConsentSignIn />
      </section>
    );
  }

  if (publicConfig === null) {
    return (
      <section className="auth-screen" aria-labelledby="oauth-consent-heading">
        {heading}
        <div className="validation-summary" role="alert">
          <p>{t("Login is unavailable: the server did not provide its public configuration.")}</p>
        </div>
      </section>
    );
  }

  if (authSurface === "guest-local") {
    return (
      <section className="auth-screen" aria-labelledby="oauth-consent-heading">
        {heading}
        <div className="validation-summary" role="alert">
          <p>
            {t(
              "This deployment has no account sign-in, so remote app authorization is unavailable.",
            )}
          </p>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="auth-screen" aria-labelledby="oauth-consent-heading">
        {heading}
        <p>{t("Loading the authorization request…")}</p>
      </section>
    );
  }

  if (loadError !== null || details === null) {
    return (
      <section className="auth-screen" aria-labelledby="oauth-consent-heading">
        {heading}
        <div className="validation-summary" role="alert">
          <p>{loadError ?? t("Could not load this authorization request.")}</p>
        </div>
      </section>
    );
  }

  const clientName = details.client.name ?? details.client.id;
  const busy = deciding !== null || redirecting;

  return (
    <section className="auth-screen" aria-labelledby="oauth-consent-heading">
      {heading}
      <p>
        {t("{client} wants to connect to your Agent Fit Trace training data.", {
          client: clientName,
        })}
      </p>
      <dl className="consent-details">
        <dt>{t("App")}</dt>
        <dd>{clientName}</dd>
        {details.client.uri === undefined ? null : (
          <>
            <dt>{t("App website")}</dt>
            <dd>{details.client.uri}</dd>
          </>
        )}
        <dt>{t("Requested access")}</dt>
        <dd>
          {details.scopes.length === 0
            ? t("No scopes were requested.")
            : details.scopes.join(", ")}
        </dd>
        {details.redirectUri === undefined ? null : (
          <>
            <dt>{t("After you decide, you will be sent to")}</dt>
            <dd>{details.redirectUri}</dd>
          </>
        )}
      </dl>
      <div className="validation-warnings" role="note">
        <p>
          {t(
            "Approving lets this app read and write your own training records: your workout history, analysis results, and draft training plans. It cannot see another user's data.",
          )}
        </p>
      </div>
      {decisionError !== null ? (
        <div className="validation-summary" role="alert">
          <p>{decisionError}</p>
        </div>
      ) : null}
      {redirecting ? (
        <p role="status">{t("Sending you back to the app…")}</p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void decide("approve");
        }}
      >
        <button type="submit" disabled={busy}>
          {deciding === "approve" ? t("Approving…") : t("Approve access")}
        </button>{" "}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void decide("deny");
          }}
        >
          {deciding === "deny" ? t("Denying…") : t("Deny")}
        </button>
      </form>
    </section>
  );
}
