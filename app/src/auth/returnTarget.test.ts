import { beforeEach, describe, expect, it } from "vitest";
import {
  clearReturnTarget,
  consumeReturnTarget,
  markExplicitSignOut,
  peekReturnTarget,
  sanitizeReturnTarget,
  saveReturnTarget,
} from "./returnTarget.ts";

describe("sanitizeReturnTarget", () => {
  it("accepts known routes and preserves ordinary query parameters", () => {
    expect(sanitizeReturnTarget("/")).toBe("/");
    expect(sanitizeReturnTarget("/me")).toBe("/me");
    expect(sanitizeReturnTarget("/workout/new")).toBe("/workout/new");
    expect(sanitizeReturnTarget("/workout/wkt_123-abc.def~")).toBe("/workout/wkt_123-abc.def~");
    expect(sanitizeReturnTarget("/analysis")).toBe("/analysis");
    expect(sanitizeReturnTarget("/plan")).toBe("/plan");
    expect(sanitizeReturnTarget("/analysis?from=2026-09-01&to=2026-10-01")).toBe(
      "/analysis?from=2026-09-01&to=2026-10-01",
    );
  });

  it("rejects external, protocol-relative, and backslash targets", () => {
    expect(sanitizeReturnTarget("https://evil.example/analysis")).toBeNull();
    expect(sanitizeReturnTarget("//evil.example/analysis")).toBeNull();
    expect(sanitizeReturnTarget("/\\evil.example/analysis")).toBeNull();
    expect(sanitizeReturnTarget("/analysis\\..\\evil")).toBeNull();
    expect(sanitizeReturnTarget(" /analysis")).toBeNull();
    expect(sanitizeReturnTarget("analysis")).toBeNull();
  });

  it("rejects encoded separator and control-character evasions", () => {
    expect(sanitizeReturnTarget("/%2Fevil.example")).toBeNull();
    expect(sanitizeReturnTarget("/%252Fevil.example")).toBeNull();
    expect(sanitizeReturnTarget("/%5Cevil")).toBeNull();
    expect(sanitizeReturnTarget("/analysis%00")).toBeNull();
    expect(sanitizeReturnTarget("/analysis%0A")).toBeNull();
    expect(sanitizeReturnTarget("/analysis%".concat("zz"))).toBeNull();
  });

  it("rejects auth loops, unknown routes, fragments, and auth token params", () => {
    for (const target of [
      "/login",
      "/forgot-password",
      "/reset-password",
      "/auth/callback",
      "/settings",
      "/workout/new/extra",
      "/analysis#access_token=abc",
      "/analysis?access_token=abc",
      "/analysis?refresh_token=abc",
      "/analysis?code=abc",
      "/analysis?type=recovery",
      "/analysis?error=denied",
      "/analysis?ACCESS_TOKEN=abc",
      "/analysis?%2561ccess_token=secret",
      "/analysis?%252561ccess_token=secret",
      "/analysis?re%2566resh_token=secret",
      "/analysis?pro%2576ider_token=secret",
    ]) {
      expect(sanitizeReturnTarget(target)).toBeNull();
    }
  });

  it("rejects oversized values", () => {
    expect(sanitizeReturnTarget(`/analysis?x=${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("tab-scoped return target storage", () => {
  beforeEach(() => {
    clearReturnTarget();
  });

  it("stores only sanitized targets and re-validates on read", () => {
    expect(saveReturnTarget("https://evil.example")).toBeNull();
    expect(saveReturnTarget("/plan")).toBe("/plan");
    expect(peekReturnTarget()).toBe("/plan");

    window.sessionStorage.setItem("pi-fit-trace:auth:return-target:v1", "/login");
    expect(peekReturnTarget()).toBeNull();
  });

  it("consumes once", () => {
    saveReturnTarget("/analysis?from=2026-09-01");
    expect(consumeReturnTarget()).toBe("/analysis?from=2026-09-01");
    expect(consumeReturnTarget()).toBeNull();
  });

  it("clears an armed target on explicit sign-out", () => {
    saveReturnTarget("/plan");
    expect(peekReturnTarget()).toBe("/plan");
    markExplicitSignOut("/plan");
    expect(peekReturnTarget()).toBeNull();
  });

  it("does not capture the explicit sign-out route, but captures the next intentional target", () => {
    markExplicitSignOut("/coach");
    expect(saveReturnTarget("/coach")).toBeNull();
    expect(peekReturnTarget()).toBeNull();
    // The marker is consumed rather than leaking into a later provider/nav.
    expect(saveReturnTarget("/analysis?from=2026-09-01")).toBe("/analysis?from=2026-09-01");
    expect(peekReturnTarget()).toBe("/analysis?from=2026-09-01");
  });

  it("does not leak a sign-out marker across independent providers", () => {
    markExplicitSignOut("/plan");
    // A different provider/tab starts with empty session storage.
    window.sessionStorage.clear();
    expect(saveReturnTarget("/plan")).toBe("/plan");
  });

  it("expires a stale sign-out marker", () => {
    markExplicitSignOut("/plan");
    const marker = JSON.parse(
      window.sessionStorage.getItem("pi-fit-trace:auth:explicit-sign-out:v1") ?? "{}",
    ) as { path: string; at: number };
    marker.at = Date.now() - 60_000;
    window.sessionStorage.setItem("pi-fit-trace:auth:explicit-sign-out:v1", JSON.stringify(marker));
    expect(saveReturnTarget("/plan")).toBe("/plan");
  });
});
