/**
 * Canonical coaching request identity.
 *
 * One deterministic projection of the client-visible submit content. It is
 * used by the in-process idempotency map AND by durable journal validation,
 * so a stored run can be proven to describe exactly the request that created
 * it after a restart. No clock, randomness, credentials, or runtime state is
 * part of the projection.
 */
import type { CoachingBackendId, CoachingDataSnapshot } from "@pi-fit-trace/api-contracts";

export interface CanonicalCoachingSubmit {
  prompt: string;
  backendId: CoachingBackendId;
  runtimeId: string;
  snapshot: CoachingDataSnapshot;
}

export function canonicalizeCoachingSubmit(input: CanonicalCoachingSubmit): string {
  return JSON.stringify({
    prompt: input.prompt,
    backendId: input.backendId,
    runtimeId: input.runtimeId,
    snapshot: {
      snapshotId: input.snapshot.snapshotId,
      source: input.snapshot.source,
      accountId: input.snapshot.accountId,
      recordIds: input.snapshot.recordIds,
      recordCount: input.snapshot.recordCount,
      ...(input.snapshot.from === undefined ? {} : { from: input.snapshot.from }),
      ...(input.snapshot.to === undefined ? {} : { to: input.snapshot.to }),
    },
  });
}
