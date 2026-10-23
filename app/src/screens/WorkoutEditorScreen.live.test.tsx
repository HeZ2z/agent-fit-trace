import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../i18n/i18n.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { SessionDraftProvider } from "../state/SessionDraftContext.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { clientFor } from "../test/asyncClient.ts";
import { WorkoutEditorScreen } from "./WorkoutEditorScreen.tsx";

const { playRestCue, vibrate } = vi.hoisted(() => ({
  playRestCue: vi.fn(),
  vibrate: vi.fn(),
}));

// Feedback is an environment boundary (Web Audio / Vibration API). Mocking it
// here lets the live test assert "exactly once" without faking device APIs;
// `liveFeedback.test.ts` separately covers the browser guards.
vi.mock("../workout/liveFeedback.ts", () => ({
  playRestCue,
  vibrate,
  REST_ENDED_VIBRATION: [80, 40, 80],
  SET_CHECKED_VIBRATION_MS: 30,
}));

const START = new Date("2026-01-05T10:00:00.000Z");
const DRAFT_OWNER = "editor-live-test-owner";

function renderEditor(): void {
  // One in-memory adapter backs both workouts and the session draft so these
  // tests never read or write the real localStorage.
  const adapter = new MemoryStorageAdapter();
  render(
    <MemoryRouter initialEntries={["/workout/new"]}>
      <WorkoutStoreProvider client={clientFor(adapter)}>
        <SessionDraftProvider ownerId={DRAFT_OWNER} adapter={adapter}>
          <Routes>
            <Route path="/workout/new" element={<WorkoutEditorScreen />} />
            <Route path="/workout/:id" element={<div data-testid="summary" />} />
          </Routes>
        </SessionDraftProvider>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
}

/** Flush the initial history load (a microtask) without advancing the clock. */
async function renderEditorSettled(): Promise<void> {
  renderEditor();
  await act(async () => {});
}

function startSession(): void {
  fireEvent.click(screen.getByRole("button", { name: /start session/i }));
}

function checkSet(index = 0): void {
  fireEvent.click(screen.getAllByRole("checkbox")[index]!);
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function elapsed(): string {
  return screen.getByTestId("session-elapsed").textContent ?? "";
}

function restRemaining(): string {
  return screen.getByTestId("rest-remaining").textContent ?? "";
}

describe("WorkoutEditorScreen live session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    window.localStorage.clear();
    setLanguage("en");
    playRestCue.mockClear();
    vibrate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setLanguage("en");
  });

  it("shows only the start affordance before the session is timed", async () => {
    await renderEditorSettled();

    expect(screen.getByRole("button", { name: /start session/i })).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByLabelText(/rest \(seconds\)/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /pause session/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume session/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /finish session/i })).toBeNull();
    expect(screen.queryByTestId("rest-bar")).toBeNull();
  });

  it("reveals the timer, checkboxes and rest configuration on start", async () => {
    await renderEditorSettled();
    startSession();

    expect(screen.getByTestId("session-elapsed")).toHaveTextContent(/elapsed: 00:00/i);
    expect(screen.getByTestId("session-elapsed")).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("button", { name: /pause session/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /finish session/i })).toBeEnabled();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByLabelText(/rest \(seconds\)/i)).toHaveValue(90);
    expect(screen.queryByRole("button", { name: /start session/i })).toBeNull();
  });

  it("advances elapsed time with the ticker, including the hour segment", async () => {
    await renderEditorSettled();
    startSession();

    advance(65_000);
    expect(elapsed()).toContain("01:05");

    advance(3_596_000);
    expect(elapsed()).toContain("1:01:01");
  });

  it("freezes elapsed while paused and resumes from the frozen value", async () => {
    await renderEditorSettled();
    startSession();
    advance(3_000);

    fireEvent.click(screen.getByRole("button", { name: /pause session/i }));
    expect(screen.getByTestId("session-phase")).toHaveTextContent(/paused/i);
    expect(elapsed()).toContain("00:03");

    advance(10_000);
    expect(elapsed()).toContain("00:03");

    fireEvent.click(screen.getByRole("button", { name: /resume session/i }));
    expect(screen.queryByTestId("session-phase")).toBeNull();
    advance(2_000);
    expect(elapsed()).toContain("00:05");
  });

  it("finishes the session, stops the ticker and disables live controls", async () => {
    await renderEditorSettled();
    startSession();
    advance(5_000);

    fireEvent.click(screen.getByRole("button", { name: /finish session/i }));
    expect(screen.getByTestId("session-phase")).toHaveTextContent(/finished/i);
    expect(elapsed()).toContain("00:05");
    expect(screen.getByRole("button", { name: /finish session/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /pause session/i })).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();

    advance(10_000);
    expect(elapsed()).toContain("00:05");
  });

  it("checks a set, appends a prefilled suggestion and starts its rest", async () => {
    await renderEditorSettled();
    startSession();
    checkSet();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
    expect(vibrate).toHaveBeenCalledWith(30);

    expect(screen.getByTestId("rest-bar")).toBeInTheDocument();
    expect(restRemaining()).toContain("01:30");
  });

  it("counts the rest down and adjusts it by 15 seconds", async () => {
    await renderEditorSettled();
    startSession();
    checkSet();

    advance(15_000);
    expect(restRemaining()).toContain("01:15");

    fireEvent.click(screen.getByRole("button", { name: /add 15 seconds/i }));
    expect(restRemaining()).toContain("01:30");

    fireEvent.click(screen.getByRole("button", { name: /subtract 15 seconds/i }));
    expect(restRemaining()).toContain("01:15");
  });

  it("scopes set checkbox names to the exercise and toggles them independently", async () => {
    await renderEditorSettled();
    startSession();
    fireEvent.click(screen.getByRole("button", { name: /add exercise/i }));

    const firstExerciseCheckbox = screen.getByRole("checkbox", {
      name: "Exercise 1: Set 1 complete",
    });
    const secondExerciseCheckbox = screen.getByRole("checkbox", {
      name: "Exercise 2: Set 1 complete",
    });
    expect(firstExerciseCheckbox).not.toBe(secondExerciseCheckbox);

    fireEvent.click(firstExerciseCheckbox);

    expect(firstExerciseCheckbox).toBeChecked();
    expect(secondExerciseCheckbox).not.toBeChecked();
  });

  it("skips the rest without firing the rest-ended cue", async () => {
    await renderEditorSettled();
    startSession();
    checkSet();
    vibrate.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /skip rest/i }));

    expect(screen.queryByTestId("rest-bar")).toBeNull();
    expect(screen.queryByTestId("rest-complete")).toBeNull();
    expect(playRestCue).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("fires the rest-ended cue once and re-arms it for the next rest", async () => {
    await renderEditorSettled();
    startSession();
    checkSet();
    playRestCue.mockClear();
    vibrate.mockClear();

    advance(90_000);

    expect(screen.queryByTestId("rest-bar")).toBeNull();
    expect(screen.getByTestId("rest-complete")).toHaveTextContent(/rest complete/i);
    expect(playRestCue).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([80, 40, 80]);

    // Later ticks must not replay the cue for the same settled rest.
    advance(5_000);
    expect(playRestCue).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("rest-complete")).toBeInTheDocument();

    // Checking the prefilled next set starts a new rest: the settled status is
    // hidden again and the cue is armed for the next completion.
    checkSet(1);
    expect(screen.queryByTestId("rest-complete")).toBeNull();
    expect(screen.getByTestId("rest-bar")).toBeInTheDocument();

    advance(90_000);
    expect(playRestCue).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("rest-complete")).toBeInTheDocument();

    // Finishing hides the settled status and never replays the cue.
    fireEvent.click(screen.getByRole("button", { name: /finish session/i }));
    expect(screen.queryByTestId("rest-complete")).toBeNull();
    expect(playRestCue).toHaveBeenCalledTimes(2);
  });

  it("uses the per-exercise rest seconds and treats an empty value as no rest", async () => {
    await renderEditorSettled();
    startSession();

    const restInput = screen.getByLabelText(/rest \(seconds\)/i);
    fireEvent.change(restInput, { target: { value: "45" } });
    expect(restInput).toHaveValue(45);

    checkSet();
    expect(restRemaining()).toContain("00:45");

    // Clearing the field means zero rest: checking the next set starts nothing.
    fireEvent.click(screen.getByRole("button", { name: /skip rest/i }));
    fireEvent.change(restInput, { target: { value: "" } });
    expect(restInput).toHaveValue(0);
    checkSet(1);
    expect(screen.queryByTestId("rest-bar")).toBeNull();
    expect(screen.queryByTestId("rest-complete")).toBeNull();
  });

  it("catches the clock up when the tab becomes visible again", async () => {
    await renderEditorSettled();
    startSession();
    checkSet();

    // The interval is throttled in the background: move the wall clock without
    // running timers, then return to the tab.
    act(() => {
      vi.setSystemTime(new Date(START.getTime() + 60_000));
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(restRemaining()).toContain("00:30");
  });

  it("drops the rest when the session finishes", async () => {
    await renderEditorSettled();
    startSession();
    checkSet();
    expect(screen.getByTestId("rest-bar")).toBeInTheDocument();
    playRestCue.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /finish session/i }));

    expect(screen.queryByTestId("rest-bar")).toBeNull();
    expect(screen.queryByTestId("rest-complete")).toBeNull();
    expect(playRestCue).not.toHaveBeenCalled();
  });
});
