import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ExerciseLibraryScreen } from "./ExerciseLibraryScreen.tsx";

/** The page hands a canonical name to the editor as one-shot router state; the
 * editor tests cover the append itself, this test pins the handoff payload. */

function EditorProbe() {
  const location = useLocation();
  return <pre data-testid="editor-state">{JSON.stringify(location.state)}</pre>;
}

function renderPage() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/exercises"]}>
      <Routes>
        <Route path="/exercises" element={<ExerciseLibraryScreen />} />
        <Route path="/workout/new" element={<EditorProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return user;
}

describe("ExerciseLibraryScreen", () => {
  it("renders one page heading and the shared library", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Exercise Library" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search exercises")).toBeInTheDocument();
  });

  it("navigates to the editor with a one-shot canonical-name request", async () => {
    const user = renderPage();
    await user.type(screen.getByLabelText("Search exercises"), "barbell squat");
    await user.click(screen.getByRole("button", { name: /^Barbell Squat/ }));
    await user.click(screen.getByRole("button", { name: "Add to workout" }));

    const state = await screen.findByTestId("editor-state");
    await waitFor(() => expect(state).toHaveTextContent("Barbell Squat"));
    const parsed = JSON.parse(state.textContent ?? "{}") as {
      libraryAdd?: { id?: string; name?: string };
    };
    expect(parsed.libraryAdd?.name).toBe("Barbell Squat");
    expect(typeof parsed.libraryAdd?.id).toBe("string");
    expect(parsed.libraryAdd?.id).not.toBe("");
  });
});
