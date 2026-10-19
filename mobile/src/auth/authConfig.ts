import Constants from "expo-constants";

import { resolveAuthConfig, type SupabaseAuthConfig } from "./authModel";

/**
 * Read the public Supabase configuration for the mobile client.
 *
 * Expo inlines `EXPO_PUBLIC_*` variables into the bundle at build time, which
 * is the primary source (`mobile/.env.local` during development / EAS
 * environment variables for builds). `expo-constants` `extra` is supported as a
 * fallback for local config files and EAS `app.config.*` without introducing
 * any app.json field. Only the publishable (anon) key is accepted — a Supabase
 * service-role key must never be configured here.
 *
 * A missing/invalid value is not an error: `resolveAuthConfig` returns `null`
 * and the provider reports the `unconfigured` state while local-only use
 * continues to work.
 */
function extraString(
  extra: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = extra?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Ignore blank env/extra entries so a lower-priority source can still apply. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

export function readSupabaseAuthConfig(): SupabaseAuthConfig | null {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | null | undefined;
  const supabaseUrl = firstNonEmpty(
    process.env.EXPO_PUBLIC_SUPABASE_URL,
    extraString(extra, "EXPO_PUBLIC_SUPABASE_URL"),
    extraString(extra, "supabaseUrl"),
  );
  const supabaseAnonKey = firstNonEmpty(
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    extraString(extra, "EXPO_PUBLIC_SUPABASE_ANON_KEY"),
    extraString(extra, "supabaseAnonKey"),
  );

  return resolveAuthConfig({ supabaseUrl, supabaseAnonKey });
}
