import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";

/**
 * Shared contracts for the remote (HTTP) MCP surface.
 *
 * The remote endpoint is a *resource server*: every request carries an OAuth
 * access token issued by Supabase Auth for an allow-listed MCP client. This
 * module holds only types and the fixed constants every other part of
 * `server/mcp/` agrees on — no I/O — so the auth verifier, the HTTP handler,
 * the cloud store adapter, and their tests can be written against one shape.
 */

/**
 * JWT claim the Supabase custom-access-token hook writes for allow-listed MCP
 * clients. Its value is the exact MCP resource URL the token was issued for.
 *
 * Why a dedicated claim instead of rewriting `aud`: Supabase access tokens are
 * shared with Auth (`GET /auth/v1/user`) and PostgREST, both of which expect
 * `aud: authenticated`. Overwriting `aud` for OAuth tokens would put the
 * caller's own RLS-scoped token at risk, so the resource binding travels in an
 * additive claim while `aud` stays untouched. The verifier still requires
 * `aud` to contain `authenticated`, so a future audience change fails closed
 * instead of silently widening access. See `docs/mcp.md` ("Remote MCP").
 */
export const MCP_RESOURCE_CLAIM = "fit_trace_mcp_resource";

/** Stable OAuth error codes used in `WWW-Authenticate` and JSON bodies. */
export const MCP_AUTH_ERRORS = {
  /** Missing, malformed, expired, wrong-issuer, wrong-audience, unbound or
   * unlisted-client credentials. Always 401 with a challenge. */
  INVALID_TOKEN: "invalid_token",
  /** Valid credentials that are not authorized for the requested operation. 403. */
  INSUFFICIENT_SCOPE: "insufficient_scope",
  /** The verification dependency (Auth/JWKS) is unreachable. 503, never a
   * silent downgrade to anonymous access. */
  AUTH_UNAVAILABLE: "auth_unavailable",
} as const;

export type McpAuthErrorCode = (typeof MCP_AUTH_ERRORS)[keyof typeof MCP_AUTH_ERRORS];

/** Status code each auth failure maps to. */
export const MCP_AUTH_ERROR_STATUS: Record<McpAuthErrorCode, number> = {
  invalid_token: 401,
  insufficient_scope: 403,
  auth_unavailable: 503,
};

/** A structured remote-MCP authentication failure. Never carries a token. */
export class McpAuthError extends Error {
  readonly code: McpAuthErrorCode;
  readonly status: number;

  constructor(code: McpAuthErrorCode, message: string) {
    super(message);
    this.name = "McpAuthError";
    this.code = code;
    this.status = MCP_AUTH_ERROR_STATUS[code];
  }
}

/** Static configuration for the remote MCP resource server. */
export interface McpAuthConfig {
  supabaseUrl: string;
  publishableKey: string;
  /** Exact issuer expected in the token, e.g. `https://<ref>.supabase.co/auth/v1`. */
  issuer: string;
  /** Exact MCP resource URL this endpoint serves; tokens must be bound to it. */
  resource: string;
  /** OAuth client ids allowed to present MCP credentials (dynamic registration is off). */
  allowedClientIds: readonly string[];
  /** Claim carrying the resource binding; defaults to {@link MCP_RESOURCE_CLAIM}. */
  resourceClaim?: string;
}

/** A verified remote-MCP caller: the identity plus the token's provenance. */
export interface McpAuthPrincipal {
  /** Stable owner identity, resolved by the Auth server's own user response. */
  principal: AuthPrincipal;
  /** The OAuth client the token was issued to; always allow-listed. */
  clientId: string;
  /** The resource URL the token is bound to; equals `config.resource`. */
  resource: string;
  /**
   * The caller's own access token. Per-request stores carry it so PostgREST
   * RLS (`auth.uid() = owner_id`) always applies — the server never uses the
   * service-role key as user authorization.
   */
  accessToken: string;
}

/** Verify one bearer token; throws {@link McpAuthError} on every failure. */
export type McpTokenVerifier = (bearerToken: string) => Promise<McpAuthPrincipal>;
