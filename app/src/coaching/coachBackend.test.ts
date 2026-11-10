import { describe, expect, it } from "vitest";
import type { CloudCapabilities } from "@agent-fit-trace/api-contracts";
import {
  cloudOptionFromCapabilities,
  defaultCoachBackend,
  writeBackendPreference,
  descriptorToOption,
  isBackendSupportedInMode,
  localPiOption,
  selectLocalBackend,
  resolveLocalBackendChoice,
} from "./coachBackend.ts";

function capabilities(overrides: Partial<CloudCapabilities> = {}): CloudCapabilities {
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

describe("cloud backend availability", () => {
  it("advertises cloud only when one full per-run budget is reservable", () => {
    const option = cloudOptionFromCapabilities(capabilities());
    expect(option.available).toBe(true);
    expect(option.unavailableReason).toBeUndefined();
  });

  it("rejects a positive balance that cannot reserve the configured per-run budget", () => {
    const option = cloudOptionFromCapabilities(
      capabilities({ tokensRemaining: 1, perRunTokenBudget: 2_000 }),
    );
    expect(option.available).toBe(false);
    expect(option.unavailableReason?.code).toBe("quota-exhausted");
    expect(option.unavailableReason?.message).toMatch(/per run/i);
  });

  it("uses the server's remaining balance directly (already net of reservations)", () => {
    // Server contract: 6,000 limit - 2,000 reserved = 4,000 remaining. A
    // 3,000 per-run budget is affordable; subtracting the reserve again
    // would wrongly expose 2,000 and disable cloud.
    const option = cloudOptionFromCapabilities(
      capabilities({ tokensRemaining: 4_000, tokensReserved: 2_000, perRunTokenBudget: 3_000 }),
    );
    expect(option.available).toBe(true);
    expect(option.unavailableReason).toBeUndefined();
  });

  it("does not subtract the reserve a second time", () => {
    const option = cloudOptionFromCapabilities(
      capabilities({ tokensRemaining: 2_500, tokensReserved: 1_000, perRunTokenBudget: 2_000 }),
    );
    expect(option.available).toBe(true);
  });

  it("accepts an exact per-run budget as available", () => {
    const option = cloudOptionFromCapabilities(
      capabilities({ tokensRemaining: 2_000, tokensReserved: 0, perRunTokenBudget: 2_000 }),
    );
    expect(option.available).toBe(true);
  });
});

describe("mode-bound restore compatibility", () => {
  it("lets the launcher replay local runs but not cloud runs it cannot serve", () => {
    expect(isBackendSupportedInMode("local-pi", "launcher")).toBe(true);
    expect(isBackendSupportedInMode("cloud-default", "launcher")).toBe(false);
  });

  it("never replays a local launcher run through a plain browser", () => {
    expect(isBackendSupportedInMode("local-pi", "browser")).toBe(false);
    expect(isBackendSupportedInMode("cloud-default", "browser")).toBe(true);
  });
});

describe("local pi availability messaging", () => {
  it("the launcher's own reason survives the piAvailable=false path", () => {
    // Regression for the inversion this project fixed twice: when a packaged
    // build lacks its extension, the server says so. Flattening every
    // `piAvailable === false` into the "install pi" text would send the user to
    // fix a CLI that is already installed.
    const serverSays = descriptorToOption({
      backendId: "local-pi",
      runtimeId: "pi",
      executionLocation: "local",
      displayName: "pi CLI (local)",
      available: false,
      unavailableReason: {
        code: "cli-version-unsupported",
        message: "pi CLI is installed, but no Fit Trace extension was found.",
      },
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
    });
    expect(serverSays.available).toBe(false);
    expect(serverSays.unavailableReason?.code).toBe("cli-version-unsupported");
    expect(serverSays.unavailableReason?.message).toContain("extension");

    // The fallback text is still what a genuinely absent CLI gets, so the two
    // states remain distinguishable rather than collapsing into one.
    expect(localPiOption(false).unavailableReason?.code).toBe("cli-not-installed");
  });
});

describe("a saved local preference survives a reload", () => {
  it("launcher mode adopts a stored non-pi backend", () => {
    // Regression: `defaultCoachBackend` returned `local-pi` unconditionally in
    // launcher mode, so choosing Codex in settings survived only until the next
    // reload — the radio said Codex while the run used pi.
    writeBackendPreference("user-a", "local-codex");
    expect(defaultCoachBackend({ mode: "launcher", accountId: "user-a", guest: false })).toBe("local-codex");
  });

  it("waits for discovery with no local preference", () => {
    expect(defaultCoachBackend({ mode: "launcher", accountId: "user-b", guest: false })).toBeNull();
    writeBackendPreference("user-c", "cloud-default");
    // Launcher serves local coaching; a cloud preference belongs to browser mode.
    expect(defaultCoachBackend({ mode: "launcher", accountId: "user-c", guest: false })).toBeNull();
  });

  it("a guest waits for discovery", () => {
    expect(defaultCoachBackend({ mode: "launcher", accountId: null, guest: true })).toBeNull();
  });
});


describe("local automatic selection", () => {
  const pi = localPiOption(true);
  const codex = { ...pi, id: "local-codex" as const, available: true };
  const openCode = { ...pi, id: "local-opencode" as const, available: true };
  it("uses stable priority among verified available options", () => {
    expect(selectLocalBackend(null, [openCode, codex, pi])).toBe("local-pi");
    expect(selectLocalBackend(null, [{ ...pi, available: false }, openCode, codex])).toBe("local-codex");
    expect(selectLocalBackend(null, [{ ...pi, available: false }, { ...codex, available: false }])).toBeNull();
  });
  it("keeps an explicit unavailable default visible", () => {
    expect(selectLocalBackend("local-pi", [{ ...pi, available: false }, codex])).toBe("local-pi");
  });
});


it("selection records preference, runtime, automatic and empty provenance", () => {
  const pi = localPiOption(false);
  const codex = { ...pi, id: "local-codex" as const, available: true };
  const options = [pi, codex];
  expect(resolveLocalBackendChoice({ preference: "local-pi", defaultId: "local-codex", defaultSource: "runtime", options })).toEqual({ backendId: "local-pi", source: "preference" });
  expect(resolveLocalBackendChoice({ preference: null, defaultId: "local-pi", defaultSource: "runtime", options })).toEqual({ backendId: "local-pi", source: "runtime" });
  expect(resolveLocalBackendChoice({ preference: null, defaultId: "local-codex", defaultSource: "automatic", options })).toEqual({ backendId: "local-codex", source: "automatic" });
  expect(resolveLocalBackendChoice({ preference: null, defaultId: null, options: [pi] })).toEqual({ backendId: null, source: "none" });
  expect(resolveLocalBackendChoice({ preference: null, defaultId: "local-pi", options })).toEqual({ backendId: "local-pi", source: "server" });
});
