import type { AuthPrincipal } from "@pi-fit-trace/api-contracts";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import type { PrincipalStoreFactory } from "./auth/verifier.ts";
import { createInMemoryWorkoutStore } from "./inMemoryWorkoutStore.ts";

export type { PrincipalStoreFactory } from "./auth/verifier.ts";

/**
 * Per-principal, in-memory, append-only workout stores.
 *
 * Each authenticated principal gets an isolated `FitTraceClient` by reusing
 * the shared in-memory store factory: records are keyed by `(owner, store)`,
 * so two principals may hold the same business id without seeing each other.
 * The idempotency/conflict semantics are exactly the shared store's
 * (identical re-import is a no-op duplicate via canonical comparison; same
 * id with different content is a `CONFLICT`).
 *
 * Used by the authenticated loopback server and its tests. Production uses
 * the Supabase repository with the same semantics backed by Postgres + RLS.
 */

/** Create isolated in-memory stores keyed by verified principal id. */
export function createPrincipalMemoryStores(): PrincipalStoreFactory {
  const stores = new Map<string, FitTraceClient>();
  return {
    storeFor(principal: AuthPrincipal): FitTraceClient {
      let store = stores.get(principal.id);
      if (store === undefined) {
        store = createInMemoryWorkoutStore();
        stores.set(principal.id, store);
      }
      return store;
    },
  };
}
