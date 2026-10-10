import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { createMemoryHandler } from "@pi-fit-trace/api-contracts/testing";
import type { HandlerInit } from "@pi-fit-trace/api-contracts/testing";
import App from "./App.tsx";
import { downloadJson } from "./api/fileTransport.ts";
import { HttpFitTraceClient } from "./api/httpFitTraceClient.ts";
import type { HttpResponseLike } from "./api/httpFitTraceClient.ts";
import { LocalFitTraceClient } from "./api/localFitTraceClient.ts";
import { MemoryStorageAdapter } from "./storage/adapter.ts";

vi.mock("./api/fileTransport.ts", () => ({
  downloadJson: vi.fn(),
  readTextFile: vi.fn(),
}));

const downloadJsonMock = vi.mocked(downloadJson);

/**
 * Both dev modes must drive the identical app workflow through a real
 * `FitTraceClient`. Local mode stores in a memory adapter; HTTP mode goes
 * through the real `HttpFitTraceClient` bridged to an in-process memory
 * handler (the same bridge pattern as `fitTraceClient.contract.test.ts`),
 * so the app's HTTP path is exercised without a Node server in jsdom. The
 * true loopback server is covered at root by `tests/httpApi.test.ts`.
 */

interface ModeSetup {
  name: string;
  client: FitTraceClient;
  /** Records currently in the mode's underlying store. */
  storedRecords(): Promise<WorkoutRecord[]>;
  /** Number of HTTP POSTs issued (HTTP mode only; -1 for local). */
  postCount(): number;
}

function makeLocal(): ModeSetup {
  const client = new LocalFitTraceClient(new MemoryStorageAdapter());
  return {
    name: "local",
    client,
    storedRecords: () => client.listWorkouts(),
    postCount: () => -1,
  };
}

function makeHttp(): ModeSetup {
  const backing = new LocalFitTraceClient(new MemoryStorageAdapter());
  const handler = createMemoryHandler(backing);
  let posts = 0;
  const fetchImpl = async (
    input: string,
    init?: HandlerInit,
  ): Promise<HttpResponseLike> => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") posts += 1;
    const url = new URL(input, "http://fit-trace.invalid");
    const route = url.pathname.replace(/^\/api\/v1(?=\/|$)/, "");
    const response = await handler(`${route}${url.search}`, init);
    return { status: response.status, text: () => Promise.resolve(response.body) };
  };
  const client = new HttpFitTraceClient({ fetchImpl });
  return {
    name: "http",
    client,
    storedRecords: () => backing.listWorkouts(),
    postCount: () => posts,
  };
}

/** Fill the single default exercise/set on the editor and submit. */
async function fillAndSave(user: UserEvent): Promise<void> {
  await user.type(screen.getByLabelText(/exercise 1 name/i), "Squat");
  await user.type(screen.getByLabelText(/exercise 1 set 1 weight/i), "100");
  await user.type(screen.getByLabelText(/exercise 1 set 1 reps/i), "5");
  await user.type(screen.getByLabelText(/exercise 1 set 1 RPE/i), "8");
  await user.click(screen.getByRole("button", { name: /save workout/i }));
}

describe.each([
  { name: "local", make: makeLocal },
  { name: "http", make: makeHttp },
])("App workflow in $name mode", ({ make }) => {
  let setup: ModeSetup;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
    setup = make();
    render(<App client={setup.client} />);
  });

  it("drives log → history → summary → analysis → unconfirmed draft plan, and confirmation writes nothing", async () => {
    const user = userEvent.setup();

    // Empty history → editor → save.
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /log your first workout/i }));
    expect(screen.getByRole("heading", { level: 1, name: /log workout/i })).toBeInTheDocument();
    await fillAndSave(user);

    // Summary reflects the stored record.
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });
    const [saved] = await setup.storedRecords();
    expect(saved).toBeDefined();
    expect(screen.getByText(saved.date)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Squat" })).toBeInTheDocument();

    // History lists the saved workout; opening it shows the summary.
    await user.click(screen.getByRole("link", { name: /^history$/i }));
    expect(screen.getByRole("heading", { level: 1, name: /workout history/i })).toBeInTheDocument();
    await user.click(
      await screen.findByRole("link", { name: `View ${saved.session_type} workout on ${saved.date}` }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: /workout summary/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/100 kg × 5 reps · RPE 8/)).toBeInTheDocument();

    // Analysis reflects the saved workout.
    await user.click(screen.getByRole("link", { name: /analysis/i }));
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Volume: 500 kg/)).toBeInTheDocument();

    // Plan is an unconfirmed draft; confirming adopts it without any write.
    await user.click(screen.getByRole("link", { name: /^plan$/i }));
    expect(await screen.findByTestId("plan-status")).toHaveTextContent(/draft/i);
    const beforeRecords = await setup.storedRecords();
    const beforePosts = setup.postCount();
    await user.click(screen.getByRole("button", { name: /confirm plan/i }));
    expect(await screen.findByText(/adopted/i)).toBeInTheDocument();
    expect(await setup.storedRecords()).toEqual(beforeRecords);
    expect(setup.postCount()).toBe(beforePosts);
  });

  it("exports every stored record with identical content", async () => {
    const user = userEvent.setup();

    await screen.findByText(/no workouts yet/i);
    await user.click(screen.getByRole("link", { name: /log workout/i }));
    await fillAndSave(user);
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });

    await user.click(screen.getByRole("link", { name: /^history$/i }));
    await screen.findByRole("button", { name: /export workouts \(json\)/i });
    await user.click(screen.getByRole("button", { name: /export workouts \(json\)/i }));

    expect(downloadJsonMock).toHaveBeenCalledTimes(1);
    const [filename, text] = downloadJsonMock.mock.calls[0];
    expect(filename).toBe("workout.json");
    const payload = JSON.parse(text) as { schema_version: number; records: WorkoutRecord[] };
    const stored = await setup.storedRecords();
    expect(payload.schema_version).toBe(1);
    expect(payload.records).toEqual(stored);
    expect(payload.records).toHaveLength(1);
  });
});
