import { stableStringify } from "@pi-fit-trace/core";
import {
  applyImportedArtifactKeyset,
  buildImportedArtifact,
  encodeArtifactCursor,
  isImportedArtifactKind,
  normalizeListImportedArtifactsQuery,
  parseArtifactSelection,
  parseImportArtifactInput,
  parseImportedArtifact,
  parseImportedArtifactId,
  parseImportedArtifactMeta,
  parsePlanAdoption,
  parsePlanAdoptionRequest,
} from "@pi-fit-trace/api-contracts";
import type {
  ArtifactSelection,
  AuthPrincipal,
  FitTraceImportClient,
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactKind,
  ImportedArtifactMeta,
  ImportedArtifactPage,
  ListImportedArtifactsQuery,
  PlanAdoption,
  PlanAdoptionInput,
  SaveImportedArtifactResult,
} from "@pi-fit-trace/api-contracts";
import { API_ERROR_CODES, ApiError } from "@pi-fit-trace/api-contracts";

/**
 * Supabase-backed import resources for one verified principal.
 *
 * Every request carries the caller's own access token, so RLS
 * (`auth.uid() = owner_id`) is the authority; the server never uses a
 * service-role key and never accepts an owner from the body. Snapshot saves
 * are immutable and content-addressed in TypeScript before the RPC call; the
 * RPC derives `owner_id` from `auth.uid()` and compares canonical jsonb on a
 * duplicate. List reads request metadata only, so a page never downloads
 * every payload. Stored rows are re-parsed on read and a mismatch surfaces as
 * `CORRUPT_STORE` instead of a silent empty history.
 */

export interface SupabaseImportStoreOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** The verified caller's access token (used for RLS, never logged). */
  accessToken: string;
  fetchImpl?: typeof fetch;
}

function storageUnavailable(message: string): ApiError {
  return new ApiError({ code: API_ERROR_CODES.STORAGE_UNAVAILABLE, message });
}

function authErrorFor(status: number): ApiError {
  return new ApiError({
    code: status === 401 ? API_ERROR_CODES.UNAUTHENTICATED : API_ERROR_CODES.FORBIDDEN,
    message: status === 401 ? "Invalid or expired bearer token." : "Access denied.",
    status,
  });
}

function notFound(message: string, details?: unknown): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.NOT_FOUND,
    message,
    status: 404,
    ...(details === undefined ? {} : { details }),
  });
}

function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.VALIDATION_ERROR,
    message,
    status: 400,
    ...(details === undefined ? {} : { details }),
  });
}

function corrupt(message: string, details?: unknown): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.CORRUPT_STORE,
    message,
    details,
  });
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

function bodyMentions(body: unknown, token: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "hint"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.includes(token)) return true;
  }
  return false;
}

export function createSupabaseImportMethods(
  principal: AuthPrincipal,
  options: SupabaseImportStoreOptions,
): FitTraceImportClient {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const ownerId = principal.id;

  function headers(): Record<string, string> {
    // The publishable key identifies the project; the user token authorizes.
    // Never log either value — error messages below carry status codes only.
    return {
      apikey: options.publishableKey,
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async function rpc(name: string, body: unknown): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
    } catch {
      throw storageUnavailable("Import storage is unreachable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw authErrorFor(response.status);
    }
    const parsed = await readJson(response).catch(() => {
      throw storageUnavailable("Import storage returned an unreadable body.");
    });
    return { status: response.status, body: parsed };
  }

  function mapRpcFailure(status: number, body: unknown, operation: string): never {
    const code = postgrestErrorCode(body);
    if (bodyMentions(body, "IMPORT_ARTIFACT_NOT_FOUND") || code === "P0002") {
      throw notFound("No imported artifact with that id.", { id: "unknown" });
    }
    if (bodyMentions(body, "IMPORT_CONFLICT") || status === 409 || code === "23505") {
      throw new ApiError({
        code: API_ERROR_CODES.CONFLICT,
        message: "An imported artifact with this id already exists with different content.",
      });
    }
    if (status === 400 || status === 422 || code === "22023" || code === "23514") {
      throw badRequest(`Invalid imported artifact ${operation}.`);
    }
    throw storageUnavailable(`Import storage responded with status ${status}.`);
  }

  async function listMetaPage(
    kind: ImportedArtifactKind | undefined,
    after: { created_at: string; id: string } | null,
    limit: number,
  ): Promise<ImportedArtifactMeta[]> {
    const { status, body } = await rpc("list_imported_artifacts_page", {
      p_kind: kind ?? null,
      p_after_created_at: after?.created_at ?? null,
      p_after_id: after?.id ?? null,
      p_limit: limit,
    });
    if (status < 200 || status >= 300) {
      mapRpcFailure(status, body, "list");
    }
    if (!Array.isArray(body)) throw corrupt("Import list returned a malformed payload.");
    return body.map((row, index) => {
      if (
        typeof row !== "object" ||
        row === null ||
        (row as { owner_id?: unknown }).owner_id !== ownerId
      ) {
        throw corrupt(`Stored import metadata at index ${index} failed ownership validation.`, {
          index,
        });
      }
      try {
        return parseImportedArtifactMeta(row);
      } catch {
        throw corrupt(`Stored import metadata at index ${index} failed validation.`, { index });
      }
    });
  }

  return {
    async saveImportedArtifact<K extends ImportedArtifactKind>(
      input: ImportArtifactInput<K>,
    ): Promise<SaveImportedArtifactResult<K>> {
      const { input: normalizedInput, warnings } = parseImportArtifactInput(input);
      const artifact = await buildImportedArtifact(normalizedInput as ImportArtifactInput<K>, {
        // The DB assigns the real created_at; this value is never sent.
        created_at: new Date(0).toISOString(),
      });
      const { status, body } = await rpc("save_imported_artifact", {
        p_kind: artifact.kind,
        p_id: artifact.id,
        p_payload_schema_version: artifact.payload_schema_version,
        p_payload: artifact.payload,
        p_source_filename: artifact.source_filename,
        p_source_record_ids: artifact.source_record_ids,
        p_content_digest: artifact.content_digest,
      });
      if (status < 200 || status >= 300) {
          mapRpcFailure(status, body, "save");
      }
      if (typeof body !== "object" || body === null) {
        throw corrupt("Import storage returned a malformed save result.");
      }
      const record = body as { created?: unknown; artifact?: unknown };
      if (
        typeof record.created !== "boolean" ||
        typeof record.artifact !== "object" ||
        record.artifact === null
      ) {
        throw corrupt("Import storage returned a malformed save result.");
      }
      if ((record.artifact as { owner_id?: unknown }).owner_id !== ownerId) {
        throw corrupt("Stored imported artifact failed ownership validation.");
      }
      let stored: ImportedArtifact;
      try {
        stored = await parseImportedArtifact(record.artifact);
      } catch {
        throw corrupt("Stored imported artifact failed validation.");
      }
      if (
        stored.id !== artifact.id ||
        stored.kind !== artifact.kind ||
        stored.content_digest !== artifact.content_digest ||
        stableStringify(stored.payload) !== stableStringify(artifact.payload) ||
        stableStringify(stored.source_record_ids) !== stableStringify(artifact.source_record_ids)
      ) {
        throw corrupt(
          "Stored imported artifact does not match the submitted canonical payload and identity.",
        );
      }
      return {
        artifact: stored as ImportedArtifact<K>,
        duplicate: !record.created,
        warnings,
      };
    },

    async listImportedArtifacts(
      query: ListImportedArtifactsQuery = {},
    ): Promise<ImportedArtifactPage> {
      const normalized = normalizeListImportedArtifactsQuery(query);
      const target = normalized.limit + 1;
      const rows: ImportedArtifactMeta[] = [];
      let after = normalized.cursor === null
        ? null
        : { created_at: normalized.cursor.created_at, id: normalized.cursor.id };
      const seen = new Set<string>();
      for (;;) {
        const remaining = Math.max(target - rows.length, 1);
        const page = await listMetaPage(
          normalized.kind,
          after,
          Math.min(remaining, normalized.limit),
        );
        if (page.length === 0) break;
        for (const row of page) {
          const key = `${row.created_at}\u0000${row.id}`;
          if (seen.has(key)) {
            // A short page is normal (PostgREST max_rows); a page that repeats
            // an already-seen row would make keyset pagination spin forever.
            throw corrupt("Import list pagination repeated a row.");
          }
          seen.add(key);
        }
        rows.push(...page);
        const last = page[page.length - 1];
        if (last === undefined) break;
        // A short page is not necessarily the end of history (PostgREST may
        // cap rows below the requested limit), so keep asking after the last
        // row until an empty page or the look-ahead target is reached.
        if (
          after !== null &&
          last.created_at === after.created_at &&
          last.id === after.id
        ) {
          throw corrupt("Import list pagination did not advance.");
        }
        after = { created_at: last.created_at, id: last.id };
        if (rows.length >= target) break;
      }
      // Re-apply the shared keyset in case the RPC returned an unexpected
      // order; this also trims the look-ahead row deterministically.
      const items = applyImportedArtifactKeyset(rows, {
        ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
        limit: normalized.limit,
        cursor: normalized.cursor,
      });
      const hasMore = rows.length > normalized.limit;
      const last = items[items.length - 1];
      return {
        items,
        next_cursor:
          hasMore && last !== undefined
            ? encodeArtifactCursor({
                kind: last.kind,
                created_at: last.created_at,
                id: last.id,
              })
            : null,
      };
    },

    async getImportedArtifact(id: string): Promise<ImportedArtifact> {
      const artifactId = parseImportedArtifactId(id);
      const { status, body } = await rpc("get_imported_artifact", { p_id: artifactId });
      if (status < 200 || status >= 300) {
          mapRpcFailure(status, body, "read");
      }
      if (!Array.isArray(body)) throw corrupt("Import storage returned a malformed artifact.");
      if (body.length === 0) {
        throw notFound(`No imported artifact with id "${artifactId}".`, { id: artifactId });
      }
      if (body.length > 1) throw corrupt("Import storage returned multiple artifacts for one id.");
      const row = body[0];
      if (
        typeof row !== "object" ||
        row === null ||
        (row as { owner_id?: unknown }).owner_id !== ownerId
      ) {
        throw corrupt(`Stored imported artifact "${artifactId}" failed ownership validation.`, {
          id: artifactId,
        });
      }
      try {
        const artifact = await parseImportedArtifact(row);
        if (artifact.id !== artifactId) throw new Error("id mismatch");
        return artifact;
      } catch {
        throw corrupt(`Stored imported artifact "${artifactId}" failed validation.`, {
          id: artifactId,
        });
      }
    },

    async getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
      if (!isImportedArtifactKind(kind)) throw badRequest("Invalid artifact kind.");
      const { status, body } = await rpc("get_artifact_selection", { p_kind: kind });
      if (status < 200 || status >= 300) {
          mapRpcFailure(status, body, "selection");
      }
      try {
        return parseArtifactSelection(body);
      } catch {
        throw corrupt("Stored artifact selection failed validation.");
      }
    },

    async setArtifactSelection(
      kind: ImportedArtifactKind,
      artifactId: string | null,
    ): Promise<ArtifactSelection> {
      if (!isImportedArtifactKind(kind)) throw badRequest("Invalid artifact kind.");
      const targetId = artifactId === null ? null : parseImportedArtifactId(artifactId);
      const { status, body } = await rpc("set_artifact_selection", {
        p_kind: kind,
        p_artifact_id: targetId,
      });
      if (status < 200 || status >= 300) {
          mapRpcFailure(status, body, "selection");
      }
      try {
        return parseArtifactSelection(body);
      } catch {
        throw corrupt("Import storage returned a malformed selection.");
      }
    },

    async getPlanAdoption(): Promise<PlanAdoption | null> {
      const { status, body } = await rpc("get_plan_adoption", {});
      if (status < 200 || status >= 300) {
          mapRpcFailure(status, body, "adoption");
      }
      try {
        return parsePlanAdoption(body);
      } catch {
        throw corrupt("Stored plan adoption failed validation.");
      }
    },

    async setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null> {
      const request = parsePlanAdoptionRequest(input);
      const { status, body } = await rpc("set_plan_adoption", {
        p_artifact_id: request === null ? null : request.artifact_id,
        p_confirmed_digest: request === null ? null : request.confirmed_digest,
      });
      if (status < 200 || status >= 300) {
          mapRpcFailure(status, body, "adoption");
      }
      try {
        return parsePlanAdoption(body);
      } catch {
        throw corrupt("Import storage returned a malformed adoption.");
      }
    },
  };
}
