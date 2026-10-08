import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.tsx";
import { startDevApiServer } from "../../server/devApiServer.ts";
import type { DevApiServer } from "../../server/devApiServer.ts";

/**
 * HTTP mode against the REAL loopback API. The app is rendered WITHOUT an
 * injected client, so its production default (`createFitTraceClient()`)
 * selects the HTTP client purely from `VITE_FIT_TRACE_MODE=http`. jsdom has
 * no Vite proxy, so `fetch` is stubbed with a thin same-origin rewrite that
 * forwards `/api/v1/...` to the real server — the server, the real
 * `HttpFitTraceClient`, and env-based selection all stay in the path.
 */
describe("App workflow against the real loopback API", () => {
  let server: DevApiServer;
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    server = await startDevApiServer({ port: 0 });
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
    realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const target = raw.startsWith("/api/") ? `${server.url}${raw}` : raw;
      return realFetch(target, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    await server.close();
  });

  it("logs a workout through the server from empty history to an unconfirmed draft plan", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Empty server-side history.
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /log your first workout/i }));
    expect(screen.getByRole("heading", { level: 1, name: /log workout/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/exercise 1 name/i), "Squat");
    await user.type(screen.getByLabelText(/exercise 1 set 1 weight/i), "100");
    await user.type(screen.getByLabelText(/exercise 1 set 1 reps/i), "5");
    await user.type(screen.getByLabelText(/exercise 1 set 1 RPE/i), "8");
    await user.click(screen.getByRole("button", { name: /save workout/i }));

    // Summary reflects the record that round-tripped through the server.
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });
    expect(screen.getByRole("heading", { level: 3, name: "Squat" })).toBeInTheDocument();

    // History lists the server-stored workout; opening it renders the summary.
    await user.click(screen.getByRole("link", { name: /^history$/i }));
    expect(screen.getByRole("heading", { level: 1, name: /workout history/i })).toBeInTheDocument();
    // The record genuinely round-tripped through the server, not the UI.
    const listed = (await (await fetch(`${server.url}/api/v1/workouts`)).json()) as {
      data: { id: string; date: string }[];
    };
    expect(listed.data).toHaveLength(1);
    const viewLink = await screen.findByRole("link", { name: /view .* workout on/i });
    expect(viewLink.textContent ?? "").toContain(listed.data[0].date);
    await user.click(viewLink);
    expect(
      await screen.findByRole("heading", { level: 1, name: /workout summary/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/100 kg × 5 reps · RPE 8/)).toBeInTheDocument();

    // Analysis reflects the server-side workout.
    await user.click(screen.getByRole("link", { name: /analysis/i }));
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Volume: 500 kg/)).toBeInTheDocument();

    // Plan stays an unconfirmed draft without an explicit confirmation.
    await user.click(screen.getByRole("link", { name: /^plan$/i }));
    expect(await screen.findByTestId("plan-status")).toHaveTextContent(/draft/i);
    expect(screen.getByRole("button", { name: /confirm plan/i })).toBeInTheDocument();
    expect(screen.queryByText(/adopted/i)).not.toBeInTheDocument();
  });
});
