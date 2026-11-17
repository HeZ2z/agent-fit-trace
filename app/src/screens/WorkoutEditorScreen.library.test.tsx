import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import { MemoryStorageAdapter, StorageUnavailableError } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import {
  loadSessionDraft,
  sessionDraftKey,
} from "../storage/sessionDraftRepository.ts";
import { SessionDraftProvider } from "../state/SessionDraftContext.tsx";
import { WorkoutStoreProvider } from "../state/WorkoutStoreContext.tsx";
import { clientFor } from "../test/asyncClient.ts";
import { WorkoutEditorScreen } from "./WorkoutEditorScreen.tsx";

const OWNER = "editor-library-test-owner";

function renderEditor(
  adapter: StorageAdapter = new MemoryStorageAdapter(),
  client: FitTraceClient = clientFor(adapter),
) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={["/workout/new"]}>
      <WorkoutStoreProvider client={client}>
        <SessionDraftProvider ownerId={OWNER} adapter={adapter}>
          <Routes>
            <Route path="/workout/new" element={<WorkoutEditorScreen />} />
            <Route path="/exercises" element={<div data-testid="library" />} />
          </Routes>
        </SessionDraftProvider>
      </WorkoutStoreProvider>
    </MemoryRouter>,
  );
  return { user, ...view };
}

/** A storage backend whose writes always fail. */
class FailingWriteAdapter extends MemoryStorageAdapter {
  write(_key: string, _value: string): void {
    throw new StorageUnavailableError("write blocked");
  }
}

describe("WorkoutEditorScreen exercise-library entry", () => {
  it("flushes the in-memory draft and opens the library without saving a workout", async () => {
    const adapter = new MemoryStorageAdapter();
    const client = clientFor(adapter);
    const createWorkout = vi.spyOn(client, "createWorkout");
    const { user } = renderEditor(adapter, client);

    await user.type(screen.getByLabelText(/exercise 1 name/i), "Front Squat");
    await user.click(screen.getByRole("button", { name: /browse library/i }));

    expect(screen.getByTestId("library")).toBeInTheDocument();
    expect(loadSessionDraft(adapter, OWNER)?.exercises[0]?.name).toBe("Front Squat");
    expect(createWorkout).not.toHaveBeenCalled();
  });

  it("keeps the editor and reports a failed draft flush", async () => {
    const { user } = renderEditor(new FailingWriteAdapter());

    await user.type(screen.getByLabelText(/exercise 1 name/i), "Front Squat");
    await user.click(screen.getByRole("button", { name: /browse library/i }));

    expect(screen.queryByTestId("library")).not.toBeInTheDocument();
    expect(screen.getByTestId("draft-save-error")).toBeInTheDocument();
  });

  it("opens the library without overwriting an unreadable stored draft", async () => {
    const adapter = new MemoryStorageAdapter();
    const key = sessionDraftKey(OWNER);
    adapter.write(key, "{ not a session draft");
    const before = adapter.read(key);

    const { user } = renderEditor(adapter);
    await user.click(screen.getByRole("button", { name: /browse library/i }));

    expect(screen.getByTestId("library")).toBeInTheDocument();
    expect(adapter.read(key)).toBe(before);
  });
});
