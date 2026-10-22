import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { isValidPrincipalId } from "./verifier.ts";
import type { TokenVerifier } from "./verifier.ts";

/**
 * Deterministic test/dev verifier mapping fixed tokens to principals.
 *
 * Development and test use only: production builds must construct the
 * Supabase verifier instead — this verifier trusts any configured string
 * without cryptography. Unknown tokens reject so routes fail closed.
 */
export function createTestVerifier(tokens: Record<string, AuthPrincipal>): TokenVerifier {
  return {
    verify(bearerToken: string): Promise<AuthPrincipal> {
      const principal = tokens[bearerToken];
      if (principal === undefined || !isValidPrincipalId(principal.id)) {
        const error = new Error("Invalid bearer token.");
        (error as { code?: string }).code = "UNAUTHENTICATED";
        return Promise.reject(error);
      }
      return Promise.resolve({
        id: principal.id,
        ...(principal.email === undefined ? {} : { email: principal.email }),
        ...(principal.isAnonymous === undefined ? {} : { isAnonymous: principal.isAnonymous }),
      });
    },
  };
}
