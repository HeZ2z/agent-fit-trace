/**
 * Pure configuration resolution for the mobile cloud-sync client.
 *
 * The configured value is the full API base (including `/api/v1`, e.g.
 * `https://fit-trace.vercel.app/api/v1`), matching the documented HTTP
 * contract and the web client's default base. The client appends the
 * documented resource paths from `API_ENDPOINTS` to it.
 *
 * This module deliberately reads no environment and imports no Expo value, so
 * the root `node:test` suite can exercise every branch without a native
 * runtime. The thin Expo/env reader lives in `syncClient.ts`.
 */

/** Expo public env var holding the absolute API base URL. */
export const SYNC_API_URL_ENV = "EXPO_PUBLIC_FIT_TRACE_API_URL";

/** Tri-state config reported to the UI; only `configured` can enable sync. */
export type SyncConfigStatus = "configured" | "unconfigured" | "invalid";

/** Why a non-blank API URL was rejected. Never carries the rejected value. */
export type SyncConfigProblem =
  | "malformed-url"
  | "not-http"
  | "credentials"
  | "query"
  | "fragment";

/**
 * Resolved sync configuration.
 *
 * `unconfigured` is a first-class product state: local-only use must keep
 * working when the build has no API URL. `invalid` is distinct so a typo is
 * surfaced instead of silently disabling cloud sync.
 */
export type SyncConfig =
  | { readonly status: "configured"; readonly baseUrl: string }
  | { readonly status: "unconfigured" }
  | { readonly status: "invalid"; readonly reason: SyncConfigProblem };

/**
 * Validate and normalize the configured API base URL.
 *
 * - Missing/blank values are `unconfigured`, never an error.
 * - Only absolute `http(s)` URLs without credentials, query or fragment are
 *   accepted, so the base cannot be mangled by string concatenation and a
 *   user-supplied URL can never smuggle a token into an error path.
 * - Trailing slashes are removed so endpoint appends are unambiguous.
 */
export function resolveSyncConfig(rawUrl: unknown): SyncConfig {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { status: "unconfigured" };
  }
  const candidate = rawUrl.trim();
  // A literal space/newline always means a copy/paste or config mistake; URL
  // would otherwise silently percent-encode it.
  if (/\s/.test(candidate)) return { status: "invalid", reason: "malformed-url" };

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { status: "invalid", reason: "malformed-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: "invalid", reason: "not-http" };
  }
  // Credentials, queries and fragments are not part of the API base contract.
  if (url.username !== "" || url.password !== "") {
    return { status: "invalid", reason: "credentials" };
  }
  if (url.search !== "") return { status: "invalid", reason: "query" };
  if (url.hash !== "") return { status: "invalid", reason: "fragment" };

  const pathname = url.pathname.replace(/\/+$/, "");
  return { status: "configured", baseUrl: `${url.origin}${pathname}` };
}
