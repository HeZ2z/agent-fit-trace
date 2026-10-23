import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createSessionDraft } from "@agent-fit-trace/workout-session";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { loadSessionDraft, sessionDraftKey } from "../storage/sessionDraftRepository.ts";
import { SessionDraftProvider, useSessionDraft } from "./SessionDraftContext.tsx";

function wrapperFor(ownerId: string, adapter: MemoryStorageAdapter) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SessionDraftProvider ownerId={ownerId} adapter={adapter}>
        {children}
      </SessionDraftProvider>
    );
  };
}

describe("SessionDraftProvider", () => {
  it("binds load/save/clear to the provider's owner", () => {
    const adapter = new MemoryStorageAdapter();
    const { result } = renderHook(() => useSessionDraft(), {
      wrapper: wrapperFor("owner-a", adapter),
    });

    expect(result.current.load()).toBeNull();

    const next = { ...createSessionDraft("2026-01-05"), notes: "in progress" };
    act(() => result.current.save(next));

    expect(loadSessionDraft(adapter, "owner-a")).toEqual(next);
    expect(loadSessionDraft(adapter, "owner-b")).toBeNull();
    expect(adapter.read(sessionDraftKey("owner-a"))).not.toBeNull();

    act(() => result.current.clear());

    expect(result.current.load()).toBeNull();
    expect(adapter.read(sessionDraftKey("owner-a"))).toBeNull();
  });

  it("keeps the callbacks stable across re-renders", () => {
    const adapter = new MemoryStorageAdapter();
    const { result, rerender } = renderHook(() => useSessionDraft(), {
      wrapper: wrapperFor("owner-a", adapter),
    });
    const first = result.current;

    rerender();

    expect(result.current).toEqual(first);
    expect(result.current.load).toBe(first.load);
  });

  it("fails loudly outside a provider", () => {
    expect(() => renderHook(() => useSessionDraft())).toThrow(
      /within a <SessionDraftProvider>/,
    );
  });
});
