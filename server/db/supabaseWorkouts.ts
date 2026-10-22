import {
  analyzeProgress,
  generateNextPlan,
  sortRecords,
  stableStringify,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type {
  AnalysisFilter,
  PlanConstraints,
  PlanDraft,
  AnalysisResult,
  ValidationWarning,
  WorkoutRecord,
} from "@agent-fit-trace/core";
import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import type { CreateWorkoutResult, FitTraceClient } from "@agent-fit-trace/api-contracts";
import { ValidationError } from "@agent-fit-trace/core";
import { createSupabaseImportMethods } from "./supabaseImports.ts";

/**
 * Supabase-backed `FitTraceClient` scoped to one verified principal.
 *
 * Every PostgREST request carries the caller's own access token
 * (`Authorization: Bearer <user token>` + `apikey: <publishable key>`), so
 * Postgres RLS (`auth.uid() = owner_id`) is always enforced — the server
 * never uses the service-role key as user authorization. The owner id is
 * never taken from the request body: creates go through the
 * `create_workout` RPC, which derives `owner_id` from `auth.uid()`.
 *
 * Defence in depth (never RLS alone):
 * - reads go through the `list_workouts_page` RPC, which scopes by
 *   `auth.uid()` AND the table RLS policy; the server additionally validates
 *   that every returned row's `owner_id`/`id`/`date` matches the principal
 *   and the embedded payload;
 * - histories use keyset pagination over the database's own
 *   `(date ASC, id ASC)` order: each page passes the previous page's last
 *   `(date, id)` as a strictly-greater cursor (JSON RPC parameters, so
 *   arbitrary business ids round-trip byte-exact with no quoting or
 *   injection surface). Reads stop only on an empty page, so PostgREST
 *   `max_rows` truncation can never silently omit old data, and rows
 *   inserted before the cursor can never be returned twice;
 * - sorting reuses core's `sortRecords` so all stores share one order.
 *
 * Read-consistency boundary: a multi-page read is not a single MVCC
 * snapshot. A row inserted strictly before the cursor while paging appears
 * on the next reload instead — never twice in the same read.
 *
 * Both incoming records and rows read back from the database are validated
 * through core's `validateWorkoutRecord`; a stored row that no longer
 * validates surfaces as `CORRUPT_STORE` instead of being silently repaired.
 * Sorting, date filters, warnings, and draft-never-writes mirror the
 * in-memory store exactly. Raw PostgREST error bodies are never forwarded —
 * known shapes map to sanitized `ApiError` codes with generic messages.
 */

export interface SupabaseWorkoutStoreOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** The verified caller's access token (used for RLS, never logged). */
  accessToken: string;
  fetchImpl?: typeof fetch;
  /**
   * Rows requested per history page (default `SUPABASE_PAGE_SIZE`). Tests use
   * small values to force multi-page reads; the server may still truncate
   * shorter (PostgREST `max_rows`). Reads stop only on an empty page either
   * way. Must be a positive integer.
   */
  pageSize?: number;
}

/** Page size for deterministic history pagination (PostgREST max_rows guard). */
export const SUPABASE_PAGE_SIZE = 1000;

function toValidationApiError(error: unknown): never {
  if (error instanceof ValidationError) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: error.message,
      details: { issues: error.issues },
    });
  }
  throw error;
}

function storageUnavailable(message: string): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
    message,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validationError(field: string, reason: string): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.VALIDATION_ERROR,
    message: `Invalid plan constraints: \`${field}\` ${reason}.`,
  });
}

function parsePlanConstraints(input: unknown): PlanConstraints | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: "Plan constraints must be a JSON object.",
    });
  }
  if ("goal" in input && input.goal !== undefined && typeof input.goal !== "string") {
    throw validationError("goal", "must be a string");
  }
  if ("days_available" in input && input.days_available !== undefined) {
    const days = input.days_available;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 7) {
      throw validationError("days_available", "must be an integer from 1 to 7");
    }
  }
  for (const field of ["equipment", "constraints"] as const) {
    if (field in input && input[field] !== undefined) {
      const value = input[field];
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw validationError(field, "must be an array of strings");
      }
    }
  }
  return input as PlanConstraints;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function postgrestErrorCode(body: unknown): string {
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = (body as { code: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function bodyMentionsConflict(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "hint"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.includes("WORKOUT_CONFLICT")) return true;
  }
  return false;
}

export function createSupabaseWorkoutStore(
  principal: AuthPrincipal,
  options: SupabaseWorkoutStoreOptions,
): FitTraceClient {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const ownerId = principal.id;
  const pageSize = options.pageSize ?? SUPABASE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("SupabaseWorkoutStore requires a positive integer pageSize.");
  }

  function headers(): Record<string, string> {
    // The publishable key identifies the project; the user token authorizes.
    // Never log either value — errors below carry status codes only.
    return {
      apikey: options.publishableKey,
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  function authErrorFor(status: number): ApiError {
    return new ApiError({
      code: status === 401 ? API_ERROR_CODES.UNAUTHENTICATED : API_ERROR_CODES.FORBIDDEN,
      message: status === 401 ? "Invalid or expired bearer token." : "Access denied.",
      status,
    });
  }

  async function fetchPage(after: { date: string; id: string } | null): Promise<unknown[]> {
    let response: Response;
    try {
      // Parameterized cursor: ids travel as JSON arguments, never as URL
      // filter text, so arbitrary business strings cannot break or inject
      // into the query.
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/list_workouts_page`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          p_after_date: after?.date ?? null,
          p_after_id: after?.id ?? null,
          p_limit: pageSize,
        }),
      });
    } catch {
      throw storageUnavailable("Workout storage is unreachable.");
    }
    if (response.status === 401 || response.status === 403) throw authErrorFor(response.status);
    if (!response.ok) {
      throw storageUnavailable(`Workout storage responded with status ${response.status}.`);
    }
    let rows: unknown;
    try {
      rows = JSON.parse(await response.text()) as unknown;
    } catch {
      throw storageUnavailable("Workout storage returned an unreadable body.");
    }
    if (!Array.isArray(rows)) {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: "Workout storage returned a malformed payload.",
      });
    }
    return rows;
  }

  async function listStored(): Promise<WorkoutRecord[]> {
    const records: WorkoutRecord[] = [];
    // Keyset loop: each page continues strictly after the previous page's
    // last row in database (date, id) order. Only an empty page ends the
    // read — a short page just means the server truncated below p_limit.
    let after: { date: string; id: string } | null = null;
    for (;;) {
      const rows = await fetchPage(after);
      if (rows.length === 0) break;
      for (const row of rows) {
        const typed = row as { payload?: unknown; owner_id?: unknown; id?: unknown; date?: unknown };
        const rowObj = typed !== null && typeof typed === "object" ? typed : null;
        const payload = rowObj?.payload;
        try {
          const validated = validateWorkoutRecord(payload).record;
          // Defence in depth: the RPC's auth.uid() scope + RLS must agree
          // with the stored columns and the embedded payload.
          if (
            rowObj?.owner_id !== ownerId ||
            rowObj?.id !== validated.id ||
            rowObj?.date !== validated.date
          ) {
            throw new Error("owner mismatch");
          }
          records.push(validated);
          after = { date: validated.date, id: validated.id };
        } catch {
          throw new ApiError({
            code: API_ERROR_CODES.CORRUPT_STORE,
            message: `Stored workout at index ${records.length} failed validation.`,
            details: { index: records.length },
          });
        }
      }
    }
    return sortRecords(records);
  }

  const workoutMethods = {
    async listWorkouts(): Promise<WorkoutRecord[]> {
      return listStored();
    },

    async createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
      let normalized: WorkoutRecord;
      let warnings: ValidationWarning[];
      try {
        const validated = validateWorkoutRecord(record);
        normalized = validated.record;
        warnings = validated.warnings;
      } catch (error) {
        toValidationApiError(error);
      }
      // Caller-supplied owner ids are never trusted: the record shape has no
      // owner field and the RPC derives `owner_id` from `auth.uid()`. Any
      // extra `owner_id` key on the raw input is dropped by core validation
      // (unknown-field warning) and never sent.
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/rpc/create_workout`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            p_id: normalized!.id,
            p_payload: JSON.parse(stableStringify(normalized!)) as unknown,
            p_date: normalized!.date,
          }),
        });
      } catch {
        throw storageUnavailable("Workout storage is unreachable.");
      }
      if (response.status === 401 || response.status === 403) {
        throw authErrorFor(response.status);
      }
      const body = await readJson(response).catch(() => {
        throw storageUnavailable("Workout storage returned an unreadable body.");
      });
      if (!response.ok) {
        const code = postgrestErrorCode(body);
        if (response.status === 409 || code === "23505" || bodyMentionsConflict(body)) {
          // Distinguish identical-retry (duplicate) from real conflict by
          // comparing canonical payloads: fetch the stored row and compare.
          const stored = await listStored();
          const existing = stored.find((entry) => entry.id === normalized!.id);
          if (existing !== undefined && stableStringify(existing) === stableStringify(normalized!)) {
            return { record: existing, duplicate: true, warnings: warnings! };
          }
          throw new ApiError({
            code: API_ERROR_CODES.CONFLICT,
            message: `A workout with id "${normalized!.id}" already exists with different content.`,
            details: { id: normalized!.id },
          });
        }
        if (response.status === 400 || code === "22023") {
          // Sanitized: never forward raw PostgREST messages (may carry
          // payload fragments, URLs, or secrets).
          throw new ApiError({
            code: API_ERROR_CODES.VALIDATION_ERROR,
            message: "Invalid workout record.",
          });
        }
        throw storageUnavailable(`Workout storage responded with status ${response.status}.`);
      }
      // Strict RPC shape: `{ created: boolean, payload }` only. The payload
      // must validate through core AND canonically match the submitted
      // normalized record — no fallback accepting arbitrary success bodies.
      if (typeof body !== "object" || body === null) {
        throw new ApiError({
          code: API_ERROR_CODES.CORRUPT_STORE,
          message: "Stored workout failed validation.",
        });
      }
      const rpc = body as { created?: unknown; payload?: unknown };
      if (typeof rpc.created !== "boolean" || rpc.payload === undefined) {
        throw new ApiError({
          code: API_ERROR_CODES.CORRUPT_STORE,
          message: "Stored workout failed validation.",
        });
      }
      try {
        const stored = validateWorkoutRecord(rpc.payload).record;
        if (
          stored.id !== normalized!.id ||
          stored.date !== normalized!.date ||
          stableStringify(stored) !== stableStringify(normalized!)
        ) {
          throw new Error("rpc payload mismatch");
        }
        return { record: stored, duplicate: !rpc.created, warnings: warnings! };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError({
          code: API_ERROR_CODES.CORRUPT_STORE,
          message: "Stored workout failed validation.",
        });
      }
    },

    async analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
      try {
        return analyzeProgress(await listStored(), filter);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof ValidationError) toValidationApiError(error);
        throw error;
      }
    },

    async createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
      let constraints: PlanConstraints | undefined;
      try {
        constraints = parsePlanConstraints(input);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw error;
      }
      try {
        // Drafts never write: they read the principal's rows and run core only.
        return generateNextPlan(await listStored(), constraints);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof ValidationError) toValidationApiError(error);
        throw error;
      }
    },
  };

  // Import resources live in their own module but share the caller's RLS
  // scope and token; composing here keeps `FitTraceClient` one surface.
  return { ...workoutMethods, ...createSupabaseImportMethods(principal, options) };
}
