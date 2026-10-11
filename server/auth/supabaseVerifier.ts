import type { AuthPrincipal } from "@pi-fit-trace/api-contracts";
import { API_ERROR_CODES, ApiError } from "@pi-fit-trace/api-contracts";
import { isValidPrincipalId } from "./verifier.ts";
import type { TokenVerifier } from "./verifier.ts";

export interface SupabaseVerifierOptions {
  supabaseUrl: string;
  /** Publishable (anon) key; the service-role key must never be configured here. */
  publishableKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Production token verifier against Supabase Auth.
 *
 * Verification calls the project's Auth server (`GET /auth/v1/user` with the
 * caller's access token, the same check `supabase-js` `auth.getUser()`
 * performs) using only the publishable key. The token itself authenticates;
 * no local JWT-signature trust is required, so issuer/audience/expiry are
 * enforced by the Auth server's response, not by parsing claims here.
 *
 * Missing/invalid/expired tokens reject with `UNAUTHENTICATED` (401, forcing
 * a local sign-out). Transient upstream failures — network errors, 429/5xx,
 * or an unreadable 2xx body — reject with `STORAGE_UNAVAILABLE` (503) so
 * callers surface "auth service unavailable" instead of logging the user out.
 */
export function createSupabaseVerifier(options: SupabaseVerifierOptions): TokenVerifier {
  const supabaseUrl = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  if (supabaseUrl === "" || options.publishableKey === "") {
    throw new Error("Supabase verifier requires a URL and a publishable key.");
  }

  return {
    async verify(bearerToken: string): Promise<AuthPrincipal> {
      let response: Response;
      try {
        response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
          headers: {
            apikey: options.publishableKey,
            Authorization: `Bearer ${bearerToken}`,
          },
        });
      } catch {
        throw new ApiError({
          code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: "Authentication service is unavailable.",
          status: 503,
        });
      }
      if (!response.ok) {
        // 429/5xx are transient: never force a logout for them.
        if (response.status === 429 || response.status >= 500) {
          throw new ApiError({
            code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
            message: "Authentication service is unavailable.",
            status: 503,
          });
        }
        throw new ApiError({
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Invalid or expired bearer token.",
          status: 401,
        });
      }
      let user: unknown;
      try {
        user = (await response.json()) as unknown;
      } catch {
        throw new ApiError({
          code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
          message: "Authentication service is unavailable.",
          status: 503,
        });
      }
      const id =
        typeof user === "object" && user !== null && "id" in user
          ? (user as { id: unknown }).id
          : undefined;
      if (!isValidPrincipalId(id)) {
        throw new ApiError({
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Invalid or expired bearer token.",
          status: 401,
        });
      }
      const email =
        typeof user === "object" && user !== null && "email" in user
          ? (user as { email: unknown }).email
          : undefined;
      return {
        id,
        ...(typeof email === "string" && email !== "" ? { email } : {}),
      };
    },
  };
}
