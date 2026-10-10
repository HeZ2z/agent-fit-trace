import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { WorkoutRecord } from "@pi-fit-trace/core";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider, useWorkoutStore } from "../state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";
import { WorkoutSummaryScreen } from "./WorkoutSummaryScreen.tsx";

function richRecord(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_sum_1",
    schema_version: 1,
    date: "2026-02-01",
    session_type: "strength",
    duration_minutes: 60,
    sleep_hours: 7.5,
    notes: "Felt strong",
    exercises: [
      { name: "Deadlift", sets: [{ weight: 150, reps: 3, rpe: 9 }] },
      { name: "Plank", sets: [{ reps: 60 }] },
    ],
    pain: [{ area: "low back", level: 4 }],
    ...overrides,
  };
}

function renderSummary(client: FitTraceClient, id: string) {
  return render(
    <MemoryRouter initialEntries={[`/workout/${id}`]}>
      <WorkoutStoreProvider client={client}>
        <Routes>
          <Route path="/workout/:id" element={<WorkoutSummaryScreen />} />
          <Route path="/" element={<div>history</div>} />
        </Routes>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
}

function renderSummaryOver(adapter: MemoryStorageAdapter, id: string) {
  return renderSummary(clientFor(adapter), id);
}

describe("WorkoutSummaryScreen", () => {
  it("shows loading instead of not-found while history loads", () => {
    const client = new FakeFitTraceClient({ records: [richRecord()] });
    client.nextList();
    renderSummary(client, "wkt_sum_1");

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    expect(screen.queryByRole("heading", { name: /workout not found/i })).not.toBeInTheDocument();
  });

  it("renders a stored record's details, exercises, sets, and metrics", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, richRecord());

    renderSummaryOver(adapter, "wkt_sum_1");

    expect(await screen.findByRole("heading", { level: 1, name: /workout summary/i }))
      .toBeInTheDocument();
    expect(screen.getByText("2026-02-01")).toBeInTheDocument();
    expect(screen.getByText("strength")).toBeInTheDocument();
    expect(screen.getByText("60 minutes")).toBeInTheDocument();
    expect(screen.getByText("7.5 hours")).toBeInTheDocument();
    expect(screen.getByText("Felt strong")).toBeInTheDocument();

    expect(screen.getByText("Deadlift")).toBeInTheDocument();
    expect(screen.getByText("Plank")).toBeInTheDocument();
    expect(screen.getByText("150 kg × 3 reps · RPE 9")).toBeInTheDocument();
    expect(screen.getByText("weight n/a × 60 reps · RPE n/a")).toBeInTheDocument();

    expect(screen.getByText("Sets: 2")).toBeInTheDocument();
    expect(screen.getByText("Volume: 450 kg")).toBeInTheDocument();
    expect(screen.getByText("Average RPE: 9")).toBeInTheDocument();
  });

  it("renders a not-found state for an unknown id once ready", async () => {
    renderSummaryOver(new MemoryStorageAdapter(), "does-not-exist");

    expect(await screen.findByRole("heading", { level: 1, name: /workout not found/i }))
      .toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to history/i })).toHaveAttribute("href", "/");
  });

  it("shows a retryable error when history fails to load", async () => {
    const client = new FakeFitTraceClient();
    const first = client.nextList();
    const user = userEvent.setup();
    renderSummary(client, "wkt_sum_1");

    await waitFor(() => expect(client.listCalls).toBe(1));
    first.reject(new Error("blocked"));
    expect(await screen.findByTestId("summary-error")).toBeInTheDocument();

    const second = client.nextList();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    second.resolve([richRecord()]);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: /workout summary/i })).toBeInTheDocument(),
    );
  });

  it("shows a workout saved while history is still loading", async () => {
    const saved = richRecord({ id: "wkt_sum_new", date: "2026-02-02" });
    const client = new FakeFitTraceClient();
    const initialLoad = client.nextList();
    // Queued before the save so the post-save silent refresh takes this slot.
    const postSaveRefresh = client.nextList();
    const saveGate = client.nextCreate();
    function SaveButton() {
      const { saveWorkout } = useWorkoutStore();
      return (
        <button
          type="button"
          onClick={() => {
            void saveWorkout(saved).catch(() => {});
          }}
        >
          Save it
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={["/workout/wkt_sum_new"]}>
        <WorkoutStoreProvider client={client}>
          <Routes>
            <Route path="/workout/:id" element={<WorkoutSummaryScreen />} />
            <Route path="/" element={<div>history</div>} />
          </Routes>
          <SaveButton />
        </WorkoutStoreProvider>
      </MemoryRouter>,
    );

    // History is still loading, so the summary cannot resolve the workout yet.
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save it/i }));
    saveGate.resolve({ record: saved, duplicate: false, warnings: [] });

    // The save settles history status, so the saved workout renders.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: /workout summary/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("2026-02-02")).toBeInTheDocument();

    postSaveRefresh.resolve([saved]);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: /workout summary/i }),
      ).toBeInTheDocument(),
    );

    // The invalidated initial load resolves late; it must not revert the
    // summary back to loading nor drop the saved record.
    initialLoad.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      screen.getByRole("heading", { level: 1, name: /workout summary/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/loading workout/i)).not.toBeInTheDocument();
  });

  it("flags pain and extreme RPE via data-safety markers", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, richRecord());

    const { container } = renderSummaryOver(adapter, "wkt_sum_1");
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });

    expect(container.querySelector('[data-safety="extreme-rpe"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-safety="pain"]')).toHaveLength(1);
  });

  it("shows validation warnings as non-blocking notices", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(
      adapter,
      richRecord({
        exercises: [{ name: "Squat", sets: [{ weight: 0, reps: 10, rpe: 7 }] }],
        pain: undefined,
      }),
    );

    renderSummaryOver(adapter, "wkt_sum_1");

    const warnings = await screen.findByRole("status", { name: /warnings/i });
    expect(warnings).toHaveTextContent(/0 kg/i);
  });
});
