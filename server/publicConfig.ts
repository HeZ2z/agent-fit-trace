/**
 * Server-only public bootstrap configuration.
 *
 * The browser needs the Supabase project URL and publishable key to start a
 * login, but `VITE_*` variables are build-time baked. The API serves them at
 * runtime from server environment instead, so no `NEXT_PUBLIC`-to-`VITE`
 * magic is required. Secret keys are never included here: values that look
 * like `sb_secret_…` or a JWT with `role: service_role` are rejected so an
 * env mistake cannot leak the service role to the browser.
 */

export interface ServerPublicConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  /**
   * Anonymous guest sign-in readiness. Defaults to false; only an explicit
   * `FIT_TRACE_GUEST_SIGN_IN=1` enables it, and that must stay unset until the
   * live guest profile has been verified.
   */
  guestSignInEnabled?: boolean;
  /**
   * Invited guest-upgrade readiness. Defaults to false; only an explicit
   * `FIT_TRACE_GUEST_UPGRADE=1` enables it after the narrow Auth trigger and
   * real email-confirmation flow have been verified live.
   */
  guestUpgradeEnabled?: boolean;
  /**
   * Explicitly declare that anonymous sign-in requires a CAPTCHA token. The
   * current browser UI has no CAPTCHA widget, so it fails closed instead of
   * pretending the request can pass. Operators must set this flag when
   * Supabase CAPTCHA is enabled for anonymous sign-ups.
   */
  guestSignInCaptchaRequired?: boolean;
}

function isRejectedKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payloadJson = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const payload = JSON.parse(payloadJson) as { role?: unknown };
      if (payload.role === "service_role") return true;
    } catch {
      // Leave unparseable values to fail closed below only on exact matches.
    }
  }
  return false;
}

export function getPublicConfig(
  env: Record<string, string | undefined> = process.env,
): ServerPublicConfig | null {
  const supabaseUrl = env.SUPABASE_URL;
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (supabaseUrl === undefined || supabaseUrl === "") return null;
  if (supabasePublishableKey === undefined || supabasePublishableKey === "") return null;
  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (isRejectedKey(supabasePublishableKey)) return null;
  return {
    supabaseUrl,
    supabasePublishableKey,
    // Guest capability is opt-in and default-false: an unset/typo value must
    // never advertise anonymous sign-up readiness.
    guestSignInEnabled: env.FIT_TRACE_GUEST_SIGN_IN === "1",
    guestUpgradeEnabled: env.FIT_TRACE_GUEST_UPGRADE === "1",
    guestSignInCaptchaRequired: env.FIT_TRACE_GUEST_CAPTCHA_REQUIRED === "1",
  };
}
