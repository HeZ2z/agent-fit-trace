import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { AUTH_STORAGE_KEY } from "../auth/supabaseAuth.ts";
import type { SupabaseSession } from "../auth/supabaseAuth.ts";
import App from "../App.tsx";
import { OAuthConsentScreen } from "./OAuthConsentScreen.tsx";

/**
 * Remote-MCP OAuth consent screen, driven through the real screen + the real
 * `AuthProvider` over a `fetch` stub (the `App.*.test.tsx` style). The stub
 * fakes only Supabase Auth: `/auth/v1/oauth/authorizations/{id}` and
 * `/auth/v1/oauth/authorizations/{id}/consent`, plus the two endpoints the
 * shared provider needs for a password sign-in.
 *
 * Navigation is observed through a stubbed `location` object, because jsdom
 * makes `Location.assign` non-configurable and cannot be spied on in place.
 */

const SUPABASE_URL = "http://auth.invalid";
const PUBLIC_CONFIG = {
  supabaseUrl: SUPABASE_URL,
  supabasePublishableKey: "publishable-key",
};
const AUTH_ID = "e6f2a0c1-9d3b-4c5e-8f70-2b1a4c6d8e01";
const REDIRECT_URL = `https://client.example/callback?code=abc123&state=xyz`;
const SECOND_AUTH_ID = "7c1d3e5f-0a2b-4d6c-9e81-3f5a7b9c1d02";

const session: SupabaseSession = {
  accessToken: "access-token-a",
  refreshToken: "refresh-token-a",
  expiresAt: 0,
  user: { id: "user-a", email: "a@example.com", isAnonymous: false },
};

interface RecordedCall {
  url: string;
  method: string;
  apikey: string | null;
  authorization: string | null;
  body: string | null;
}

interface MockState {
  /** Response for GET …/oauth/authorizations/{id}. */
  authorizationStatus: number;
  authorizationBody: unknown;
  /** Response for POST …/consent. */
  consentStatus: number;
  consentBody: unknown;
  /** When set, the consent POST waits for this gate before resolving. */
  consentGate: (() => Promise<void>) | null;
  calls: RecordedCall[];
}

function makeState(): MockState {
  return {
    authorizationStatus: 200,
    authorizationBody: {
      authorization_id: AUTH_ID,
      redirect_uri: REDIRECT_URL,
      client: {
        id: "client-id-1",
        name: "Claude Desktop",
        uri: "https://claude.example",
        logo_uri: "https://claude.example/logo.png",
      },
      user: { id: "user-a", email: "a@example.com" },
      scope: "openid profile email",
    },
    consentStatus: 200,
    consentBody: { redirect_url: REDIRECT_URL },
    consentGate: null,
    calls: [],
  };
}

function installFetch(state: MockState): void {
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : null;
      state.calls.push({
        url,
        method,
        apikey: headers.apikey ?? headers.Apikey ?? null,
        authorization: headers.authorization ?? headers.Authorization ?? null,
        body,
      });

      if (url === `${SUPABASE_URL}/auth/v1/token?grant_type=password`) {
        return new Response(
          JSON.stringify({
            access_token: "access-token-a",
            refresh_token: "refresh-token-a",
            expires_in: 3600,
            user: { id: "user-a", email: "a@example.com" },
          }),
          { status: 200 },
        );
      }
      if (url === `${SUPABASE_URL}/auth/v1/user`) {
        return new Response(
          JSON.stringify({ id: "user-a", email: "a@example.com", is_anonymous: false }),
          { status: 200 },
        );
      }
      // Any authorization id, so a test can prove nothing leaks across two
      // different requests.
      const authorizationPath = `${SUPABASE_URL}/auth/v1/oauth/authorizations/`;
      if (url.startsWith(authorizationPath) && !url.endsWith("/consent")) {
        return new Response(JSON.stringify(state.authorizationBody), {
          status: state.authorizationStatus,
        });
      }
      if (url.startsWith(authorizationPath) && url.endsWith("/consent")) {
        if (state.consentGate !== null) await state.consentGate();
        return new Response(JSON.stringify(state.consentBody), { status: state.consentStatus });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  );
}

const assignSpy = vi.fn();

function renderConsent(path: string, initialSession: SupabaseSession | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider
        skipBootstrap
        skipValidation
        publicConfig={PUBLIC_CONFIG}
        initialSession={initialSession}
      >
        <Routes>
          <Route path="/oauth/consent" element={<OAuthConsentScreen />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function consentCalls(state: MockState): RecordedCall[] {
  return state.calls.filter((call) => call.url.includes("/oauth/authorizations/"));
}

/** Consent POSTs only (excludes the sign-in token POST a test may also make). */
function consentPosts(state: MockState): RecordedCall[] {
  return state.calls.filter(
    (call) => call.method === "POST" && call.url.endsWith("/consent"),
  );
}

describe("OAuth consent screen", () => {
  let state: MockState;

  beforeEach(() => {
    state = makeState();
    installFetch(state);
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    assignSpy.mockReset();
    // jsdom's Location.assign is non-configurable; swap the whole object so a
    // navigation is observable instead of "Not implemented: navigation".
    vi.stubGlobal("location", {
      assign: assignSpy,
      href: `http://localhost/oauth/consent?authorization_id=${AUTH_ID}`,
      origin: "http://localhost",
      pathname: "/oauth/consent",
      search: `?authorization_id=${AUTH_ID}`,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("asks a signed-out visitor to sign in and makes no server call", async () => {
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, null);

    expect(
      await screen.findByRole("heading", { level: 1, name: /authorize an app/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    // No client details and no approve/deny action before authentication.
    expect(screen.queryByRole("button", { name: /approve access/i })).not.toBeInTheDocument();
    expect(consentCalls(state)).toHaveLength(0);
  });

  it("keeps the authorization_id through a sign-in and then loads the same request", async () => {
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, null);

    await user.type(await screen.findByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    // The details load for the SAME authorization id — the page is never
    // redirected away to a sanitized return target.
    expect((await screen.findAllByText(/Claude Desktop/)).length).toBeGreaterThan(0);
    const loads = consentCalls(state).filter((call) => call.method === "GET");
    expect(loads).toHaveLength(1);
    expect(loads[0]?.url).toBe(
      `${SUPABASE_URL}/auth/v1/oauth/authorizations/${AUTH_ID}`,
    );
    expect(loads[0]?.authorization).toBe("Bearer access-token-a");
  });

  it("renders the client, the requested scopes, and the redirect target", async () => {
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    expect((await screen.findAllByText(/Claude Desktop/)).length).toBeGreaterThan(0);
    expect(screen.getByText("https://claude.example")).toBeInTheDocument();
    expect(screen.getByText("openid, profile, email")).toBeInTheDocument();
    expect(screen.getByText(REDIRECT_URL)).toBeInTheDocument();
    // Minimal-privilege copy names the exposed training data.
    expect(screen.getByText(/workout history, analysis results, and draft training plans/i))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve access/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();

    const load = consentCalls(state)[0];
    expect(load?.url).toBe(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${AUTH_ID}`);
    expect(load?.method).toBe("GET");
    expect(load?.apikey).toBe("publishable-key");
    expect(load?.authorization).toBe("Bearer access-token-a");
  });

  it("posts approve to the consent endpoint with the bearer and follows the returned redirect_url", async () => {
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    await user.click(await screen.findByRole("button", { name: /approve access/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(REDIRECT_URL));
    expect(assignSpy).toHaveBeenCalledTimes(1);

    const consent = consentPosts(state);
    expect(consent).toHaveLength(1);
    expect(consent[0]?.url).toBe(
      `${SUPABASE_URL}/auth/v1/oauth/authorizations/${AUTH_ID}/consent`,
    );
    expect(consent[0]?.apikey).toBe("publishable-key");
    expect(consent[0]?.authorization).toBe("Bearer access-token-a");
    expect(JSON.parse(consent[0]?.body ?? "null")).toEqual({ action: "approve" });
  });

  it("posts deny to the same endpoint and follows the server's denial redirect", async () => {
    const denied = "https://client.example/callback?error=access_denied&state=xyz";
    state.consentBody = { redirect_url: denied };
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    await user.click(await screen.findByRole("button", { name: /^deny$/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(denied));
    const consent = consentPosts(state);
    expect(consent).toHaveLength(1);
    expect(consent[0]?.url).toBe(
      `${SUPABASE_URL}/auth/v1/oauth/authorizations/${AUTH_ID}/consent`,
    );
    expect(JSON.parse(consent[0]?.body ?? "null")).toEqual({ action: "deny" });
  });

  it("shows a clear error for an expired/unknown request and never navigates", async () => {
    state.authorizationStatus = 404;
    state.authorizationBody = { error: "oauth_authorization_not_found" };
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/missing, expired, or was already used/i);
    expect(screen.queryByRole("button", { name: /approve access/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^deny$/i })).not.toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("surfaces a failed consent POST without navigating", async () => {
    state.consentStatus = 404;
    state.consentBody = { error: "oauth_authorization_not_found" };
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    await user.click(await screen.findByRole("button", { name: /approve access/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /missing, expired, or was already used/i,
    );
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("refuses a redirect_url that is not an absolute http(s) URL", async () => {
    state.consentBody = { redirect_url: "javascript:alert(1)" };
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    await user.click(await screen.findByRole("button", { name: /approve access/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unexpected response/i);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("uses the signed-in session's token for the consent POST after an inline sign-in", async () => {
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, null);

    await user.type(await screen.findByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "pw-a-1234");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await user.click(await screen.findByRole("button", { name: /approve access/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(REDIRECT_URL));
    const consent = consentPosts(state);
    expect(consent).toHaveLength(1);
    expect(consent[0]?.authorization).toBe("Bearer access-token-a");
    expect(JSON.parse(consent[0]?.body ?? "null")).toEqual({ action: "approve" });
  });

  it("allows a retry after a failed decision", async () => {
    state.consentStatus = 503;
    state.consentBody = { message: "overloaded" };
    const user = userEvent.setup();
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    await user.click(await screen.findByRole("button", { name: /approve access/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
    expect(assignSpy).not.toHaveBeenCalled();

    // The single-flight lock was released: a retry dispatches a new request.
    state.consentStatus = 200;
    state.consentBody = { redirect_url: REDIRECT_URL };
    await user.click(screen.getByRole("button", { name: /approve access/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(REDIRECT_URL));
    expect(consentPosts(state)).toHaveLength(2);
  });

  it("reports an origin-rejected request without asking the user to sign in again", async () => {
    state.authorizationStatus = 403;
    state.authorizationBody = { message: "forbidden" };
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be completed from this site/i);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("reports an expired session when Auth answers 401", async () => {
    state.authorizationStatus = 401;
    state.authorizationBody = { message: "unauthorized" };
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    expect(await screen.findByRole("alert")).toHaveTextContent(/session is no longer valid/i);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("sends exactly one consent for a double click while a decision is in flight", async () => {
    let release!: () => void;
    state.consentGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);

    const approve = await screen.findByRole("button", { name: /approve access/i });
    // Two clicks in one batch: the `disabled` attribute has not re-rendered
    // yet, so this exercises the in-flight guard rather than the attribute.
    act(() => {
      fireEvent.click(approve);
      fireEvent.click(approve);
    });

    await waitFor(() => expect(consentPosts(state)).toHaveLength(1));
    expect(screen.getByRole("button", { name: /approving/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeDisabled();

    await act(async () => {
      release();
    });

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(consentPosts(state)).toHaveLength(1);
  });

  it("renders an error, and no request, when authorization_id is missing", async () => {
    renderConsent("/oauth/consent", session);

    expect(
      await screen.findByRole("heading", { level: 1, name: /authorize an app/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/missing a valid authorization request/i);
    expect(consentCalls(state)).toHaveLength(0);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("rejects a hostile authorization_id before it reaches the endpoint path", async () => {
    renderConsent("/oauth/consent?authorization_id=..%2F..%2Fuser", session);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /missing a valid authorization request/i,
    );
    expect(consentCalls(state)).toHaveLength(0);
  });

  it("does not reuse a previous request's details on remount", async () => {
    const first = renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);
    expect((await screen.findAllByText(/Claude Desktop/)).length).toBeGreaterThan(0);
    first.unmount();

    state.authorizationBody = {
      authorization_id: SECOND_AUTH_ID,
      redirect_uri: REDIRECT_URL,
      client: { id: "client-id-2", name: "Other Client" },
      user: { id: "user-a" },
      scope: "openid",
    };
    renderConsent(`/oauth/consent?authorization_id=${SECOND_AUTH_ID}`, session);

    expect((await screen.findAllByText(/Other Client/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Claude Desktop/)).not.toBeInTheDocument();
    expect(state.calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("drops a details response that arrives after unmount", async () => {
    let release!: () => void;
    state.consentGate = null;
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === `${SUPABASE_URL}/auth/v1/oauth/authorizations/${AUTH_ID}`) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return realFetch(input as RequestInfo, init);
      }) as unknown as typeof fetch,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const view = renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    view.unmount();
    await act(async () => {
      release();
    });

    // A late response must not write state on the unmounted screen.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("never stores the pending authorization in localStorage", async () => {
    renderConsent(`/oauth/consent?authorization_id=${AUTH_ID}`, session);
    expect((await screen.findAllByText(/Claude Desktop/)).length).toBeGreaterThan(0);

    // Only the session key the shared provider owns may exist.
    const keys = Object.keys(window.localStorage);
    expect(keys.filter((key) => key !== AUTH_STORAGE_KEY)).toEqual([]);
    expect(window.sessionStorage.length).toBe(0);
  });

});

/**
 * The route wiring itself: `/oauth/consent` must render this screen through
 * the real `App` (so a future refactor cannot drop the route or wrap it in the
 * shared sign-in gate, which would lose the `authorization_id`).
 */
describe("OAuth consent route in App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("serves the consent screen (not the shared sign-in gate) at /oauth/consent", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/v1/public-config")) {
          return new Response(JSON.stringify({ data: PUBLIC_CONFIG }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    );
    window.history.pushState({}, "", `/oauth/consent?authorization_id=${AUTH_ID}`);

    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: /authorize an app/i }),
    ).toBeInTheDocument();
    // The shared gate would have rendered its invite-only sign-in copy instead.
    expect(screen.queryByText(/Accounts are invite-only/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    // Signed out: no authorization request was made yet.
    expect(calls.filter((url) => url.includes("/oauth/authorizations/"))).toHaveLength(0);
  });
});
