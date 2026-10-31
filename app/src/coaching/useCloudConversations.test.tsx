import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCloudConversations } from "./useCloudConversations.ts";

const token = () => "token";
const item = { id: "c1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const answer = { id: "m1", role: "assistant", content: "Keep going", createdAt: item.createdAt };
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
}
afterEach(() => vi.unstubAllGlobals());

describe("cloud conversations", () => {
  it("loads a conversation and refreshes its messages after a run", async () => {
    let messages: unknown[] = [];
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => String(input).endsWith("/c1")
      ? json({ conversation: item, messages })
      : json({ conversations: [item] }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useCloudConversations("account-a", true, token));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    await act(async () => { await result.current.select("c1"); });
    expect(result.current.selectedId).toBe("c1");
    messages = [answer];
    await act(async () => { await result.current.refresh(); });
    expect(result.current.messages).toEqual([answer]);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer token" });
  });

  it("keeps the same create id after a lost response", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return json({ conversations: [] });
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error("offline");
      const { id } = JSON.parse(bodies[1]!) as { id: string };
      return json({ ...item, id });
    }));
    const { result } = renderHook(() => useCloudConversations("account-a", true, token));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { expect(await result.current.create()).toBeNull(); });
    expect(result.current.error).toBe("offline");
    await act(async () => { expect(await result.current.create()).not.toBeNull(); });
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("keeps history visible when deletion is rejected for an active run", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") return json({}, 409);
      if (String(input).endsWith("/c1")) return json({ conversation: item, messages: [answer] });
      return json({ conversations: [item] });
    }));
    const { result } = renderHook(() => useCloudConversations("account-a", true, token));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    await act(async () => { await result.current.select("c1"); });
    await act(async () => { await result.current.remove(); });
    expect(result.current.messages).toEqual([answer]);
    expect(result.current.selectedId).toBe("c1");
    expect(result.current.error).toMatch(/409/);
  });

  it("never displays a previous account's late result after an account switch", async () => {
    let resolveA!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveA = resolve; })));
    const { result, rerender } = renderHook(({ id }) => useCloudConversations(id, true, token), { initialProps: { id: "account-a" } });
    const oldResolve = resolveA;
    rerender({ id: "account-b" });
    await act(async () => { oldResolve(json({ conversations: [item] })); });
    expect(result.current.conversations).toEqual([]);
    expect(result.current.accountId).toBe("account-b");
  });
});
