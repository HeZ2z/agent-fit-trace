import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import { HttpFitTraceClient } from "./httpFitTraceClient.ts";
import { LocalFitTraceClient } from "./localFitTraceClient.ts";
import { requireRuntimeMode } from "./runtimeMode.ts";

/**
 * Pick the transport from the central runtime resolver so no screen knows about
 * clients. In development an unset/unknown mode still resolves to local; in
 * production any non-`http` mode (including malformed launcher injection)
 * throws the shared configuration error instead of quietly falling back to
 * local storage.
 *
 * A launcher-served build may carry a same-origin runtime override
 * (`window.__FIT_TRACE_RUNTIME.mode === "http"`, see `runtimeMode.ts`).
 */
export function createFitTraceClient(ownerId?: string): FitTraceClient {
  const runtime = requireRuntimeMode();
  return runtime.mode === "http"
    ? new HttpFitTraceClient()
    : new LocalFitTraceClient(undefined, ownerId);
}
