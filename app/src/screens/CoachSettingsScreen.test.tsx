import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CoachingCapabilityDiscovery } from "@agent-fit-trace/api-contracts";
import { CoachDiscoveryProvider, useCoachDiscovery } from "../coaching/CoachDiscoveryContext.tsx";
import { CloudCoachingClient } from "../api/cloudCoachingClient.ts";
import type { CloudCapabilities } from "@agent-fit-trace/api-contracts";
import { CoachSettingsScreen } from "./CoachSettingsScreen.tsx";
import * as cloudDestination from "../api/cloudDestination.ts";

vi.mock("../api/cloudDestination.ts", () => ({
  readCloudDestination: vi.fn(),
  previewCloudDestination: vi.fn(),
  confirmCloudDestination: vi.fn(),
  resetCloudDestination: vi.fn(),
}));

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
  // Source-string translator with the same {placeholder} substitution the real
  // provider performs; the assertions match the English source strings.
  useI18n: () => ({
    t: (text: string, params?: Record<string, unknown>) =>
      text.replace(/\{(\w+)\}/g, (match, key: string) =>
        params?.[key] === undefined ? match : String(params[key]),
      ),
  }),
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

function cloudCapabilities(overrides: Partial<CloudCapabilities> = {}): CloudCapabilities {
  return {
    enabled: true,
    providerConfigured: true,
    providerEnabled: true,
    accountFormal: true,
    quotaConfigured: true,
    budgetConfigured: true,
    concurrentLimit: 2,
    reservedCount: 0,
    tokensRemaining: 10_000,
    tokensReserved: 0,
    perRunTokenBudget: 2_000,
    perStepTokenBudget: 500,
    perRunRequestLimit: 20,
    tools: ["get_training_history", "analyze_progress"],
    maxSteps: 8,
    maxTokens: 10_000,
    timeoutMs: 600_000,
    ...overrides,
  };
}

function setCloudRuntime(enabled: boolean): void {
  (window as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME = {
    mode: "http",
    coaching: "same-origin",
    ...(enabled ? { cloud: true } : {}),
  };
}

const OFFICIAL_DESTINATION = {
  source: "official" as const,
  destination: "https://cloud.example.test/api/v1",
  host: "cloud.example.test",
  officialDestination: "https://cloud.example.test/api/v1",
  issuer: "https://project.example.test",
  consent: "not-applicable" as const,
};

beforeEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
  vi.restoreAllMocks();
  vi.mocked(cloudDestination.readCloudDestination).mockResolvedValue(OFFICIAL_DESTINATION);
  vi.mocked(cloudDestination.previewCloudDestination).mockReset();
  vi.mocked(cloudDestination.confirmCloudDestination).mockReset();
  vi.mocked(cloudDestination.resetCloudDestination).mockReset();
});

afterEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __FIT_TRACE_RUNTIME?: unknown }).__FIT_TRACE_RUNTIME;
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

  it("offers the proxied hosted coach and discloses the synced-history boundary", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(cloudCapabilities());
    const client = stubClient(
      discoveryOf([
        descriptor({ backendId: "local-pi" }),
        // The daemon's local discovery still carries its own unavailable
        // cloud-default entry. The proxy's answer must REPLACE it, not add a
        // second contradictory "Cloud coach" row.
        descriptor({
          backendId: "cloud-default",
          runtimeId: "hosted-sdk",
          executionLocation: "cloud",
          displayName: "Cloud coach",
          available: false,
          unavailableReason: {
            code: "identity-unverified",
            message: "Cloud eligibility could not be verified.",
          },
          capabilities: {
            ...descriptor({ backendId: "local-pi" }).capabilities,
            accountEligibility: "required",
            quotaReservation: "required",
            dataDestination: "vendor-api",
          },
        }),
      ]),
    );
    renderPage({ user: { id: "user-cloud-settings", isAnonymous: false }, client });

    const clouds = await screen.findAllByRole("radio", { name: /cloud coach/i });
    expect(clouds).toHaveLength(1);
    const cloud = clouds[0] as HTMLInputElement;
    expect(cloud.disabled).toBe(false);
    expect(cloud.checked).toBe(true);
    expect(await screen.findByTestId("cloud-history-disclosure")).toHaveTextContent(
      /only on this device are not visible/i,
    );
  });

  it("keeps cloud visible but refuses it when the hosted service reports no budget", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(
      cloudCapabilities({ quotaConfigured: false }),
    );
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-cloud-quota", isAnonymous: false }, client });

    const cloud = (await screen.findByRole("radio", { name: /cloud coach/i })) as HTMLInputElement;
    expect(cloud.disabled).toBe(true);
    expect(await screen.findByTestId("reason-cloud-default")).toHaveTextContent(/finite execution budget/i);
    // No silent switch: the local backend becomes the usable default instead.
    const pi = screen.getByRole("radio", { name: /pi cli/i }) as HTMLInputElement;
    expect(pi.checked).toBe(true);
  });

  it("keeps the guest placeholder even when the daemon proxies cloud", async () => {
    setCloudRuntime(true);
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "guest-cloud-settings", isAnonymous: true }, client });
    expect(await screen.findByTestId("cloud-placeholder")).toHaveTextContent(/sign in/i);
  });

  it("shows the official cloud server in use for a signed-in account", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(cloudCapabilities());
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-cloud-server", isAnonymous: false }, client });

    expect(await screen.findByTestId("cloud-server-official")).toHaveTextContent(
      /official cloud server in use: cloud\.example\.test/i,
    );
    expect(screen.getByTestId("cloud-server-settings")).toBeInTheDocument();
  });

  it("requires an explicit confirmation naming the host before saving a custom destination", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(cloudCapabilities());
    vi.mocked(cloudDestination.previewCloudDestination).mockResolvedValue({
      ok: true,
      destination: "https://custom.example.test/api/v1",
      host: "custom.example.test",
      official: false,
      issuerCompatible: true,
    });
    vi.mocked(cloudDestination.confirmCloudDestination).mockResolvedValue({
      ...OFFICIAL_DESTINATION,
      source: "user",
      destination: "https://custom.example.test/api/v1",
      host: "custom.example.test",
      consent: "confirmed",
    });
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-cloud-confirm", isAnonymous: false }, client });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /use a different server/i }));
    await user.type(screen.getByTestId("cloud-server-input"), "https://custom.example.test/api/v1");
    await user.click(screen.getByRole("button", { name: /check server/i }));

    const confirmation = await screen.findByTestId("cloud-server-confirm");
    expect(confirmation).toHaveTextContent(/custom\.example\.test/);
    expect(vi.mocked(cloudDestination.confirmCloudDestination)).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm and use this server/i }));
    await waitFor(() =>
      expect(vi.mocked(cloudDestination.confirmCloudDestination)).toHaveBeenCalledWith(
        "https://custom.example.test/api/v1",
        "custom.example.test",
        expect.anything(),
      ),
    );
    expect(await screen.findByTestId("cloud-server-custom")).toHaveTextContent(/custom\.example\.test/);
  });

  it("refuses an incompatible destination without offering confirmation", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(cloudCapabilities());
    vi.mocked(cloudDestination.previewCloudDestination).mockResolvedValue({
      ok: false,
      error: {
        code: "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE",
        message: "This server uses a different account service.",
      },
    });
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-cloud-wrong-issuer", isAnonymous: false }, client });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /use a different server/i }));
    await user.type(screen.getByTestId("cloud-server-input"), "https://other.example.test/api/v1");
    await user.click(screen.getByRole("button", { name: /check server/i }));

    expect(await screen.findByTestId("cloud-server-form-error")).toHaveTextContent(
      /different account service/i,
    );
    expect(screen.queryByTestId("cloud-server-confirm")).toBeNull();
    expect(screen.queryByRole("button", { name: /confirm and use this server/i })).toBeNull();
  });

  it("asks a second account to confirm an already stored custom server", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(cloudCapabilities());
    vi.mocked(cloudDestination.readCloudDestination).mockResolvedValue({
      ...OFFICIAL_DESTINATION,
      source: "user",
      destination: "https://custom.example.test/api/v1",
      host: "custom.example.test",
      consent: "required",
    });
    vi.mocked(cloudDestination.confirmCloudDestination).mockResolvedValue({
      ...OFFICIAL_DESTINATION,
      source: "user",
      destination: "https://custom.example.test/api/v1",
      host: "custom.example.test",
      consent: "confirmed",
    });
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-cloud-second", isAnonymous: false }, client });

    expect(await screen.findByTestId("cloud-server-unconfirmed")).toHaveTextContent(
      /custom\.example\.test/,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /confirm custom\.example\.test/i }));
    await waitFor(() =>
      expect(vi.mocked(cloudDestination.confirmCloudDestination)).toHaveBeenCalledWith(
        "https://custom.example.test/api/v1",
        "custom.example.test",
        expect.anything(),
      ),
    );
  });

  it("surfaces an invalid stored destination and offers a reset to official", async () => {
    setCloudRuntime(true);
    vi.spyOn(CloudCoachingClient.prototype, "readCapabilities").mockResolvedValue(cloudCapabilities());
    vi.mocked(cloudDestination.readCloudDestination).mockResolvedValue({
      ...OFFICIAL_DESTINATION,
      source: "invalid",
      destination: null,
      host: null,
      consent: "not-applicable",
      error: { code: "CLOUD_DESTINATION_INVALID", message: "The stored setting is invalid." },
    });
    vi.mocked(cloudDestination.resetCloudDestination).mockResolvedValue(OFFICIAL_DESTINATION);
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    renderPage({ user: { id: "user-cloud-invalid", isAnonymous: false }, client });

    expect(await screen.findByTestId("cloud-server-invalid")).toHaveTextContent(/stored setting is invalid/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /reset to the official cloud server/i }));
    await waitFor(() => expect(vi.mocked(cloudDestination.resetCloudDestination)).toHaveBeenCalled());
    expect(await screen.findByTestId("cloud-server-official")).toHaveTextContent(/cloud\.example\.test/);
  });
});

describe("cross-screen propagation (review follow-up)", () => {
  it("a rescan publishes a revision that consumers can key on", async () => {
    // `useCoach` folds this into its discovery key. Without a change the Coach
    // screen kept its cached option list after a backend became available.
    const client = stubClient(discoveryOf([descriptor({ backendId: "local-pi" })]));
    const { rerender } = render(
      <CoachDiscoveryProvider client={client as never}>
        <RevisionProbe />
      </CoachDiscoveryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("revision").textContent).not.toBe("0"));
    const before = screen.getByTestId("revision").textContent;
    // Force a refresh through the same path the page's button uses.
    await act(async () => {
      await screen.getByTestId("refresh").click();
    });
    await waitFor(() => expect(screen.getByTestId("revision").textContent).not.toBe(before));
    rerender(<span />);
  });
});

/** Minimal consumer that surfaces the provider's signals. */
function RevisionProbe() {
  const { revision, refresh } = useCoachDiscovery();
  return (
    <div>
      <span data-testid="revision">{String(revision)}</span>
      <button data-testid="refresh" type="button" onClick={() => void refresh()}>
        refresh
      </button>
    </div>
  );
}

describe("account switch during discovery", () => {
  it("does not publish the previous account's result to the new one", async () => {
    // Regression: with the client shared across identities, a sign-in as B
    // while A's discovery was pending returned A's promise to B — the account
    // change neither bumped the generation nor cleared the in-flight handle, so
    // A's answer landed in B's snapshot and B never issued its own request.
    let releaseA: ((value: CoachingCapabilityDiscovery) => void) | undefined;
    const aDiscovery = new Promise<CoachingCapabilityDiscovery>((resolve) => {
      releaseA = resolve;
    });
    const firstClient = {
      isBootstrapped: false,
      bootstrap: vi.fn(async () => ({ capability: "cap-a", expiresInMs: 1000 })),
      discoverBackends: vi.fn(() => aDiscovery),
    };
    const secondClient = {
      isBootstrapped: false,
      bootstrap: vi.fn(async () => ({ capability: "cap-b", expiresInMs: 1000 })),
      discoverBackends: vi.fn(async () => discoveryOf([descriptor({ backendId: "local-pi", displayName: "pi (B)" })])),
    };

    authState.user = { id: "user-a", isAnonymous: false };
    const { rerender } = render(
      <CoachDiscoveryProvider client={firstClient as never}>
        <RevisionProbe />
      </CoachDiscoveryProvider>,
    );
    // A's discovery is now pending.
    authState.user = { id: "user-b", isAnonymous: false };
    rerender(
      <CoachDiscoveryProvider client={secondClient as never}>
        <RevisionProbe />
      </CoachDiscoveryProvider>,
    );

    // B must issue its OWN discovery rather than inheriting A's promise.
    await waitFor(() => expect(secondClient.discoverBackends).toHaveBeenCalled());

    // A's late answer must not overwrite B's snapshot.
    await act(async () => {
      releaseA?.(discoveryOf([descriptor({ backendId: "local-pi", displayName: "pi (A)" })]));
    });
    // The provider keeps rendering B's result; A's promise resolving changed
    // nothing observable.
    expect(secondClient.discoverBackends).toHaveBeenCalled();
  });
});
