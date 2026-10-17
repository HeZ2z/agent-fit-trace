import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  ValidationError,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  ValidationWarning,
  WorkoutRecord,
} from "@pi-fit-trace/core";
import {
  API_ERROR_CODES,
  ApiError,
  HTTP_STATUS,
  buildImportedArtifact,
  deriveWorkoutId,
  encodeArtifactCursor,
  isImportedArtifactKind,
  normalizeListImportedArtifactsQuery,
  parseImportArtifactInput,
} from "@pi-fit-trace/api-contracts";
import type {
  ArtifactSelection,
  CreateWorkoutResult,
  FitTraceClient,
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactKind,
  ImportedArtifactPage,
  ListImportedArtifactsQuery,
  PlanAdoption,
  PlanAdoptionInput,
  SaveImportedArtifactResult,
} from "@pi-fit-trace/api-contracts";
import { LocalStorageAdapter, StorageUnavailableError } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import {
  ImportStorageCorruptionError,
  clearPlanAdoptionRecord,
  loadArtifactSelection,
  loadImportedArtifact,
  loadImportedArtifacts,
  loadPlanAdoptionRecord,
  metadataFor,
  pageArtifacts,
  saveArtifactSelection,
  saveImportedArtifactRecord,
  savePlanAdoptionRecord,
} from "../storage/importRepository.ts";
import {
  StorageCorruptionError,
  loadRecord,
  loadRecords,
  saveRecord,
} from "../storage/workoutRepository.ts";

/**
 * Maps a thrown storage/core error onto the API error contract. Unknown
 * errors pass through untouched so nothing is silently re-labelled.
 */
function toApiError(error: unknown): unknown {
  if (error instanceof ValidationError) {
    return new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: error.message,
      details: { issues: error.issues },
    });
  }
  if (error instanceof StorageUnavailableError) {
    return new ApiError({ code: API_ERROR_CODES.STORAGE_UNAVAILABLE, message: error.message });
  }
  if (error instanceof StorageCorruptionError || error instanceof ImportStorageCorruptionError) {
    return new ApiError({ code: API_ERROR_CODES.CORRUPT_STORE, message: error.message });
  }
  // Custom adapters may throw the platform DOMException directly instead of
  // wrapping it. Treat the storage-blocked names as unavailable storage.
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { name?: unknown }).name === "string" &&
    STORAGE_DOM_EXCEPTION_NAMES.has((error as { name: string }).name)
  ) {
    const message = (error as { message?: unknown }).message;
    return new ApiError({
      code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: typeof message === "string" && message !== "" ? message : "Storage is unavailable.",
    });
  }
  return error;
}

const STORAGE_DOM_EXCEPTION_NAMES = new Set([
  "QuotaExceededError",
  "SecurityError",
  "InvalidStateError",
  "NotSupportedError",
]);

function hasUsableId(record: WorkoutRecord): boolean {
  return typeof record.id === "string" && record.id.trim() !== "";
}

function notFound(message: string, details?: unknown): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.NOT_FOUND,
    message,
    status: HTTP_STATUS.notFound,
    ...(details === undefined ? {} : { details }),
  });
}

function validation(message: string, details?: unknown): ApiError {
  return new ApiError({
    code: API_ERROR_CODES.VALIDATION_ERROR,
    message,
    status: HTTP_STATUS.badRequest,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * Fixed owner namespace for the explicit development-only unauthenticated
 * loopback bypass. It is deliberately not a real Supabase user id and never
 * falls back to legacy unowned keys.
 */
export const LOCAL_DEV_BYPASS_OWNER = "dev-loopback-bypass";

/**
 * `FitTraceClient` over the browser's own storage. When `ownerId` is provided,
 * every repository key is namespaced to that verified Supabase user id, so two
 * account identities on the same browser never see each other's records and
 * legacy unowned v1 keys stay hidden. Omitting `ownerId` keeps the legacy
 * (unowned) namespace for tests/tools only; the App always passes an owner.
 *
 * Imported artifacts live under separate per-owner keys; saving one never
 * rewrites another. Every method is async, which is what turns synchronous
 * storage throws (blocked `localStorage`) into promise rejections.
 */
export interface LocalFitTraceClientOptions {
  ownerId?: string;
  /**
   * Injectable clock for sibling client methods (issue 6). Keeping it in the
   * options object lets both branches merge on one constructor signature
   * without dropping either branch's methods.
   */
  now?: () => Date;
}

export class LocalFitTraceClient implements FitTraceClient {
  private readonly adapter: StorageAdapter;
  private readonly ownerId: string | undefined;
  private readonly now: () => Date;
  /**
   * Per-client promise queue for artifact saves. Artifact reads/hash are async
   * (native Web Crypto), so the check-then-write sequence must be serialized
   * to keep identical concurrent saves to one duplicate. This is per client
   * instance: cross-tab/cross-client atomicity is an explicit known gap.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    adapter: StorageAdapter = new LocalStorageAdapter(),
    ownerOrOptions?: string | LocalFitTraceClientOptions,
  ) {
    this.adapter = adapter;
    if (typeof ownerOrOptions === "string") {
      this.ownerId = ownerOrOptions;
      this.now = () => new Date();
    } else {
      this.ownerId = ownerOrOptions?.ownerId;
      this.now = ownerOrOptions?.now ?? (() => new Date());
    }
  }

  /**
   * Imported artifacts always live in an explicit namespace. The fallback
   * keeps the pre-auth single-user local store isolated; verified identities
   * always pass their account id.
   */
  private get artifactOwnerId(): string {
    return this.ownerId ?? "local";
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async listWorkouts(): Promise<WorkoutRecord[]> {
    try {
      return loadRecords(this.adapter, this.ownerId);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
    try {
      // Derive the id from the raw content *before* validation and dispatch,
      // so a retried submit always targets the same id (idempotent retries).
      const withId = hasUsableId(record) ? record : { ...record, id: deriveWorkoutId(record) };

      let normalized: WorkoutRecord;
      let warnings: ValidationWarning[];
      try {
        const validated = validateWorkoutRecord(withId);
        normalized = validated.record;
        warnings = validated.warnings;
      } catch (error) {
        throw toApiError(error);
      }

      // Idempotency runs on the normalized record: identical content is a
      // no-op duplicate, differing content under the same id is a conflict.
      const existing = loadRecord(this.adapter, normalized.id, this.ownerId);
      if (existing !== null) {
        if (stableStringify(existing) === stableStringify(normalized)) {
          return { record: existing, duplicate: true, warnings };
        }
        throw new ApiError({
          code: API_ERROR_CODES.CONFLICT,
          message: `A workout with id "${normalized.id}" already exists with different content.`,
          details: { id: normalized.id },
        });
      }

      saveRecord(this.adapter, normalized, this.ownerId);
      return { record: normalized, duplicate: false, warnings };
    } catch (error) {
      throw toApiError(error);
    }
  }

  async analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
    try {
      // Core throws ValidationError on invalid or inverted filter dates.
      return analyzeProgress(loadRecords(this.adapter, this.ownerId), filter);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
    try {
      return generateNextPlan(loadRecords(this.adapter, this.ownerId), input);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async saveImportedArtifact<K extends ImportedArtifactKind>(
    input: ImportArtifactInput<K>,
  ): Promise<SaveImportedArtifactResult<K>> {
    return this.enqueue(async () => {
      try {
        const { input: normalizedInput, warnings } = parseImportArtifactInput(input);
        const artifact = await buildImportedArtifact(normalizedInput as ImportArtifactInput<K>, {
          created_at: this.now().toISOString(),
        });
        const existing = await loadImportedArtifact(this.adapter, this.artifactOwnerId, artifact.id);
        if (existing !== null) {
          if (
            existing.kind === artifact.kind &&
            stableStringify(existing.payload) === stableStringify(artifact.payload)
          ) {
            return { artifact: existing as ImportedArtifact<K>, duplicate: true, warnings };
          }
          throw new ApiError({
            code: API_ERROR_CODES.CONFLICT,
            message: `An imported artifact with id "${artifact.id}" already exists with different content.`,
            details: { id: artifact.id },
          });
        }
        saveImportedArtifactRecord(this.adapter, this.artifactOwnerId, artifact);
        return { artifact, duplicate: false, warnings };
      } catch (error) {
        throw toApiError(error);
      }
    });
  }

  async listImportedArtifacts(
    query: ListImportedArtifactsQuery = {},
  ): Promise<ImportedArtifactPage> {
    try {
      const normalized = normalizeListImportedArtifactsQuery(query);
      const all = (await loadImportedArtifacts(this.adapter, this.artifactOwnerId)).map(metadataFor);
      const items = pageArtifacts(all, normalized);
      const hasMore = pageArtifacts(all, { ...normalized, limit: normalized.limit + 1 }).length > normalized.limit;
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
    } catch (error) {
      throw toApiError(error);
    }
  }

  async getImportedArtifact(id: string): Promise<ImportedArtifact> {
    try {
      if (typeof id !== "string" || id === "" || id.length > 256) {
        throw validation("Invalid imported artifact id.");
      }
      const artifact = await loadImportedArtifact(this.adapter, this.artifactOwnerId, id);
      if (artifact === null) {
        throw notFound(`No imported artifact with id "${id}".`, { id });
      }
      return artifact;
    } catch (error) {
      throw toApiError(error);
    }
  }

  async getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
    try {
      if (!isImportedArtifactKind(kind)) throw validation("Invalid artifact kind.");
      return await loadArtifactSelection(this.adapter, this.artifactOwnerId, kind);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async setArtifactSelection(
    kind: ImportedArtifactKind,
    artifactId: string | null,
  ): Promise<ArtifactSelection> {
    try {
      if (!isImportedArtifactKind(kind)) throw validation("Invalid artifact kind.");
      if (artifactId === null) {
        const selection: ArtifactSelection = { artifact_id: null };
        saveArtifactSelection(this.adapter, this.artifactOwnerId, kind, selection);
        return selection;
      }
      if (typeof artifactId !== "string" || artifactId === "" || artifactId.length > 256) {
        throw validation("Invalid imported artifact id.");
      }
      const artifact = await loadImportedArtifact(this.adapter, this.artifactOwnerId, artifactId);
      if (artifact === null) {
        throw notFound(`No imported artifact with id "${artifactId}".`, { id: artifactId });
      }
      if (artifact.kind !== kind) {
        throw validation(`Imported artifact "${artifactId}" is not a ${kind} snapshot.`, {
          id: artifactId,
          kind,
        });
      }
      const selection: ArtifactSelection = { artifact_id: artifactId };
      saveArtifactSelection(this.adapter, this.artifactOwnerId, kind, selection);
      return selection;
    } catch (error) {
      throw toApiError(error);
    }
  }

  async getPlanAdoption(): Promise<PlanAdoption | null> {
    try {
      return await loadPlanAdoptionRecord(this.adapter, this.artifactOwnerId);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null> {
    try {
      if (input === null) {
        clearPlanAdoptionRecord(this.adapter, this.artifactOwnerId);
        return null;
      }
      if (
        typeof input !== "object" ||
        typeof input.artifact_id !== "string" ||
        input.artifact_id === "" ||
        input.artifact_id.length > 256
      ) {
        throw validation("Invalid plan adoption request.");
      }
      const artifact = await loadImportedArtifact(this.adapter, this.artifactOwnerId, input.artifact_id);
      if (artifact === null) {
        throw notFound(`No imported artifact with id "${input.artifact_id}".`, {
          id: input.artifact_id,
        });
      }
      if (artifact.kind !== "plan") {
        throw validation("Only a plan snapshot can be adopted.", { id: input.artifact_id });
      }
      if (artifact.content_digest !== input.confirmed_digest) {
        throw validation("The confirmed digest does not match the stored plan snapshot.", {
          id: input.artifact_id,
        });
      }
      const existing = await loadPlanAdoptionRecord(this.adapter, this.artifactOwnerId);
      if (
        existing !== null &&
        existing.artifact_id === input.artifact_id &&
        existing.confirmed_digest === input.confirmed_digest
      ) {
        return existing;
      }
      const adoption: PlanAdoption = {
        artifact_id: input.artifact_id,
        confirmed_digest: input.confirmed_digest,
        confirmed_at: this.now().toISOString(),
      };
      savePlanAdoptionRecord(this.adapter, this.artifactOwnerId, adoption);
      return adoption;
    } catch (error) {
      throw toApiError(error);
    }
  }
}
