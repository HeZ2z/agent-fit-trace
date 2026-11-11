import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AccountSignOut } from "./AccountSignOut.tsx";
import { GuestAccountControls } from "./GuestAccountControls.tsx";

const { signOut, teardown, navigate, auth } = vi.hoisted(() => ({
  signOut: vi.fn(), teardown: vi.fn(), navigate: vi.fn(),
  auth: { isGuest: false },
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));
vi.mock("./AuthContext.tsx", () => ({
  useAuth: () => ({
    status: "signed-in", user: { id: "user-a", isAnonymous: auth.isGuest },
    authSurface: "supabase", guestUpgradeEnabled: false, pendingGuestUpgrade: null,
    beginGuestUpgrade: vi.fn(), refreshVerifiedUser: vi.fn(), signOutSession: signOut,
  }),
}));
vi.mock("../coaching/useCoach.ts", () => ({ useCoach: () => ({ teardown }) }));
vi.mock("../i18n/useI18n.ts", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

beforeEach(() => { vi.clearAllMocks(); auth.isGuest = false; });

for (const mode of ["account", "guest", "compact guest"] as const) {
  describe(`${mode} sign-out`, () => {
    function show() {
      auth.isGuest = mode !== "account";
      render(<MemoryRouter>{mode === "account" ? <AccountSignOut /> : <GuestAccountControls compact={mode === "compact guest"} />}</MemoryRouter>);
      if (mode !== "account") fireEvent.click(screen.getByRole("button", { name: "Sign out guest" }));
      return screen.getByRole("button", { name: mode === "account" ? "Sign out" : "Sign out and lose guest access" });
    }

    it("waits for confirmation before navigating", async () => {
      let finish!: () => void;
      signOut.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
      fireEvent.click(show());
      expect(teardown).toHaveBeenCalledOnce();
      expect(signOut).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
      expect(navigate).not.toHaveBeenCalled();
      finish();
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login", { replace: true }));
    });

    it("stays on the page and shows an error when confirmation fails", async () => {
      signOut.mockRejectedValue(new Error("revocation unavailable"));
      fireEvent.click(show());
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not confirm sign out");
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: mode === "account" ? "Sign out" : "Sign out and lose guest access" })).toBeEnabled();
    });
  });
}
