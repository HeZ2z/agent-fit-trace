import type { SupabaseAuthConfig } from "../auth/authModel";
import {
  metadataFromUserResponse,
  mapPreferencesErrorStatus,
  PreferencesError,
} from "./preferencesModel";

/**
 * Minimal Supabase Auth metadata client for account-scoped preferences.
 *
 * Reuses the mobile auth configuration and access-token flow (the caller reads
 * `readSupabaseAuthConfig()` once and `getAccessToken()` from the auth
 * provider). Only two requests are made, both against the verified user
 * endpoint:
 *
 * - `GET /auth/v1/user` → the current `user_metadata`;
 * - `PUT /auth/v1/user` with `{ data: { ...metadata, skin, language } }` → the
 *   updated user.
 *
 * Tokens travel only in `Authorization: Bearer` headers. Nothing here logs,
 * stores or returns a token, and every failure is redacted to a
 * `PreferencesError` so the provider can fail soft.
 */

export type PreferencesFetch = typeof fetch;

function requestHeaders(
  config: SupabaseAuthConfig,
  accessToken: string,
): Record<string, string> {
  return {
    apikey: config.publishableKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function send(
  fetchImpl: PreferencesFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    // A rejected fetch is a transient network failure, never a local-pref error.
    throw new PreferencesError("network");
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function ensureOk(response: Response): void {
  if (response.ok) return;
  throw new PreferencesError(mapPreferencesErrorStatus(response.status), {
    status: response.status,
  });
}

/**
 * Read the signed-in user's `user_metadata`.
 *
 * A missing/null `user_metadata` is a valid empty account (`{}`). A response
 * that is not a user object — or metadata that is not an object — raises
 * `invalid-response`: writing a fresh object over unknown data would be
 * destructive, so the provider surfaces a non-blocking error instead.
 */
export async function readAccountMetadata(
  config: SupabaseAuthConfig,
  accessToken: string,
  fetchImpl: PreferencesFetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await send(fetchImpl, `${config.supabaseUrl}/auth/v1/user`, {
    headers: requestHeaders(config, accessToken),
  });
  ensureOk(response);
  const metadata = metadataFromUserResponse(await readJson(response));
  if (metadata === null) {
    throw new PreferencesError("invalid-response", { status: response.status });
  }
  return metadata;
}

/**
 * Replace the account's `user_metadata` with `metadata`.
 *
 * Callers merge the preference fields first (see `mergePreferenceMetadata`) so
 * unrelated account metadata survives. A successful response without a
 * parseable body falls back to the metadata that was sent; the write itself
 * already succeeded.
 */
export async function writeAccountMetadata(
  config: SupabaseAuthConfig,
  accessToken: string,
  metadata: Record<string, unknown>,
  fetchImpl: PreferencesFetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await send(fetchImpl, `${config.supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: requestHeaders(config, accessToken),
    body: JSON.stringify({ data: metadata }),
  });
  ensureOk(response);
  return metadataFromUserResponse(await readJson(response)) ?? metadata;
}
