import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.tsx";
import { downloadJson } from "./api/fileTransport.ts";
import { MemoryStorageAdapter } from "./storage/adapter.ts";
import { loadRecords } from "./storage/workoutRepository.ts";
import { clientFor } from "./test/asyncClient.ts";

vi.mock("./api/fileTransport.ts", () => ({
  downloadJson: vi.fn(),
  readTextFile: vi.fn(),
}));

const downloadJsonMock = vi.mocked(downloadJson);

function renderApp(adapter: MemoryStorageAdapter) {
  const user = userEvent.setup();
  const view = render(<App client={clientFor(adapter)} />);
  return { user, ...view };
}

/** Fill the single default exercise/set on the editor and submit. */
async function fillAndSave(
  user: UserEvent,
  options: { name?: string; weight?: string; reps?: string; rpe?: string } = {},
): Promise<void> {
  const { name = "Squat", weight = "100", reps = "5", rpe = "8" } = options;
  await user.type(screen.getByLabelText(/exercise 1 name/i), name);
  await user.type(screen.getByLabelText(/exercise 1 set 1 weight/i), weight);
  await user.type(screen.getByLabelText(/exercise 1 set 1 reps/i), reps);
  await user.type(screen.getByLabelText(/exercise 1 set 1 RPE/i), rpe);
  await user.click(screen.getByRole("button", { name: /save workout/i }));
}

describe("App integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // BrowserRouter reads `window.location`; reset it so each test starts at /.
    window.history.pushState({}, "", "/");
  });

  it("drives the full path from empty history to a non-adopted draft plan", async () => {
    const adapter = new MemoryStorageAdapter();
    const { user } = renderApp(adapter);

    // Empty history.
    expect(await screen.findByText(/no workouts yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /log your first workout/i }));

    // Editor.
    expect(screen.getByRole("heading", { level: 1, name: /log workout/i })).toBeInTheDocument();
    await fillAndSave(user);

    // Summary reflects the stored record (id derived by the client).
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });
    const [saved] = loadRecords(adapter);
    expect(saved).toBeDefined();
    expect(screen.getByText(saved.date)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Squat" })).toBeInTheDocument();
    expect(screen.getByText(/100 kg × 5 reps · RPE 8/)).toBeInTheDocument();

    // History lists the saved workout.
    await user.click(screen.getByRole("link", { name: /^history$/i }));
    expect(screen.getByRole("heading", { level: 1, name: /workout history/i })).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: `View ${saved.session_type} workout on ${saved.date}` }),
    ).toBeInTheDocument();

    // Analysis reflects the saved workout.
    await user.click(screen.getByRole("link", { name: /analysis/i }));
    expect(await screen.findByText(/Sessions: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Volume: 500 kg/)).toBeInTheDocument();

    // Plan is a draft and is not adopted without confirmation.
    await user.click(screen.getByRole("link", { name: /^plan$/i }));
    expect(await screen.findByTestId("plan-status")).toHaveTextContent(/draft/i);
    expect(screen.getByRole("button", { name: /confirm plan/i })).toBeInTheDocument();
    expect(screen.queryByText(/adopted/i)).not.toBeInTheDocument();
  });

  it("persists a saved workout across a fresh App over the same adapter", async () => {
    const adapter = new MemoryStorageAdapter();
    const first = renderApp(adapter);

    await screen.findByText(/no workouts yet/i);
    await first.user.click(screen.getByRole("link", { name: /log workout/i }));
    await fillAndSave(first.user);
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });
    const [saved] = loadRecords(adapter);
    expect(saved).toBeDefined();

    first.unmount();
    window.history.pushState({}, "", "/");

    renderApp(adapter);

    expect(screen.getByRole("heading", { level: 1, name: /workout history/i })).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: `View ${saved.session_type} workout on ${saved.date}` }),
    ).toBeInTheDocument();
  });

  it("exports the stored workout as workout.json", async () => {
    const adapter = new MemoryStorageAdapter();
    const { user } = renderApp(adapter);

    await screen.findByText(/no workouts yet/i);
    await user.click(screen.getByRole("link", { name: /log workout/i }));
    await fillAndSave(user);
    await screen.findByRole("heading", { level: 1, name: /workout summary/i });
    const [saved] = loadRecords(adapter);

    await user.click(screen.getByRole("link", { name: /^history$/i }));
    await screen.findByRole("button", { name: /export workouts \(json\)/i });
    await user.click(screen.getByRole("button", { name: /export workouts \(json\)/i }));

    expect(downloadJsonMock).toHaveBeenCalledTimes(1);
    const [filename, text] = downloadJsonMock.mock.calls[0];
    expect(filename).toBe("workout.json");
    const payload = JSON.parse(text) as { records: { id: string }[] };
    expect(payload.records.map((entry) => entry.id)).toContain(saved.id);
  });

  it("does not persist an invalid workout", async () => {
    const adapter = new MemoryStorageAdapter();
    const { user } = renderApp(adapter);

    await screen.findByText(/no workouts yet/i);
    await user.click(screen.getByRole("link", { name: /log workout/i }));
    await fillAndSave(user, { weight: "-5" });

    expect(await screen.findByTestId("validation-summary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /log workout/i })).toBeInTheDocument();
    expect(loadRecords(adapter)).toEqual([]);
  });

  it("exposes the primary nav and labels every editor control", async () => {
    const adapter = new MemoryStorageAdapter();
    const { user, container } = renderApp(adapter);

    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();

    await screen.findByText(/no workouts yet/i);
    await user.click(screen.getByRole("link", { name: /log workout/i }));

    const controls = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ),
    );
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) {
      const label = control.labels?.[0];
      expect(label, `control is missing a label: ${control.outerHTML}`).toBeTruthy();
      const accessibleName = label?.textContent?.trim() ?? "";
      expect(accessibleName.length).toBeGreaterThan(0);
      // The control must resolve through its accessible name, not a selector.
      expect(screen.getByLabelText(accessibleName)).toBe(control);
    }
  });
});
