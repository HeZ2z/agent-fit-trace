import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./AuthContext.tsx";
import { AuthCallbackScreen, ResetPasswordScreen } from "./AuthScreens.tsx";
import {
  RECOVERY_TOKEN_KEY,
  loadRecoveryToken,
  resetRecoveryTokenMemoryForTests,
} from "./supabaseAuth.ts";

const PUBLIC_CONFIG = { supabaseUrl: "http://127.0.0.1:54321", supabasePublishableKey: "pub" };

function renderAt(path: string, providerProps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider skipBootstrap publicConfig={PUBLIC_CONFIG} initialSession={null} {...providerProps}>
        <Routes>
          <Route path="/" element={<div>Home</div>} />
          <Route path="/login" element={<div>Login stub</div>} />
          <Route path="/auth/callback" element={<AuthCallbackScreen />} />
          <Route path="/reset-password" element={<ResetPasswordScreen />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("auth callback and reset screens", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    window.location.hash = "";
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    resetRecoveryTokenMemoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("completes a recovery link: routes to reset, stores the token, cleans the URL hash", async () => {
    window.location.hash = "#access_token=rec-token&refresh_token=r&type=recovery";
    renderAt("/auth/callback");
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBe("rec-token");
    expect(window.location.hash).toBe("");
  });

  it("completes an invite link through the same password-setup form", async () => {
    window.location.hash = "#access_token=invite-token&refresh_token=r&type=invite";
    renderAt("/auth/callback");
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBe("invite-token");
    expect(window.location.hash).toBe("");
  });

  it("shows an expired-link notice with existing form styling when no session is carried", async () => {
    const view = renderAt("/auth/callback");
    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument();
    expect(view.container.querySelector(".validation-summary")).not.toBeNull();
    expect(screen.getByRole("link", { name: /back to sign in/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBeNull();
  });

  it("hands the stored reset token to the password update and clears it", async () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "rec-token");
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    const user = userEvent.setup();
    const view = renderAt("/reset-password");
    // Existing form styling is reused.
    expect(view.container.querySelectorAll(".field").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/auth/v1/user");
    expect(seen[0]?.auth).toBe("Bearer rec-token");
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBeNull();
  });

  it("waits for async public config before the reset can succeed", async () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "rec-token");
    const stubFetch = (async (url: unknown) => {
      if (String(url).includes("/public-config")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(
          JSON.stringify({ data: { supabaseUrl: PUBLIC_CONFIG.supabaseUrl, supabasePublishableKey: "pub" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stubFetch);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <AuthProvider skipBootstrap={false} skipValidation fetchImpl={stubFetch} initialSession={null}>
          <Routes>
            <Route path="/login" element={<div>Login stub</div>} />
            <Route path="/reset-password" element={<ResetPasswordScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    // The submit runs after the async bootstrap resolves: success, not the
    // invalid-link error.
    await waitFor(() => expect(screen.queryByText("Login stub")).toBeInTheDocument());
  });

  it("survives a repeated effect without reporting the consumed link as expired", async () => {
    window.location.hash = "#access_token=invite-token&refresh_token=r&type=invite";
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/auth/callback"]}>
          <AuthProvider skipBootstrap publicConfig={PUBLIC_CONFIG} initialSession={null}>
            <Routes>
              <Route path="/auth/callback" element={<AuthCallbackScreen />} />
              <Route path="/reset-password" element={<ResetPasswordScreen />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBe("invite-token");
  });

  it("never reads a token from the query string", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: unknown) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    const user = userEvent.setup();
    renderAt("/reset-password?access_token=query-token");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it("completes a recovery link when sessionStorage get/set/remove all throw", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (_url: unknown, init?: RequestInit) => {
        seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    window.location.hash = "#access_token=rec-memory&refresh_token=r&type=recovery";
    renderAt("/auth/callback");
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    // The handoff lives in page memory when storage is disabled.
    expect(loadRecoveryToken()).toBe("rec-memory");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(seen).toEqual(["Bearer rec-memory"]);
    expect(loadRecoveryToken()).toBeNull();
  });

  it("completes an invite link when sessionStorage set throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (_url: unknown, init?: RequestInit) => {
        seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    window.location.hash = "#access_token=invite-memory&refresh_token=r&type=invite";
    renderAt("/auth/callback");
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(loadRecoveryToken()).toBe("invite-memory");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(seen).toEqual(["Bearer invite-memory"]);
  });

  it("prefers the newest token over a stale stored value and blocks reuse after clear", async () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "stale-token");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (_url: unknown, init?: RequestInit) => {
        seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    window.location.hash = "#access_token=fresh-token&refresh_token=r&type=recovery";
    const user = userEvent.setup();
    renderAt("/auth/callback");
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    // The stale stored value must never be used for the update.
    expect(seen).toEqual(["Bearer fresh-token"]);
  });

  it("never reuses a cleared token when sessionStorage remove fails", async () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "stale-token");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async () => {
        seen.push("put");
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    const user = userEvent.setup();
    renderAt("/reset-password");
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    // The raw store still holds the stale value, but the tombstone blocks reuse.
    expect(window.sessionStorage.getItem(RECOVERY_TOKEN_KEY)).toBe("stale-token");
    expect(loadRecoveryToken()).toBeNull();
  });

  it("disables submit while public config is pending without reporting an expired link", async () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "rec-token");
    let resolveConfig!: (value: Response) => void;
    const configGate = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    const putSeen: string[] = [];
    const stubFetch = (async (url: unknown) => {
      if (String(url).includes("/public-config")) return configGate;
      putSeen.push(String(url));
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stubFetch);
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <AuthProvider skipBootstrap={false} skipValidation fetchImpl={stubFetch} initialSession={null}>
          <Routes>
            <Route path="/login" element={<div>Login stub</div>} />
            <Route path="/reset-password" element={<ResetPasswordScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    const submit = screen.getByRole("button", { name: /update password/i });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/loading configuration/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
    // A programmatic submit while pending hits the config guard, not the
    // expired-link path, and never dispatches the password update.
    const form = submit.closest("form");
    if (form !== null) fireEvent.submit(form);
    expect(await screen.findByText(/still loading configuration/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
    expect(putSeen).toHaveLength(0);
    // The typed password survives the config wait.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    resolveConfig(
      new Response(
        JSON.stringify({ data: { supabaseUrl: PUBLIC_CONFIG.supabaseUrl, supabasePublishableKey: "pub" } }),
        { status: 200 },
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /update password/i })).toBeEnabled());
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("new-password-1");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expect(screen.queryByText("Login stub")).toBeInTheDocument());
    expect(putSeen).toHaveLength(1);
  });

  it("shows a configuration failure instead of an expired link", async () => {
    window.sessionStorage.setItem(RECOVERY_TOKEN_KEY, "rec-token");
    const putSeen: string[] = [];
    const stubFetch = (async (url: unknown) => {
      if (String(url).includes("/public-config")) {
        return new Response(JSON.stringify({ message: "down" }), { status: 500 });
      }
      putSeen.push(String(url));
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stubFetch);
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <AuthProvider skipBootstrap={false} skipValidation fetchImpl={stubFetch} initialSession={null}>
          <Routes>
            <Route path="/login" element={<div>Login stub</div>} />
            <Route path="/reset-password" element={<ResetPasswordScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/did not provide its public configuration/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update password/i })).toBeDisabled();
    expect(screen.queryByText(/invalid or expired/i)).not.toBeInTheDocument();
    expect(putSeen).toHaveLength(0);
  });

  it("consumes a direct reset hash on mount while config is still pending", async () => {
    let resolveConfig!: (value: Response) => void;
    const configGate = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    const putSeen: string[] = [];
    const stubFetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/public-config")) return configGate;
      putSeen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stubFetch);
    window.location.hash = "#access_token=direct-token&refresh_token=r&type=recovery";
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <AuthProvider skipBootstrap={false} skipValidation fetchImpl={stubFetch} initialSession={null}>
          <Routes>
            <Route path="/login" element={<div>Login stub</div>} />
            <Route path="/reset-password" element={<ResetPasswordScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    // The token leaves the address bar before the slow config resolves.
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(loadRecoveryToken()).toBe("direct-token");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "new-password-1");
    resolveConfig(
      new Response(
        JSON.stringify({ data: { supabaseUrl: PUBLIC_CONFIG.supabaseUrl, supabasePublishableKey: "pub" } }),
        { status: 200 },
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /update password/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expect(screen.queryByText("Login stub")).toBeInTheDocument());
    expect(putSeen).toEqual(["Bearer direct-token"]);
  });
});
