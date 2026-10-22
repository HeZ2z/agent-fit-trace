import type { AuthPrincipal, FitTraceClient } from "@agent-fit-trace/api-contracts";

/**
 * Verifies a bearer token and resolves the stable caller principal.
 *
 * The HTTP boundary depends only on this interface: production uses the
 * Supabase verifier (`supabaseVerifier.ts`), tests and local development
 * inject a test verifier. The core and the workout stores never see tokens —
 * they receive only the resolved {@link AuthPrincipal}.
 */
export interface TokenVerifier {
  verify(bearerToken: string): Promise<AuthPrincipal>;
}

/** Per-principal store lookup: each verified principal gets an isolated store. */
export interface PrincipalStoreFactory {
  storeFor(principal: AuthPrincipal): FitTraceClient;
}

/** Extract a `Bearer` token from an `Authorization` header value. */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  if (match === null) return null;
  const token = (match[1] ?? "").trim();
  return token === "" ? null : token;
}

/** True for non-empty provider subjects usable as stable owner ids. */
export function isValidPrincipalId(id: unknown): id is string {
  return typeof id === "string" && id.trim() !== "";
}
