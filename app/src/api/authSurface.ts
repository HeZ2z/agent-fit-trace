import type { PublicApiConfig } from "@agent-fit-trace/api-contracts";

/**
 * Derive the auth surface from the parsed `GET /api/v1/public-config`
 * payload (issue #39). This is the app-side counterpart of mobile's
 * `authModel.ts` semantics: `unconfigured` is a first-class state, signing in
 * is an optional overlay, and cloud features are gated off for guests — never
 * triggered by a mode change.
 *
 * - `daemon: true` + `auth_configured: false` → `guest-local`: the daemon has
 *   no Supabase project, so the app boots straight into the stable local
 *   guest identity instead of failing the auth gate.
 * - `daemon: true` + `auth_configured: true` → `daemon-optional`: the normal
 *   Supabase login gate applies, with the existing "Continue as guest" path.
 * - No `daemon` marker (cloud/launcher deployments, or a null config) →
 *   `supabase`: today's strict gate, byte-for-byte unchanged.
 */
export type AuthSurface = "supabase" | "guest-local" | "daemon-optional";

export function resolveAuthSurface(config: PublicApiConfig | null): AuthSurface {
  // A null/failed config keeps the strict Supabase gate (fail closed), exactly
  // like the pre-daemon behavior. Only the explicit marker pair
  // (`daemon: true` + `auth_configured: false`) selects guest-local; a daemon
  // that omits `auth_configured` keeps today's login gate.
  if (config?.daemon !== true) return "supabase";
  if (config.auth_configured === true) return "daemon-optional";
  return config.auth_configured === false ? "guest-local" : "daemon-optional";
}

/**
 * The single bearer token the standalone local daemon accepts for its guest
 * data plane. Mirrors `LOCAL_DAEMON_BEARER` in `server/auth/localVerifier.ts`;
 * redefined here (with a comment, not an import) because the app must stay
 * browser-safe and never import Node server code. Loopback-only by design:
 * the daemon binds 127.0.0.1 and trusts the local machine.
 */
export const LOCAL_GUEST_BEARER = "fit-trace-local-daemon";

/**
 * The stable local guest principal id the daemon resolves the bearer to.
 * Mirrors `LOCAL_GUEST_PRINCIPAL_ID` in `server/auth/localVerifier.ts` (which
 * matches `GUEST_PRINCIPAL` in `@agent-fit-trace/store`); redefined for the
 * same browser-safe reason. The app uses it as the local guest's owner id so
 * client-side owner namespacing agrees with the daemon's per-principal store.
 */
export const LOCAL_GUEST_PRINCIPAL_ID = "guest";
