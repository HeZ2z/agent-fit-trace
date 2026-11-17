import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLanguage } from "../i18n/i18n.ts";
import { ExerciseLibrary } from "./ExerciseLibrary.tsx";

/** The library page and the Log dialog share this component; tests pin both
 * languages, combined filters, empty states, detail selection and the add
 * callback without touching storage. */

function renderLibrary(options: { autoFocusSearch?: boolean } = {}) {
  const onAdd = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <ExerciseLibrary onAdd={onAdd} autoFocusSearch={options.autoFocusSearch} />,
  );
  return { onAdd, user, ...view };
}

afterEach(() => {
  window.localStorage.clear();
  setLanguage("en");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("ExerciseLibrary", () => {
  it("searches English names and adds the canonical name from the detail panel", async () => {
    const { onAdd, user } = renderLibrary();

    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    const row = screen.getByRole("button", { name: /^Barbell Squat/ });
    await user.click(row);

    expect(screen.getByRole("heading", { name: "Barbell Squat", level: 3 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toMatchObject({
      name: "Barbell Squat",
      pattern: "squat",
    });
  });

  it("searches Chinese display names and still adds the canonical English name", async () => {
    setLanguage("zh");
    const { onAdd, user } = renderLibrary();

    await user.type(screen.getByLabelText("搜索动作"), "深蹲");
    const row = screen.getByRole("button", { name: /杠铃深蹲/ });
    await user.click(row);

    expect(screen.getByRole("heading", { name: "杠铃深蹲", level: 3 })).toBeInTheDocument();
    expect(screen.getAllByText("Barbell Squat").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "加入训练" }));

    expect(onAdd.mock.calls[0][0].name).toBe("Barbell Squat");
  });

  it("combines filters and resets search, filters and selection", async () => {
    const { user } = renderLibrary();

    await user.selectOptions(screen.getByLabelText("Movement pattern"), "squat");
    await user.selectOptions(screen.getByLabelText("Muscle"), "quadriceps");
    await user.selectOptions(screen.getByLabelText("Equipment"), "barbell");

    expect(screen.getByRole("button", { name: /^Barbell Squat/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Bodyweight Squat/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Barbell Deadlift/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Barbell Squat/ }));
    expect(screen.getByRole("heading", { name: "Barbell Squat", level: 3 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(screen.getByRole("button", { name: /^Barbell Deadlift/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Barbell Squat", level: 3 })).toBeNull();
  });

  it("shows an actionable empty state and keeps the reference notice visible", async () => {
    const { user } = renderLibrary();

    await user.type(screen.getByLabelText("Search exercises"), "zzz-no-such-exercise");
    expect(
      screen.getByText("No exercises match the current search and filters."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Catalog metadata only\. Content review is incomplete/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Select an exercise to see its details.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(screen.getByRole("button", { name: /^Barbell Squat/ })).toBeInTheDocument();
  });

  it("does not call onAdd until the detail action is used", async () => {
    const { onAdd, user } = renderLibrary();
    await user.click(screen.getByRole("button", { name: /^Barbell Squat/ }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("can focus the search field for the dialog entry point", () => {
    renderLibrary({ autoFocusSearch: true });
    expect(screen.getByLabelText("Search exercises")).toHaveFocus();
  });

  it("keeps focus on the search field when the clear-search control unmounts", async () => {
    const { user } = renderLibrary();
    const search = screen.getByLabelText("Search exercises");
    await user.type(search, "barbell");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");
  });

  it("scrolls the stacked detail into view on a narrow viewport", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(max-width: 900px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const { user } = renderLibrary();
    await user.click(screen.getByRole("button", { name: /^Barbell Squat/ }));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("marks the selected row with aria-current", async () => {
    const { user } = renderLibrary();
    const row = screen.getByRole("button", { name: /^Barbell Squat/ });
    expect(row).not.toHaveAttribute("aria-current");
    await user.click(row);
    expect(row).toHaveAttribute("aria-current", "true");
  });
});
