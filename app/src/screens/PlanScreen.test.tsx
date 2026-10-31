import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlanDraft, WorkoutRecord } from "@agent-fit-trace/core";
import { generateNextPlan } from "@agent-fit-trace/core";
import type { FitTraceClient, ImportedArtifact } from "@agent-fit-trace/api-contracts";
import { setLanguage } from "../i18n/i18n.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { loadRecords, saveRecord } from "../storage/workoutRepository.ts";
import { WorkoutStoreProvider, useWorkoutStore } from "../state/WorkoutStoreContext.tsx";
import { FakeFitTraceClient, clientFor, deferred } from "../test/asyncClient.ts";
import { PlanScreen } from "./PlanScreen.tsx";

function record(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
  return {
    id: "wkt_a",
    schema_version: 1,
    date: "2026-01-05",
    session_type: "strength",
    exercises: [{ name: "Squat", sets: [{ weight: 100, reps: 5, rpe: 8 }] }],
    ...overrides,
  };
}

const importedPlan: PlanDraft = {
  is_draft: true,
  requires_confirmation: true,
  goal: "Imported goal",
  based_on: {
    period: { from: "2026-02-01", to: "2026-02-28" },
    sessions: 12,
    source_records: ["wkt_x", "wkt_y"],
  },
  recommendations: [
    {
      action: "imported_action",
      detail: "Imported detail.",
      reason: "Imported reason.",
      evidence: { imported_metric: 42 },
    },
  ],
  safety_notes: ["Imported safety note."],
  professional_care_prompt: null,
};

const carePlan: PlanDraft = {
  ...importedPlan,
  professional_care_prompt: "Seek evaluation from a qualified medical professional.",
};

async function savePlan(
  client: FitTraceClient,
  payload: PlanDraft = importedPlan,
  filename = "plan.json",
): Promise<ImportedArtifact<"plan">> {
  const result = await client.saveImportedArtifact({
    kind: "plan",
    payload_schema_version: 1,
    payload,
    source_filename: filename,
  });
  return result.artifact;
}

function renderPlan(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/plan"]}>
      <WorkoutStoreProvider client={client}>
        <Routes>
          <Route path="/plan" element={<PlanScreen />} />
          <Route path="/workout/new" element={<div data-testid="editor" />} />
        </Routes>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

function renderPlanOver(adapter: MemoryStorageAdapter) {
  return renderPlan(clientFor(adapter));
}

function PlanWithReloadControl() {
  const { reload } = useWorkoutStore();
  return (
    <>
      <button type="button" onClick={reload}>
        Reload history
      </button>
      <PlanScreen />
    </>
  );
}

function renderPlanWithReload(client: FitTraceClient) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/plan"]}>
      <WorkoutStoreProvider client={client}>
        <PlanWithReloadControl />
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

describe("PlanScreen", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows a loading notice while the draft resolves", () => {
    const client = new FakeFitTraceClient({ records: [record()] });
    client.nextPlan();
    renderPlan(client);

    expect(screen.getAllByRole("status").some((node) => /loading/i.test(node.textContent ?? ""))).toBe(true);
  });

  it("shows an empty state when there is no history", async () => {
    renderPlanOver(new MemoryStorageAdapter());

    expect(await screen.findByText(/no workout history to draft a plan from yet/i))
      .toBeInTheDocument();
    expect(screen.queryByTestId("plan-status")).not.toBeInTheDocument();
  });

  it("renders a local draft with reasons and no independent file input", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());

    const { container } = renderPlanOver(adapter);

    expect(await screen.findByTestId("plan-status")).toHaveTextContent(/draft/i);
    expect(screen.queryByText(/rule-based next-session draft/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-source")).toHaveTextContent(/current computed/i);
    expect(screen.getByRole("link", { name: /manage imports and exports/i })).toHaveAttribute(
      "href",
      "/me",
    );
    const recommendations = container.querySelectorAll("[data-recommendation-action]");
    expect(recommendations.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/import plan\.json/i)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("labels generated confirmation as only this view without persisting", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const before = loadRecords(adapter);
    const client = clientFor(adapter);

    const { user } = renderPlan(client);
    await screen.findByTestId("plan-status");
    await user.click(screen.getByRole("button", { name: /confirm plan for this view only/i }));

    expect(screen.getByTestId("plan-status")).toHaveTextContent(/only in this view/i);
    expect(await client.getPlanAdoption()).toBeNull();
    expect(loadRecords(adapter)).toEqual(before);
  });

  it("shows a saved and selected snapshot without adopting it", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await savePlan(client);
    await client.setArtifactSelection("plan", artifact.id);

    renderPlan(client);

    expect(await screen.findByText(/imported goal/i)).toBeInTheDocument();
    expect(screen.getByTestId("plan-source")).toHaveTextContent(/imported snapshot/i);
    expect(screen.getByTestId("selected-snapshot-adoption")).toHaveTextContent("This saved plan is not adopted.");
    expect(await client.getPlanAdoption()).toBeNull();
    expect(screen.getByTestId("plan-snapshot-meta")).toHaveTextContent(/plan\.json/);
    expect(screen.getByTestId("plan-snapshot-linkage")).toHaveTextContent(/2 missing/i);
  });

  it("shows the computed plan after recovering a lost source-switch response", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await savePlan(client);
    await client.setArtifactSelection("plan", artifact.id);

    // The server commits the computed source (null), then the response is lost.
    const commit = client.setArtifactSelection.bind(client);
    client.setArtifactSelection = async (kind, artifactId) => {
      await commit(kind, artifactId);
      throw new Error("response lost");
    };

    const { user } = renderPlan(client);
    await screen.findByText(/imported goal/i);
    await user.click(screen.getByRole("button", { name: /show current computed plan/i }));

    // The recovery re-read confirms null and loads the computed draft, so the
    // page must not stay hidden behind a blocking selection error.
    expect(await screen.findByTestId("plan-status")).toBeInTheDocument();
    expect(screen.getByTestId("plan-source")).toHaveTextContent(/current computed/i);
    expect(screen.queryByText(/imported goal/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-selection-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-selection-warning")).toHaveTextContent(/response lost/i);
  });

  it("adopts only the exact imported snapshot after explicit confirmation", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const before = loadRecords(adapter);
    const client = clientFor(adapter);
    const artifact = await savePlan(client);
    await client.setArtifactSelection("plan", artifact.id);

    const { user } = renderPlan(client);
    await screen.findByText(/imported goal/i);
    await user.click(screen.getByRole("button", { name: "Adopt this plan" }));

    expect(await screen.findByTestId("current-adoption")).toHaveTextContent(
      "A saved plan is adopted.",
    );
    expect(screen.getByTestId("selected-snapshot-adoption")).toHaveTextContent(
      "This saved plan is adopted.",
    );
    expect(screen.getByTestId("plan-snapshot-draft")).toHaveTextContent("This plan is adopted.");
    expect(await client.getPlanAdoption()).toMatchObject({
      artifact_id: artifact.id,
      confirmed_digest: artifact.content_digest,
    });
    expect(loadRecords(adapter)).toEqual(before);
  });

  it("keeps a stale adoption read from undoing a confirmation", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await savePlan(client);
    await client.setArtifactSelection("plan", artifact.id);

    const adoptionWrite = deferred<Awaited<ReturnType<FitTraceClient["setPlanAdoption"]>>>();
    const staleRead = deferred<Awaited<ReturnType<FitTraceClient["getPlanAdoption"]>>>();
    let reads = 0;
    client.setPlanAdoption = () => adoptionWrite.promise;
    client.getPlanAdoption = () => {
      reads += 1;
      return reads === 1 ? Promise.resolve(null) : staleRead.promise;
    };

    const { user } = renderPlan(client);
    await screen.findByText(/imported goal/i);
    await waitFor(() => expect(reads).toBe(1));

    await user.click(
      screen.getByRole("button", { name: "Adopt this plan" }),
    );
    await user.click(screen.getByRole("button", { name: /refresh saved data/i }));
    await waitFor(() => expect(reads).toBe(2));

    await act(async () => {
      adoptionWrite.resolve({
        artifact_id: artifact.id,
        confirmed_digest: artifact.content_digest,
        confirmed_at: "2026-02-01T00:00:00.000Z",
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("current-adoption")).toHaveTextContent("A saved plan is adopted."),
    );

    await act(async () => {
      staleRead.resolve(null);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByTestId("current-adoption")).toHaveTextContent("A saved plan is adopted.");
  });

  it("restores an adoption binding after a hard remount", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await savePlan(client);
    await client.setArtifactSelection("plan", artifact.id);
    await client.setPlanAdoption({
      artifact_id: artifact.id,
      confirmed_digest: artifact.content_digest,
    });

    const first = renderPlan(client);
    await screen.findByText("This saved plan is adopted.");
    first.unmount();

    renderPlan(clientFor(adapter));
    expect(await screen.findByText("This saved plan is adopted.")).toBeInTheDocument();
    expect(screen.getByTestId("current-adoption")).toHaveTextContent("A saved plan is adopted.");
  });

  it("does not let a newly imported draft inherit the old adoption", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const old = await savePlan(client, importedPlan, "old.json");
    await client.setArtifactSelection("plan", old.id);
    await client.setPlanAdoption({
      artifact_id: old.id,
      confirmed_digest: old.content_digest,
    });
    const fresh = await savePlan(
      client,
      { ...importedPlan, goal: "Fresh imported goal" },
      "fresh.json",
    );
    await client.setArtifactSelection("plan", fresh.id);

    const { user } = renderPlan(client);

    expect(await screen.findByText(/Fresh imported goal/i)).toBeInTheDocument();
    expect(screen.getByTestId("current-adoption")).toHaveTextContent("A saved plan is adopted.");
    expect(screen.getByTestId("selected-snapshot-adoption")).toHaveTextContent("This saved plan is not adopted.");

    // Viewing the fresh draft did not adopt it, but the old adoption remains
    // revocable without navigating back to the adopted snapshot.
    await user.click(screen.getByRole("button", { name: "Revoke adoption" }));
    expect(await client.getPlanAdoption()).toBeNull();
    expect(screen.getByTestId("current-adoption")).toHaveTextContent("No plan adopted.");
    expect(screen.getByTestId("selected-snapshot-adoption")).toHaveTextContent("This saved plan is not adopted.");
  });

  it("revokes adoption metadata only, leaving payload and workouts unchanged", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const before = loadRecords(adapter);
    const client = clientFor(adapter);
    const artifact = await savePlan(client);
    await client.setArtifactSelection("plan", artifact.id);
    await client.setPlanAdoption({
      artifact_id: artifact.id,
      confirmed_digest: artifact.content_digest,
    });

    const { user } = renderPlan(client);
    await screen.findByText("This saved plan is adopted.");
    await user.click(screen.getByRole("button", { name: "Revoke adoption" }));

    expect(await client.getPlanAdoption()).toBeNull();
    expect(screen.getByTestId("selected-snapshot-adoption")).toHaveTextContent("This saved plan is not adopted.");
    expect(await client.getImportedArtifact(artifact.id)).toMatchObject({
      payload: { is_draft: true, requires_confirmation: true },
      content_digest: artifact.content_digest,
    });
    expect(loadRecords(adapter)).toEqual(before);
  });

  it("renders a professional care prompt from a selected snapshot", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await savePlan(client, carePlan);
    await client.setArtifactSelection("plan", artifact.id);

    renderPlan(client);

    expect(await screen.findByTestId("care-prompt")).toHaveTextContent(
      /qualified medical professional/i,
    );
  });

  it("shows history-load errors separately from saved plan data", async () => {
    const client = new FakeFitTraceClient({
      records: [record()],
      plan: generateNextPlan([record()]),
    });
    const gate = client.nextList();
    const { user } = renderPlan(client);

    await waitFor(() => expect(client.listCalls).toBe(1));
    gate.reject(new Error("history down"));
    expect(await screen.findByTestId("history-error")).toHaveTextContent(/history down/i);

    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId("plan-status")).toHaveTextContent(/draft/i));
  });

  it("replaces a stale plan with a history-load error on reload failure", async () => {
    const client = new FakeFitTraceClient({
      records: [record()],
      plan: generateNextPlan([record()]),
    });
    const { user } = renderPlanWithReload(client);
    await screen.findByTestId("plan-status");

    const refresh = client.nextList();
    await user.click(screen.getByRole("button", { name: /reload history/i }));
    await waitFor(() => expect(client.listCalls).toBe(2));
    refresh.reject(new Error("reload failed"));

    expect(await screen.findByTestId("history-error")).toHaveTextContent(/reload failed/i);
    expect(screen.queryByTestId("plan-status")).not.toBeInTheDocument();
  });
});

describe("PlanScreen exercise name localization", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLanguage("en");
  });

  it("renders Chinese recommendation copy with the catalog display name", async () => {
    setLanguage("zh");
    const adapter = new MemoryStorageAdapter();
    const weights = [100, 105, 110, 115];
    weights.forEach((weight, index) => {
      saveRecord(
        adapter,
        record({
          id: `wkt_rising_${index}`,
          date: `2026-09-${String(index * 3 + 1).padStart(2, "0")}`,
          sleep_hours: 8,
          exercises: [{ name: "Bench press", sets: [{ weight, reps: 5, rpe: 6 }] }],
        }),
      );
    });

    renderPlanOver(adapter);

    // The progressive-overload sentence embeds the exercise name; the record's
    // alias is normalized by analysis and localized by the display helper.
    expect(await screen.findByText(/渐进超负荷/)).toBeInTheDocument();
    // Both the detail and the reason sentences carry the localized name.
    expect(screen.getAllByText(/杠铃卧推/).length).toBeGreaterThan(0);
    // The evidence chip is user-facing too: the payload keeps canonical English,
    // but the rendered exercise evidence shows the Chinese display name.
    expect(screen.getByText("exercise: 杠铃卧推")).toBeInTheDocument();
    expect(screen.queryByText("exercise: Barbell Bench Press - Medium Grip")).not.toBeInTheDocument();
  });

  it("keeps the canonical English name in the English payload copy", async () => {
    const adapter = new MemoryStorageAdapter();
    const weights = [100, 105, 110, 115];
    weights.forEach((weight, index) => {
      saveRecord(
        adapter,
        record({
          id: `wkt_rising_${index}`,
          date: `2026-09-${String(index * 3 + 1).padStart(2, "0")}`,
          sleep_hours: 8,
          exercises: [{ name: "Bench press", sets: [{ weight, reps: 5, rpe: 6 }] }],
        }),
      );
    });

    renderPlanOver(adapter);

    expect(await screen.findByText(/progressive_overload/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Barbell Bench Press - Medium Grip/).length,
    ).toBeGreaterThan(0);
    // English UI keeps the canonical exercise name in both copy and evidence.
    expect(
      screen.getByText("exercise: Barbell Bench Press - Medium Grip"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/杠铃卧推/)).not.toBeInTheDocument();
  });

  it("localizes exercise evidence names without rewriting the payload", async () => {
    const adapter = new MemoryStorageAdapter();
    saveRecord(adapter, record());
    const client = clientFor(adapter);
    const artifact = await savePlan(client, {
      ...importedPlan,
      recommendations: [
        {
          action: "progressive_overload",
          detail: "Imported detail stays authored.",
          reason: "Imported reason stays authored.",
          evidence: {
            exercise: "Barbell Bench Press - Medium Grip",
            custom_metric: "unchanged",
          },
        },
      ],
    });
    await client.setArtifactSelection("plan", artifact.id);

    renderPlan(client);

    // Authored copy is preserved verbatim in both languages…
    expect(await screen.findByText("Imported detail stays authored.")).toBeInTheDocument();
    expect(
      screen.getByText("exercise: Barbell Bench Press - Medium Grip"),
    ).toBeInTheDocument();
    expect(screen.getByText("custom_metric: unchanged")).toBeInTheDocument();

    // …while only the exercise evidence name follows the UI language.
    act(() => setLanguage("zh"));
    expect(screen.getByText("exercise: 杠铃卧推")).toBeInTheDocument();
    expect(
      screen.queryByText("exercise: Barbell Bench Press - Medium Grip"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("custom_metric: unchanged")).toBeInTheDocument();

    // Rendering never rewrites the stored snapshot payload.
    const stored = await client.getImportedArtifact(artifact.id);
    const storedPlan = stored.payload as PlanDraft;
    expect(storedPlan.recommendations[0]?.evidence.exercise).toBe(
      "Barbell Bench Press - Medium Grip",
    );
  });
});
