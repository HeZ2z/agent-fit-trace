import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";

describe("App", () => {
  it("renders the primary navigation and the history screen at /", async () => {
    render(<App legacyLoopback />);

    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /log workout/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /analysis/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /plan/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /exercise library/i })).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 1, name: /workout history/i })).toBeInTheDocument();
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
  });

  it("routes to the exercise library from the primary navigation", async () => {
    const user = userEvent.setup();
    render(<App legacyLoopback />);

    await user.click(screen.getByRole("link", { name: /exercise library/i }));

    expect(
      screen.getByRole("heading", { level: 1, name: /exercise library/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search exercises")).toBeInTheDocument();
  });
});
