/**
 * Pure account-preference model for the mobile app.
 *
 * Preferences are stored in Supabase `user_metadata` under `skin` and
 * `language`. This module owns the environment-free rules: parsing untrusted
 * metadata, deciding what a signed-in device should apply from the account and
 * what it still needs to upload, merging a metadata patch without dropping
 * unrelated keys, and mapping account failures to redacted codes.
 *
 * It imports no React, AsyncStorage, expo or DOM values, so the root
 * `node:test` suite can load it through Node's TypeScript type stripping (see
 * `tests/mobilePreferencesModel.test.ts`).
 */

import { isLanguage, type AppLanguage } from "@pi-fit-trace/i18n";
import { isSkinName, type SkinName } from "@pi-fit-trace/ui-tokens";

/** The local values a guest sees and an account mirrors. */
export interface LocalPreferences {
  skin: SkinName;
  language: AppLanguage;
}

export type PartialPreferences = Partial<LocalPreferences>;

/**
 * One reconciliation decision, computed from a metadata snapshot and the
 * current local values.
 *
 * - `applyLocal` holds account values that differ from the device and must be
 *   applied without echoing a write.
 * - `uploadLocal` holds local values the account does not have yet. A first
 *   sign-in uploads both; a partially populated account only receives the
 *   missing fields, so an existing account preference is never overwritten.
 */
export interface PreferencesReconciliation {
  applyLocal?: PartialPreferences;
  uploadLocal?: PartialPreferences;
}

/** True for a plain JSON object; arrays and `null` are not metadata. */
export function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the preference fields out of untrusted `user_metadata`.
 *
 * Missing, blank, unknown or wrongly-typed values are treated as absent. The
 * caller decides whether absent fields should be filled from the device; this
 * function never throws.
 */
export function parseAccountPreferences(userMetadata: unknown): PartialPreferences {
  if (!isMetadataRecord(userMetadata)) return {};
  const skin = userMetadata.skin;
  const language = userMetadata.language;
  return {
    ...(isSkinName(skin) ? { skin } : {}),
    ...(isLanguage(language) ? { language } : {}),
  };
}

/**
 * Decide how a signed-in account and this device should converge.
 *
 * Account values win per field. A field the account does not have (first
 * sign-in, or invalid metadata) is uploaded from the device exactly once. When
 * both sides already agree the decision is empty, so a restore/re-render never
 * sends a redundant request.
 */
export function decidePreferences(
  userMetadata: unknown,
  local: LocalPreferences,
): PreferencesReconciliation {
  const account = parseAccountPreferences(userMetadata);
  const applyLocal: PartialPreferences = {};
  const uploadLocal: PartialPreferences = {};

  if (account.skin === undefined) {
    uploadLocal.skin = local.skin;
  } else if (account.skin !== local.skin) {
    applyLocal.skin = account.skin;
  }

  if (account.language === undefined) {
    uploadLocal.language = local.language;
  } else if (account.language !== local.language) {
    applyLocal.language = account.language;
  }

  return {
    ...(Object.keys(applyLocal).length > 0 ? { applyLocal } : {}),
    ...(Object.keys(uploadLocal).length > 0 ? { uploadLocal } : {}),
  };
}

/**
 * Merge a preference patch into existing metadata.
 *
 * Supabase's `PUT /auth/v1/user` `data` field replaces `user_metadata`, so the
 * whole object must be sent back. Unknown keys (display name, future account
 * fields) are preserved; invalid metadata starts from an empty object.
 */
export function mergePreferenceMetadata(
  currentMetadata: unknown,
  patch: PartialPreferences,
): Record<string, unknown> {
  const next: Record<string, unknown> = isMetadataRecord(currentMetadata)
    ? { ...currentMetadata }
    : {};
  if (patch.skin !== undefined) next.skin = patch.skin;
  if (patch.language !== undefined) next.language = patch.language;
  return next;
}

/**
 * Extract `user_metadata` from a verified `GET|PUT /auth/v1/user` response.
 *
 * - a missing/null metadata field means "no preferences yet" (`{}`);
 * - an object is copied so callers never mutate the response body;
 * - a malformed response or a non-object metadata container returns `null`,
 *   which the API layer reports as `invalid-response` instead of overwriting
 *   unknown account data with a fresh object.
 */
export function metadataFromUserResponse(raw: unknown): Record<string, unknown> | null {
  if (!isMetadataRecord(raw)) return null;
  const metadata = raw.user_metadata;
  if (metadata === undefined || metadata === null) return {};
  if (!isMetadataRecord(metadata)) return null;
  return { ...metadata };
}

/** Redacted preference-sync failure; never carries tokens or response bodies. */
export type PreferencesFailureCode =
  | "network"
  | "unauthorized"
  | "rate-limited"
  | "service-unavailable"
  | "invalid-response"
  | "unknown";

export class PreferencesError extends Error {
  readonly code: PreferencesFailureCode;
  readonly status: number | undefined;

  constructor(
    code: PreferencesFailureCode,
    options: { status?: number; message?: string } = {},
  ) {
    super(options.message ?? code);
    this.name = "PreferencesError";
    this.code = code;
    this.status = options.status;
  }
}

/**
 * Map an account-endpoint HTTP status to a failure code. A 401/403 means the
 * access token was rejected (the auth provider owns re-sign-in); transient
 * statuses must leave local preferences untouched and simply retry later.
 */
export function mapPreferencesErrorStatus(status: number): PreferencesFailureCode {
  if (status === 429) return "rate-limited";
  if (status >= 500) return "service-unavailable";
  if (status === 401 || status === 403) return "unauthorized";
  return "unknown";
}

/** Map any thrown value to a redacted PreferencesError (network ⇒ transient). */
export function toPreferencesError(cause: unknown): PreferencesError {
  if (cause instanceof PreferencesError) return cause;
  if (cause instanceof TypeError) return new PreferencesError("network");
  return new PreferencesError("unknown");
}
