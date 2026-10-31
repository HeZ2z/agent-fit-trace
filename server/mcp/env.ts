/**
 * Remote MCP resource-server configuration.
 *
 * The HTTP MCP endpoint is an OAuth 2.1 resource server: tokens are issued by
 * Supabase Auth and verified by this server, which never falls back to
 * anonymous access. Configuration therefore fails closed — any missing,
 * malformed, or secret-looking value yields `null` so the endpoint refuses to
 * serve instead of accepting whoever shows up.
 *
 * The Supabase URL/key rules are shared with the data API rather than
 * reimplemented: `isRejectedSupabaseKey` rejects the service-role secret (the
 * MCP path must only ever use the caller's own token + the publishable key)
 * and `isSafeSupabaseUrl` requires an absolute http(s) URL.
 */

import { isRejectedSupabaseKey, isSafeSupabaseUrl } from "../db/env.ts";
import type { McpAuthConfig } from "./contracts.ts";

/** Env vars specific to the remote MCP endpoint (Supabase vars are shared). */
export const MCP_ENV_VARS = {
  /** Exact resource URL this endpoint serves; tokens must be bound to it. */
  RESOURCE: "FIT_TRACE_MCP_RESOURCE",
  /** Comma-separated allow-list of OAuth `client_id`s (dynamic registration is off). */
  CLIENT_IDS: "FIT_TRACE_MCP_CLIENT_IDS",
} as const;

/** Path of the Auth server that issues the tokens, appended to the project URL. */
const AUTH_ISSUER_PATH = "/auth/v1";

/**
 * Parse a comma-separated allow-list. Empty and whitespace-only entries are
 * dropped (so a trailing comma cannot admit a blank client id) and duplicates
 * are collapsed.
 */
function readAllowList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const ids = new Set<string>();
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (value !== "") ids.add(value);
  }
  return [...ids];
}

/**
 * Resolve the remote-MCP auth config, or `null` when the endpoint must not
 * serve. `env` is injectable for tests; production passes `process.env`.
 *
 * Fail-closed conditions: missing/unsafe Supabase URL, missing or
 * secret-looking publishable key, missing/relative MCP resource URL, and an
 * empty client allow-list (an empty list would otherwise accept nothing at
 * best and everything at worst).
 */
export function readMcpAuthConfig(
  env: Record<string, string | undefined> = process.env,
): McpAuthConfig | null {
  const rawSupabaseUrl = (env.SUPABASE_URL ?? "").trim();
  const publishableKey = (env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? "").trim();
  const resource = (env[MCP_ENV_VARS.RESOURCE] ?? "").trim();
  const allowedClientIds = readAllowList(env[MCP_ENV_VARS.CLIENT_IDS]);

  if (rawSupabaseUrl === "" || publishableKey === "") return null;
  if (!isSafeSupabaseUrl(rawSupabaseUrl)) return null;
  if (isRejectedSupabaseKey(publishableKey)) return null;

  if (resource === "") return null;
  // The resource binding is compared for exact equality, so a garbage value
  // would silently reject every token; require an absolute http(s) URL up
  // front. `isSafeSupabaseUrl` is the repo's only absolute-URL validator, so
  // it is reused here instead of growing a second implementation.
  if (!isSafeSupabaseUrl(resource)) return null;

  if (allowedClientIds.length === 0) return null;

  const supabaseUrl = rawSupabaseUrl.replace(/\/+$/, "");
  return {
    supabaseUrl,
    publishableKey,
    issuer: `${supabaseUrl}${AUTH_ISSUER_PATH}`,
    resource,
    allowedClientIds,
  };
}
