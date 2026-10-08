import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { HttpFitTraceClient } from "./httpFitTraceClient.ts";
import { LocalFitTraceClient } from "./localFitTraceClient.ts";

/**
 * Pick the transport from `VITE_FIT_TRACE_MODE` so no screen knows about
 * clients. Anything but the explicit `http` mode stays local (the v1
 * default); an unknown value must not break the app.
 */
export function createFitTraceClient(): FitTraceClient {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env?.VITE_FIT_TRACE_MODE === "http"
    ? new HttpFitTraceClient()
    : new LocalFitTraceClient();
}
