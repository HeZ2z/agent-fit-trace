import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { LANGUAGE_STORAGE_KEY } from "../i18n/i18n.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { clientFor } from "../test/asyncClient.ts";
import { MeScreen } from "./MeScreen.tsx";

vi.mock("../coaching/useCoach.ts", () => ({ useCoach: () => ({ teardown: vi.fn() }) }));

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

describe("MeScreen language preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-lang");
    document.documentElement.lang = "en";
  });

  it("offers English and Simplified Chinese with English selected by default", () => {
    renderMe();

    expect(screen.getByRole("heading", { name: "Language" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /interface language/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "简体中文" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("switches the display layer, persists it and restores it on the next mount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderMe();

    await user.click(screen.getByRole("button", { name: "简体中文" }));

    expect(screen.getByRole("button", { name: "简体中文" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The switcher itself is part of the display layer.
    expect(screen.getByRole("heading", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "界面语言" })).toBeInTheDocument();
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.getAttribute("data-lang")).toBe("zh");

    unmount();
    renderMe();
    expect(screen.getByRole("button", { name: "简体中文" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "语言" })).toBeInTheDocument();

    // Switching back restores English chrome and persists the choice.
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("heading", { name: "Language" })).toBeInTheDocument();
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.getAttribute("data-lang")).toBe("en");
  });
});
