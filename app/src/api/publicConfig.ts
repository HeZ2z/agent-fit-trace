import type { PublicApiConfig } from "@agent-fit-trace/api-contracts";
import { MalformedResponseError } from "@agent-fit-trace/api-contracts";

/**
 * Fetch the public bootstrap config (`GET /api/v1/public-config`).
 *
 * This endpoint is intentionally unauthenticated: the browser needs the
 * Supabase URL + publishable key before it can start a login. Only those two
 * public fields are accepted — anything else is rejected as malformed so a
 * misconfigured server cannot leak secrets through this path. Keys that look
 * like `sb_secret_…` or a JWT with `role: service_role` are rejected
 * client-side as well, so an env mistake cannot publish the service role.
 *
 * Additive daemon fields (issue #39): the standalone local daemon answers
 * `GET /api/v1/public-config` with `daemon: true` and `auth_configured`
 * instead of the Supabase fields when no project is configured. Both markers
 * are optional strict booleans; a payload without them parses exactly as
 * before (Vercel/launcher paths unchanged). A `daemon: true,
 * auth_configured: false` payload is guest-local mode: it legitimately has no
 * Supabase fields, so the config carries empty Supabase strings that no
 * Supabase code path may consume (see `resolveAuthSurface` in
 * `authSurface.ts` — every sign-in/refresh path is refused before the fields
 * are read).
 */

function isRejectedKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(payload)) as { role?: unknown };
      if (json.role === "service_role") return true;
    } catch {
      // Unparseable — leave to the shape checks; only definite matches reject.
    }
  }
  return false;
}

export function isSafeSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchPublicConfig(
  baseUrl = "/api/v1",
  fetchImpl: typeof fetch = fetch,
): Promise<PublicApiConfig> {
  const response = await fetchImpl(`${baseUrl}/public-config`, {
    headers: { Accept: "application/json" },
  });
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    throw new MalformedResponseError("(root)", "is not valid JSON");
  }
  if (!response.ok) {
    const code =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error?: { code?: unknown } }).error?.code ?? "API_ERROR")
        : "API_ERROR";
    throw new MalformedResponseError("(root)", `public config unavailable (${code})`);
  }
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) {
    throw new MalformedResponseError("data", "is missing");
  }
  const data = (parsed as { data: unknown }).data;
  if (typeof data !== "object" || data === null) {
    throw new MalformedResponseError("data", "must be an object");
  }
  const {
    supabaseUrl,
    supabasePublishableKey,
    guestSignInEnabled,
    guestUpgradeEnabled,
    guestSignInCaptchaRequired,
    daemon,
    auth_configured,
  } = data as Record<string, unknown>;
  if (daemon !== undefined && typeof daemon !== "boolean") {
    throw new MalformedResponseError("daemon", "must be a boolean");
  }
  if (auth_configured !== undefined && typeof auth_configured !== "boolean") {
    throw new MalformedResponseError("auth_configured", "must be a boolean");
  }
  if (guestSignInEnabled !== undefined && typeof guestSignInEnabled !== "boolean") {
    throw new MalformedResponseError("guestSignInEnabled", "must be a boolean");
  }
  if (guestUpgradeEnabled !== undefined && typeof guestUpgradeEnabled !== "boolean") {
    throw new MalformedResponseError("guestUpgradeEnabled", "must be a boolean");
  }
  if (
    guestSignInCaptchaRequired !== undefined &&
    typeof guestSignInCaptchaRequired !== "boolean"
  ) {
    throw new MalformedResponseError("guestSignInCaptchaRequired", "must be a boolean");
  }
  // Guest-local daemon: the explicit marker pair (`daemon: true` AND
  // `auth_configured: false`) says no Supabase project is configured, so the
  // Supabase fields are legitimately absent. Anything else missing them fails
  // closed exactly as before — a bare `daemon: true` without the marker pair
  // never widens the gate.
  const guestLocal = daemon === true && auth_configured === false;
  if (guestLocal && supabaseUrl === undefined && supabasePublishableKey === undefined) {
    return {
      supabaseUrl: "",
      supabasePublishableKey: "",
      guestSignInEnabled: guestSignInEnabled === true,
      guestUpgradeEnabled: guestUpgradeEnabled === true,
      guestSignInCaptchaRequired: guestSignInCaptchaRequired === true,
      daemon: true,
      auth_configured: false,
    };
  }
  if (typeof supabaseUrl !== "string" || supabaseUrl === "" || !isSafeSupabaseUrl(supabaseUrl)) {
    throw new MalformedResponseError("supabaseUrl", "must be a non-empty http(s) URL");
  }
  if (typeof supabasePublishableKey !== "string" || supabasePublishableKey === "") {
    throw new MalformedResponseError("supabasePublishableKey", "must be a non-empty string");
  }
  if (isRejectedKey(supabasePublishableKey)) {
    throw new MalformedResponseError("supabasePublishableKey", "must be a publishable key");
  }
  return {
    supabaseUrl,
    supabasePublishableKey,
    // Fail closed: only an explicit true advertises guest readiness.
    guestSignInEnabled: guestSignInEnabled === true,
    guestUpgradeEnabled: guestUpgradeEnabled === true,
    guestSignInCaptchaRequired: guestSignInCaptchaRequired === true,
    ...(daemon === undefined ? {} : { daemon }),
    ...(auth_configured === undefined ? {} : { auth_configured }),
  };
}
