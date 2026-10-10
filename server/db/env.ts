/**
 * Server-only Supabase environment resolution.
 *
 * Production fails closed: when the project URL or publishable key is absent
 * (or the key looks like a secret) the API returns 500 `API_ERROR` and never
 * falls back to an in-memory store or anonymous access. The service-role key
 * is never read here — user PostgREST requests authenticate with the caller's
 * own access token so RLS always applies.
 */

export interface SupabaseServerEnv {
  supabaseUrl: string;
  publishableKey: string;
}

/** True when a configured key must never be published to the browser. */
export function isRejectedSupabaseKey(key: string): boolean {
  if (key === "") return true;
  // Supabase secret keys (new `sb_secret_…` format) are server-only.
  if (key.startsWith("sb_secret_")) return true;
  // Legacy JWT publishable keys vs service-role keys: decode the payload and
  // reject `role: service_role` so an env mistake cannot leak it.
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payloadJson = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const payload = JSON.parse(payloadJson) as { role?: unknown };
      if (payload.role === "service_role") return true;
    } catch {
      // Unparseable JWT-shaped strings are left to the Auth call to reject;
      // only the definite service_role case is rejected here.
    }
  }
  return false;
}

/** Supabase project URLs must be absolute http(s) URLs. */
export function isSafeSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function readSupabaseServerEnv(
  env: Record<string, string | undefined> = process.env,
): SupabaseServerEnv | null {
  const supabaseUrl = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (supabaseUrl === undefined || supabaseUrl === "") return null;
  if (publishableKey === undefined || publishableKey === "") return null;
  if (!isSafeSupabaseUrl(supabaseUrl)) return null;
  if (isRejectedSupabaseKey(publishableKey)) return null;
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), publishableKey };
}
