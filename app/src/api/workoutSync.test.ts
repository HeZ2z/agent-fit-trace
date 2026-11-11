import { afterEach, beforeEach, expect, it, vi } from "vitest";

const jwt = (id: string, session: string, revision = 1) => `header.${btoa(JSON.stringify({ iss: "https://auth.test/auth/v1", sub: id, session_id: session, revision }))}.signature`;
const capA = "A".repeat(43), capB = "B".repeat(43);
beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it("a delayed old-account logout cannot revoke the new account capability", async () => {
  const { CAPABILITY_KEY, connectWorkoutSync, revokeWorkoutSync } = await import("./workoutSync.ts");
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { capability: capA } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { capability: capB } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { configured: true, revoked: true } })));
  vi.stubGlobal("fetch", fetchMock);
  const alice = jwt("alice", "session-a"), bob = jwt("bob", "session-b");
  await connectWorkoutSync(alice);
  await connectWorkoutSync(bob);
  await revokeWorkoutSync(alice);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2][0]).toBe("/api/v1/sync/revoke-session");
  expect(localStorage.getItem(CAPABILITY_KEY)).toBe("active");
  expect(JSON.stringify(localStorage)).not.toContain(capB);
});
it("a refreshed token from the same session can revoke its capability", async () => {
  const { CAPABILITY_KEY, connectWorkoutSync, revokeWorkoutSync } = await import("./workoutSync.ts");
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { capability: capA } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { revoked: true } })));
  vi.stubGlobal("fetch", fetchMock);
  await connectWorkoutSync(jwt("alice", "session-a", 1));
  await revokeWorkoutSync(jwt("alice", "session-a", 2));
  expect(localStorage.getItem(CAPABILITY_KEY)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("retains the in-memory capability for a retry after revocation fails", async () => {
  const { connectWorkoutSync, revokeWorkoutSync } = await import("./workoutSync.ts");
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { capability: capA } })))
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { revoked: true } })));
  vi.stubGlobal("fetch", fetchMock);
  const token = jwt("alice", "session-a");
  await connectWorkoutSync(token);
  await expect(revokeWorkoutSync(token)).rejects.toThrow("offline");
  await revokeWorkoutSync(token);
  expect(fetchMock.mock.calls[3][0]).toBe("/api/v1/sync/logout");
  expect(fetchMock.mock.calls[3][1].headers["x-fit-trace-sync-capability"]).toBe(capA);
});
it("reacquires an active session before sign-out after a renderer reload", async () => {
  const { CAPABILITY_KEY, connectWorkoutSync } = await import("./workoutSync.ts");
  const token = jwt("alice", "session-a");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { capability: capA } }))));
  await connectWorkoutSync(token);
  expect(localStorage.getItem(CAPABILITY_KEY)).toBe("active");
  vi.resetModules();
  const reloaded = await import("./workoutSync.ts");
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { configured: true, revoked: true } })));
  vi.stubGlobal("fetch", fetchMock);
  await reloaded.revokeWorkoutSync(token);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/sync/revoke-session");
  expect(localStorage.getItem(CAPABILITY_KEY)).toBeNull();
});
it("discards a late capability when another tab ends the session", async () => {
  const { CAPABILITY_KEY, connectWorkoutSync } = await import("./workoutSync.ts");
  let reply!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((resolve) => { reply = resolve; })));
  const pending = connectWorkoutSync(jwt("alice", "session-a"));
  window.dispatchEvent(new StorageEvent("storage", { key: CAPABILITY_KEY, newValue: null }));
  reply(new Response(JSON.stringify({ data: { capability: capA } })));
  await expect(pending).rejects.toThrow(/identity changed/);
  expect(localStorage.getItem(CAPABILITY_KEY)).toBeNull();
});
it("asks the daemon to revoke even when the local marker is missing", async () => {
  const { revokeWorkoutSync } = await import("./workoutSync.ts");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { configured: true, revoked: true } })));
  vi.stubGlobal("fetch", fetchMock);
  await revokeWorkoutSync(jwt("alice", "session-a"));
  expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/sync/revoke-session");
});
it("does not revoke a refreshed session, but revokes the previous session on account change", async () => {
  const { transitionWorkoutSyncIfConnected } = await import("./workoutSync.ts");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { configured: true, revoked: true } })));
  vi.stubGlobal("fetch", fetchMock);
  await transitionWorkoutSyncIfConnected(jwt("alice", "session-a", 2), jwt("alice", "session-a", 1));
  expect(fetchMock).not.toHaveBeenCalled();
  await transitionWorkoutSyncIfConnected(jwt("bob", "session-b"), jwt("alice", "session-a"));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/sync/revoke-session");
});
