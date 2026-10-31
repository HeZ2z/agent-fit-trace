/** Trigger gate shared by UI controls and automatic lifecycle events. */
export type SyncTrigger = "manual" | "foreground" | "reconnect" | "background";

export interface SyncTriggerGate {
  authenticated: boolean;
  configured: boolean;
  consented: boolean;
  appActive?: boolean;
  networkAvailable?: boolean;
}

/** Guests, missing config and missing consent never start a data sync. */
export function shouldRunSyncForTrigger(trigger: SyncTrigger, gate: SyncTriggerGate): boolean {
  if (!gate.authenticated || !gate.configured || !gate.consented) return false;
  if (trigger === "foreground") return gate.appActive === true;
  if (trigger === "reconnect" || trigger === "background") return gate.networkAvailable === true;
  // Manual invocation remains available offline so the user receives the
  // runner's normal network error and the queued data remains durable.
  return true;
}
