import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CoachingCapabilityDiscovery } from "@agent-fit-trace/api-contracts";
import { CoachDiscoveryProvider } from "../coaching/CoachDiscoveryContext.tsx";
import { CoachSettingsScreen } from "./CoachSettingsScreen.tsx";

// Both are hook-only modules with no injectable provider, so they are mocked at
// the module boundary. Mocking here is deliberate: the page's contract is "read
// the server's answers and refuse unavailable choices", and pulling the real
// auth and i18n stacks in would test those instead.
const authState: { user: { id: string; isAnonymous?: boolean } | null } = { user: null };
vi.mock("../auth/AuthContext.tsx", () => ({
  useAuth: () => ({
    user: authState.user,
    status: authState.user === null ? "signed-out" : "signed-in",
    getAccessToken: () => "token",
  }),
}));
vi.mock("../i18n/useI18n.ts", () => ({
  // Identity translator: the assertions below match the English source strings.
  useI18n: () => ({ t: (text: string) => text }),
}));

/**
 * The settings page renders server-derived availability and refuses to select
 * anything the server did not mark available.
 *
 * The provider is exercised with an injected client so these tests assert the
 * PAGE's behaviour, not the network. The one-capability rule itself is covered
 * by `App.coachNavigation.test.tsx`, which mounts the real App.
 */

function descriptor(
  overrides: Partial<CoachingCapabilityDiscovery["backends"][number]> & {
    backendId: CoachingCapabilityDiscovery["backends"][number]["backendId"];
  },
): CoachingCapabilityDiscovery["backends"][number] {
  const base = {
    runtimeId: "pi",
    executionLocation: "local",
    displayName: "pi CLI (local)",
    available: true,
    capabilities: {
      capabilityVersion: 1,
      protocolVersion: 1,
      tools: ["get_training_history", "analyze_progress"],
      productReplay: false,
      nativeContinuation: true,
      cancelConfirmation: "process-exit",
      maxInputBytes: 1024,
      maxEvents: 10,
      maxEventBytes: 1024,
      accountEligibility: "not-required",
      quotaReservation: "not-required",
      dataDestination: "cli-provider",
    },
  } as const;
  return { ...base, ...overrides } as CoachingCapabilityDiscovery["backends"][number];
}

function discoveryOf(backends: CoachingCapabilityDiscovery["backends"]): CoachingCapabilityDiscovery {
  return { discoveryVersion: 1, protocolVersion: 1, tools: ["get_training_history", "analyze_progress"], backends };
}

/** A client stub; `bootstrap` is a no-op because the provider owns the sequence. */
function stubClient(discovery: CoachingCapabilityDiscovery) {
  // `isBootstrapped` is modelled honestly: it flips after the first bootstrap,
  // which is what lets the page reuse a live capability instead of minting a
  // new one on every rescan.
  let bootstrapped = false;
  const client = {
    get isBootstrapped(): boolean {
      return bootstrapped;
    },
    bootstrap: vi.fn(async () => {
      bootstrapped = true;
      return { capability: "cap", expiresInMs: 1000 };
    }),
    discoverBackends: vi.fn(async () => discovery),
  };
  return client;
}

function renderPage({
  user,
  client,
}: {
  user: { id: string; isAnonymous?: boolean } | null;
  client: ReturnType<typeof stubClient>;
}) {
  authState.user = user;
  return render(
    <CoachDiscoveryProvider client={client as never}>
      <CoachSettingsScreen />
    </CoachDiscoveryProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("coach settings: local CLI section", () => {
  it("renders each backend with the server's own unavailable reason", async () => {
    const client = stubClient(
      discoveryOf([
        descriptor({ backendId: "local-pi", displayName: "pi CLI (local)", available: true }),
        descriptor({
          backendId: "local-codex",
          runtimeId: "codex",
          displayName: "Codex CLI (local)",
          available: false,
          version: "0.164.0",
          unavailableReason: {
            code: "cli-version-unsupported",
            message: "read-only sandbox: built-in file reads remain possible (ADR 0007)",
          },
        }),
      ]),
    );
    renderPage({ user: { id: "user-a", isAnonymous: false }, client });

    // The reason must be the SERVER's text, not a locally invented one: #67
    // established that flattening every unavailable backend into "install the
    // CLI" sends users to fix something they already have.
    expect(await screen.findByTestId("reason-local-codex")).toHaveTextContent(/read-only sandbox/);
    expect(screen.queryByTestId("reason-local-pi")).toBeNull();
  });

  it("refuses to select an unavailable backend", async () => {
    const client = stubClient(
      discoveryOf([
        descriptor({ backendId: "local-pi", available: false, unavailableReason: { code: "cli-not-installed", message: "pi is not installed." } }),
        descriptor({ backendId: "local-codex", runtimeId: "codex", displayName: "Codex CLI (local)", available: true }),
      ]),
    );
    renderPage({ user: { id: "user-a", isAnonymous: false }, client });
    await screen.findByRole("radio", { name: /codex cli/i });
    const piRadio = screen.getByRole("radio", { name: /pi cli/i }) as HTMLInputElement;
    expect(piRadio.disabled).toBe(true);
  });

  it("re-runs discovery on demand and does not mint a second bootstrap while one is in flight", async () => {
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-a", isAnonymous: false }, client });
    await screen.findByRole("radio", { name: /pi cli/i });

    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: /check again/i });
    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(client.discoverBackends.mock.calls.length).toBeGreaterThan(1));
    // THE regression this guards: `bootstrap()` coalesces concurrent calls but
    // does not reuse a live capability, so a naive rescan would mint a new
    // 10-minute capability each time. The daemon caps them at 5 per account and
    // then answers 503, wedging discovery until expiry. Four rescans must still
    // cost exactly one bootstrap.
    expect(client.bootstrap.mock.calls.length).toBe(1);
  });

  it("a repeated rescan never mints a second capability", async () => {
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-a", isAnonymous: false }, client });
    await screen.findByRole("radio", { name: /pi cli/i });
    const user = userEvent.setup();
    for (let i = 0; i < 4; i += 1) {
      await user.click(screen.getByRole("button", { name: /check again|checking/i }));
      await waitFor(() => expect(client.discoverBackends.mock.calls.length).toBeGreaterThan(i + 1));
    }
    expect(client.bootstrap.mock.calls.length).toBe(1);
  });
});

describe("coach settings: cloud section", () => {
  it("shows a placeholder for a guest rather than nothing", async () => {
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "guest-a", isAnonymous: true }, client });
    // ADR 0008: a blank section is indistinguishable from a broken one.
    expect(await screen.findByTestId("cloud-placeholder")).toHaveTextContent(/sign in/i);
  });

  it("does not offer cloud to a signed-in user until it is wired", async () => {
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-a", isAnonymous: false }, client });
    expect(await screen.findByTestId("cloud-not-wired")).toBeInTheDocument();
  });
});
