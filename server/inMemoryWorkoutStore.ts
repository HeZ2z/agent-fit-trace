import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  sortRecords,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type {
  AnalysisFilter,
  PlanConstraints,
  PlanDraft,
  AnalysisResult,
  ValidationWarning,
  WorkoutRecord,
} from "@pi-fit-trace/core";
import { API_ERROR_CODES, ApiError } from "@pi-fit-trace/api-contracts";
import {
  buildImportedArtifact,
  encodeArtifactCursor,
  isImportedArtifactKind,
  normalizeListImportedArtifactsQuery,
  parseImportArtifactInput,
  parseImportedArtifact,
  parseImportedArtifactMeta,
  applyImportedArtifactKeyset,
} from "@pi-fit-trace/api-contracts";
import type {
  ArtifactSelection,
  CreateWorkoutResult,
  FitTraceClient,
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
import { ValidationError } from "@pi-fit-trace/core";

/** Map a thrown core error onto the API error contract; unknown errors pass through. */
function toApiError(error: unknown): unknown {
  if (error instanceof ValidationError) {
    return new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: error.message,
      details: { issues: error.issues },
    });
  }
  return error;
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

export interface InMemoryWorkoutStoreOptions {
  /** Clock injection for deterministic tests; the store never hashes time. */
  now?: () => Date;
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

/**
 * Server-side, in-memory, append-only `FitTraceClient`. Records are keyed by
 * id and never overwritten: an identical re-import is a no-op duplicate and
 * the same id with different content is a conflict.
 *
 * The server requires the caller to supply the id and NEVER derives one:
 * malformed bodies and missing/blank ids are rejected as `VALIDATION_ERROR`.
 * Plan-constraint field validation is part of the server's independent
 * request validation and runs before any plan is generated.
 *
 * All imports are serialized through a promise queue so the check-then-store
 * sequence is atomic. Artifact hashing is async (native Web Crypto) and the
 * create path shares the same queue, so concurrent identical saves cannot both
 * observe a missing artifact and write twice.
 */
export function createInMemoryWorkoutStore(
  options: InMemoryWorkoutStoreOptions = {},
): FitTraceClient {
  const records = new Map<string, WorkoutRecord>();
  const artifacts = new Map<string, ImportedArtifact>();
  const selections = new Map<ImportedArtifactKind, ArtifactSelection>();
  let planAdoption: PlanAdoption | null = null;
  const now = options.now ?? (() => new Date());
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function sortedRecords(): WorkoutRecord[] {
    return sortRecords([...records.values()]);
  }

  async function readArtifact(id: string): Promise<ImportedArtifact | null> {
    const stored = artifacts.get(id);
    if (stored === undefined) return null;
    try {
      const parsed = await parseImportedArtifact(stored);
      if (parsed.id !== id) throw new Error("id mismatch");
      return parsed;
    } catch {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: `Stored imported artifact "${id}" failed validation.`,
        details: { id },
      });
    }
  }

  async function allArtifactMeta(): Promise<ImportedArtifactMeta[]> {
    const meta: ImportedArtifactMeta[] = [];
    for (const id of artifacts.keys()) {
      const artifact = await readArtifact(id);
      if (artifact === null) throw new Error("artifact disappeared");
      meta.push(parseImportedArtifactMeta(artifact));
    }
    return meta;
  }

  async function normalizeSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
    const selection = selections.get(kind) ?? { artifact_id: null };
    if (selection.artifact_id !== null) {
      const artifact = await readArtifact(selection.artifact_id);
      if (artifact === null || artifact.kind !== kind) {
        throw new ApiError({
          code: API_ERROR_CODES.CORRUPT_STORE,
          message: `Stored ${kind} selection points at a missing or differently-kinded artifact.`,
        });
      }
    }
    return selection;
  }

  async function readAdoption(): Promise<PlanAdoption | null> {
    if (planAdoption === null) return null;
    const artifact = await readArtifact(planAdoption.artifact_id);
    if (
      artifact === null ||
      artifact.kind !== "plan" ||
      artifact.content_digest !== planAdoption.confirmed_digest
    ) {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: "Stored plan adoption points at a missing or changed plan artifact.",
      });
    }
    return planAdoption;
  }

  return {
    listWorkouts(): Promise<WorkoutRecord[]> {
      return Promise.resolve(sortedRecords());
    },

    createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
      const task = async (): Promise<CreateWorkoutResult> => {
        // Validate the raw record directly: a missing/blank id or a
        // non-object body fails in core validation and maps to
        // VALIDATION_ERROR below.
        let normalized: WorkoutRecord;
        let warnings: ValidationWarning[];
        try {
          const validated = validateWorkoutRecord(record);
          normalized = validated.record;
          warnings = validated.warnings;
        } catch (error) {
          throw toApiError(error);
        }
        const existing = records.get(normalized.id) ?? null;
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
        records.set(normalized.id, normalized);
        return { record: normalized, duplicate: false, warnings };
      };
      return enqueue(task);
    },

    analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
      try {
        return Promise.resolve(analyzeProgress(sortedRecords(), filter));
      } catch (error) {
        return Promise.reject(toApiError(error));
      }
    },

    createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
      let constraints: PlanConstraints | undefined;
      try {
        constraints = parsePlanConstraints(input);
      } catch (error) {
        return Promise.reject(error);
      }
      try {
        return Promise.resolve(generateNextPlan(sortedRecords(), constraints));
      } catch (error) {
        return Promise.reject(toApiError(error));
      }
    },

    saveImportedArtifact<K extends ImportedArtifactKind>(
      input: ImportArtifactInput<K>,
    ): Promise<SaveImportedArtifactResult<K>> {
      return enqueue(async () => {
        const { input: normalizedInput, warnings } = parseImportArtifactInput(input);
        const artifact = await buildImportedArtifact(normalizedInput as ImportArtifactInput<K>, {
          created_at: now().toISOString(),
        });
        const existing = await readArtifact(artifact.id);
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
        artifacts.set(artifact.id, artifact);
        return { artifact, duplicate: false, warnings };
      });
    },

    async listImportedArtifacts(
      query: ListImportedArtifactsQuery = {},
    ): Promise<ImportedArtifactPage> {
      const normalized = normalizeListImportedArtifactsQuery(query);
      const all = await allArtifactMeta();
      const items = applyImportedArtifactKeyset(all, normalized);
      const hasMore =
        applyImportedArtifactKeyset(all, { ...normalized, limit: normalized.limit + 1 }).length >
        normalized.limit;
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
      if (typeof id !== "string" || id === "" || id.length > 256) {
        throw badRequest("Invalid imported artifact id.");
      }
      const artifact = await readArtifact(id);
      if (artifact === null) throw notFound(`No imported artifact with id "${id}".`, { id });
      return artifact;
    },

    async getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
      if (!isImportedArtifactKind(kind)) throw badRequest("Invalid artifact kind.");
      return await normalizeSelection(kind);
    },

    async setArtifactSelection(
      kind: ImportedArtifactKind,
      artifactId: string | null,
    ): Promise<ArtifactSelection> {
      if (!isImportedArtifactKind(kind)) throw badRequest("Invalid artifact kind.");
      if (artifactId === null) {
        const selection: ArtifactSelection = { artifact_id: null };
        selections.set(kind, selection);
        return selection;
      }
      if (typeof artifactId !== "string" || artifactId === "" || artifactId.length > 256) {
        throw badRequest("Invalid imported artifact id.");
      }
      const artifact = await readArtifact(artifactId);
      if (artifact === null) {
        throw notFound(`No imported artifact with id "${artifactId}".`, { id: artifactId });
      }
      if (artifact.kind !== kind) {
        throw badRequest(`Imported artifact "${artifactId}" is not a ${kind} snapshot.`, {
          id: artifactId,
          kind,
        });
      }
      const selection: ArtifactSelection = { artifact_id: artifactId };
      selections.set(kind, selection);
      return selection;
    },

    async getPlanAdoption(): Promise<PlanAdoption | null> {
      return await readAdoption();
    },

    async setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null> {
      if (input === null) {
        planAdoption = null;
        return null;
      }
      if (
        typeof input !== "object" ||
        typeof input.artifact_id !== "string" ||
        input.artifact_id === "" ||
        input.artifact_id.length > 256 ||
        typeof input.confirmed_digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.confirmed_digest)
      ) {
        throw badRequest("Invalid plan adoption request.");
      }
      const artifact = await readArtifact(input.artifact_id);
      if (artifact === null) {
        throw notFound(`No imported artifact with id "${input.artifact_id}".`, {
          id: input.artifact_id,
        });
      }
      if (artifact.kind !== "plan") {
        throw badRequest("Only a plan snapshot can be adopted.", { id: input.artifact_id });
      }
      if (artifact.content_digest !== input.confirmed_digest) {
        throw badRequest("The confirmed digest does not match the stored plan snapshot.", {
          id: input.artifact_id,
        });
      }
      const existing = await readAdoption();
      if (
        existing !== null &&
        existing.artifact_id === input.artifact_id &&
        existing.confirmed_digest === input.confirmed_digest
      ) {
        return existing;
      }
      planAdoption = {
        artifact_id: input.artifact_id,
        confirmed_digest: input.confirmed_digest,
        confirmed_at: now().toISOString(),
      };
      return planAdoption;
    },
  };
}
