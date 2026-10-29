import { ConflictError, ValidationError, sortRecords } from "@agent-fit-trace/core";
import type { HistoryFilter, ValidationIssue, WorkoutRecord } from "@agent-fit-trace/core";
import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import type {
  AuthPrincipal,
  CreateWorkoutResult,
} from "@agent-fit-trace/api-contracts";
import { assertValidHistoryFilter, filterRecordsPage } from "@agent-fit-trace/store";
import type { QueryResult } from "@agent-fit-trace/store";
import { createSupabaseWorkoutStore } from "../../../server/db/supabaseWorkouts.ts";
import type { FitTraceStore } from "./store.ts";

/**
 * Cloud (`FitTraceStore`) adapter over the Supabase-backed `FitTraceClient`.
 *
 * The remote MCP endpoint must serve the *same* tools and resources as the
 * local stdio server, so this module adapts the existing Supabase client
 * (`createSupabaseWorkoutStore`) to the minimal `FitTraceStore` surface
 * instead of forking tools/resources. The MCP layer is unchanged: it calls
 * `all()`, `import()`, and `query()` exactly as it does against the JSON and
 * SQLite backends.
 *
 * Identity and authorization:
 * - the verified principal and the caller's own access token are closed over
 *   at construction; neither is ever read from a request body or a session
 *   header, and there is no service-role key anywhere on this path — every
 *   PostgREST request carries `Authorization: Bearer <user token>`, so
 *   Postgres RLS (`auth.uid() = owner_id`) is the authority;
 * - one instance per request: nothing is cached in module scope, so
 *   concurrent requests cannot share identity.
 *
 * Error contract: the MCP tools report `FitTraceError` codes and never leak a
 * stack, so the client's `ApiError`s are translated at this boundary — CONFLICT
 * becomes the domain `ConflictError`, VALIDATION_ERROR becomes the domain
 * `ValidationError` (keeping `issues` when the server supplied a well-shaped
 * list), and every other code (CORRUPT_STORE, STORAGE_UNAVAILABLE, FORBIDDEN,
 * UNAUTHENTICATED) is rethrown unchanged so it still surfaces as a code.
 */
export interface CloudFitTraceStoreOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** The verified caller's access token (used for RLS, never logged). */
  accessToken: string;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Accept `details.issues` only when every entry is a real validation issue;
 * anything else (missing, partial, wrong types) degrades to no issues rather
 * than surfacing a half-shaped payload to the model.
 */
function toValidationIssues(details: unknown): ValidationIssue[] {
  const issues = asRecord(details)?.issues;
  if (!Array.isArray(issues)) return [];
  const parsed: ValidationIssue[] = [];
  for (const entry of issues) {
    const fields = asRecord(entry);
    if (fields === null) return [];
    const { code, message, path } = fields;
    if (typeof code !== "string" || typeof message !== "string") return [];
    if (path !== undefined && typeof path !== "string") return [];
    if (path === undefined) parsed.push({ code, message });
    else parsed.push({ code, message, path });
  }
  return parsed;
}

/** The conflicting id the client reported, falling back to the submitted record. */
function conflictId(details: unknown, fallbackId: string): string {
  const id = asRecord(details)?.id;
  return typeof id === "string" && id !== "" ? id : fallbackId;
}

/**
 * Translate the client's `ApiError` into the domain error contract and
 * rethrow anything else untouched. Returns `never`, so callers can use it
 * directly from a `catch` block.
 */
function throwDomainError(error: unknown, recordId: string): never {
  if (error instanceof ApiError) {
    if (error.code === API_ERROR_CODES.CONFLICT) {
      throw new ConflictError(conflictId(error.details, recordId));
    }
    if (error.code === API_ERROR_CODES.VALIDATION_ERROR) {
      throw new ValidationError(error.message, toValidationIssues(error.details));
    }
  }
  throw error;
}

/**
 * Build a `FitTraceStore` for one verified principal. The Supabase client is
 * created here and never exposed; callers only see the three store methods.
 */
export function createCloudFitTraceStore(
  principal: AuthPrincipal,
  options: CloudFitTraceStoreOptions,
): FitTraceStore {
  const client = createSupabaseWorkoutStore(principal, {
    supabaseUrl: options.supabaseUrl,
    publishableKey: options.publishableKey,
    accessToken: options.accessToken,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  /**
   * Complete history, not a page: the client keyset-paginates every page until
   * an empty page comes back, so a PostgREST `max_rows` truncation can never
   * silently drop old records. Re-paginating here would reintroduce exactly
   * the truncation bug that loop exists to prevent.
   */
  async function all(): Promise<WorkoutRecord[]> {
    return client.listWorkouts();
  }

  return {
    all,

    /**
     * Idempotent by record id (`import_workout` mirrors this): an identical
     * re-import is a no-op reported as `duplicate`, and the same id with
     * different content is a domain `ConflictError`. `total` is the resulting
     * count read back *after* the write, so it matches `all().length`.
     */
    async import(record: WorkoutRecord): Promise<{ duplicate: boolean; total: number }> {
      let created: CreateWorkoutResult;
      try {
        created = await client.createWorkout(record);
      } catch (error) {
        throwDomainError(error, record.id);
      }
      const total = (await client.listWorkouts()).length;
      return { duplicate: created.duplicate, total };
    },

    /**
     * Filtering and paging are shared with the JSON and SQLite backends
     * (`filterRecordsPage` over `sortRecords`), so limits, offsets, date
     * bounds, and exercise matching cannot drift per backend. The filter is
     * validated before any network read, so an invalid range reports
     * VALIDATION_ERROR instead of a storage error.
     */
    async query(filter: HistoryFilter = {}): Promise<QueryResult> {
      assertValidHistoryFilter(filter);
      return filterRecordsPage(sortRecords(await all()), filter);
    },
  };
}
