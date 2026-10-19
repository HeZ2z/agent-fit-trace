import Constants from "expo-constants";

import { resolveCoachConfig, type CoachConfig } from "./coachModel";

/**
 * Resolve the hosted cloud-coach API base for this build.
 *
 * Expo inlines `EXPO_PUBLIC_*` values at build time, which is the primary
 * source (`mobile/.env.local` in development, EAS environment variables for
 * shipped builds). `expo-constants` `extra` is a fallback for `app.config.*`
 * without adding an `app.json` field. A blank or malformed value is not an
 * error: {@link resolveCoachConfig} returns `configured: false` and the Coach
 * screen can render a setup hint while the rest of the local app works.
 *
 * Only the public API origin belongs here — never a token or secret. Mobile
 * coaching always targets the hosted cloud backend; it never starts a local
 * CLI agent.
 */
export const COACH_API_URL_ENV = "EXPO_PUBLIC_FIT_TRACE_API_URL";

function extraString(
  extra: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = extra?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Ignore blank entries so a lower-priority source can still apply. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** Raw configured value, without validation (exported for diagnostics/tests). */
export function readCoachApiUrlValue(): string | undefined {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | null | undefined;
  return firstNonEmpty(
    process.env.EXPO_PUBLIC_FIT_TRACE_API_URL,
    extraString(extra, "EXPO_PUBLIC_FIT_TRACE_API_URL"),
    extraString(extra, "fitTraceApiUrl"),
  );
}

export function readCoachConfig(): CoachConfig {
  return resolveCoachConfig(readCoachApiUrlValue());
}
