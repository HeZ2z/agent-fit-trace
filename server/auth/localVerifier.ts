import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import type { TokenVerifier } from "./verifier.ts";

/**
 * Bearer verifier for the standalone local daemon.
 *
 * The daemon is loopback-only and trusts the local machine, so there is no
 * identity provider: it accepts exactly one fixed token and resolves it to the
 * stable local guest principal. Anything else rejects with the same
 * `UNAUTHENTICATED` semantics as the test verifier (`testVerifier.ts`), so
 * routes fail closed even on loopback. The guest id matches
 * `GUEST_PRINCIPAL` in `@agent-fit-trace/store`, which keys the guest's
 * per-principal database file (`principalDbPath`).
 */

/** The single bearer token the local daemon accepts. */
export const LOCAL_DAEMON_BEARER = "fit-trace-local-daemon";

/** The stable guest principal id; the sole owner key of the local data plane. */
export const LOCAL_GUEST_PRINCIPAL_ID = "guest";

/** Create the verifier backing `agent-fit-trace daemon`'s guest data plane. */
export function createLocalDaemonVerifier(): TokenVerifier {
  return {
    verify(bearerToken: string): Promise<AuthPrincipal> {
      if (bearerToken !== LOCAL_DAEMON_BEARER) {
        const error = new Error("Invalid bearer token.");
        (error as { code?: string }).code = "UNAUTHENTICATED";
        return Promise.reject(error);
      }
      // No email and no `isAnonymous`: this verifier has no identity provider
      // behind it, and the principal contract keeps `isAnonymous` undefined
      // exactly when the verifier cannot classify the caller.
      return Promise.resolve({ id: LOCAL_GUEST_PRINCIPAL_ID });
    },
  };
}
