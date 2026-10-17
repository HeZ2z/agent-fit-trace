import { describe, expect, it } from "vitest";
import type { CloudCapabilities } from "@pi-fit-trace/api-contracts";
import {
  cloudOptionFromCapabilities,
  isBackendSupportedInMode,
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

  it("subtracts reserved credits before deciding availability", () => {
    const option = cloudOptionFromCapabilities(
      capabilities({ tokensRemaining: 2_500, tokensReserved: 1_000, perRunTokenBudget: 2_000 }),
    );
    expect(option.available).toBe(false);
    expect(option.unavailableReason?.code).toBe("quota-exhausted");
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
