import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  WorkoutRecord,
} from "@pi-fit-trace/core";
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
import { LocalFitTraceClient } from "../api/localFitTraceClient.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import { MemoryStorageAdapter } from "../storage/adapter.ts";

/** Build a local client over the given (or a fresh in-memory) adapter. */
export function clientFor(adapter: StorageAdapter = new MemoryStorageAdapter()): LocalFitTraceClient {
  return new LocalFitTraceClient(adapter);
}

/** A manually resolvable/rejectable promise. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Controllable `FitTraceClient` for async-ordering tests. Each method returns
 * a pending promise the test resolves/rejects on demand, and records call
 * counts. Defaults can be seeded so basic renders succeed without wiring.
 */
export class FakeFitTraceClient implements FitTraceClient {
  listCalls = 0;
  createCalls = 0;
  analyzeCalls = 0;
  planCalls = 0;

  pendingLists: Deferred<WorkoutRecord[]>[] = [];
  pendingCreates: Deferred<CreateWorkoutResult>[] = [];
  pendingAnalyses: Deferred<AnalysisResult>[] = [];
  pendingPlans: Deferred<PlanDraft>[] = [];

  /** Import resources are not part of the ordering tests; delegate locally. */
  private readonly imports = new LocalFitTraceClient(new MemoryStorageAdapter());

  constructor(
    private defaults: {
      records?: WorkoutRecord[];
      analysis?: AnalysisResult | null;
      plan?: PlanDraft | null;
    } = {},
  ) {}

  listWorkouts(): Promise<WorkoutRecord[]> {
    this.listCalls += 1;
    if (this.pendingLists.length > 0) {
      const next = this.pendingLists.shift();
      if (next) return next.promise;
    }
    return Promise.resolve(this.defaults.records ?? []);
  }

  /** Queue the next `listWorkouts` response. */
  nextList(): Deferred<WorkoutRecord[]> {
    const d = deferred<WorkoutRecord[]>();
    this.pendingLists.push(d);
    return d;
  }

  createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult> {
    this.createCalls += 1;
    if (this.pendingCreates.length > 0) {
      const next = this.pendingCreates.shift();
      if (next) return next.promise;
    }
    const saved: WorkoutRecord = { ...record };
    return Promise.resolve({ record: saved, duplicate: false, warnings: [] });
  }

  /** Queue the next `createWorkout` response. */
  nextCreate(): Deferred<CreateWorkoutResult> {
    const d = deferred<CreateWorkoutResult>();
    this.pendingCreates.push(d);
    return d;
  }

  analyze(_filter?: AnalysisFilter): Promise<AnalysisResult> {
    this.analyzeCalls += 1;
    if (this.pendingAnalyses.length > 0) {
      const next = this.pendingAnalyses.shift();
      if (next) return next.promise;
    }
    if (this.defaults.analysis) return Promise.resolve(this.defaults.analysis);
    throw new Error("FakeFitTraceClient has no default analysis; queue one with nextAnalyze().");
  }

  /** Queue the next `analyze` response. */
  nextAnalyze(): Deferred<AnalysisResult> {
    const d = deferred<AnalysisResult>();
    this.pendingAnalyses.push(d);
    return d;
  }

  createPlanDraft(_input?: PlanConstraints): Promise<PlanDraft> {
    this.planCalls += 1;
    if (this.pendingPlans.length > 0) {
      const next = this.pendingPlans.shift();
      if (next) return next.promise;
    }
    if (this.defaults.plan) return Promise.resolve(this.defaults.plan);
    throw new Error("FakeFitTraceClient has no default plan; queue one with nextPlan().");
  }

  /** Queue the next `createPlanDraft` response. */
  nextPlan(): Deferred<PlanDraft> {
    const d = deferred<PlanDraft>();
    this.pendingPlans.push(d);
    return d;
  }

  saveImportedArtifact<K extends ImportedArtifactKind>(
    input: ImportArtifactInput<K>,
  ): Promise<SaveImportedArtifactResult<K>> {
    return this.imports.saveImportedArtifact(input);
  }

  listImportedArtifacts(query?: ListImportedArtifactsQuery): Promise<ImportedArtifactPage> {
    return this.imports.listImportedArtifacts(query);
  }

  getImportedArtifact(id: string): Promise<ImportedArtifact> {
    return this.imports.getImportedArtifact(id);
  }

  getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection> {
    return this.imports.getArtifactSelection(kind);
  }

  setArtifactSelection(
    kind: ImportedArtifactKind,
    artifactId: string | null,
  ): Promise<ArtifactSelection> {
    return this.imports.setArtifactSelection(kind, artifactId);
  }

  getPlanAdoption(): Promise<PlanAdoption | null> {
    return this.imports.getPlanAdoption();
  }

  setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null> {
    return this.imports.setPlanAdoption(input);
  }
}
