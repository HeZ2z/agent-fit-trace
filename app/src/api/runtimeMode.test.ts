import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_MODE_ERROR,
  RuntimeModeError,
  evaluateRuntimeMode,
  isHttpModeActive,
  requireRuntimeMode,
  runtimeModeOverride,
} from "./runtimeMode.ts";
import { createFitTraceClient } from "./createFitTraceClient.ts";

function setRuntimeOverride(value: unknown): void {
  (globalThis as unknown as Record<string, unknown>).__FIT_TRACE_RUNTIME = value;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__FIT_TRACE_RUNTIME;
  vi.unstubAllEnvs();
});

describe("evaluateRuntimeMode", () => {
  it("selects http from the build in production", () => {
    const result = evaluateRuntimeMode({
      buildMode: "http",
      runtimeOverride: null,
      isProduction: true,
    });
    expect(result).toEqual({ mode: "http", source: "build", error: null });
  });

  it("reads the launcher runtime override in production", () => {
    const result = evaluateRuntimeMode({
      buildMode: "local",
      runtimeOverride: "http",
      isProduction: true,
    });
    expect(result).toEqual({ mode: "http", source: "runtime", error: null });
  });

  it("fails closed for every non-http production configuration", () => {
    for (const buildMode of [undefined, "", "local", "bogus"]) {
      const result = evaluateRuntimeMode({
        buildMode,
        runtimeOverride: null,
        isProduction: true,
      });
      expect(result.mode).toBeNull();
      expect(result.error).toBe(PRODUCTION_MODE_ERROR);
    }
    const runtimeLocal = evaluateRuntimeMode({
      buildMode: "http",
      runtimeOverride: "local",
      isProduction: true,
    });
    expect(runtimeLocal.mode).toBeNull();
    expect(runtimeLocal.error).toBe(PRODUCTION_MODE_ERROR);
  });

  it("keeps local mode for development while normal auth still gates it", () => {
    for (const buildMode of [undefined, "", "local"]) {
      const result = evaluateRuntimeMode({
        buildMode,
        runtimeOverride: null,
        isProduction: false,
      });
      expect(result.mode).toBe("local");
      expect(result.error).toBeNull();
    }
    // Legacy dev fallback for an unknown build value never bypasses auth.
    expect(
      evaluateRuntimeMode({ buildMode: "bogus", runtimeOverride: null, isProduction: false }).mode,
    ).toBe("local");
  });

  it("rejects unknown runtime overrides instead of falling back", () => {
    for (const override of ["bogus", 42, true, { mode: "http" }]) {
      const result = evaluateRuntimeMode({
        buildMode: "http",
        runtimeOverride: override,
        isProduction: false,
      });
      expect(result.mode).toBeNull();
      expect(result.error).toMatch(/unknown runtime mode/i);
    }
  });

  it("distinguishes an explicitly malformed mode property from an absent object", () => {
    for (const override of [null, undefined, 42, true, { mode: "http" }]) {
      const result = evaluateRuntimeMode({
        buildMode: "http",
        runtimeOverride: override,
        runtimeModePresent: true,
        isProduction: false,
      });
      expect(result.mode).toBeNull();
      expect(result.source).toBe("runtime");
      expect(result.error).toMatch(/unknown runtime mode/i);
    }
    // No explicit property: the build mode wins normally.
    expect(
      evaluateRuntimeMode({ buildMode: "http", runtimeOverride: null, isProduction: false }).mode,
    ).toBe("http");
    expect(
      evaluateRuntimeMode({
        buildMode: "http",
        runtimeOverride: null,
        runtimeModePresent: false,
        isProduction: false,
      }).mode,
    ).toBe("http");
  });
});

describe("runtimeMode override globals", () => {
  it("stays local when neither the build mode nor the override selects http", () => {
    expect(isHttpModeActive(undefined)).toBe(false);
    expect(isHttpModeActive("bogus")).toBe(false);
    expect(runtimeModeOverride()).toBeNull();
  });

  it("selects http from the build mode", () => {
    expect(isHttpModeActive("http")).toBe(true);
  });

  it("lets the launcher runtime override promote a local build to http", () => {
    setRuntimeOverride({ mode: "http" });
    expect(runtimeModeOverride()).toBe("http");
    expect(isHttpModeActive(undefined)).toBe(true);
    expect(isHttpModeActive("bogus")).toBe(true);
  });

  it("ignores the override for build-mode consumers when it is not a string", () => {
    setRuntimeOverride({ mode: 42 });
    expect(runtimeModeOverride()).toBeNull();
    // Unknown runtime mode fails closed; it must not promote or silently
    // fall back to a local protected app.
    expect(isHttpModeActive(undefined)).toBe(false);
  });

  it("does not infer http from an unrelated runtime object", () => {
    setRuntimeOverride({ coaching: "same-origin" });
    expect(isHttpModeActive(undefined)).toBe(false);
  });

  it("makes createFitTraceClient throw centrally instead of falling back to local in production", () => {
    for (const buildMode of [undefined, "local", "bogus"]) {
      vi.stubEnv("MODE", "production");
      if (buildMode !== undefined) vi.stubEnv("VITE_FIT_TRACE_MODE", buildMode);
      expect(() => createFitTraceClient()).toThrow(RuntimeModeError);
      expect(() => createFitTraceClient()).toThrow(PRODUCTION_MODE_ERROR);
      vi.unstubAllEnvs();
    }
  });

  it("fails closed for an explicitly malformed mode and lets consumers throw centrally", () => {
    for (const mode of [null, undefined, 42]) {
      setRuntimeOverride({ mode });
      expect(isHttpModeActive("http")).toBe(false);
      expect(() => requireRuntimeMode()).toThrow(RuntimeModeError);
      expect(() => createFitTraceClient()).toThrow(RuntimeModeError);
    }
  });
});
