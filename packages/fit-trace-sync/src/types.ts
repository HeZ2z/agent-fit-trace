/** Durable ownership scope for one destination and account. */
export interface SyncScope {
  accountId: string;
  endpoint: string;
  /** Verified issuer and session, supplied only by the daemon. */
  issuer?: string;
  sessionId?: string;
  leaseOwner?: string;
  leaseGeneration?: number;
}

export interface SyncLease {
  owner: string;
  generation: number;
  expiresAt: string;
}
