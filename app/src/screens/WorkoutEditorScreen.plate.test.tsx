import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { SessionDraftProvider } from "../state/SessionDraftContext.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { clientFor } from "../test/asyncClient.ts";
import { WorkoutEditorScreen } from "./WorkoutEditorScreen.tsx";

const OWNER = "plate-test-owner";

function renderEditor() {
  const adapter = new MemoryStorageAdapter();
  return render(
    <MemoryRouter initialEntries={["/workout/new"]}>
      <WorkoutStoreProvider client={clientFor(adapter)}>
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

function openCalculator(): void {
  fireEvent.click(screen.getByRole("button", { name: /open plate calculator/i }));
}

function targetInput(): HTMLElement {
  return screen.getByLabelText(/target weight \(kg\)/i);
}

function setTarget(value: string): void {
  fireEvent.change(targetInput(), { target: { value } });
}

function setBar(value: "20" | "15"): void {
  fireEvent.change(screen.getByLabelText(/bar weight \(kg\)/i), { target: { value } });
}

function plateRows(): string[] {
  return within(screen.getByTestId("plate-list"))
    .queryAllByRole("listitem")
    .map((row) => row.textContent ?? "");
}

describe("WorkoutEditorScreen plate calculator", () => {
  it("opens an accessible modal dialog labelled by its heading", () => {
    renderEditor();
    openCalculator();

    const dialog = screen.getByRole("dialog", { name: /plate calculator/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("plate-dialog")).toBe(dialog);
    expect(screen.getByLabelText(/target weight \(kg\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/bar weight \(kg\)/i)).toHaveValue("20");
  });

  it("loads 2 × 20 kg per side for 100 kg on a 20 kg bar", () => {
    renderEditor();
    openCalculator();
    setTarget("100");

    expect(plateRows()).toEqual(["20 kg × 2"]);
    expect(screen.getByTestId("plate-loaded")).toHaveTextContent("100 kg");
    expect(screen.getByTestId("plate-remainder")).toHaveTextContent("0 kg");
    expect(screen.queryByTestId("plate-error")).toBeNull();
  });

  it("supports a 15 kg bar", () => {
    renderEditor();
    openCalculator();
    setTarget("100");
    setBar("15");

    expect(plateRows()).toEqual(["20 kg × 2", "2.5 kg × 1"]);
    expect(screen.getByTestId("plate-loaded")).toHaveTextContent("100 kg");
    expect(screen.getByTestId("plate-remainder")).toHaveTextContent("0 kg");
  });

  it("reports the remainder for an unbalanced target", () => {
    renderEditor();
    openCalculator();
    setTarget("61.3");

    expect(plateRows()).toEqual(["20 kg × 1"]);
    expect(screen.getByTestId("plate-loaded")).toHaveTextContent("60 kg");
    expect(screen.getByTestId("plate-remainder")).toHaveTextContent("1.3 kg");
  });

  it("shows an empty plate list when the bar itself is the target", () => {
    renderEditor();
    openCalculator();
    setTarget("20");

    expect(plateRows()).toEqual([]);
    expect(screen.getByTestId("plate-loaded")).toHaveTextContent("20 kg");
    expect(screen.getByTestId("plate-remainder")).toHaveTextContent("0 kg");
  });

  it("rejects a target below the bar weight", () => {
    renderEditor();
    openCalculator();
    setTarget("10");

    expect(screen.getByTestId("plate-error")).toHaveTextContent(
      /target weight must be at least the bar weight/i,
    );
    expect(screen.queryByTestId("plate-list")).toBeNull();
  });

  it("rejects a non-numeric target", () => {
    renderEditor();
    openCalculator();
    setTarget("not-a-number");

    expect(screen.getByTestId("plate-error")).toHaveTextContent(
      /enter a valid target weight/i,
    );
  });

  it("closes with the Close button and Escape, then reopens", async () => {
    renderEditor();
    const user = userEvent.setup();
    openCalculator();

    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    openCalculator();
    expect(screen.getByRole("dialog", { name: /plate calculator/i })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
