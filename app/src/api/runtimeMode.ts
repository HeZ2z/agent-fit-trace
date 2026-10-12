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
    __FIT_TRACE_RUNTIME?: { mode?: unknown };
  };
  const mode = holder.__FIT_TRACE_RUNTIME?.mode;
  return typeof mode === "string" ? mode : null;
}

/** True only for the explicit `http` mode (runtime override wins). */
export function isHttpModeActive(buildMode?: string): boolean {
  if (runtimeModeOverride() === "http") return true;
  return buildMode === "http";
}
