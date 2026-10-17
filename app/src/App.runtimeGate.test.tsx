import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./api/runtimeMode.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/runtimeMode.ts")>();
  return {
    ...actual,
    currentRuntimeMode: () => ({
      mode: null,
      source: "build" as const,
      error:
        "This deployment is misconfigured: authenticated HTTP mode is required in production. Sign-in and workout data are unavailable until the server is fixed.",
    }),
  };
});

import App from "./App.tsx";

describe("production runtime gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails before mounting auth or protected providers", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(screen.getByRole("heading", { name: /configuration error/i })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/authenticated HTTP mode is required/i);
    // No public-config, auth, or data request is made by a protected provider.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: /primary/i })).not.toBeInTheDocument();
  });
});
