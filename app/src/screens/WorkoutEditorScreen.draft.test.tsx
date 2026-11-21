import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionDraftCorruptionError,
  createDraftExercise,
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
import { loadRecords } from "../storage/workoutRepository.ts";
import { SessionDraftProvider } from "../state/SessionDraftContext.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { WorkoutEditorScreen } from "./WorkoutEditorScreen.tsx";

const OWNER = "draft-test-owner";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state)}</output>;
}

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

type EditorEntry = string | { pathname: string; state?: unknown };

function renderEditor(
  adapter: StorageAdapter = new MemoryStorageAdapter(),
  client: FitTraceClient = clientFor(adapter),
  initialEntries: EditorEntry[] = ["/workout/new"],
  strict = false,
) {
  const tree = (
    <div className="app-shell">
    <MemoryRouter initialEntries={initialEntries}>
      <WorkoutStoreProvider client={client}>
        <SessionDraftProvider ownerId={OWNER} adapter={adapter}>
          <Routes>
            <Route path="/workout/new" element={<WorkoutEditorScreen />} />
            <Route path="/workout/:id" element={<div data-testid="summary" />} />
          </Routes>
          <LocationProbe />
        </SessionDraftProvider>
      </WorkoutStoreProvider>
    </MemoryRouter>
    </div>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
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

    expect(screen.queryByText(/validation runs before anything is stored/i)).not.toBeInTheDocument();
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

  it("does not clear a draft another tab wrote while this editor was open", async () => {
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(adapter, validDraft(), OWNER);
    renderEditor(adapter);
    const user = userEvent.setup();

    // Another tab owns the same key and autosaves its newer draft while this
    // editor still shows the older in-memory copy.
    saveSessionDraft(adapter, { ...validDraft(), notes: "another tab" }, OWNER);

    await user.click(screen.getByRole("button", { name: /save workout/i }));
    expect(await screen.findByTestId("summary")).toBeInTheDocument();

    // This tab saved its older record, but must not delete the other tab's draft.
    expect(loadSessionDraft(adapter, OWNER)?.notes).toBe("another tab");
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


describe("exercise library integration", () => {
  it("opens the library dialog, focuses search and appends an editable exercise without saving", async () => {
    const adapter = new MemoryStorageAdapter();
    renderEditor(adapter);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: /browse exercise library/i });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: /exercise library/i });
    expect(within(dialog).getByLabelText("Search exercises")).toHaveFocus();

    await user.type(within(dialog).getByLabelText("Search exercises"), "barbell squat");
    await user.click(within(dialog).getByRole("button", { name: /^Barbell Squat/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add to workout" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/exercise 2 name/i)).toHaveValue("Barbell Squat");
    // Adding is a draft edit, never an implicit workout save.
    expect(loadRecords(adapter)).toHaveLength(0);
  });

  it("closes the dialog with Escape and restores focus to the opener", async () => {
    renderEditor();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: /browse exercise library/i });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("replaces the pristine blank exercise instead of appending a second row", async () => {
    const adapter = new MemoryStorageAdapter();
    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-pristine", name: "Barbell Squat" } },
      },
    ]);

    // A new draft's untouched row becomes the chosen exercise: one row, no
    // abandoned blank EXERCISE 1 above it.
    expect(await screen.findByLabelText(/exercise 1 name/i)).toHaveValue("Barbell Squat");
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(1);
    // Reusing the row keeps its pristine blank set; nothing was invented.
    expect(screen.getByLabelText(/exercise 1 set 1 weight/i)).toHaveValue(null);
    expect(screen.getByLabelText(/exercise 1 set 1 reps/i)).toHaveValue(null);
    expect(screen.getByLabelText(/exercise 1 set 1 rpe/i)).toHaveValue(null);
    expect(screen.getByTestId("location-state")).toHaveTextContent("null");
    expect(loadRecords(adapter)).toHaveLength(0);
    await waitFor(() => expect(loadSessionDraft(adapter, OWNER)?.exercises).toHaveLength(1));
  });

  it("appends when the draft already has typed set values", async () => {
    const adapter = new MemoryStorageAdapter();
    const base = createSessionDraft("2026-01-05");
    const exercise = base.exercises[0]!;
    saveSessionDraft(
      adapter,
      {
        ...base,
        exercises: [
          {
            ...exercise,
            // Blank name but real data: the row is in use and must be kept.
            sets: [{ ...exercise.sets[0]!, weight: "100", reps: "5" }],
          },
        ],
      },
      OWNER,
    );

    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-typed", name: "Barbell Squat" } },
      },
    ]);

    expect(await screen.findByLabelText(/exercise 2 name/i)).toHaveValue("Barbell Squat");
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(2);
    expect(screen.getByLabelText(/exercise 1 name/i)).toHaveValue("");
    expect(screen.getByLabelText(/exercise 1 set 1 weight/i)).toHaveValue(100);
    expect(screen.getByLabelText(/exercise 1 set 1 reps/i)).toHaveValue(5);
  });

  it("appends when a blank draft already has more than one exercise", async () => {
    const adapter = new MemoryStorageAdapter();
    const base = createSessionDraft("2026-01-05");
    saveSessionDraft(
      adapter,
      { ...base, exercises: [base.exercises[0]!, createDraftExercise(3)] },
      OWNER,
    );

    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-two-rows", name: "Barbell Squat" } },
      },
    ]);

    expect(await screen.findByLabelText(/exercise 3 name/i)).toHaveValue("Barbell Squat");
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(3);
    expect(screen.getByLabelText(/exercise 1 name/i)).toHaveValue("");
    expect(screen.getByLabelText(/exercise 2 name/i)).toHaveValue("");
  });

  it("consumes the one-shot request once even when StrictMode replays the effect", async () => {
    const adapter = new MemoryStorageAdapter();
    renderEditor(
      adapter,
      clientFor(adapter),
      [
        {
          pathname: "/workout/new",
          state: { libraryAdd: { id: "request-strict", name: "Barbell Squat" } },
        },
      ],
      true,
    );

    expect(await screen.findByLabelText(/exercise 1 name/i)).toHaveValue("Barbell Squat");
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(1);
  });

  it("appends to a restored draft and keeps its notes", async () => {
    const adapter = new MemoryStorageAdapter();
    saveSessionDraft(adapter, seededDraft({ notes: "keep me" }), OWNER);

    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-2", name: "Barbell Squat" } },
      },
    ]);

    expect(screen.getByLabelText(/^notes$/i)).toHaveValue("keep me");
    expect(await screen.findByLabelText(/exercise 2 name/i)).toHaveValue("Barbell Squat");
    await waitFor(() => expect(loadSessionDraft(adapter, OWNER)?.exercises).toHaveLength(2));
  });

  it("never appends over a corrupt draft and preserves the original payload", async () => {
    const adapter = new MemoryStorageAdapter();
    const key = sessionDraftKey(OWNER);
    adapter.write(key, "{not json");

    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-3", name: "Barbell Squat" } },
      },
    ]);

    expect(screen.getByTestId("draft-corrupt")).toHaveTextContent(/could not restore/i);
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /browse exercise library/i })).toBeDisabled();
    expect(adapter.read(key)).toBe("{not json");
  });

  it("drops a one-shot add when the draft cannot be read", async () => {
    const adapter = new FailingReadAdapter();
    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-read-error", name: "Barbell Squat" } },
      },
    ]);

    expect(screen.getByTestId("draft-read-error")).toHaveTextContent(/read blocked/i);
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(1);
    expect(screen.getByTestId("location-state")).toHaveTextContent("null");
    expect(adapter.writes).toBe(0);
  });

  it("allows an intentional second add with a fresh request id", async () => {
    const adapter = new MemoryStorageAdapter();
    const first = renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-fresh-1", name: "Barbell Squat" } },
      },
    ]);
    expect(await screen.findByLabelText(/exercise 1 name/i)).toHaveValue("Barbell Squat");
    first.unmount();

    // The draft now holds a real exercise, so the next request appends.
    renderEditor(adapter, clientFor(adapter), [
      {
        pathname: "/workout/new",
        state: { libraryAdd: { id: "request-fresh-2", name: "Barbell Squat" } },
      },
    ]);
    expect(await screen.findByLabelText(/exercise 2 name/i)).toHaveValue("Barbell Squat");
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(2);
  });

  it("does not replay the same request id on a remount", async () => {
    const adapter = new MemoryStorageAdapter();
    const request = {
      pathname: "/workout/new",
      state: { libraryAdd: { id: "request-replay", name: "Barbell Squat" } },
    };
    const first = renderEditor(adapter, clientFor(adapter), [request]);
    expect(await screen.findByLabelText(/exercise 1 name/i)).toHaveValue("Barbell Squat");
    first.unmount();

    renderEditor(adapter, clientFor(adapter), [request]);
    expect(await screen.findByLabelText(/exercise 1 name/i)).toHaveValue("Barbell Squat");
    expect(screen.getAllByLabelText(/exercise \d+ name/i)).toHaveLength(1);
  });

  it("makes the app shell inert while the dialog is open and restores focus", async () => {
    renderEditor();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: /browse exercise library/i });
    await user.click(trigger);
    const shell = document.querySelector(".app-shell");
    expect(shell).toHaveAttribute("inert");
    const dialog = screen.getByRole("dialog");
    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(shell).not.toHaveAttribute("inert");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps focus inside the dialog after clearing the query", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /browse exercise library/i }));
    const dialog = screen.getByRole("dialog");
    const search = within(dialog).getByLabelText("Search exercises");
    await user.type(search, "barbell");
    await user.click(within(dialog).getByRole("button", { name: "Clear search" }));
    expect(search).toHaveFocus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not recreate a discarded draft when the editor unmounts", async () => {
    const adapter = new MemoryStorageAdapter();
    const key = sessionDraftKey(OWNER);
    adapter.write(key, "{not json");
    const { unmount } = renderEditor(adapter);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    await user.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(loadSessionDraft(adapter, OWNER)).toBeNull();

    unmount();
    expect(loadSessionDraft(adapter, OWNER)).toBeNull();
  });

  it("persists the latest draft across navigation (autosave + defensive unmount flush)", async () => {
    const adapter = new MemoryStorageAdapter();
    const { unmount } = renderEditor(adapter);
    const user = userEvent.setup();
    await user.type(notesField(), "latest draft");

    unmount();
    expect(loadSessionDraft(adapter, OWNER)?.notes).toBe("latest draft");
  });
});
