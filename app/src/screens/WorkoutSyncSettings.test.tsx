import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkoutSyncSettings } from "./WorkoutSyncSettings.tsx";
import { StrictMode } from "react";

const { connect, request, reload, auth } = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn(), reload: vi.fn(), auth: { token: "token", userId: "user-a" } }));
vi.mock("../auth/AuthContext.tsx", () => ({ useAuth: () => ({ authSurface: "daemon-optional", session: { accessToken: auth.token }, user: { id: auth.userId, isAnonymous: false } }) }));
vi.mock("../state/WorkoutStoreContext.tsx", () => ({ useWorkoutStore: () => ({ reload }) }));
vi.mock("../i18n/useI18n.ts", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../api/workoutSync.ts", () => ({ connectWorkoutSync: connect, workoutSyncRequest: request }));

describe("workout sync settings", () => {
  beforeEach(() => { vi.clearAllMocks(); auth.token = "token"; auth.userId = "user-a"; connect.mockResolvedValue("cap"); });
  it("shows the destination before asking for whole-account consent", async () => {
    request.mockResolvedValue({ endpoint: "https://api.example.test/api/v1", enabled: false, pendingCount: 0, lastSuccessAt: null });
    render(<WorkoutSyncSettings />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect sync" }));
    await screen.findByText(/https:\/\/api.example.test/);
    expect(request).toHaveBeenCalledWith("status", "token");
    expect(request).not.toHaveBeenCalledWith("consent", "token", { endpoint: "https://api.example.test/api/v1" });
    fireEvent.click(screen.getByRole("button", { name: "Allow sync for this account" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("consent", "token", { endpoint: "https://api.example.test/api/v1" }));
  });
  it("loads the destination in StrictMode", async () => {
    request.mockResolvedValue({ endpoint: "https://api.example.test/api/v1", enabled: false, pendingCount: 0, lastSuccessAt: null });
    render(<StrictMode><WorkoutSyncSettings /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Connect sync" }));
    expect(await screen.findByText(/https:\/\/api.example.test/)).toBeInTheDocument();
  });
  it("explains an unconfirmed sync", async () => {
    connect.mockRejectedValue(new Error("offline"));
    render(<WorkoutSyncSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Connect sync" }));
    expect(await screen.findByRole("status")).toHaveTextContent("offline");
  });
  it("resets status and preview on identity changes while retaining them on same-session refresh", async () => {
    const jwt = (session: string, revision: number) => `header.${btoa(JSON.stringify({ session_id: session, revision }))}.signature`;
    auth.token = jwt("session-a", 1);
    request.mockImplementation(async (path: string) => path === "status"
      ? { endpoint: "https://api.example.test/api/v1", enabled: false, pendingCount: 0, lastSuccessAt: null }
      : { copies: 1, duplicates: 0, conflicts: 0, fingerprint: "a" });
    const view = render(<WorkoutSyncSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Connect sync" }));
    await screen.findByText(/https:\/\/api.example.test/);
    fireEvent.click(screen.getByRole("button", { name: "Preview guest import" }));
    await screen.findByText(/To copy/);
    auth.token = jwt("session-a", 2);
    view.rerender(<WorkoutSyncSettings />);
    expect(screen.getByText(/To copy/)).toBeInTheDocument();
    auth.userId = "user-b"; auth.token = jwt("session-b", 1);
    view.rerender(<WorkoutSyncSettings />);
    expect(screen.queryByText(/To copy/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect sync" })).toBeEnabled();
  });
  it("ignores a late result from the previous identity", async () => {
    let resolveStatus!: (value: unknown) => void;
    request.mockReturnValue(new Promise(resolve => { resolveStatus = resolve; }));
    const view = render(<WorkoutSyncSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Connect sync" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    auth.userId = "user-b"; auth.token = "other-token";
    view.rerender(<WorkoutSyncSettings />);
    resolveStatus({ endpoint: "https://old.example.test", enabled: true, pendingCount: 4, lastSuccessAt: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect sync" })).toBeEnabled());
    expect(screen.queryByText(/old.example.test/)).not.toBeInTheDocument();
  });

});
