/**
 * Central runtime-mode validation.
 *
 * The App can run in two data modes, but a production deployment is allowed
 * to run in **http only**. The mode is resolved from the build-time
 * `VITE_FIT_TRACE_MODE` and a launcher-injected
 * `window.__FIT_TRACE_RUNTIME = { mode: "http" }` (written by a same-origin
 * script before the module bundle runs). Local mode stays available in
 * development so tests and `pnpm dev` can use browser storage *after* the
 * normal Supabase login gate; it is never a production fallback.
 *
 * Everything that decides whether protected providers may mount goes through
 * {@link evaluateRuntimeMode}; consumers must not re-interpret
 * `mode !== "http"` on their own.
 */

export type RuntimeMode = "http" | "local";
export type RuntimeModeSource = "runtime" | "build" | "default";

export interface RuntimeModeEvaluation {
  /** Resolved mode, or null when the configuration is invalid. */
  mode: RuntimeMode | null;
  source: RuntimeModeSource;
  /** User-facing configuration error; null only when the mode is valid. */
  error: string | null;
}

export interface RuntimeModeInput {
  buildMode: string | undefined;
  /** Raw runtime override value. */
  runtimeOverride: unknown;
  /**
   * True when the runtime object explicitly owns a `mode` property, even if
   * its value is null/undefined/non-string. The explicit-property distinction
   * is what makes malformed launcher injection fail closed; when omitted,
   * null/undefined retain the legacy "absent" meaning for direct callers.
   */
  runtimeModePresent?: boolean;
  isProduction: boolean;
}

export const PRODUCTION_MODE_ERROR =
  "This deployment is misconfigured: authenticated HTTP mode is required in production. Sign-in and workout data are unavailable until the server is fixed.";

/** Thrown by consumers that must have a valid resolved mode before mounting. */
export class RuntimeModeError extends Error {
  code = "RUNTIME_MODE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeModeError";
  }
}

function invalidRuntimeOverride(value: unknown): RuntimeModeEvaluation {
  const shown = typeof value === "string" ? `"${value}"` : String(value);
  return {
    mode: null,
    source: "runtime",
    error: `This deployment is misconfigured: unknown runtime mode ${shown}.`,
  };
}

/**
 * Pure resolution used by the App and by tests.
 *
 * Priority: an explicit runtime override wins over the build value. Unknown
 * runtime overrides always fail closed. In production, anything other than an
 * effective `http` (missing build value, `local`, or a typo) also fails
 * closed; in development an unknown build value keeps the legacy local
 * fallback, but normal local mode still goes through the auth gate.
 */
export function evaluateRuntimeMode(input: RuntimeModeInput): RuntimeModeEvaluation {
  const override = input.runtimeOverride;
  const overridePresent = input.runtimeModePresent ?? (override !== null && override !== undefined);
  if (overridePresent) {
    if (override === "http") return { mode: "http", source: "runtime", error: null };
    if (override === "local") {
      if (input.isProduction) {
        return { mode: null, source: "runtime", error: PRODUCTION_MODE_ERROR };
      }
      return { mode: "local", source: "runtime", error: null };
    }
    return invalidRuntimeOverride(override);
  }

  const buildMode = input.buildMode;
  if (buildMode === "http") return { mode: "http", source: "build", error: null };
  if (buildMode === "local" || buildMode === undefined || buildMode === "") {
    if (input.isProduction) {
      return { mode: null, source: buildMode === "local" ? "build" : "default", error: PRODUCTION_MODE_ERROR };
    }
    return { mode: "local", source: buildMode === "local" ? "build" : "default", error: null };
  }

  // Unknown build value: failed closed in production, legacy local fallback
  // in development (it never skips the login gate).
  if (input.isProduction) return { mode: null, source: "build", error: PRODUCTION_MODE_ERROR };
  return { mode: "local", source: "build", error: null };
}

interface RuntimeHolder {
  __FIT_TRACE_RUNTIME?: { mode?: unknown; coaching?: unknown; piAvailable?: unknown };
}

function runtimeHolder(): RuntimeHolder {
  return globalThis as unknown as RuntimeHolder;
}

/** True when the runtime object explicitly carries a `mode` property. */
function hasRuntimeMode(): boolean {
  const holder = runtimeHolder().__FIT_TRACE_RUNTIME;
  return (
    typeof holder === "object" &&
    holder !== null &&
    Object.prototype.hasOwnProperty.call(holder, "mode")
  );
}

/** Raw `mode` runtime override, or `null` when no string mode was injected. */
export function runtimeModeOverride(): string | null {
  const mode = runtimeHolder().__FIT_TRACE_RUNTIME?.mode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Raw runtime mode: `undefined` when the script did not set `mode` at all,
 * otherwise the unvalidated value (including non-strings).
 */
function rawRuntimeMode(): unknown {
  if (!hasRuntimeMode()) return null;
  return runtimeHolder().__FIT_TRACE_RUNTIME?.mode;
}

/** Raw `coaching` runtime override (`"same-origin"` when the launcher wires local coaching). */
export function runtimeCoachingOverride(): string | null {
  const coaching = runtimeHolder().__FIT_TRACE_RUNTIME?.coaching;
  return typeof coaching === "string" ? coaching : null;
}

function isProductionEnv(env: Record<string, unknown> | undefined): boolean {
  return env?.PROD === true || env?.MODE === "production";
}

/** Resolve the mode from the current build + injected runtime. */
export function currentRuntimeMode(): RuntimeModeEvaluation {
  const env = import.meta.env as Record<string, unknown> | undefined;
  return evaluateRuntimeMode({
    buildMode: typeof env?.VITE_FIT_TRACE_MODE === "string" ? env.VITE_FIT_TRACE_MODE : undefined,
    runtimeOverride: rawRuntimeMode(),
    runtimeModePresent: hasRuntimeMode(),
    isProduction: isProductionEnv(env),
  });
}

/** Resolve the current mode or throw a central configuration error. */
export function requireRuntimeMode(): RuntimeModeEvaluation & { mode: RuntimeMode } {
  const resolved = currentRuntimeMode();
  if (resolved.mode === null) {
    throw new RuntimeModeError(resolved.error ?? PRODUCTION_MODE_ERROR);
  }
  return resolved as RuntimeModeEvaluation & { mode: RuntimeMode };
}

/** True only for a valid effective `http` mode (runtime override wins). */
export function isHttpModeActive(buildMode?: string): boolean {
  if (buildMode !== undefined) {
    const env = import.meta.env as Record<string, unknown> | undefined;
    return (
      evaluateRuntimeMode({
        buildMode,
        runtimeOverride: rawRuntimeMode(),
        runtimeModePresent: hasRuntimeMode(),
        isProduction: isProductionEnv(env),
      }).mode === "http"
    );
  }
  return currentRuntimeMode().mode === "http";
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
  const value = runtimeHolder().__FIT_TRACE_RUNTIME?.piAvailable;
  return typeof value === "boolean" ? value : null;
}
