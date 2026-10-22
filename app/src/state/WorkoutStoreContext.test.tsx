import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { saveRecord } from "../storage/workoutRepository.ts";
import { LocalFitTraceClient } from "../api/localFitTraceClient.ts";
import {
  WorkoutStoreProvider,
  useWorkoutStore,
} from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient, clientFor } from "../test/asyncClient.ts";

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_ctx_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

function Probe() {
  const { status, records, loadError, reload, saveWorkout, saveStatus, saveError } =
    useWorkoutStore();
  return (
    <div>
      <span data-testid="probe-status">{status}</span>
      <span data-testid="probe-count">{records.length}</span>
      <span data-testid="probe-ids">{records.map((r) => r.id).join(",")}</span>
      <span data-testid="probe-load-error">{loadError?.message ?? "none"}</span>
      <span data-testid="probe-save-status">{saveStatus}</span>
      <span data-testid="probe-save-error">{saveError?.message ?? "none"}</span>
      <button type="button" onClick={reload}>
        Reload probe
      </button>
      <button
        type="button"
        disabled={saveStatus === "saving"}
        onClick={() => {
          // The provider rethrows save failures (the editor relies on this to
          // retain input); swallow here since status is asserted via the probe.
          void saveWorkout(record({ id: "wkt_ctx_new", date: "2026-01-06" })).catch(() => {});
        }}
      >
        Save probe
      </button>
    </div>
  );
}

function renderProbe(client: FakeFitTraceClient | ReturnType<typeof clientFor>) {
  return render(
    <WorkoutStoreProvider client={client}>
      <Probe />
    </WorkoutStoreProvider>,
  );
}

describe("WorkoutStoreProvider", () => {
  it("loads history asynchronously and becomes ready", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    renderProbe(clientFor(adapter));

    expect(screen.getByTestId("probe-status")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("probe-count")).toHaveTextContent("1");
    expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_a");
  });

  it("shows a loading state before listWorkouts resolves", () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const gate = client.nextList();
    renderProbe(client);

    expect(screen.getByTestId("probe-status")).toHaveTextContent("loading");
    gate.resolve([record()]);
  });

  it("surfaces a failed history load and recovers on retry", async () => {
    const client = new FakeFitTraceClient();
    const first = client.nextList();
    const user = userEvent.setup();
    renderProbe(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    first.reject(new Error("storage blocked"));
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("error"));
    expect(screen.getByTestId("probe-load-error")).toHaveTextContent("storage blocked");

    const second = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload probe/i }));
    expect(client.listCalls).toBe(2);
    second.resolve([record()]);
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("probe-count")).toHaveTextContent("1");
  });

  it("merges a saved record immediately and survives a failed background refresh", async () => {
    const base = clientFor(new MemoryStorageAdapter());
    let failLists = false;
    const flaky: typeof base = Object.create(base) as typeof base;
    flaky.listWorkouts = async (...args: Parameters<typeof base.listWorkouts>) => {
      if (failLists) throw new Error("refresh failed");
      return base.listWorkouts(...args);
    };
    const user = userEvent.setup();
    renderProbe(flaky);
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));

    failLists = true;
    await user.click(screen.getByRole("button", { name: /save probe/i }));
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new"),
    );
    expect(screen.getByTestId("probe-save-status")).toHaveTextContent("idle");
    expect(screen.getByTestId("probe-save-error")).toHaveTextContent("none");
  });

  it("reports a save failure without losing history", async () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    const user = userEvent.setup();
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));

    const gate = client.nextCreate();
    await user.click(screen.getByRole("button", { name: /save probe/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));
    gate.reject(new Error("conflict"));
    await waitFor(() =>
      expect(screen.getByTestId("probe-save-status")).toHaveTextContent("error"),
    );
    expect(screen.getByTestId("probe-save-error")).toHaveTextContent("conflict");
    // The previously loaded history is untouched.
    expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_a");
  });

  it("throws outside a provider", () => {
    expect(() => render(<Probe />)).toThrow(/within a <WorkoutStoreProvider>/);
  });

  it("creates the default client once and does not refetch on rerender", async () => {
    const spy = vi.spyOn(LocalFitTraceClient.prototype, "listWorkouts");
    try {
      const view = render(
        <WorkoutStoreProvider>
          <Probe />
        </WorkoutStoreProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));
      expect(spy).toHaveBeenCalledTimes(1);

      view.rerender(
        <WorkoutStoreProvider>
          <Probe />
        </WorkoutStoreProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the newer history when responses resolve out of order", async () => {
    const oldRecord = record({ id: "wkt_old", date: "2026-01-01" });
    const newRecord = record({ id: "wkt_newer", date: "2026-02-01" });
    const client = new FakeFitTraceClient();
    const first = client.nextList();
    const user = userEvent.setup();
    renderProbe(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    const second = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload probe/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));

    // Newer request resolves first and wins; the older one is discarded.
    second.resolve([oldRecord, newRecord]);
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_newer"),
    );
    first.resolve([oldRecord]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_old,wkt_newer");
    expect(screen.getByTestId("probe-status")).toHaveTextContent("ready");
  });

  it("does not let a stale refresh remove a just-saved record", async () => {
    const base = record();
    const savedRecord = record({ id: "wkt_ctx_new", date: "2026-01-06" });
    const client = new FakeFitTraceClient({ records: [base] });
    const user = userEvent.setup();
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));

    // Start a refresh, then save while it is still in flight.
    const staleRefresh = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload probe/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));

    const saveGate = client.nextCreate();
    const postSaveRefresh = client.nextList();
    await user.click(screen.getByRole("button", { name: /save probe/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));
    saveGate.resolve({ record: savedRecord, duplicate: false, warnings: [] });
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new"),
    );

    // The pre-save refresh resolves after the save; it must not clobber it.
    staleRefresh.resolve([base]);
    postSaveRefresh.resolve([base, savedRecord]);
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new"),
    );
    expect(screen.getByTestId("probe-save-status")).toHaveTextContent("idle");
    expect(screen.getByTestId("probe-status")).toHaveTextContent("ready");
  });

  it("settles history status when saving while the initial load is still in flight", async () => {
    const savedRecord = record({ id: "wkt_ctx_new", date: "2026-01-06" });
    const client = new FakeFitTraceClient();
    const initialLoad = client.nextList();
    const postSaveRefresh = client.nextList();
    const user = userEvent.setup();
    renderProbe(client);
    await waitFor(() => expect(client.listCalls).toBe(1));
    expect(screen.getByTestId("probe-status")).toHaveTextContent("loading");

    const saveGate = client.nextCreate();
    await user.click(screen.getByRole("button", { name: /save probe/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));
    saveGate.resolve({ record: savedRecord, duplicate: false, warnings: [] });

    // The save settles history even though the visible load never resolves.
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new"),
    );
    expect(screen.getByTestId("probe-status")).toHaveTextContent("ready");
    expect(screen.getByTestId("probe-save-status")).toHaveTextContent("idle");

    postSaveRefresh.resolve([savedRecord]);
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new"),
    );

    // The invalidated initial load resolves late; it must not revert status
    // to loading nor drop the saved record.
    initialLoad.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("probe-status")).toHaveTextContent("ready");
    expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new");
  });

  it("recovers from a failed load when the post-save refresh succeeds", async () => {
    const savedRecord = record({ id: "wkt_ctx_new", date: "2026-01-06" });
    const client = new FakeFitTraceClient();
    const failedLoad = client.nextList();
    // Queued before the save so the post-save silent refresh takes this slot.
    const postSaveRefresh = client.nextList();
    const user = userEvent.setup();
    renderProbe(client);
    await waitFor(() => expect(client.listCalls).toBe(1));
    failedLoad.reject(new Error("storage blocked"));
    await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("error"));
    expect(screen.getByTestId("probe-load-error")).toHaveTextContent("storage blocked");

    const saveGate = client.nextCreate();
    await user.click(screen.getByRole("button", { name: /save probe/i }));
    await waitFor(() => expect(client.createCalls).toBe(1));
    saveGate.resolve({ record: savedRecord, duplicate: false, warnings: [] });

    // The record merges immediately, but history is still in error — and the
    // real error message must survive until the refresh resolves it.
    await waitFor(() =>
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new"),
    );
    expect(screen.getByTestId("probe-save-status")).toHaveTextContent("idle");
    expect(screen.getByTestId("probe-status")).toHaveTextContent("error");
    expect(screen.getByTestId("probe-load-error")).toHaveTextContent("storage blocked");

    // The background silent refresh succeeds, so history recovers fully.
    postSaveRefresh.resolve([savedRecord]);
    await waitFor(() =>
      expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"),
    );
    expect(screen.getByTestId("probe-load-error")).toHaveTextContent("none");
    expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_ctx_new");
  });

  it.each(["success", "failure"] as const)(
    "resets save state when the client is replaced during a save (late %s)",
    async (outcome) => {
      const clientA = new FakeFitTraceClient({ records: [record()] });
      const view = renderProbe(clientA);
      await waitFor(() => expect(screen.getByTestId("probe-status")).toHaveTextContent("ready"));

      const saveGate = clientA.nextCreate();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /save probe/i }));
      await waitFor(() =>
        expect(screen.getByTestId("probe-save-status")).toHaveTextContent("saving"),
      );

      // Replace the client mid-save; the provider must leave "saving".
      const clientB = new FakeFitTraceClient({ records: [record({ id: "wkt_client_b" })] });
      view.rerender(
        <WorkoutStoreProvider client={clientB}>
          <Probe />
        </WorkoutStoreProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("probe-save-status")).toHaveTextContent("idle"),
      );

      // The replaced client's late completion must not write save/history state.
      if (outcome === "success") {
        saveGate.resolve({
          record: record({ id: "wkt_ctx_new", date: "2026-01-06" }),
          duplicate: false,
          warnings: [],
        });
      } else {
        saveGate.reject(new Error("stale save"));
      }
      await waitFor(() =>
        expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_client_b"),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByTestId("probe-save-status")).toHaveTextContent("idle");
      expect(screen.getByTestId("probe-save-error")).toHaveTextContent("none");
      expect(screen.getByRole("button", { name: /save probe/i })).toBeEnabled();
      // History belongs to the new client; the stale save merged nothing.
      expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_client_b");
    },
  );

  it("ignores a replaced client's pending request", async () => {
    const recA = record({ id: "wkt_client_a" });
    const recB = record({ id: "wkt_client_b" });
    const clientA = new FakeFitTraceClient();
    const gateA = clientA.nextList();
    const view = renderProbe(clientA);
    await waitFor(() => expect(clientA.listCalls).toBe(1));

    const clientB = new FakeFitTraceClient({ records: [recB] });
    view.rerender(
      <WorkoutStoreProvider client={clientB}>
        <Probe />
      </WorkoutStoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_client_b"));

    gateA.resolve([recA]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("probe-ids")).toHaveTextContent("wkt_client_b");
  });
});
