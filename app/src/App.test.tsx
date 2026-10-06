import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";

describe("App", () => {
  it("renders the primary navigation and the history screen at /", async () => {
    render(<App />);

    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /log workout/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /analysis/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /plan/i })).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 1, name: /workout history/i })).toBeInTheDocument();
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
  });
});
