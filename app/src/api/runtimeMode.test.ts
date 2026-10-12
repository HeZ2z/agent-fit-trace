import { afterEach, describe, expect, it } from "vitest";
import { isHttpModeActive, runtimeModeOverride } from "./runtimeMode.ts";

function setRuntimeOverride(value: unknown): void {
  (globalThis as unknown as Record<string, unknown>).__FIT_TRACE_RUNTIME = value;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__FIT_TRACE_RUNTIME;
});

describe("runtimeMode", () => {
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

  it("ignores a non-http override without breaking", () => {
    setRuntimeOverride({ mode: "local" });
    expect(isHttpModeActive(undefined)).toBe(false);
    setRuntimeOverride({ mode: 42 });
    expect(isHttpModeActive("http")).toBe(true);
  });
});
