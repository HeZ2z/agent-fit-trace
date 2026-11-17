import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { listExercises } from "@agent-fit-trace/core";
import {
  createSessionDraft,
  type SessionDraft,
} from "@agent-fit-trace/workout-session";
import { MemoryStorageAdapter, StorageUnavailableError } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import {
  loadSessionDraft,
  saveSessionDraft,
  sessionDraftKey,
} from "../storage/sessionDraftRepository.ts";
import { SessionDraftProvider } from "../state/SessionDraftContext.tsx";
import { setLanguage } from "../i18n/i18n.ts";
import { ExerciseLibraryScreen } from "./ExerciseLibraryScreen.tsx";

const OWNER = "library-test-owner";
const OTHER_OWNER = "library-test-other-owner";

function renderLibrary(
  adapter: StorageAdapter = new MemoryStorageAdapter(),
  owner: string = OWNER,
) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/exercises"]}>
      <SessionDraftProvider ownerId={owner} adapter={adapter}>
        <Routes>
          <Route path="/exercises" element={<ExerciseLibraryScreen />} />
          <Route path="/workout/new" element={<div data-testid="editor" />} />
        </Routes>
      </SessionDraftProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

/** The result-list button whose visible name is exactly `name`. */
function resultButton(name: string): HTMLButtonElement {
  const list = screen.getByTestId("exercise-library-list");
  const label = within(list).getByText(name);
  const button = label.closest("button");
  if (button === null) throw new Error(`no result button for ${name}`);
  return button;
}

/** A storage backend whose writes always fail. */
class FailingWriteAdapter extends MemoryStorageAdapter {
  write(_key: string, _value: string): void {
    throw new StorageUnavailableError("write blocked");
  }
}

function seededDraft(overrides: Partial<SessionDraft> = {}): SessionDraft {
  const base = createSessionDraft("2026-03-01");
  return {
    ...base,
    notes: "keep me",
    exercises: [{ ...base.exercises[0]!, name: "Front Squat" }],
    ...overrides,
  };
}

describe("ExerciseLibraryScreen", () => {
  afterEach(() => {
    setLanguage("en");
  });

  it("renders the catalog, review notice and filter controls", () => {
    renderLibrary();

    expect(
      screen.getByRole("heading", { level: 1, name: "Exercise Library" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Catalog data is a reference/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("194 exercises");
    expect(screen.getByLabelText("Search exercises")).toBeInTheDocument();
    expect(screen.getByLabelText("Movement pattern")).toBeInTheDocument();
    expect(screen.getByLabelText("Muscle")).toBeInTheDocument();
    expect(screen.getByLabelText("Equipment")).toBeInTheDocument();
    expect(screen.getByLabelText("Difficulty")).toBeInTheDocument();
    expect(screen.getByText("Select an exercise to see its details.")).toBeInTheDocument();
    expect(
      screen.getByText("Muscle filters match primary and secondary muscles."),
    ).toBeInTheDocument();
  });

  it("searches beyond the autocomplete cap and filters the ranked results", async () => {
    const { user } = renderLibrary();

    await user.type(screen.getByLabelText("Search exercises"), "press");
    const list = screen.getByTestId("exercise-library-list");
    expect(within(list).getByText("Barbell Bench Press - Medium Grip")).toBeInTheDocument();
    expect(within(list).getByText("Cable Chest Press")).toBeInTheDocument();
    expect(within(list).getAllByRole("button").length).toBeGreaterThan(20);

    await user.selectOptions(screen.getByLabelText("Equipment"), "barbell");
    expect(within(list).getByText("Barbell Bench Press - Medium Grip")).toBeInTheDocument();
    expect(within(list).queryByText("Cable Chest Press")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("194 exercises");
  });

  it("shows an empty state that clears back to the full catalog", async () => {
    const { user } = renderLibrary();
    const search = screen.getByLabelText("Search exercises");

    await user.type(search, "zzzz-not-an-exercise");
    expect(screen.getByText("No exercises match these filters.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("status")).toHaveTextContent("194 exercises");
    expect(search).toHaveValue("");
  });

  it("selects an exercise and adds it to a fresh draft without saving a workout", async () => {
    const adapter = new MemoryStorageAdapter();
    const { user } = renderLibrary(adapter);

    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(resultButton("Barbell Squat"));

    expect(
      screen.getByRole("heading", { level: 2, name: "Barbell Squat" }),
    ).toHaveFocus();
    expect(screen.getByText("Primary muscles")).toBeInTheDocument();
    expect(screen.getByText("Quadriceps", { selector: "dd" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    expect(screen.getByTestId("editor")).toBeInTheDocument();
    const stored = loadSessionDraft(adapter, OWNER);
    expect(stored).not.toBeNull();
    expect(stored!.exercises).toHaveLength(1);
    expect(stored!.exercises[0]!.name).toBe("Barbell Squat");
    expect(stored!.exercises[0]!.sets).toHaveLength(1);
    // The owner-scoped key is the only one written.
    expect(loadSessionDraft(adapter, OTHER_OWNER)).toBeNull();
    expect(sessionDraftKey(OWNER)).not.toBe(sessionDraftKey(OTHER_OWNER));
  });

  it("preserves an existing draft's notes, date and timing when appending", async () => {
    const adapter = new MemoryStorageAdapter();
    const timing = {
      startedAtMs: 1_000,
      endedAtMs: null,
      pausedAtMs: null,
      pausedTotalMs: 0,
      lastActiveAtMs: 2_000,
    };
    saveSessionDraft(adapter, seededDraft({ timing }), OWNER);
    const { user } = renderLibrary(adapter);

    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(resultButton("Barbell Squat"));
    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    const stored = loadSessionDraft(adapter, OWNER);
    expect(stored).not.toBeNull();
    expect(stored!.date).toBe("2026-03-01");
    expect(stored!.notes).toBe("keep me");
    expect(stored!.timing).toEqual(timing);
    expect(stored!.exercises).toHaveLength(2);
    expect(stored!.exercises[0]!.name).toBe("Front Squat");
    expect(stored!.exercises[1]!.name).toBe("Barbell Squat");
  });

  it("keeps a corrupt draft untouched and reports the read failure", async () => {
    const adapter = new MemoryStorageAdapter();
    const key = sessionDraftKey(OWNER);
    adapter.write(key, "{ this is not a session draft");
    const before = adapter.read(key);

    const { user } = renderLibrary(adapter);
    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(resultButton("Barbell Squat"));
    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Could not read the stored workout draft/,
    );
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    expect(adapter.read(key)).toBe(before);
  });

  it("reports a failed draft write and stays on the library", async () => {
    const adapter = new FailingWriteAdapter();
    const { user } = renderLibrary(adapter);

    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(resultButton("Barbell Squat"));
    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Could not add this exercise to the workout draft/,
    );
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("returns from the detail to the results", async () => {
    const { user } = renderLibrary();

    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(resultButton("Barbell Squat"));
    await user.click(screen.getByRole("button", { name: "Back to results" }));

    expect(screen.getByText("Select an exercise to see its details.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to workout" })).not.toBeInTheDocument();
    expect(screen.getByTestId("exercise-library-list")).toBeInTheDocument();
    expect(screen.getByLabelText("Search exercises")).toHaveFocus();
  });

  it("adds a new row when the only existing row already has logged sets", async () => {
    const adapter = new MemoryStorageAdapter();
    const base = createSessionDraft("2026-03-01");
    const unnamedWithData: SessionDraft = {
      ...base,
      exercises: [
        {
          ...base.exercises[0]!,
          sets: [{ ...base.exercises[0]!.sets[0]!, weight: "100", reps: "5" }],
        },
      ],
    };
    saveSessionDraft(adapter, unnamedWithData, OWNER);
    const { user } = renderLibrary(adapter);

    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(resultButton("Barbell Squat"));
    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    const stored = loadSessionDraft(adapter, OWNER);
    expect(stored).not.toBeNull();
    expect(stored!.exercises).toHaveLength(2);
    expect(stored!.exercises[0]!.name).toBe("");
    expect(stored!.exercises[0]!.sets[0]!.weight).toBe("100");
    expect(stored!.exercises[1]!.name).toBe("Barbell Squat");
  });

  it("renders a missing classification as Not classified", async () => {
    const missing = listExercises().find(
      (entry) => entry.mechanics === null || entry.force === null,
    );
    if (missing === undefined) throw new Error("catalog has no unclassified entry");
    const { user } = renderLibrary();

    await user.type(screen.getByLabelText("Search exercises"), missing.name);
    await user.click(resultButton(missing.name));

    expect(
      screen.getAllByText("Not classified", { selector: "dd" }).length,
    ).toBeGreaterThan(0);
  });

  it("clears a stale selection when a filter hides the selected entry", async () => {
    const { user } = renderLibrary();

    await user.type(screen.getByLabelText("Search exercises"), "squat");
    await user.click(resultButton("Barbell Squat"));
    expect(
      screen.getByRole("heading", { level: 2, name: "Barbell Squat" }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Movement pattern"), "cardio");

    expect(screen.queryByRole("button", { name: "Add to workout" })).not.toBeInTheDocument();
    expect(screen.getByText("Select an exercise to see its details.")).toBeInTheDocument();
  });

  it("uses Chinese labels but stores the canonical English name", async () => {
    setLanguage("zh");
    const adapter = new MemoryStorageAdapter();
    const { user } = renderLibrary(adapter);

    expect(screen.getByRole("heading", { level: 1, name: "动作库" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索动作")).toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索动作"), "卧推");

    const list = screen.getByTestId("exercise-library-list");
    const button = within(list).getByText("杠铃卧推").closest("button");
    if (button === null) throw new Error("no Chinese result button");
    await user.click(button);

    expect(
      screen.getByRole("heading", { level: 2, name: "杠铃卧推" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Barbell Bench Press - Medium Grip")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加入训练" }));

    const stored = loadSessionDraft(adapter, OWNER);
    expect(stored).not.toBeNull();
    expect(stored!.exercises[0]!.name).toBe("Barbell Bench Press - Medium Grip");
  });
});
