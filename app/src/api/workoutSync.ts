/** Only a non-secret marker is shared across same-origin tabs. */
export const CAPABILITY_KEY = "fit-trace-workout-sync-capability";

interface StoredCapability { capability: string; session: string }
let entry: StoredCapability | null = null;
let revision = 0;
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === CAPABILITY_KEY || event.key === null) { entry = null; revision++; }
  });
}
function readEntry(): StoredCapability | null {
  return entry;
}
function sessionHint(token: string): string {
  // This is only a selector for a secret, never an authorization decision.
  // The daemon verified the exact token when it issued the capability.
  const payload = token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/");
  if (!payload) throw new Error("Invalid sync session.");
  const claims = JSON.parse(atob(payload)) as Record<string, unknown>;
  if (typeof claims.iss !== "string" || typeof claims.sub !== "string" || typeof claims.session_id !== "string") throw new Error("Invalid sync session.");
  return JSON.stringify([claims.iss, claims.sub, claims.session_id]);
}
function storeCapability(value: StoredCapability | null): void {
  entry = value;
  revision++;
  if (value === null) localStorage.removeItem(CAPABILITY_KEY);
  else localStorage.setItem(CAPABILITY_KEY, "active");
}
async function request(path: string, token: string | null, capability: string | null, method: "GET" | "POST" = "POST", body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/v1/sync/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(capability ? { "x-fit-trace-sync-capability": capability } : {}),
  } });
  if (!response.ok) {
    throw new Error(response.status === 503
      ? "Workout sync is not configured or is unavailable on this device."
      : `Workout sync request failed (HTTP ${response.status}).`);
  }
  const parsed = await response.json() as { data?: unknown };
  if (parsed.data === undefined) throw new Error("Invalid sync response.");
  return parsed.data;
}
function readReturnedCapability(value: unknown): string {
  if (typeof value !== "object" || value === null || !("capability" in value) || typeof value.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.capability)) throw new Error("Invalid sync response.");
  return value.capability;
}
/** Explicitly enter or change the active daemon sync session. */
export async function connectWorkoutSync(token: string): Promise<string> {
  const current = readEntry();
  const observedRevision = revision;
  let response: unknown;
  try {
    response = await request(current ? "transition" : "bootstrap", token, current?.capability ?? null);
  } catch (error) {
    // After daemon restart its in-memory capability is gone. Bootstrap only
    // succeeds for the still-active verified session; a different or revoked
    // identity cannot use this path to reset the server state.
    if (!current) throw error;
    response = await request("bootstrap", token, null);
  }
  const next = readReturnedCapability(response);
  if (revision !== observedRevision) throw new Error("Sync identity changed in another tab. Try again.");
  storeCapability({ capability: next, session: sessionHint(token) });
  return next;
}
/** Called before identity changes; a failure leaves the capability available for retry. */
export async function revokeWorkoutSync(token?: string): Promise<void> {
  if (!token || token.split(".").length !== 3) return;
  const current = readEntry();
  if (current && sessionHint(token) === current.session) {
    try {
      await request("logout", null, current.capability);
      if (readEntry() === current) storeCapability(null);
      return;
    } catch {
      // A daemon restart drops capabilities; verify the session below instead.
    }
  }
  const observedRevision = revision;
  const result = await request("revoke-session", token, null);
  if (typeof result !== "object" || result === null || !("configured" in result) || typeof result.configured !== "boolean" || !("revoked" in result) || typeof result.revoked !== "boolean" || (result.configured && !result.revoked)) {
    throw new Error("Sync sign-out could not be confirmed.");
  }
  if (revision === observedRevision && (current === null || current.session === sessionHint(token))) storeCapability(null);
}
export async function transitionWorkoutSyncIfConnected(token: string, previousToken?: string): Promise<void> {
  if (!previousToken || previousToken === token) return;
  // The sync endpoint accepts Supabase JWT sessions only. Other token formats
  // cannot have opened a sync session on this daemon.
  if (previousToken.split(".").length !== 3 || token.split(".").length !== 3) return;
  if (sessionHint(previousToken) === sessionHint(token)) return;
  await revokeWorkoutSync(previousToken);
}
export async function workoutSyncRequest(path: "status" | "consent" | "revoke-consent" | "run" | "guest-preview" | "guest-import", token: string, body?: unknown): Promise<unknown> {
  const entry = readEntry();
  if (!entry || entry.session !== sessionHint(token)) throw new Error("Connect sync before continuing.");
  return request(path, token, entry.capability, path === "status" || path === "guest-preview" ? "GET" : "POST", body);
}
