import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { downloadJson } from "../api/fileTransport.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { HistoryScreen } from "./HistoryScreen.tsx";

vi.mock("../api/fileTransport.ts", () => ({
  downloadJson: vi.fn(),
  readTextFile: vi.fn(),
}));

const downloadJsonMock = vi.mocked(downloadJson);

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [
      {
        name: "Squat",
        sets: [
          { weight: 100, reps: 5, rpe: 8 },
          { weight: 100, reps: 5, rpe: 8 },
        ],
      },
    ],
    ...overrides,
  };
}

function renderHistory(client: FitTraceClient) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <WorkoutStoreProvider client={client}>
        <Routes>
          <Route path="/" element={<HistoryScreen />} />
          <Route path="/workout/:id" element={<div data-testid="summary" />} />
          <Route path="/workout/new" element={<div data-testid="editor" />} />
        </Routes>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
}

function renderHistoryOver(adapter: MemoryStorageAdapter) {
  return renderHistory(clientFor(adapter));
}

describe("HistoryScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading notice before history resolves", () => {
    const client = new FakeFitTraceClient({ records: [] });
    client.nextList();
    renderHistory(client);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("shows an empty state with a link to the editor", async () => {
    renderHistoryOver(new MemoryStorageAdapter());

    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /log your first workout/i });
    expect(link).toHaveAttribute("href", "/workout/new");
  });

  it("renders stored records with date, session type, and a summary", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    saveRecord(
      adapter,
      record({
        id: "wkt_b",
        date: "2026-01-07",
        session_type: "cardio",
        exercises: [{ name: "Row", sets: [{ weight: 80, reps: 10, rpe: 7 }] }],
      }),
    );

    renderHistoryOver(adapter);

    expect(await screen.findByText(/2026-01-05/)).toBeInTheDocument();
    expect(screen.getByText(/2026-01-07/)).toBeInTheDocument();
    expect(screen.getByText(/2 sets · 1000 kg · avg RPE 8/)).toBeInTheDocument();
    expect(screen.getByText(/1 set · 800 kg · avg RPE 7/)).toBeInTheDocument();
  });

  it("shows a retryable error when history fails to load and recovers", async () => {
    const client = new FakeFitTraceClient();
    const first = client.nextList();
    const user = userEvent.setup();
    renderHistory(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    first.reject(new Error("blocked"));
    expect(await screen.findByTestId("history-error")).toBeInTheDocument();

    const second = client.nextList();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    second.resolve([record()]);
    await waitFor(() => expect(screen.getByText(/2026-01-05/)).toBeInTheDocument());
    expect(client.listCalls).toBe(2);
  });

  it("links each row to the right workout", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    saveRecord(adapter, record({ id: "wkt_b", date: "2026-01-07" }));

    renderHistoryOver(adapter);

    await screen.findByText(/2026-01-05/);
    expect(screen.getByRole("link", { name: /2026-01-05/ })).toHaveAttribute(
      "href",
      "/workout/wkt_a",
    );
    expect(screen.getByRole("link", { name: /2026-01-07/ })).toHaveAttribute(
      "href",
      "/workout/wkt_b",
    );
  });

  it("renders avg RPE as n/a when no RPE values are recorded", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(
      adapter,
      record({
        exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5 }] }],
      }),
    );

    renderHistoryOver(adapter);

    expect(await screen.findByText(/avg RPE n\/a/)).toBeInTheDocument();
  });

  it("exports the stored records as workout.json", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    renderHistoryOver(adapter);
    await screen.findByText(/2026-01-05/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /export workouts/i }));

    expect(downloadJsonMock).toHaveBeenCalledTimes(1);
    const [filename, payload] = downloadJsonMock.mock.calls[0]!;
    expect(filename).toBe("workout.json");

    const parsed = JSON.parse(payload) as { records: WorkoutRecord[] };
    expect(parsed.records.map((entry) => entry.id)).toContain("wkt_a");
  });

  it("shows an alert when the export download fails", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    downloadJsonMock.mockImplementation(() => {
      throw new Error("browser download APIs are unavailable");
    });

    renderHistoryOver(adapter);
    await screen.findByText(/2026-01-05/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /export workouts/i }));

    const alert = screen.getByTestId("export-error");
    expect(alert).toHaveTextContent(/could not export workouts/i);
    expect(alert).toHaveTextContent(/download APIs are unavailable/i);
  });

  it("disables export when there are no records", async () => {
    renderHistoryOver(new MemoryStorageAdapter());
    await screen.findByText(/no workouts yet/i);

    expect(screen.getByRole("button", { name: /export workouts/i })).toBeDisabled();
    expect(downloadJsonMock).not.toHaveBeenCalled();
  });
});
