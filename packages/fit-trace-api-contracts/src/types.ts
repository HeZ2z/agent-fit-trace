import type {
  AnalysisFilter,
  AnalysisResult,
  PlanConstraints,
  PlanDraft,
  ValidationWarning,
  WorkoutRecord,
} from "@agent-fit-trace/core";
import type {
  ArtifactSelection,
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactKind,
  ImportedArtifactPage,
  ListImportedArtifactsQuery,
  PlanAdoption,
  PlanAdoptionInput,
  SaveImportedArtifactResult,
} from "./imports.ts";

/**
 * Transport contract shared by the fit-trace app and any HTTP-shaped backend.
 *
 * This module describes *how* the four domain operations cross a network
 * boundary — the client surface, the JSON envelope, and the endpoint/status
 * mapping. The computations themselves stay in `@agent-fit-trace/core`; nothing
 * here decides values, only shapes.
 */

/** Outcome of an idempotent create: the stored record plus a duplicate signal. */
export interface CreateWorkoutResult {
  record: WorkoutRecord;
  /** True when an identical record with this id was already present (no-op). */
  duplicate: boolean;
  warnings: ValidationWarning[];
}

/**
 * The operations the app can reach over the network, expressed as async calls.
 * Implementations may hit a real HTTP server or an in-memory handler; either
 * way they resolve with unwrapped domain values (the envelope is stripped by
 * the transport, not by callers).
 */
export interface FitTraceClient extends FitTraceImportClient {
  listWorkouts(): Promise<WorkoutRecord[]>;
  createWorkout(record: WorkoutRecord): Promise<CreateWorkoutResult>;
  analyze(filter?: AnalysisFilter): Promise<AnalysisResult>;
  createPlanDraft(input?: PlanConstraints): Promise<PlanDraft>;
}

/**
 * Immutable imported snapshots plus the mutable, explicitly separate
 * "currently viewing" and plan-adoption state.
 *
 * Saving a snapshot never selects it, and selecting it never adopts a plan:
 * each mutation is a separate call so the UI cannot silently change meaning.
 */
export interface FitTraceImportClient {
  saveImportedArtifact<K extends ImportedArtifactKind>(
    input: ImportArtifactInput<K>,
  ): Promise<SaveImportedArtifactResult<K>>;
  listImportedArtifacts(query?: ListImportedArtifactsQuery): Promise<ImportedArtifactPage>;
  getImportedArtifact(id: string): Promise<ImportedArtifact>;
  getArtifactSelection(kind: ImportedArtifactKind): Promise<ArtifactSelection>;
  setArtifactSelection(
    kind: ImportedArtifactKind,
    artifactId: string | null,
  ): Promise<ArtifactSelection>;
  getPlanAdoption(): Promise<PlanAdoption | null>;
  setPlanAdoption(input: PlanAdoptionInput | null): Promise<PlanAdoption | null>;
}

export interface OkEnvelope<T> {
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  error: ApiErrorBody;
}

export const FIT_TRACE_API_VERSION = "v1";

/**
 * The authenticated caller of an API operation.
 *
 * The domain core and the workout stores never see tokens: the HTTP boundary
 * verifies the bearer token and injects only this stable principal (the app's
 * auth layer and HTTP transport necessarily handle the token itself to store
 * the session and attach it per request). `id` is the identity
 * provider's subject (`sub`, e.g. the Supabase `auth.users` id) and is the
 * sole owner key for workout isolation.
 */
export interface AuthPrincipal {
  id: string;
  email?: string;
  /**
   * Trusted anonymous classification copied from the identity provider's
   * verified user response (`GET /auth/v1/user` → `is_anonymous`).
   *
   * `undefined` means the provider did not return a usable classification
   * (or this principal came from a verifier that cannot classify it). It is
   * deliberately not inferred from a missing email, request body, client
   * cache, or user metadata. Account-only capabilities must treat both
   * `true` and `undefined` as ineligible; cloud policy and quotas are owned by
   * the sibling identity slice, not by a helper here.
   */
  isAnonymous?: boolean;
}

/** Public (unauthenticated) bootstrap configuration served by the API. */
export interface PublicApiConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  /**
   * Deployment-readiness flag for Supabase anonymous guest sign-in. Defaults
   * to false and is only true when the server explicitly reports
   * `FIT_TRACE_GUEST_SIGN_IN=1` (after the guest profile is verified live).
   * The client must keep guest entry disabled unless this is exactly `true`.
   */
  guestSignInEnabled?: boolean;
  /**
   * Deployment-readiness flag for invited guest -> account upgrades. Defaults
   * to false and is only true when the server explicitly reports
   * `FIT_TRACE_GUEST_UPGRADE=1` after the migration/trigger and live Auth flow
   * have been verified.
   */
  guestUpgradeEnabled?: boolean;
  /**
   * Set when the deployment has CAPTCHA enabled for anonymous sign-in.
   * This browser client does not bundle a CAPTCHA widget yet, so it fails
   * closed (hides guest entry) instead of sending a request that cannot pass.
   * The transport still accepts an explicit CAPTCHA token for a future UI.
   */
  guestSignInCaptchaRequired?: boolean;
}

/** Resource paths for the four endpoints (see status semantics below). */
export const API_ENDPOINTS = {
  workouts: "/workouts",
  analysis: "/analysis",
  planDrafts: "/plans/drafts",
  imports: "/imports",
  importSelections: "/import-selections",
  planAdoption: "/plan-adoption",
  publicConfig: "/public-config",
} as const;

/**
 * Status semantics:
 * - `POST /workouts` (body `{ record }`) → 201 on a new record, 200 on an
 *   identical retry (`duplicate`), 400 on invalid input, 409 when the id
 *   already exists with different content.
 * - `GET /workouts` → 200 list.
 * - `GET /analysis` (optional `from`/`to`/`exercises` query) → 200.
 * - `POST /plans/drafts` (optional `PlanConstraints` body) → 200.
 * - `POST /imports` (`{ kind, payload_schema_version, payload, source_filename? }`)
 *   → 201 on a new snapshot, 200 on an identical duplicate, 409 when the same
 *   id exists with different content. The server recomputes the id/digest and
 *   never accepts an owner.
 * - `GET /imports?kind=&limit=&cursor=` → 200 metadata page
 *   (`{ items, next_cursor }`); the payload is never included in list reads.
 * - `GET /imports/:id` → 200 full snapshot; another owner's or a missing id is
 *   uniformly 404 `NOT_FOUND`.
 * - `GET|PUT /import-selections/:kind` → 200 `{ artifact_id }`; null clears the
 *   selection. Switching what is displayed never adopts a plan.
 * - `GET|PUT /plan-adoption` → 200 `null` or
 *   `{ artifact_id, confirmed_digest, confirmed_at }`; PUT null revokes only
 *   the adoption metadata.
 * - Authenticated deployments reject missing/invalid bearer tokens on all
 *   data endpoints with 401 `UNAUTHENTICATED` (plus a `WWW-Authenticate:
 *   Bearer` header) and out-of-scope callers with 403 `FORBIDDEN`.
 * - `GET /public-config` → 200 without authentication; it only exposes the
 *   public Supabase URL and publishable key needed to start a login.
 * - Any unexpected failure → 500 with an {@link ErrorEnvelope}.
 */
export const HTTP_STATUS = {
  created: 201,
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  gone: 410,
  serverError: 500,
  serviceUnavailable: 503,
} as const;
