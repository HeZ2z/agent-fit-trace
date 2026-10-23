import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@agent-fit-trace/core";
import { deriveWorkoutId } from "../contracts/ids.ts";
import { setLanguage } from "../i18n/i18n.ts";
import { MemoryStorageAdapter, StorageUnavailableError } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import { loadRecords } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { WorkoutEditorScreen } from "./WorkoutEditorScreen.tsx";

function SummaryProbe() {
  const { id } = useParams<{ id: string }>();
  return <div data-testid="summary-id">{id}</div>;
}

function renderEditor(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/workout/new"]}>
      <WorkoutStoreProvider client={client}>
        <Routes>
          <Route path="/workout/new" element={<WorkoutEditorScreen />} />
          <Route path="/workout/:id" element={<SummaryProbe />} />
        </Routes>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );

  return { user, container: view.container };
}

function renderEditorOver(adapter: StorageAdapter = new MemoryStorageAdapter()) {
  return { adapter, ...renderEditor(clientFor(adapter)) };
}

async function fillValidSet(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/exercise 1 name/i), "Squat");
  await user.type(screen.getByLabelText(/exercise 1 set 1 weight \(kg\)/i), "100");
  await user.type(screen.getByLabelText(/exercise 1 set 1 reps/i), "5");
  await user.type(screen.getByLabelText(/exercise 1 set 1 rpe/i), "8");
}

/** Fill the numeric set fields, leaving the exercise name as typed separately. */
async function fillSetFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/exercise 1 set 1 weight \(kg\)/i), "100");
  await user.type(screen.getByLabelText(/exercise 1 set 1 reps/i), "5");
  await user.type(screen.getByLabelText(/exercise 1 set 1 rpe/i), "8");
}

/** Chinese-UI equivalent of {@link fillSetFields}. */
async function fillSetFieldsZh(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/动作 1 第 1 组重量/), "100");
  await user.type(screen.getByLabelText(/动作 1 第 1 组次数/), "5");
  await user.type(screen.getByLabelText(/动作 1 第 1 组 RPE/), "8");
}

describe("WorkoutEditorScreen", () => {
  it("renders the core fields", () => {
    renderEditorOver();

    expect(screen.getByLabelText(/^date$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/session type/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add exercise/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save workout/i })).toBeInTheDocument();
  });

  it("shows an error and does not persist when saving a blank form", async () => {
    const { adapter, user } = renderEditorOver();

    // The editor always keeps one exercise and one set; the shared build drops
    // blank content, so core reports the empty session as missing exercises.
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/exercises/i);
    expect(alert.querySelector('[data-issue-code="MISSING_EXERCISES"]')).not.toBeNull();
    expect(loadRecords(adapter)).toHaveLength(0);
  });

  it("keeps at least one exercise and one set", async () => {
    const { user } = renderEditorOver();

    // The remove controls are unavailable at the minimum instead of leaving an
    // empty form that the shared reducer would refuse to create anyway.
    expect(screen.getByRole("button", { name: /remove exercise/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /remove set/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /add set/i }));
    const setRemovers = screen.getAllByRole("button", { name: /remove set/i });
    expect(setRemovers).toHaveLength(2);
    expect(setRemovers[0]).toBeEnabled();
    await user.click(setRemovers[0]!);
    expect(screen.getByRole("button", { name: /remove set/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /add exercise/i }));
    const exerciseRemovers = screen.getAllByRole("button", { name: /remove exercise/i });
    expect(exerciseRemovers).toHaveLength(2);
    expect(exerciseRemovers[0]).toBeEnabled();
    await user.click(exerciseRemovers[0]!);
    expect(screen.getByRole("button", { name: /remove exercise/i })).toBeDisabled();
  });

  it("rejects a negative weight", async () => {
    const { adapter, user } = renderEditorOver();
    await fillValidSet(user);

    const weight = screen.getByLabelText(/weight \(kg\)/i);
    await user.clear(weight);
    await user.type(weight, "-10");
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/weight/i);
    expect(loadRecords(adapter)).toHaveLength(0);
  });

  it("rejects non-integer reps", async () => {
    const { adapter, user } = renderEditorOver();
    await fillValidSet(user);

    const reps = screen.getByLabelText(/exercise 1 set 1 reps/i);
    await user.clear(reps);
    await user.type(reps, "2.5");
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/reps/i);
    expect(loadRecords(adapter)).toHaveLength(0);
  });

  it("rejects RPE outside 1-10", async () => {
    const { adapter, user } = renderEditorOver();
    await fillValidSet(user);

    const rpe = screen.getByLabelText(/exercise 1 set 1 rpe/i);
    await user.clear(rpe);
    await user.type(rpe, "11");
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/rpe/i);
    expect(loadRecords(adapter)).toHaveLength(0);
  });

  it("saves a valid workout and navigates to its derived id", async () => {
    const { adapter, user } = renderEditorOver();
    await fillValidSet(user);

    const dateValue = (screen.getByLabelText(/^date$/i) as HTMLInputElement).value;
    const expectedId = deriveWorkoutId({
      id: "pending",
      schema_version: CURRENT_SCHEMA_VERSION,
      date: dateValue,
      session_type: "strength",
      exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    });

    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByTestId("summary-id")).toHaveTextContent(expectedId);

    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(expectedId);
  });

  it("derives the id from pre-validation content so padded names stay idempotent", async () => {
    const { adapter, user } = renderEditorOver();
    await user.type(screen.getByLabelText(/exercise 1 name/i), " Squat ");
    await fillSetFields(user);

    const dateValue = (screen.getByLabelText(/^date$/i) as HTMLInputElement).value;
    // The client hashes the submitted content before the core trims the name.
    // Keeping that pre-validation build as the save input prevents re-entering
    // an older padded-name workout from creating a second record.
    const expectedId = deriveWorkoutId({
      id: "pending",
      schema_version: CURRENT_SCHEMA_VERSION,
      date: dateValue,
      session_type: "strength",
      exercises: [{ name: " Squat ", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    });

    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByTestId("summary-id")).toHaveTextContent(expectedId);
    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(expectedId);
    expect(stored[0]!.exercises[0]!.name).toBe("Squat");
  });

  it("disables submit while a save is pending and does not double-submit", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    const { user } = renderEditor(client);
    await fillValidSet(user);

    const gate = client.nextCreate();
    await user.click(screen.getByRole("button", { name: /save workout/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));

    const submit = await screen.findByRole("button", { name: /save workout/i });
    await waitFor(() => expect(submit).toBeDisabled());
    // A second click on the disabled button issues no further create call.
    await user.click(submit);
    expect(client.createCalls).toBe(1);

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
    expect(await screen.findByTestId("summary-id")).toHaveTextContent("wkt_saved");
    expect(client.createCalls).toBe(1);
  });

  it("retains input and does not navigate when saving fails", async () => {
    const client = new FakeFitTraceClient({ records: [] });
    const { user } = renderEditor(client);
    await fillValidSet(user);

    const gate = client.nextCreate();
    await user.click(screen.getByRole("button", { name: /save workout/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));
    gate.reject(new Error("write blocked"));

    expect(await screen.findByTestId("save-error")).toHaveTextContent(/could not save/i);
    expect(screen.queryByTestId("summary-id")).not.toBeInTheDocument();
    // Input is retained.
    expect(screen.getByLabelText(/exercise 1 name/i)).toHaveValue("Squat");
  });

  it("incorporates the saved record into history immediately", async () => {
    const adapter = new MemoryStorageAdapter();
    const base = clientFor(adapter);
    let failLists = false;
    const flaky = Object.create(base) as typeof base;
    flaky.listWorkouts = async () => {
      if (failLists) throw new Error("refresh failed");
      return base.listWorkouts();
    };
    const { user } = renderEditor(flaky);
    await fillValidSet(user);

    failLists = true;
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    // Navigation still happens: the failed background refresh is not a save error.
    const summary = await screen.findByTestId("summary-id");
    expect(summary.textContent).toMatch(/wkt_/);
    expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
    expect(loadRecords(adapter)).toHaveLength(1);
  });

  it("shows accepted-input warnings and requires confirmation before saving", async () => {
    const { adapter, user } = renderEditorOver();
    await fillValidSet(user);
    await user.type(screen.getByLabelText(/sleep \(hours\)/i), "2");

    await user.click(screen.getByRole("button", { name: /save workout/i }));

    // Warnings for accepted-but-suspicious input must be visible, and nothing
    // may be persisted until the user explicitly confirms.
    expect(await screen.findByRole("status", { name: /warnings/i })).toHaveTextContent(
      /sleep_hours/i,
    );
    expect(loadRecords(adapter)).toHaveLength(0);
    expect(screen.queryByTestId("summary-id")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save anyway/i }));

    expect(await screen.findByTestId("summary-id")).toBeInTheDocument();
    expect(loadRecords(adapter)).toHaveLength(1);
  });

  it("invalidates the pending warning confirmation when the form changes", async () => {
    const { adapter, user } = renderEditorOver();
    await fillValidSet(user);

    const sleep = screen.getByLabelText(/sleep \(hours\)/i);
    await user.type(sleep, "2");
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByRole("button", { name: /save anyway/i })).toBeInTheDocument();
    expect(loadRecords(adapter)).toHaveLength(0);

    // Correct the flagged value: the stale confirmation must be invalidated so
    // "Save anyway" can never persist the superseded 2-hour value.
    await user.clear(sleep);
    await user.type(sleep, "7");

    expect(screen.queryByRole("button", { name: /save anyway/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("warning-invalidated")).toBeInTheDocument();

    // Re-submitting validates the corrected form and saves that value.
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    await screen.findByTestId("summary-id");
    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.sleep_hours).toBe(7);
  });

  it("surfaces a storage failure on save instead of crashing", async () => {
    const base = new MemoryStorageAdapter();
    const failing: StorageAdapter = {
      keys: (prefix) => base.keys(prefix),
      read: (key) => base.read(key),
      write: () => {
        throw new StorageUnavailableError("Unable to write workout storage.");
      },
      remove: (key) => base.remove(key),
    };

    const { user } = renderEditor(clientFor(failing));
    await fillValidSet(user);
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    expect(await screen.findByTestId("save-error")).toHaveTextContent(/could not save this workout/i);
    expect(screen.queryByTestId("summary-id")).not.toBeInTheDocument();
    expect(loadRecords(base)).toHaveLength(0);
  });

  it("flags pain entries and sets at or above the extreme-RPE threshold", async () => {
    const { container, user } = renderEditorOver();

    expect(container.querySelector('[data-safety="extreme-rpe"]')).toBeNull();
    await user.type(screen.getByLabelText(/exercise 1 set 1 rpe/i), "9");
    expect(container.querySelector('[data-safety="extreme-rpe"]')).not.toBeNull();

    const rpe = screen.getByLabelText(/exercise 1 set 1 rpe/i);
    await user.clear(rpe);
    await user.type(rpe, "8");
    expect(container.querySelector('[data-safety="extreme-rpe"]')).toBeNull();

    expect(container.querySelector('[data-safety="pain"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: /add pain/i }));
    expect(container.querySelectorAll('[data-safety="pain"]')).toHaveLength(1);
  });
});

describe("exercise-name combobox", () => {
  afterEach(() => {
    window.localStorage.clear();
    act(() => setLanguage("en"));
  });

  function nameCombobox(accessibilityName: RegExp = /exercise 1 name/i): HTMLElement {
    return screen.getByRole("combobox", { name: accessibilityName });
  }

  it("suggests catalog entries with English labels and writes the canonical name", async () => {
    const { user } = renderEditorOver();
    const input = nameCombobox();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.type(input, "bench");

    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: /exercises/i });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    // In the English UI the option is the canonical English name alone.
    const option = within(listbox).getByRole("option", {
      name: "Barbell Bench Press - Medium Grip",
    });
    expect(option).toHaveAttribute("aria-selected", "false");
    expect(listbox).not.toHaveTextContent("杠铃卧推");

    await user.click(option);

    expect(input).toHaveValue("Barbell Bench Press - Medium Grip");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("filters suggestions as the query narrows and hides when nothing matches", async () => {
    const { user } = renderEditorOver();
    const input = nameCombobox();

    await user.type(input, "zzz-no-such-exercise");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "barbell bench");
    expect(input).toHaveValue("barbell bench");
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // The wider "bench" query also matched Dumbbell/other variants; the
    // narrowed query only keeps entries whose names contain "Barbell Bench".
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option).toHaveTextContent(/Barbell Bench Press/);
    }
    const optionTexts = options.map((option) => option.textContent ?? "").join(" ");
    expect(optionTexts).not.toContain("哑铃卧推");
    expect(optionTexts).toContain("Barbell Bench Press - Medium Grip");
    // English UI labels are canonical-only: no bilingual `中文 · English` copy.
    expect(optionTexts).not.toContain("·");
  });

  it("dismisses the list with Escape and saves the free text unchanged", async () => {
    const { adapter, user } = renderEditorOver();
    const input = nameCombobox();

    // "Squat" is an alias of "Barbell Squat", so suggestions open…
    await user.type(input, "Squat");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // …but dismissing them must not rewrite or block the typed custom name.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("Squat");

    await fillSetFields(user);
    await user.click(screen.getByRole("button", { name: /save workout/i }));
    await screen.findByTestId("summary-id");

    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.exercises[0]!.name).toBe("Squat");
  });

  it("supports ArrowUp/ArrowDown navigation, Enter selection and activedescendant", async () => {
    const { user } = renderEditorOver();
    const input = nameCombobox();
    await user.type(input, "deadlift");

    await user.keyboard("{ArrowDown}");
    const firstId = input.getAttribute("aria-activedescendant");
    expect(firstId).toBeTruthy();
    const firstOption = document.getElementById(firstId ?? "");
    expect(firstOption).not.toBeNull();
    expect(firstOption).toHaveAttribute("role", "option");
    expect(firstOption).toHaveAttribute("aria-selected", "true");
    expect(firstOption).toHaveTextContent("Barbell Deadlift");

    await user.keyboard("{ArrowDown}");
    const secondId = input.getAttribute("aria-activedescendant");
    expect(secondId).not.toBe(firstId);

    await user.keyboard("{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", firstId ?? "");

    await user.keyboard("{Enter}");
    expect(input).toHaveValue("Barbell Deadlift");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the Chinese name in the field and stores the canonical English name", async () => {
    setLanguage("zh");
    const { adapter, user } = renderEditorOver();
    const input = nameCombobox(/动作 1 名称/i);

    await user.type(input, "卧推");

    expect(input).toHaveValue("卧推");
    expect(input).toHaveAttribute("aria-expanded", "true");
    // Chinese suggestion labels are the Chinese display name only.
    const listbox = screen.getByRole("listbox", { name: /动作/i });
    const option = within(listbox).getByRole("option", { name: "杠铃卧推" });
    expect(listbox).not.toHaveTextContent("Barbell Bench Press");

    await user.click(option);

    // The field displays the localized name (the product-owner demo request)…
    expect(input).toHaveValue("杠铃卧推");
    expect(input).not.toHaveValue("Barbell Bench Press - Medium Grip");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // …while the saved record keeps the canonical English spelling.
    await user.type(screen.getByLabelText(/动作 1 第 1 组重量/), "100");
    await user.type(screen.getByLabelText(/动作 1 第 1 组次数/), "5");
    await user.type(screen.getByLabelText(/动作 1 第 1 组 RPE/), "8");
    await user.click(screen.getByRole("button", { name: /保存训练/ }));
    await screen.findByTestId("summary-id");

    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.exercises[0]!.name).toBe("Barbell Bench Press - Medium Grip");
  });

  it("keeps the raw draft while typing a custom name in Chinese UI", async () => {
    setLanguage("zh");
    const { adapter, user } = renderEditorOver();
    const input = nameCombobox(/动作 1 名称/i);

    // "Squat" alone resolves to 杠铃深蹲, but typing must never localize the
    // draft under the cursor: the next keystroke would then be appended to the
    // Chinese display text and the stored custom name would be corrupted.
    await user.type(input, "Squat");
    expect(input).toHaveValue("Squat");
    await user.type(input, " Jump");
    expect(input).toHaveValue("Squat Jump");

    await fillSetFieldsZh(user);
    await user.click(screen.getByRole("button", { name: /保存训练/ }));
    await screen.findByTestId("summary-id");

    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    // The custom name is stored exactly as typed, with no substitution.
    expect(stored[0]!.exercises[0]!.name).toBe("Squat Jump");
  });

  it("scrolls the keyboard-active suggestion into view", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrolled: { id: string; block: string | undefined }[] = [];
    HTMLElement.prototype.scrollIntoView = function (
      this: HTMLElement,
      options?: boolean | ScrollIntoViewOptions,
    ): void {
      scrolled.push({
        id: this.id,
        block: typeof options === "object" ? options.block : undefined,
      });
    };
    try {
      const { user } = renderEditorOver();
      const input = nameCombobox();
      await user.type(input, "press");
      expect(within(screen.getByRole("listbox")).getAllByRole("option").length).toBeGreaterThan(
        1,
      );

      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");

      const activeId = input.getAttribute("aria-activedescendant");
      expect(activeId).toBeTruthy();
      // The most recent scroll targets the row that now has focus, not the list.
      expect(scrolled.at(-1)).toEqual({ id: activeId, block: "nearest" });
      expect(scrolled.length).toBeGreaterThanOrEqual(3);
    } finally {
      if (originalScrollIntoView === undefined) {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      }
    }
  });

  it("ignores IME composition keys instead of selecting or moving the list", async () => {
    const { user } = renderEditorOver();
    const input = nameCombobox();
    await user.type(input, "deadlift");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // nativeEvent.isComposing: the IME owns the key while composing.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("deadlift");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    expect(input).not.toHaveAttribute("aria-activedescendant");

    // Legacy browsers only report composition through keyCode 229.
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
    expect(input).not.toHaveAttribute("aria-activedescendant");

    // Outside a composition the same keys work normally.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Barbell Deadlift");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps a dirty raw draft across a language switch", async () => {
    const { adapter, user } = renderEditorOver();
    const input = nameCombobox();

    // A typed alias is a raw draft, not a localized catalog display.
    await user.type(input, "Squat");
    expect(input).toHaveValue("Squat");

    // Switching the UI language must not translate the text under the cursor.
    act(() => setLanguage("zh"));
    expect(input).toHaveValue("Squat");

    // The next keystroke extends the raw text, so the stored name stays raw
    // instead of becoming localized copy (`杠铃深蹲 Jump`).
    await user.type(input, " Jump");
    expect(input).toHaveValue("Squat Jump");

    await fillSetFieldsZh(user);
    await user.click(screen.getByRole("button", { name: /保存训练/ }));
    await screen.findByTestId("summary-id");

    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.exercises[0]!.name).toBe("Squat Jump");
  });

  it("re-localizes a pristine selection when the language changes", async () => {
    setLanguage("zh");
    const { user } = renderEditorOver();
    const input = nameCombobox(/动作 1 名称/i);

    await user.type(input, "卧推");
    await user.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "杠铃卧推" }),
    );
    expect(input).toHaveValue("杠铃卧推");

    // A pristine selection is display-only: the same canonical value follows the
    // UI language in both directions.
    act(() => setLanguage("en"));
    expect(input).toHaveValue("Barbell Bench Press - Medium Grip");
    act(() => setLanguage("zh"));
    expect(input).toHaveValue("杠铃卧推");
  });

  it("stores the edited visible text after a Chinese selection", async () => {
    setLanguage("zh");
    const { adapter, user } = renderEditorOver();
    const input = nameCombobox(/动作 1 名称/i);

    await user.type(input, "卧推");
    await user.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "杠铃卧推" }),
    );
    expect(input).toHaveValue("杠铃卧推");

    // Editing the localized display turns the value into a custom name: the
    // visible text is exactly what the record stores from then on.
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("杠铃卧");
    await user.type(input, "推举");
    expect(input).toHaveValue("杠铃卧推举");

    await fillSetFieldsZh(user);
    await user.click(screen.getByRole("button", { name: /保存训练/ }));
    await screen.findByTestId("summary-id");

    const stored = loadRecords(adapter);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.exercises[0]!.name).toBe("杠铃卧推举");
  });
});
