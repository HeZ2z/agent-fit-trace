import { afterEach, describe, expect, it, vi } from "vitest";
import { createFitTraceClient } from "./createFitTraceClient.ts";
import { HttpFitTraceClient } from "./httpFitTraceClient.ts";
import { LocalFitTraceClient } from "./localFitTraceClient.ts";

describe("createFitTraceClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects the HTTP client when VITE_FIT_TRACE_MODE=http", () => {
    vi.stubEnv("VITE_FIT_TRACE_MODE", "http");
    expect(createFitTraceClient()).toBeInstanceOf(HttpFitTraceClient);
  });

  it("stays local when the mode is unset", () => {
    expect(createFitTraceClient()).toBeInstanceOf(LocalFitTraceClient);
  });

  it("falls back to local for an unknown value without breaking", () => {
    vi.stubEnv("VITE_FIT_TRACE_MODE", "bogus");
    expect(createFitTraceClient()).toBeInstanceOf(LocalFitTraceClient);
  });
});
