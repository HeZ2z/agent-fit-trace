import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { clientFor } from "../test/asyncClient.ts";
import { THEME_STORAGE_KEY } from "../theme/theme.ts";
import { MeScreen } from "./MeScreen.tsx";

function renderMe() {
  return render(
    <MemoryRouter initialEntries={["/me"]}>
      <AuthProvider skipBootstrap initialSession={null}>
        <WorkoutStoreProvider client={clientFor(new MemoryStorageAdapter())}>
          <Routes>
            <Route path="/me" element={<MeScreen />} />
          </Routes>
        </WorkoutStoreProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("MeScreen appearance preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("offers both skins with Pixel selected by default", () => {
    renderMe();

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /appearance theme/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pixel" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Glass" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText(/blueprint grid|frosted chrome/i)).not.toBeInTheDocument();
  });

  it("applies and persists Glass, and restores it on the next mount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderMe();

    await user.click(screen.getByRole("button", { name: "Glass" }));

    expect(screen.getByRole("button", { name: "Glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Pixel" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("glass");
    expect(document.documentElement.getAttribute("data-theme")).toBe("glass");

    // A fresh mount (as after a reload) reads the stored preference.
    unmount();
    renderMe();
    expect(screen.getByRole("button", { name: "Glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Switching back is symmetric and persists too.
    await user.click(screen.getByRole("button", { name: "Pixel" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("pixel");
    expect(document.documentElement.getAttribute("data-theme")).toBe("pixel");
  });
});
