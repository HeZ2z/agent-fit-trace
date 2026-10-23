import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionDraftCorruptionError,
  createSessionDraft,
} from "@agent-fit-trace/workout-session";
import type { SessionDraft } from "@agent-fit-trace/workout-session";
import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import { MemoryStorageAdapter, StorageUnavailableError } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import {
  loadSessionDraft,
  saveSessionDraft,
  sessionDraftKey,
} from "../storage/sessionDraftRepository.ts";
import { SessionDraftProvider } from "../state/SessionDraftContext.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { WorkoutEditorScreen } from "./WorkoutEditorScreen.tsx";

const OWNER = "draft-test-owner";

function seededDraft(overrides: Partial<SessionDraft> = {}): SessionDraft {
  const base = createSessionDraft("2026-01-05");
  return {
    ...base,
    notes: "restored notes",
    exercises: [{ ...base.exercises[0]!, name: "Squat" }],
    ...overrides,
  };
}

/** A draft that passes core validation, for the save-clears-draft case. */
function validDraft(): SessionDraft {
  const base = createSessionDraft("2026-01-05");
  const exercise = base.exercises[0]!;
  return {
    ...base,
    exercises: [
      {
        ...exercise,
        name: "Squat",
        sets: [{ ...exercise.sets[0]!, weight: "100", reps: "5", rpe: "8" }],
      },
    ],
  };
}

function renderEditor(
  adapter: StorageAdapter = new MemoryStorageAdapter(),
  client: FitTraceClient = clientFor(adapter),
) {
  return render(
    <MemoryRouter initialEntries={["/workout/new"]}>
      <WorkoutStoreProvider client={client}>
        <SessionDraftProvider ownerId={OWNER} adapter={adapter}>
          <Routes>
            <Route path="/workout/new" element={<WorkoutEditorScreen />} />
            <Route path="/workout/:id" element={<div data-testid="summary" />} />
          </Routes>
        </SessionDraftProvider>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
}

function notesField(): HTMLElement {
  return screen.getByLabelText(/^notes$/i);
}

/** A storage backend whose writes always fail, counting attempts. */
class FailingWriteAdapter extends MemoryStorageAdapter {
  attempts = 0;

  write(_key: string, _value: string): void {
    this.attempts += 1;
    throw new StorageUnavailableError("write blocked");
  }
}

/** A storage backend whose reads fail but which still counts writes. */
class FailingReadAdapter extends MemoryStorageAdapter {
  writes = 0;

  read(_key: string): string | null {
    throw new StorageUnavailableError("read blocked");
  }

  write(key: string, value: string): void {
    this.writes += 1;
    super.write(key, value);
  }
}

describe("WorkoutEditorScreen session draft", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores a stored draft without rewriting it", () => {
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(adapter, seededDraft(), OWNER);
    const key = sessionDraftKey(OWNER);
    const storedBefore = adapter.read(key);

    renderEditor(adapter);

    expect(screen.getByTestId("draft-notice")).toHaveTextContent(
      /unfinished session restored/i,
    );
    expect(screen.getByTestId("draft-notice")).toHaveAttribute("role", "status");
    expect(notesField()).toHaveValue("restored notes");
    expect(screen.getByLabelText(/exercise 1 name/i)).toHaveValue("Squat");
    // Mounting is not an edit: the stored payload must stay byte-identical.
    expect(adapter.read(key)).toBe(storedBefore);
  });

  it("auto-pauses an active timing restored from storage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T10:00:00.000Z"));
    const now = Date.now();
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(
      adapter,
      seededDraft({
        timing: {
          startedAtMs: now - 10 * 60_000,
          endedAtMs: null,
          pausedAtMs: null,
          pausedTotalMs: 0,
          lastActiveAtMs: now - 5 * 60_000,
        },
      }),
      OWNER,
    );

    renderEditor(adapter);

    expect(screen.getByTestId("draft-notice")).toHaveTextContent(/auto-paused/i);
    expect(screen.getByTestId("session-phase")).toHaveTextContent(/paused/i);
    // Time while the page was closed is not counted: elapsed stops at the last
    // confirmed activity five minutes in.
    expect(screen.getByTestId("session-elapsed")).toHaveTextContent("05:00");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    expect(screen.queryByTestId("session-phase")).toBeNull();
  });

  it("autosaves edits and restores them after unmount", async () => {
    const adapter = new MemoryStorageAdapter();
    const view = renderEditor(adapter);
    const user = userEvent.setup();

    await user.type(notesField(), "persisted work");
    expect(loadSessionDraft(adapter, OWNER)?.notes).toBe("persisted work");

    view.unmount();
    renderEditor(adapter);

    expect(screen.getByTestId("draft-notice")).toHaveTextContent(/restored/i);
    expect(notesField()).toHaveValue("persisted work");
  });

  it("clears the draft after a successful workout save", async () => {
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(adapter, validDraft(), OWNER);
    renderEditor(adapter);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByTestId("summary")).toBeInTheDocument();
    expect(loadSessionDraft(adapter, OWNER)).toBeNull();
  });

  it("clears a saved auto-paused restored draft without edits", async () => {
    const now = Date.now();
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(
      adapter,
      {
        ...validDraft(),
        timing: {
          startedAtMs: now - 10 * 60_000,
          endedAtMs: null,
          pausedAtMs: null,
          pausedTotalMs: 0,
          lastActiveAtMs: now - 5 * 60_000,
        },
      },
      OWNER,
    );
    renderEditor(adapter);
    const user = userEvent.setup();

    // Restoring auto-pauses in memory while storage still holds the active
    // timing. Saving without edits must still clear that stored payload.
    expect(screen.getByTestId("session-phase")).toHaveTextContent(/paused/i);
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByTestId("summary")).toBeInTheDocument();
    expect(loadSessionDraft(adapter, OWNER)).toBeNull();
  });

  it("does not clear a newer draft when an older save resolves", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = new FakeFitTraceClient({ records: [] });
    saveSessionDraft(adapter, validDraft(), OWNER);

    const first = renderEditor(adapter, client);
    const firstUser = userEvent.setup();
    const gate = client.nextCreate();
    await firstUser.click(screen.getByRole("button", { name: /save workout/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));

    // Leave the editor while the save is in flight, then re-enter and make a
    // newer edit for the same owner.
    first.unmount();
    renderEditor(adapter, client);
    const secondUser = userEvent.setup();
    await secondUser.type(notesField(), "newer work");
    expect(loadSessionDraft(adapter, OWNER)?.notes).toBe("newer work");

    gate.resolve({
      record: {
        id: "wkt_saved",
        schema_version: 1,
        date: "2026-01-05",
        session_type: "strength",
        exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
      },
      duplicate: false,
      warnings: [],
    });

    // The old save must not erase the newer draft under the same owner key.
    await waitFor(() => {
      expect(loadSessionDraft(adapter, OWNER)?.notes).toBe("newer work");
    });
  });

  it("discards a restored draft only after the inline confirmation", async () => {
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(adapter, seededDraft(), OWNER);
    renderEditor(adapter);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    // First click only asks; the payload is still stored.
    expect(screen.getByText(/discard the unfinished session draft\?/i)).toBeInTheDocument();
    expect(loadSessionDraft(adapter, OWNER)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /discard draft/i }));

    expect(loadSessionDraft(adapter, OWNER)).toBeNull();
    expect(screen.getByTestId("draft-discarded")).toHaveTextContent(/discarded/i);
    expect(screen.queryByTestId("draft-notice")).toBeNull();
    expect(screen.queryByTestId("draft-actions")).toBeNull();
    expect(notesField()).toHaveValue("");
    expect(screen.getByRole("button", { name: /start session/i })).toBeInTheDocument();
  });

  it("blocks autosave for a corrupt draft until the user discards it", async () => {
    const adapter = new MemoryStorageAdapter();
    const key = sessionDraftKey(OWNER);
    adapter.write(key, "{not json");
    renderEditor(adapter);
    const user = userEvent.setup();

    expect(screen.getByTestId("draft-corrupt")).toHaveTextContent(/could not restore/i);
    expect(screen.getByTestId("draft-corrupt")).toHaveAttribute("role", "alert");

    // Editing must never overwrite a payload we could not read.
    await user.type(notesField(), "typing");
    expect(adapter.read(key)).toBe("{not json");
    expect(() => loadSessionDraft(adapter, OWNER)).toThrow(SessionDraftCorruptionError);

    // Explicit two-step discard unblocks storage for the fresh draft.
    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(adapter.read(key)).toBeNull();

    await user.type(notesField(), "new work");
    expect(loadSessionDraft(adapter, OWNER)?.notes).toBe("new work");
  });

  it("shows one autosave failure banner and stops retrying", async () => {
    const adapter = new FailingWriteAdapter();
    renderEditor(adapter);
    const user = userEvent.setup();

    await user.type(notesField(), "first");

    expect(screen.getByTestId("draft-save-error")).toHaveTextContent(
      /draft autosave failed: write blocked/i,
    );
    expect(screen.getByTestId("draft-actions")).toBeInTheDocument();
    expect(adapter.attempts).toBe(1);

    await user.type(notesField(), " more");

    // A failed autosave is shown once and is not hammered on every keystroke.
    expect(adapter.attempts).toBe(1);
    expect(screen.getAllByTestId("draft-save-error")).toHaveLength(1);
  });

  it("survives a storage read failure and can discard to recover", async () => {
    const adapter = new FailingReadAdapter();
    renderEditor(adapter);
    const user = userEvent.setup();

    expect(screen.getByTestId("draft-read-error")).toHaveTextContent(/read blocked/i);
    expect(screen.getByTestId("draft-actions")).toBeInTheDocument();

    await user.type(notesField(), "unpersisted");

    expect(adapter.writes).toBe(0);
    expect(screen.queryByTestId("draft-save-error")).toBeNull();
    // The editor stays usable after the failed restore.
    expect(notesField()).toHaveValue("unpersisted");

    // An explicit discard clears the unreadable state and re-enables autosave.
    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(screen.queryByTestId("draft-read-error")).toBeNull();

    await user.type(notesField(), "after discard");
    expect(adapter.writes).toBeGreaterThan(0);
  });

  it("hides the manual duration field while the session is timed", async () => {
    renderEditor(new MemoryStorageAdapter());
    const user = userEvent.setup();

    expect(screen.getByLabelText(/duration \(minutes\)/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start session/i }));

    expect(screen.queryByLabelText(/duration \(minutes\)/i)).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("session-elapsed")).toBeInTheDocument(),
    );
  });
});
