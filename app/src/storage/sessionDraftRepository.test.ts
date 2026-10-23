import { describe, expect, it } from "vitest";
import {
  SessionDraftCorruptionError,
  createDraftExercise,
  createDraftPain,
  createDraftSet,
  createSessionDraft,
} from "@agent-fit-trace/workout-session";
import type { SessionDraft } from "@agent-fit-trace/workout-session";
import { MemoryStorageAdapter } from "./adapter.ts";
import type { StorageAdapter } from "./adapter.ts";
import {
  clearSessionDraft,
  loadSessionDraft,
  saveSessionDraft,
  sessionDraftKey,
} from "./sessionDraftRepository.ts";

function draft(overrides: Partial<SessionDraft> = {}): SessionDraft {
  return { ...createSessionDraft("2026-01-05"), ...overrides };
}

/** Draft with real content, a second exercise and a started timing. */
function filledDraft(): SessionDraft {
  const exercise = createDraftExercise(3);
  return {
    ...createSessionDraft("2026-01-05"),
    sessionType: "strength",
    durationMinutes: "45",
    sleepHours: "7.5",
    notes: "felt strong",
    exercises: [
      {
        ...exercise,
        name: "Squat",
        restSeconds: 120,
        sets: [{ ...createDraftSet(4), weight: "100", reps: "5", rpe: "8", done: true }],
      },
    ],
    pain: [{ ...createDraftPain(5), area: "knee", level: "2" }],
    timing: {
      startedAtMs: 1_700_000_000_000,
      endedAtMs: null,
      pausedAtMs: null,
      pausedTotalMs: 0,
      lastActiveAtMs: 1_700_000_060_000,
    },
  };
}

class ThrowingAdapter implements StorageAdapter {
  private readonly failure: Error;

  constructor(failure: Error) {
    this.failure = failure;
  }

  read(): string | null {
    throw this.failure;
  }

  write(): void {
    throw this.failure;
  }

  remove(): void {
    throw this.failure;
  }

  keys(): string[] {
    throw this.failure;
  }
}

describe("sessionDraftRepository", () => {
  it("returns null when the owner has no stored draft", () => {
    const adapter = new MemoryStorageAdapter();
    expect(loadSessionDraft(adapter, "owner-a")).toBeNull();
  });

  it("round-trips a full draft", () => {
    const adapter = new MemoryStorageAdapter();
    const expected = filledDraft();

    saveSessionDraft(adapter, expected, "owner-a");

    expect(loadSessionDraft(adapter, "owner-a")).toEqual(expected);
  });

  it("stores one canonical payload under the owner-scoped key", () => {
    const adapter = new MemoryStorageAdapter();
    const expected = filledDraft();

    saveSessionDraft(adapter, expected, "owner-a");
    const first = adapter.read(sessionDraftKey("owner-a"));
    saveSessionDraft(adapter, filledDraft(), "owner-a");

    expect(sessionDraftKey("owner-a")).toBe(
      "agent-fit-trace:session-draft:v1:owner:owner-a",
    );
    expect(adapter.read(sessionDraftKey("owner-a"))).toBe(first);
  });

  it("replaces the previous draft instead of accumulating keys", () => {
    const adapter = new MemoryStorageAdapter();

    saveSessionDraft(adapter, draft({ notes: "first" }), "owner-a");
    saveSessionDraft(adapter, draft({ notes: "second" }), "owner-a");

    expect(adapter.keys("agent-fit-trace:session-draft:")).toEqual([
      sessionDraftKey("owner-a"),
    ]);
    expect(loadSessionDraft(adapter, "owner-a")?.notes).toBe("second");
  });

  it("isolates accounts, including encoded owner ids", () => {
    const adapter = new MemoryStorageAdapter();
    const shared = draft({ notes: "same content" });
    const ownerWithSpecialChars = "user/a?b c";

    saveSessionDraft(adapter, draft({ notes: "owner-a draft" }), "owner-a");
    saveSessionDraft(adapter, draft({ notes: "owner-b draft" }), "owner-b");
    saveSessionDraft(adapter, shared, ownerWithSpecialChars);

    expect(loadSessionDraft(adapter, "owner-a")?.notes).toBe("owner-a draft");
    expect(loadSessionDraft(adapter, "owner-b")?.notes).toBe("owner-b draft");
    expect(loadSessionDraft(adapter, ownerWithSpecialChars)).toEqual(shared);
    expect(sessionDraftKey(ownerWithSpecialChars)).toBe(
      `agent-fit-trace:session-draft:v1:owner:${encodeURIComponent(ownerWithSpecialChars)}`,
    );
  });

  it("throws the shared typed corruption error for unreadable JSON", () => {
    const adapter = new MemoryStorageAdapter();
    adapter.write(sessionDraftKey("owner-a"), "{not json");

    expect(() => loadSessionDraft(adapter, "owner-a")).toThrow(SessionDraftCorruptionError);
  });

  it("throws the shared typed corruption error for an unsupported payload version", () => {
    const adapter = new MemoryStorageAdapter();
    adapter.write(
      sessionDraftKey("owner-a"),
      JSON.stringify({ ...filledDraft(), version: 2 }),
    );

    expect(() => loadSessionDraft(adapter, "owner-a")).toThrow(SessionDraftCorruptionError);
  });

  it("clears only the selected owner's draft", () => {
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(adapter, draft({ notes: "owner-a draft" }), "owner-a");
    saveSessionDraft(adapter, draft({ notes: "owner-b draft" }), "owner-b");

    clearSessionDraft(adapter, "owner-a");

    expect(loadSessionDraft(adapter, "owner-a")).toBeNull();
    expect(loadSessionDraft(adapter, "owner-b")?.notes).toBe("owner-b draft");
  });

  it("clearing an absent draft is a no-op", () => {
    const adapter = new MemoryStorageAdapter();
    expect(() => clearSessionDraft(adapter, "owner-a")).not.toThrow();
  });

  it("propagates storage failures instead of reporting no draft", () => {
    const failure = new Error("storage unavailable");

    expect(() => loadSessionDraft(new ThrowingAdapter(failure), "owner-a")).toThrow(failure);
    expect(() => saveSessionDraft(new ThrowingAdapter(failure), draft(), "owner-a")).toThrow(
      failure,
    );
    expect(() => clearSessionDraft(new ThrowingAdapter(failure), "owner-a")).toThrow(failure);
  });

  it("rejects an empty owner id before touching storage", () => {
    const adapter = new MemoryStorageAdapter();

    expect(() => loadSessionDraft(adapter, "  ")).toThrow(TypeError);
    expect(() => saveSessionDraft(adapter, draft(), "")).toThrow(TypeError);
    expect(() => clearSessionDraft(adapter, "   ")).toThrow(TypeError);
    expect(adapter.keys("agent-fit-trace:session-draft:")).toEqual([]);
  });
});
