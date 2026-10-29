/**
 * Remote MCP token verification.
 *
 * The HTTP MCP endpoint is an OAuth 2.1 resource server: Supabase Auth issues
 * the access token, and this module decides whether that token may reach the
 * training-data tools.
 *
 * Verification has two deliberately separate halves:
 *
 * 1. Local claim checks on the JWT payload, decoded but NOT trusted for
 *    identity: `iss`, `aud`, `exp`/`nbf`, `sub`, the allow-listed `client_id`,
 *    and the MCP resource-binding claim. These reject first-party browser
 *    tokens (no `client_id`, no resource claim) and tokens issued for another
 *    resource or another OAuth client before any network call happens.
 * 2. `GET /auth/v1/user` with the publishable key and the caller's own bearer,
 *    exactly like `server/auth/supabaseVerifier.ts`. That response is what
 *    actually authenticates the token (signature, revocation, expiry), so the
 *    principal is taken from it — never from the locally decoded payload.
 *
 * Reading claims from the token string after the Auth call is trustworthy
 * because the same token was just authenticated by Auth; conversely the local
 * issuer/audience/expiry checks mean a token Auth would accept for another
 * purpose (the browser session token) can never reach the store. Neither half
 * alone is sufficient, so both are required.
 *
 * Every failure is an {@link McpAuthError}: bad credentials are `invalid_token`
 * (401), while an unreachable or misbehaving Auth server is `auth_unavailable`
 * (503) so a transient outage never forces the caller to sign out. Messages
 * never contain the token or a claims dump.
 */

import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { isValidPrincipalId } from "../auth/verifier.ts";
import { MCP_AUTH_ERRORS, MCP_RESOURCE_CLAIM, McpAuthError } from "./contracts.ts";
import type { McpAuthConfig, McpAuthPrincipal, McpTokenVerifier } from "./contracts.ts";

export interface McpTokenVerifierOptions {
  fetchImpl?: typeof fetch;
}

/** Fixed, token-free messages; safe to surface to a client. */
const MESSAGES = {
  invalid: "Invalid or expired bearer token.",
  unavailable: "Authentication service is unavailable.",
} as const;

function invalidToken(): McpAuthError {
  return new McpAuthError(MCP_AUTH_ERRORS.INVALID_TOKEN, MESSAGES.invalid);
}

function authUnavailable(): McpAuthError {
  return new McpAuthError(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, MESSAGES.unavailable);
}

/**
 * Decode the JWT payload segment without verifying the signature.
 *
 * The result is untrusted input: it only gates *whether* the Auth call may
 * happen. Identity always comes from the Auth server response.
 */
function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload === "") return null;
  let parsed: unknown;
  try {
    // base64url decoding is built into Buffer; no JWT library is needed (and
    // none may be added just for this unauthenticated read).
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** `aud` may be a string or an array of strings per RFC 7519. */
function audienceIncludes(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

/**
 * Enforce the local claim requirements, throwing `invalid_token` on any
 * mismatch. Returns the (untrusted) subject and client id for cross-checking.
 */
function assertClaims(
  claims: Record<string, unknown>,
  config: McpAuthConfig,
  nowSeconds: number,
): { sub: string; clientId: string } {
  // Issuer must match this project's Auth server exactly: a token minted by
  // another project must never be usable here.
  if (claims.iss !== config.issuer) throw invalidToken();

  // `aud` stays `authenticated` by design (the token is shared with Auth and
  // PostgREST); it is still required so a future audience change fails closed.
  if (!audienceIncludes(claims.aud, "authenticated")) throw invalidToken();

  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) throw invalidToken();

  // `nbf` is optional, but when present it must already be valid.
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== "number" || claims.nbf > nowSeconds) throw invalidToken();
  }

  const sub = claims.sub;
  if (typeof sub !== "string" || sub.trim() === "") throw invalidToken();

  // The OAuth client is what the consent screen showed the user; only
  // registered, allow-listed clients may present MCP credentials (dynamic
  // client registration is off).
  const clientId = claims.client_id;
  if (typeof clientId !== "string" || clientId.trim() === "") throw invalidToken();
  if (!config.allowedClientIds.includes(clientId)) throw invalidToken();

  // The token must be bound to *this* resource. A plain browser token has no
  // such claim, which is exactly what keeps it out of the MCP surface.
  const resourceClaim = config.resourceClaim ?? MCP_RESOURCE_CLAIM;
  if (claims[resourceClaim] !== config.resource) throw invalidToken();

  return { sub, clientId };
}

/** Read a verified `GET /auth/v1/user` body into a principal. */
function readPrincipal(user: unknown): AuthPrincipal {
  const id =
    typeof user === "object" && user !== null && "id" in user
      ? (user as { id: unknown }).id
      : undefined;
  if (!isValidPrincipalId(id)) throw invalidToken();
  const email =
    typeof user === "object" && user !== null && "email" in user
      ? (user as { email: unknown }).email
      : undefined;
  // Only the Auth server's verified response may classify the principal; a
  // missing or non-boolean `is_anonymous` stays undefined (fail closed).
  const isAnonymous =
    typeof user === "object" && user !== null && "is_anonymous" in user
      ? (user as { is_anonymous: unknown }).is_anonymous
      : undefined;
  return {
    id,
    ...(typeof email === "string" && email !== "" ? { email } : {}),
    ...(typeof isAnonymous === "boolean" ? { isAnonymous } : {}),
  };
}

/**
 * Create the verifier for the remote MCP endpoint.
 *
 * `fetchImpl` is injectable so the tests never touch the network.
 */
export function createMcpTokenVerifier(
  config: McpAuthConfig,
  options: McpTokenVerifierOptions = {},
): McpTokenVerifier {
  const supabaseUrl = config.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  if (supabaseUrl === "" || config.publishableKey === "") {
    throw new Error("Remote MCP verifier requires a Supabase URL and a publishable key.");
  }
  const resourceClaim = config.resourceClaim ?? MCP_RESOURCE_CLAIM;

  return async function verify(bearerToken: string): Promise<McpAuthPrincipal> {
    const token = bearerToken.trim();
    if (token === "") throw invalidToken();

    const claims = decodeClaims(token);
    if (claims === null) throw invalidToken();
    const { clientId } = assertClaims(claims, config, Math.floor(Date.now() / 1000));

    // Authenticate the token with Auth. This is the only step that proves the
    // token is genuine and unrevoked, and it uses the caller's own token with
    // the publishable key — never the service-role key.
    let response: Response;
    try {
      response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw authUnavailable();
    }
    if (!response.ok) {
      // 429/5xx are transient: report an outage instead of a logout-forcing
      // 401. Any other refusal (401/403/400) means the credentials are bad.
      if (response.status === 429 || response.status >= 500) throw authUnavailable();
      throw invalidToken();
    }
    let user: unknown;
    try {
      user = (await response.json()) as unknown;
    } catch {
      throw authUnavailable();
    }

    const principal = readPrincipal(user);
    // The verified response and the locally decoded `sub` must agree; a
    // disagreement would mean the payload we gated on is not the token Auth
    // authenticated (e.g. a concatenated/garbled string), so refuse it.
    if (principal.id !== claims.sub) throw invalidToken();

    return {
      principal,
      clientId,
      resource: config.resource,
      accessToken: token,
    };
  };
}
