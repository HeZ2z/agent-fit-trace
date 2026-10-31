/**
 * Protected Resource Metadata (RFC 9728) for the remote MCP endpoint.
 *
 * An MCP client that receives `401` from `/api/mcp` reads the
 * `WWW-Authenticate: Bearer resource_metadata="…"` challenge, fetches that
 * document, and only then knows which authorization server to send the user to.
 * The document therefore has to be served from a fixed, unauthenticated path —
 * it is the entry point of the whole OAuth flow, so it must not itself require
 * a token.
 *
 * Everything here is pure: it turns the already-validated `McpAuthConfig` into
 * the metadata JSON and the challenge header. Nothing reads the environment,
 * the clock, or the network, so the values can only come from configuration —
 * never from a request.
 *
 * Deployment note: the metadata path has two segments below a dot-directory,
 * which Vercel's filesystem routing does not turn into a Function (dot-prefixed
 * directories are not route folders, and the Hobby plan cap of 12 Functions is
 * already reached). The path is therefore served by the same `/api/mcp`
 * Function through a `vercel.json` rewrite that appends
 * {@link MCP_METADATA_QUERY_KEY}; see `server/vercel.ts` and `vercel.json`.
 */

import { MCP_AUTH_ERRORS } from "./contracts.ts";
import type { McpAuthConfig, McpAuthErrorCode } from "./contracts.ts";

/** Public MCP endpoint path (also the `resource` value's path). */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/**
 * RFC 9728 puts the metadata for `https://host/api/mcp` at
 * `https://host/.well-known/oauth-protected-resource/api/mcp` — the well-known
 * segment is inserted in front of the resource path, and the path is preserved.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/api/mcp";

/**
 * Query marker the `vercel.json` rewrite appends when it maps the metadata path
 * onto the `/api/mcp` Function. It is how the handler recognizes a metadata
 * request even when the platform hands the Function the rewrite destination
 * (`/api/mcp`) instead of the original path — the same technique the cloud run
 * subpath rewrites already use (`applyCloudSubpathRewrite`).
 */
export const MCP_METADATA_QUERY_KEY = "__fit_trace_mcp_metadata";

/**
 * Scopes advertised as supported by this resource (RFC 9728
 * `scopes_supported`). Deliberately the minimum that still gives a client
 * something valid to request: Supabase Auth rejects `/oauth/authorize` with an
 * empty `scope`, so advertising nothing would leave a conforming client with
 * no requestable value.
 *
 * `openid` is deliberately NOT advertised. Verified 2026-10-30 against GoTrue
 * v2.197.0: requesting `openid` makes the token endpoint try to mint an ID
 * token, which fails with `500 "HS256 is not supported for ID token signing"`
 * on a project still using the default symmetric signing key — the code
 * exchange dies before any MCP request happens. An operator on asymmetric keys
 * could support it, but advertising a scope that breaks the default
 * configuration is worse than advertising one that always works.
 *
 * Advertising a scope is NOT enforcing it: the endpoint requires no scope today
 * (`requiredScopes` defaults to empty in `createMcpHttpHandler`) because the
 * frozen `McpAuthPrincipal` carries no scope list. Data access is governed by
 * RLS, never by OAuth scopes. See `docs/mcp.md`.
 */
export const MCP_SUPPORTED_SCOPES = ["email"] as const;

/** RFC 9728 `bearer_methods_supported`: the token travels in the header only. */
export const MCP_BEARER_METHODS_SUPPORTED = ["header"] as const;

/** The JSON document served at {@link PROTECTED_RESOURCE_METADATA_PATH}. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

/**
 * Build the metadata document, or `null` when the endpoint is unconfigured
 * (there is then no resource or issuer to advertise, and the endpoint fails
 * closed rather than inventing one).
 *
 * `authorization_servers[0]` is the Auth issuer (`https://<ref>.supabase.co/auth/v1`)
 * exactly as tokens are verified against it — a client that follows this field
 * must land on the server that minted the token.
 */
export function readProtectedResourceMetadata(
  config: McpAuthConfig | null,
): ProtectedResourceMetadata | null {
  if (config === null) return null;
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: [...MCP_BEARER_METHODS_SUPPORTED],
    scopes_supported: [...MCP_SUPPORTED_SCOPES],
  };
}

/**
 * Absolute metadata URL for the challenge header. A relative path would make
 * clients resolve it against their own origin, so an absolute URL is built from
 * the configured resource — never from the incoming `Host` header, which a
 * proxy could rewrite.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  return new URL(PROTECTED_RESOURCE_METADATA_PATH, resource).href;
}

/** True for the metadata path (a trailing slash is accepted, nothing else is). */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized === PROTECTED_RESOURCE_METADATA_PATH;
}

/**
 * Quote a parameter value for `WWW-Authenticate` (RFC 7235 quoted-string).
 * Values here are configuration-derived (URL, error code, scope names), so this
 * only guards against a stray quote ever breaking the header structure.
 */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

export interface BearerChallengeOptions {
  /** Configured MCP resource URL, or `null` when configuration is missing. */
  resource: string | null;
  /** OAuth error code (`invalid_token`, `insufficient_scope`, `auth_unavailable`). */
  code?: McpAuthErrorCode;
  /** Scopes to request for `insufficient_scope`; only emitted for that code. */
  scopes?: readonly string[];
}

/**
 * Build the `WWW-Authenticate` challenge for an auth rejection.
 *
 * Shape follows RFC 6750 §3: `Bearer` then a comma-separated auth-param list
 * (`Bearer resource_metadata="…", error="invalid_token"`). The space after the
 * scheme matters — clients (including the MCP SDK) split the header on the
 * first space to read the scheme, so a leading comma would make the whole
 * challenge unparseable.
 *
 * `resource_metadata` is omitted when the resource is unknown (unconfigured
 * deployment): a fabricated URL would send the client to a document that does
 * not exist, whereas a challenge without it at least reports the failure
 * honestly. `scope` is only meaningful together with `insufficient_scope`.
 */
export function buildBearerChallenge(options: BearerChallengeOptions): string {
  const params: string[] = [];
  if (options.resource !== null) {
    params.push(`resource_metadata=${quote(protectedResourceMetadataUrl(options.resource))}`);
  }
  if (options.code !== undefined) {
    params.push(`error=${quote(options.code)}`);
    if (options.code === MCP_AUTH_ERRORS.INSUFFICIENT_SCOPE) {
      const scopes = (options.scopes ?? []).map((scope) => scope.trim()).filter((scope) => scope !== "");
      if (scopes.length > 0) params.push(`scope=${quote(scopes.join(" "))}`);
    }
  }
  return params.length === 0 ? "Bearer" : `Bearer ${params.join(", ")}`;
}
