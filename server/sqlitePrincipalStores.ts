import { DatabaseSync } from "node:sqlite";
import {
  ConflictError,
  ValidationError,
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  ValidationWarning,
  WorkoutRecord,
} from "@agent-fit-trace/core";
import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import {
  applyImportedArtifactKeyset,
  buildImportedArtifact,
  encodeArtifactCursor,
  isImportedArtifactKind,
  normalizeListImportedArtifactsQuery,
  parseImportArtifactInput,
  parseImportedArtifact,
  parseImportedArtifactMeta,
} from "@agent-fit-trace/api-contracts";
import type {
  ArtifactSelection,
  AuthPrincipal,
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
} from "@agent-fit-trace/api-contracts";
import { SqliteWorkoutStore, principalDbPath } from "@agent-fit-trace/store";
import type { PrincipalStoreFactory } from "./auth/verifier.ts";

/**
 * Per-principal, SQLite-backed `FitTraceClient`s for the local daemon.
 *
 * Each verified principal gets one client over its own database file
 * (`principalDbPath(dataDir, principal.id)`), so two principals may hold the
 * same business id without seeing each other. The observable behavior is
 * ported from the in-memory client (`inMemoryWorkoutStore.ts`): identical
 * re-imports are no-op duplicates, same-id different-content is a `CONFLICT`,
 * and artifact selection/plan adoption stay separate mutations.
 *
 * The clients are cached per principal id: `storeFor` runs once per request,
 * and opening two fresh connections each time would leak descriptors.
 */

const CREATE_APP_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Milliseconds a writer waits on a locked database (matches `SqliteWorkoutStore`). */
const BUSY_TIMEOUT_MS = 5000;

/** The whole imported-artifact collection is one `app_state` document. */
const ARTIFACTS_KEY = "imported_artifacts";

/** The plan-adoption metadata is its own `app_state` document (`null` when revoked). */
const ADOPTION_KEY = "plan_adoption";

/** Selection state is one document per kind: `selection_analysis` / `selection_plan`. */
function selectionKey(kind: ImportedArtifactKind): string {
  return `selection_${kind}`;
}

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

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was open (already committed/rolled back) — nothing to do.
  }
}

/**
 * The full contract over one principal's SQLite database.
 *
 * The workouts face delegates to {@link SqliteWorkoutStore} untouched; the
 * artifacts/selection/adoption face keeps its mutable state in `app_state`
 * documents on a second connection to the same file (safe under WAL). Both
 * connections are closed by {@link close}.
 */
export class SqliteFitTraceClient implements FitTraceClient {
  private workoutStore: SqliteWorkoutStore;
  private stateDb: DatabaseSync;
  /** Parsed `app_state` documents: lazily loaded on first read, updated after each committed write. */
  private docs: Map<string, unknown> = new Map();
  /** Serializes the async check-then-store artifact path, like the in-memory client. */
  private queue: Promise<void> = Promise.resolve();

  constructor(dbPath: string) {
    // The workout store owns its connection (mkdir, WAL, busy_timeout, schema).
    this.workoutStore = new SqliteWorkoutStore(dbPath);
    try {
      this.stateDb = new DatabaseSync(dbPath);
      this.stateDb.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.stateDb.exec(CREATE_APP_STATE_SQL);
    } catch (error) {
      // Setup failed: release the workout store's handle before propagating.
      this.workoutStore.close();
      throw error;
    }
  }

  /** Close both connections; the client is not usable afterwards. */
  close(): void {
    this.stateDb.close();
    this.workoutStore.close();
  }

  /* ------------------------------------------------------------------ */
  /* app_state document access                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Read one `app_state` document, loading and caching it on first access.
   * A missing row reads as `null` (empty state); invalid JSON surfaces as
   * `CORRUPT_STORE` instead of silently resetting persisted state.
   */
  private readDoc(key: string): unknown {
    const cached = this.docs.get(key);
    if (cached !== undefined) return cached;
    const row = this.stateDb
      .prepare("SELECT value FROM app_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (row === undefined) {
      this.docs.set(key, null);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value) as unknown;
    } catch {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: `Stored app_state key "${key}" contains invalid JSON.`,
        details: { key },
      });
    }
    this.docs.set(key, parsed);
    return parsed;
  }

  /**
   * Persist one whole document inside a single `BEGIN IMMEDIATE`..`COMMIT`
   * window. `DatabaseSync` is synchronous, so the window cannot interleave
   * in-process; the in-memory copy is refreshed only after a successful
   * commit. Cross-process writers on the same database file are out of scope
   * for this slice.
   */
  private writeDoc(key: string, doc: unknown): void {
    this.stateDb.exec("BEGIN IMMEDIATE");
    try {
      this.stateDb
        .prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)")
        .run(key, JSON.stringify(doc));
      this.stateDb.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.stateDb);
      throw error;
    }
    this.docs.set(key, doc);
  }

  private artifactsList(): ImportedArtifact[] {
    const doc = this.readDoc(ARTIFACTS_KEY);
    if (doc === null) return [];
    if (!Array.isArray(doc)) {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: `Stored app_state key "${ARTIFACTS_KEY}" is not an artifact list.`,
        details: { key: ARTIFACTS_KEY },
      });
    }
    return doc as ImportedArtifact[];
  }

  private selectionDoc(kind: ImportedArtifactKind): ArtifactSelection {
    const key = selectionKey(kind);
    const doc = this.readDoc(key);
    if (doc === null) return { artifact_id: null };
    if (!isPlainObject(doc) || (doc.artifact_id !== null && typeof doc.artifact_id !== "string")) {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: `Stored app_state key "${key}" is not an artifact selection.`,
        details: { key },
      });
    }
    return { artifact_id: doc.artifact_id as string | null };
  }

  private adoptionDoc(): PlanAdoption | null {
    const doc = this.readDoc(ADOPTION_KEY);
    if (doc === null) return null;
    if (
      !isPlainObject(doc) ||
      typeof doc.artifact_id !== "string" ||
      typeof doc.confirmed_digest !== "string" ||
      typeof doc.confirmed_at !== "string"
    ) {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: `Stored app_state key "${ADOPTION_KEY}" is not a plan adoption.`,
        details: { key: ADOPTION_KEY },
      });
    }
    return {
      artifact_id: doc.artifact_id,
      confirmed_digest: doc.confirmed_digest,
      confirmed_at: doc.confirmed_at,
    };
  }

  /* ------------------------------------------------------------------ */
  /* shared in-memory client helpers (ported)                            */
  /* ------------------------------------------------------------------ */

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readArtifact(id: string): Promise<ImportedArtifact | null> {
    const stored = this.artifactsList().find((entry) => entry.id === id);
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

  private async allArtifactMeta(): Promise<ImportedArtifactMeta[]> {
    const meta: ImportedArtifactMeta[] = [];
    for (const entry of this.artifactsList()) {
      const artifact = await this.readArtifact(entry.id);
      if (artifact === null) throw new Error("artifact disappeared");
      meta.push(parseImportedArtifactMeta(artifact));
    }
    return meta;
  }

  private async normalizeSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
    const selection = this.selectionDoc(kind);
    if (selection.artifact_id !== null) {
      const artifact = await this.readArtifact(selection.artifact_id);
      if (artifact === null || artifact.kind !== kind) {
        throw new ApiError({
          code: API_ERROR_CODES.CORRUPT_STORE,
          message: `Stored ${kind} selection points at a missing or differently-kinded artifact.`,
        });
      }
    }
    return selection;
  }

  private async readAdoption(): Promise<PlanAdoption | null> {
    const adoption = this.adoptionDoc();
    if (adoption === null) return null;
    const artifact = await this.readArtifact(adoption.artifact_id);
    if (
      artifact === null ||
      artifact.kind !== "plan" ||
      artifact.content_digest !== adoption.confirmed_digest
    ) {
      throw new ApiError({
        code: API_ERROR_CODES.CORRUPT_STORE,
        message: "Stored plan adoption points at a missing or changed plan artifact.",
      });
    }
    return adoption;
  }

  /* ------------------------------------------------------------------ */
  /* workouts face                                                       */
  /* ------------------------------------------------------------------ */

  async listWorkouts(): Promise<WorkoutRecord[]> {
    return this.workoutStore.all();
  }

  async createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
    // Validate the raw record directly: a missing/blank id or a non-object
    // body fails in core validation and maps to VALIDATION_ERROR below.
    let normalized: WorkoutRecord;
    let warnings: ValidationWarning[];
    try {
      const validated = validateWorkoutRecord(record);
      normalized = validated.record;
      warnings = validated.warnings;
    } catch (error) {
      throw toApiError(error);
    }
    // The store's import is one synchronous BEGIN IMMEDIATE..COMMIT window, so
    // the duplicate/conflict check is atomic without a promise queue.
    try {
      const result = await this.workoutStore.import(normalized);
      if (!result.duplicate) {
        return { record: normalized, duplicate: false, warnings };
      }
      // Duplicate: the store kept its original row; surface it like the
      // in-memory client does (append-only, so the id cannot have changed).
      const stored = (await this.workoutStore.all()).find(
        (entry) => entry.id === normalized.id,
      );
      if (stored === undefined) {
        throw new Error(`Duplicate workout "${normalized.id}" is missing from the store.`);
      }
      return { record: stored, duplicate: true, warnings };
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ApiError({
          code: API_ERROR_CODES.CONFLICT,
          message: `A workout with id "${normalized.id}" already exists with different content.`,
          details: { id: normalized.id },
        });
      }
      throw toApiError(error);
    }
  }

  async analyze(filter?: AnalysisFilter): Promise<AnalysisResult> {
    try {
      return analyzeProgress(await this.workoutStore.all(), filter);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async createPlanDraft(input?: PlanConstraints): Promise<PlanDraft> {
    // Plan-constraint validation is independent request validation and runs
    // before any plan is generated; the draft is never persisted.
    const constraints = parsePlanConstraints(input);
    try {
      return generateNextPlan(await this.workoutStore.all(), constraints);
    } catch (error) {
      throw toApiError(error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* artifacts / selection / adoption face                               */
  /* ------------------------------------------------------------------ */

  saveImportedArtifact<K extends ImportedArtifactKind>(
    input: ImportArtifactInput<K>,
  ): Promise<SaveImportedArtifactResult<K>> {
    return this.enqueue(async () => {
      const { input: normalizedInput, warnings } = parseImportArtifactInput(input);
      const artifact = await buildImportedArtifact(normalizedInput as ImportArtifactInput<K>, {
        created_at: new Date().toISOString(),
      });
      const existing = await this.readArtifact(artifact.id);
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
      this.writeDoc(ARTIFACTS_KEY, [...this.artifactsList(), artifact]);
      return { artifact, duplicate: false, warnings };
    });
  }

  async listImportedArtifacts(
    query: ListImportedArtifactsQuery = {},
  ): Promise<ImportedArtifactPage> {
    const normalized = normalizeListImportedArtifactsQuery(query);
    const all = await this.allArtifactMeta();
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
  }

  async getImportedArtifact(id: string): Promise<ImportedArtifact> {
    if (typeof id !== "string" || id === "" || id.length > 256) {
      throw badRequest("Invalid imported artifact id.");
    }
    const artifact = await this.readArtifact(id);
    if (artifact === null) throw notFound(`No imported artifact with id "${id}".`, { id });
    return artifact;
  }

  async getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
    if (!isImportedArtifactKind(kind)) throw badRequest("Invalid artifact kind.");
    return await this.normalizeSelection(kind);
  }

  async setArtifactSelection(
    kind: ImportedArtifactKind,
    artifactId: string | null,
  ): Promise<ArtifactSelection> {
    if (!isImportedArtifactKind(kind)) throw badRequest("Invalid artifact kind.");
    if (artifactId === null) {
      const selection: ArtifactSelection = { artifact_id: null };
      this.writeDoc(selectionKey(kind), selection);
      return selection;
    }
    if (typeof artifactId !== "string" || artifactId === "" || artifactId.length > 256) {
      throw badRequest("Invalid imported artifact id.");
    }
    const artifact = await this.readArtifact(artifactId);
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
    this.writeDoc(selectionKey(kind), selection);
    return selection;
  }

  async getPlanAdoption(): Promise<PlanAdoption | null> {
    return await this.readAdoption();
  }

  async setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null> {
    if (input === null) {
      // Revoking only clears the adoption metadata, never the plan artifact.
      this.writeDoc(ADOPTION_KEY, null);
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
    const artifact = await this.readArtifact(input.artifact_id);
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
    const existing = await this.readAdoption();
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
      confirmed_at: new Date().toISOString(),
    };
    this.writeDoc(ADOPTION_KEY, adoption);
    return adoption;
  }
}

/**
 * Create isolated SQLite-backed stores keyed by verified principal id: each
 * principal maps to `<dataDir>/<principal>.db`, opened once and cached.
 * `closeAll` releases every cached client (daemon shutdown).
 */
export function createSqlitePrincipalStores(
  dataDir: string,
): PrincipalStoreFactory & { closeAll(): void } {
  const clients = new Map<string, SqliteFitTraceClient>();
  return {
    storeFor(principal: AuthPrincipal): FitTraceClient {
      let client = clients.get(principal.id);
      if (client === undefined) {
        client = new SqliteFitTraceClient(principalDbPath(dataDir, principal.id));
        clients.set(principal.id, client);
      }
      return client;
    },
    closeAll(): void {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
