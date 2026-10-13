/**
 * Runtime mode override for launcher-served builds.
 *
 * The launcher serves the already-built App shell with an injected
 * same-origin script (`/fit-trace-runtime.js`) that sets
 * `window.__FIT_TRACE_RUNTIME = { mode: "http" }` before the module bundle
 * runs. That lets a build whose baked `VITE_FIT_TRACE_MODE` default is local
 * act as an HTTP client under the launcher — without rebuilding, without
 * hardcoding the build default, and without the browser choosing the data
 * source (the launcher proxy target stays server-configured).
 *
 * Plain local/HTTP selection is unchanged: anything that is not the explicit
 * `http` value (build env or runtime override) stays local.
 */

export function runtimeModeOverride(): string | null {
  const holder = globalThis as unknown as {
    __FIT_TRACE_RUNTIME?: { mode?: unknown; coaching?: unknown };
  };
  const mode = holder.__FIT_TRACE_RUNTIME?.mode;
  return typeof mode === "string" ? mode : null;
}

/** Raw `coaching` runtime override (`"same-origin"` when the launcher wires local coaching). */
export function runtimeCoachingOverride(): string | null {
  const holder = globalThis as unknown as {
    __FIT_TRACE_RUNTIME?: { mode?: unknown; coaching?: unknown };
  };
  const coaching = holder.__FIT_TRACE_RUNTIME?.coaching;
  return typeof coaching === "string" ? coaching : null;
}

/** True only for the explicit `http` mode (runtime override wins). */
export function isHttpModeActive(buildMode?: string): boolean {
  if (runtimeModeOverride() === "http") return true;
  return buildMode === "http";
}

/**
 * True only when the launcher runtime explicitly enables same-origin
 * coaching (`window.__FIT_TRACE_RUNTIME.coaching === "same-origin"`).
 * Anything else — missing, misspelled, or a future cloud value — stays
 * disabled so the App never shows a fake cloud coach.
 */
export function isCoachingEnabled(): boolean {
  return runtimeCoachingOverride() === "same-origin";
}

/**
 * Raw `piAvailable` runtime signal from the launcher's presence probe, or
 * `null` when the launcher did not probe (plain local/HTTP mode). `false`
 * means the pi CLI is missing: coaching cannot run, but workout tracking
 * still works — the Coach UI shows a clear notice and disables asking.
 */
export function runtimePiAvailable(): boolean | null {
  const holder = globalThis as unknown as {
    __FIT_TRACE_RUNTIME?: { piAvailable?: unknown };
  };
  const value = holder.__FIT_TRACE_RUNTIME?.piAvailable;
  return typeof value === "boolean" ? value : null;
}
