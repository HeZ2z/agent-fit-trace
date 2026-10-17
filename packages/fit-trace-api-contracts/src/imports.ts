import { isValidIsoDate, stableStringify } from "@pi-fit-trace/core";
import type {
  AnalysisResult,
  PlanDraft,
  ValidationWarning,
} from "@pi-fit-trace/core";
import { API_ERROR_CODES, ApiError, MalformedResponseError } from "./errors.ts";
import { parseAnalysisResult, parsePlanDraft } from "./validators.ts";

/**
 * Immutable imported-artifact contract shared by every client.
 *
 * Identity is content-addressed: `id = <kind>:v1:<sha256(canonical payload)>`.
 * The digest indexes a snapshot; it is never trusted alone, because duplicate
 * detection and every read compare the canonical payload itself. The core
 * remains the only place that computes analysis/plan values; this module only
 * bounds, validates, and identifies exchanged snapshots.
 */

export const IMPORTED_ARTIFACT_KINDS = ["analysis", "plan"] as const;
export type ImportedArtifactKind = (typeof IMPORTED_ARTIFACT_KINDS)[number];

export const IMPORTED_ARTIFACT_SCHEMA_VERSION = 1;
export const IMPORTED_PAYLOAD_SCHEMA_VERSION = 1;

/** Backup file limits (the file is a container; each record is sent separately). */
export const IMPORT_MAX_FILE_BYTES = 1024 * 1024;
export const IMPORT_MAX_FILE_RECORDS = 1000;

/** A single normalized import request must stay below the existing 64 KiB HTTP cap. */
export const IMPORT_MAX_REQUEST_BYTES = 60 * 1024;

/** Additional structural bounds applied before trusting any imported JSON. */
export const IMPORT_MAX_JSON_DEPTH = 16;
export const IMPORT_MAX_JSON_KEY_LENGTH = 256;
export const IMPORT_MAX_STRING_LENGTH = 4096;
export const IMPORT_MAX_ID_LENGTH = 256;
export const IMPORT_MAX_EXERCISES = 100;
export const IMPORT_MAX_SETS_PER_EXERCISE = 100;
export const IMPORT_MAX_COLLECTION_LENGTH = 1000;
export const IMPORT_MAX_FILENAME_LENGTH = 255;

export const IMPORT_LIST_DEFAULT_LIMIT = 20;
export const IMPORT_LIST_MAX_LIMIT = 100;

export interface ImportedArtifactPayloads {
  analysis: AnalysisResult;
  plan: PlanDraft;
}

export interface ImportedArtifactMeta<K extends ImportedArtifactKind = ImportedArtifactKind> {
  id: string;
  kind: K;
  schema_version: typeof IMPORTED_ARTIFACT_SCHEMA_VERSION;
  payload_schema_version: typeof IMPORTED_PAYLOAD_SCHEMA_VERSION;
  source: "file_import";
  source_filename: string | null;
  source_record_ids: string[];
  content_digest: string;
  created_at: string;
}

export interface ImportedArtifact<K extends ImportedArtifactKind = ImportedArtifactKind>
  extends ImportedArtifactMeta<K> {
  payload: ImportedArtifactPayloads[K];
}

export interface ImportArtifactInput<K extends ImportedArtifactKind = ImportedArtifactKind> {
  kind: K;
  payload_schema_version: number;
  payload: ImportedArtifactPayloads[K];
  source_filename?: string | null;
}

export interface SaveImportedArtifactResult<K extends ImportedArtifactKind = ImportedArtifactKind> {
  artifact: ImportedArtifact<K>;
  duplicate: boolean;
  warnings: ValidationWarning[];
}

export interface ListImportedArtifactsQuery {
  kind?: ImportedArtifactKind;
  limit?: number;
  cursor?: string | null;
}

export interface ImportedArtifactPage {
  items: ImportedArtifactMeta[];
  next_cursor: string | null;
}

export interface ArtifactSelection {
  artifact_id: string | null;
}

export interface PlanAdoptionInput {
  artifact_id: string;
  confirmed_digest: string;
}

export interface PlanAdoption extends PlanAdoptionInput {
  confirmed_at: string;
}

export interface ArtifactCursor {
  kind: ImportedArtifactKind;
  created_at: string;
  id: string;
}

/** Validation failure for untrusted import input (maps to HTTP 400). */
export class ImportValidationError extends ApiError {
  field: string;

  constructor(field: string, reason: string) {
    super({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: `Invalid import: \`${field}\` ${reason}.`,
      status: 400,
    });
    this.name = "ImportValidationError";
    this.field = field;
  }
}

type Fail = (field: string, reason: string) => never;

const importFail: Fail = (field, reason) => {
  throw new ImportValidationError(field, reason);
};

const responseFail: Fail = (field, reason) => {
  throw new MalformedResponseError(field, reason);
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, field: string, fail: Fail): Record<string, unknown> {
  if (!isObject(value)) fail(field, "must be an object");
  return value;
}

function assertString(value: unknown, field: string, fail: Fail): string {
  if (typeof value !== "string") fail(field, "must be a string");
  return value;
}

function assertStringOrNull(value: unknown, field: string, fail: Fail): string | null {
  if (value !== null && typeof value !== "string") fail(field, "must be a string or null");
  return value;
}

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isImportedArtifactKind(value: unknown): value is ImportedArtifactKind {
  return value === "analysis" || value === "plan";
}

/* ------------------------------------------------------------------------- */
/* SHA-256 (native Web Crypto; browser + Node 24)                            */
/* ------------------------------------------------------------------------- */

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Lowercase hex SHA-256 of the UTF-8 encoding of `input`.
 *
 * Uses the platform's Web Crypto implementation (`crypto.subtle`), available
 * in browsers in a secure context and in Node 24. There is deliberately no
 * handwritten fallback: a missing Web Crypto implementation is an environment
 * error, never a silent second digest algorithm.
 */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("Web Crypto subtle.digest is unavailable in this environment.");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/* ------------------------------------------------------------------------- */
/* Identity                                                                  */
/* ------------------------------------------------------------------------- */

/** Canonical payload digest (`sha256(stableStringify(payload))`). */
export function artifactContentDigest(payload: unknown): Promise<string> {
  return sha256Hex(stableStringify(payload));
}

/** Canonical artifact id for one kind + digest. */
export function importedArtifactId(kind: ImportedArtifactKind, digest: string): string {
  return `${kind}:v1:${digest}`;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------------- */
/* Bounds                                                                    */
/* ------------------------------------------------------------------------- */

/** Reject JSON deeper than the import bound or containing non-finite numbers. */
export function assertImportJsonBounds(
  value: unknown,
  field = "(payload)",
  fail: Fail = importFail,
  depth = 0,
): void {
  if (depth > IMPORT_MAX_JSON_DEPTH) {
    fail(field, `exceeds the maximum JSON depth of ${IMPORT_MAX_JSON_DEPTH}`);
  }
  if (typeof value === "string") {
    if (value.length > IMPORT_MAX_STRING_LENGTH) {
      fail(field, `must be at most ${IMPORT_MAX_STRING_LENGTH} characters`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(field, "must be a finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > IMPORT_MAX_COLLECTION_LENGTH) {
      fail(field, `must contain at most ${IMPORT_MAX_COLLECTION_LENGTH} entries`);
    }
    value.forEach((entry, index) =>
      assertImportJsonBounds(entry, `${field}[${index}]`, fail, depth + 1),
    );
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key.length > IMPORT_MAX_JSON_KEY_LENGTH) {
        fail(
          `${field}.(key)`,
          `must use at most ${IMPORT_MAX_JSON_KEY_LENGTH} characters per object key`,
        );
      }
      assertImportJsonBounds(entry, `${field}.${key}`, fail, depth + 1);
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Payload guards                                                            */
/* ------------------------------------------------------------------------- */

function nonNegativeInteger(value: number, field: string, fail: Fail): void {
  if (!Number.isInteger(value) || value < 0) {
    fail(field, "must be a non-negative integer");
  }
}

function assertPeriod(
  period: { from: string | null; to: string | null },
  field: string,
  fail: Fail,
): void {
  for (const key of ["from", "to"] as const) {
    const value = period[key];
    if (value !== null && !isValidIsoDate(value)) {
      fail(`${field}.${key}`, "must be a valid ISO 8601 date or datetime, or null");
    }
  }
  if (period.from !== null && period.to !== null) {
    const from = new Date(period.from).getTime();
    const to = new Date(period.to).getTime();
    if (from > to) fail(field, "must not start after it ends");
  }
}

function assertAnalysisSemantics(result: AnalysisResult, fail: Fail): void {
  assertPeriod(result.period, "period", fail);
  nonNegativeInteger(result.metrics.sessions, "metrics.sessions", fail);
  nonNegativeInteger(result.metrics.total_sets, "metrics.total_sets", fail);
  nonNegativeInteger(result.metrics.total_reps, "metrics.total_reps", fail);
  if (result.metrics.volume_kg < 0) fail("metrics.volume_kg", "must be non-negative");
  if (result.metrics.avg_rpe !== null && (result.metrics.avg_rpe < 1 || result.metrics.avg_rpe > 10)) {
    fail("metrics.avg_rpe", "must be between 1 and 10, or null");
  }
  if (result.metrics.avg_rest_days < 0) fail("metrics.avg_rest_days", "must be non-negative");
  if (result.metrics.max_gap_days < 0) fail("metrics.max_gap_days", "must be non-negative");
  result.trends.forEach((trend, index) => {
    nonNegativeInteger(trend.sessions_compared, `trends[${index}].sessions_compared`, fail);
  });
  result.source_records.forEach((id, index) => {
    if (id === "" || id.length > IMPORT_MAX_ID_LENGTH) {
      fail(`source_records[${index}]`, `must be a non-empty id of at most ${IMPORT_MAX_ID_LENGTH} characters`);
    }
  });
}

function assertPlanSemantics(draft: PlanDraft, fail: Fail): void {
  assertPeriod(draft.based_on.period, "based_on.period", fail);
  nonNegativeInteger(draft.based_on.sessions, "based_on.sessions", fail);
  draft.based_on.source_records.forEach((id, index) => {
    if (id === "" || id.length > IMPORT_MAX_ID_LENGTH) {
      fail(
        `based_on.source_records[${index}]`,
        `must be a non-empty id of at most ${IMPORT_MAX_ID_LENGTH} characters`,
      );
    }
  });
}

function rethrowAsImport(error: unknown, fail: Fail): never {
  if (error instanceof MalformedResponseError) {
    fail(error.field, error.message.replace(/^Malformed response: /, "").replace(/\.$/, ""));
  }
  throw error;
}

/** Strict guard for an analysis payload (used for both input and stored reads). */
export function parseAnalysisImportPayload(value: unknown, fail: Fail = responseFail): AnalysisResult {
  assertImportJsonBounds(value, "(payload)", fail);
  let parsed: AnalysisResult;
  try {
    parsed = parseAnalysisResult(value);
  } catch (error) {
    rethrowAsImport(error, fail);
  }
  assertAnalysisSemantics(parsed, fail);
  return parsed;
}

/** Strict guard for a plan payload; drafts only, confirmation-gated. */
export function parsePlanImportPayload(value: unknown, fail: Fail = responseFail): PlanDraft {
  assertImportJsonBounds(value, "(payload)", fail);
  let parsed: PlanDraft;
  try {
    parsed = parsePlanDraft(value);
  } catch (error) {
    rethrowAsImport(error, fail);
  }
  assertPlanSemantics(parsed, fail);
  return parsed;
}

function parsePayloadForKind(value: unknown, kind: ImportedArtifactKind, fail: Fail): AnalysisResult | PlanDraft {
  return kind === "analysis"
    ? parseAnalysisImportPayload(value, fail)
    : parsePlanImportPayload(value, fail);
}

function sourceRecordIdsFor(payload: AnalysisResult | PlanDraft): string[] {
  return "source_records" in payload ? [...payload.source_records] : [...payload.based_on.source_records];
}

/* ------------------------------------------------------------------------- */
/* Input validation                                                          */
/* ------------------------------------------------------------------------- */

function normalizeSourceFilename(value: unknown, fail: Fail): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail("source_filename", "must be a string or null");
  // Bound the raw input before normalization: a short basename must not hide
  // an arbitrarily large path prefix (or payload hidden in the name).
  if (value.length > IMPORT_MAX_FILENAME_LENGTH) {
    fail(
      "source_filename",
      `must be at most ${IMPORT_MAX_FILENAME_LENGTH} characters before path normalization`,
    );
  }
  if (value.includes("\u0000")) fail("source_filename", "must not contain NUL characters");
  const base = value.replace(/\\/g, "/").split("/").filter((part) => part !== "").pop() ?? "";
  if (base.trim() === "") return null;
  if (base.length > IMPORT_MAX_FILENAME_LENGTH) {
    fail("source_filename", `must be at most ${IMPORT_MAX_FILENAME_LENGTH} characters`);
  }
  return base;
}

function assertRequestBytes(value: unknown, fail: Fail): void {
  const bytes = byteLengthUtf8(stableStringify(value));
  if (bytes > IMPORT_MAX_REQUEST_BYTES) {
    fail("(request)", `exceeds the ${IMPORT_MAX_REQUEST_BYTES} byte import limit`);
  }
}

function assertRequestBounds(input: ImportArtifactInput, fail: Fail): void {
  assertRequestBytes(input, fail);
}

const ANALYSIS_KEYS = new Set(["period", "metrics", "trends", "flags", "source_records"]);
const PLAN_KEYS = new Set([
  "is_draft",
  "requires_confirmation",
  "goal",
  "based_on",
  "recommendations",
  "safety_notes",
  "professional_care_prompt",
]);
const IMPORT_INPUT_KEYS = new Set([
  "kind",
  "payload_schema_version",
  "payload",
  "source_filename",
]);
const METRICS_KEYS = new Set([
  "sessions",
  "total_sets",
  "total_reps",
  "volume_kg",
  "avg_rpe",
  "avg_rest_days",
  "max_gap_days",
]);

function unknownFieldWarnings(
  value: unknown,
  known: Set<string>,
  base: string,
): ValidationWarning[] {
  if (!isObject(value)) return [];
  const warnings: ValidationWarning[] = [];
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      warnings.push({
        code: "UNKNOWN_FIELD",
        message: `Unknown field \`${key}\` will be ignored`,
        path: base === "" ? key : `${base}.${key}`,
      });
    }
  }
  return warnings;
}

/** Unknown-field warnings for a (possibly enveloped) analysis/plan payload. */
export function importPayloadWarnings(
  payload: unknown,
  kind: ImportedArtifactKind,
): ValidationWarning[] {
  return payloadWarnings(payload, kind);
}

function payloadWarnings(payload: unknown, kind: ImportedArtifactKind): ValidationWarning[] {
  const warnings = unknownFieldWarnings(payload, kind === "analysis" ? ANALYSIS_KEYS : PLAN_KEYS, "");
  if (isObject(payload)) {
    if (isObject(payload.period)) {
      warnings.push(...unknownFieldWarnings(payload.period, new Set(["from", "to"]), "period"));
    }
    if (kind === "analysis" && isObject(payload.metrics)) {
      warnings.push(...unknownFieldWarnings(payload.metrics, METRICS_KEYS, "metrics"));
    }
    if (isObject(payload.based_on)) {
      warnings.push(
        ...unknownFieldWarnings(
          payload.based_on,
          new Set(["period", "sessions", "source_records"]),
          "based_on",
        ),
      );
    }
  }
  return warnings;
}

/**
 * Validate an untrusted `POST /imports` body (or an equivalent client call).
 * Bounds and semantics are checked here so every backend rejects identically.
 */
export function parseImportArtifactInput(value: unknown): {
  input: ImportArtifactInput;
  warnings: ValidationWarning[];
} {
  // Bound the raw, untrusted body first. Unknown extra fields (including long
  // object keys and deep unknown payloads) count toward the transport limit
  // even though normalization drops them from the returned input.
  assertImportJsonBounds(value, "(root)", importFail);
  assertRequestBytes(value, importFail);
  const root = assertObject(value, "(root)", importFail);
  const kind = root.kind;
  if (!isImportedArtifactKind(kind)) {
    importFail("kind", 'must be "analysis" or "plan"');
  }
  if (root.payload_schema_version !== IMPORTED_PAYLOAD_SCHEMA_VERSION) {
    importFail(
      "payload_schema_version",
      `must be ${IMPORTED_PAYLOAD_SCHEMA_VERSION}; other versions are not supported`,
    );
  }
  const payload = parsePayloadForKind(root.payload, kind, importFail);
  const input: ImportArtifactInput = {
    kind,
    payload_schema_version: IMPORTED_PAYLOAD_SCHEMA_VERSION,
    payload,
    source_filename: normalizeSourceFilename(root.source_filename, importFail),
  };
  // The normalized request is bounded too, so every backend enforces the same
  // limit even when called directly with an already-sanitized object.
  assertRequestBounds(input, importFail);
  return {
    input,
    warnings: [
      ...unknownFieldWarnings(root, IMPORT_INPUT_KEYS, "(root)"),
      ...payloadWarnings(root.payload, kind),
    ],
  };
}

/** Build the immutable canonical artifact for an already-validated input. */
export async function buildImportedArtifact<K extends ImportedArtifactKind>(
  input: ImportArtifactInput<K>,
  options: { created_at: string; source_filename?: string | null },
): Promise<ImportedArtifact<K>> {
  const payload = parsePayloadForKind(input.payload, input.kind, importFail) as ImportedArtifactPayloads[K];
  const digest = await artifactContentDigest(payload);
  return {
    id: importedArtifactId(input.kind, digest),
    kind: input.kind,
    schema_version: IMPORTED_ARTIFACT_SCHEMA_VERSION,
    payload_schema_version: IMPORTED_PAYLOAD_SCHEMA_VERSION,
    payload,
    source: "file_import",
    source_filename:
      options.source_filename !== undefined
        ? normalizeSourceFilename(options.source_filename, importFail)
        : normalizeSourceFilename(input.source_filename, importFail),
    source_record_ids: sourceRecordIdsFor(payload),
    content_digest: digest,
    created_at: options.created_at,
  };
}

/* ------------------------------------------------------------------------- */
/* Stored-artifact guards (corruption detection)                             */
/* ------------------------------------------------------------------------- */

function parseWarning(value: unknown, field: string, fail: Fail): ValidationWarning {
  const obj = assertObject(value, field, fail);
  const warning: ValidationWarning = {
    code: assertString(obj.code, `${field}.code`, fail),
    message: assertString(obj.message, `${field}.message`, fail),
  };
  if (obj.path !== undefined) warning.path = assertString(obj.path, `${field}.path`, fail);
  return warning;
}

export function parseImportedArtifactMeta(
  value: unknown,
  fail: Fail = responseFail,
): ImportedArtifactMeta {
  const root = assertObject(value, "(root)", fail);
  const kind = root.kind;
  if (!isImportedArtifactKind(kind)) fail("kind", 'must be "analysis" or "plan"');
  if (root.schema_version !== IMPORTED_ARTIFACT_SCHEMA_VERSION) {
    fail("schema_version", `must be ${IMPORTED_ARTIFACT_SCHEMA_VERSION}`);
  }
  if (root.payload_schema_version !== IMPORTED_PAYLOAD_SCHEMA_VERSION) {
    fail("payload_schema_version", `must be ${IMPORTED_PAYLOAD_SCHEMA_VERSION}`);
  }
  if (root.source !== "file_import") fail("source", 'must be "file_import"');
  if (root.content_digest === undefined || typeof root.content_digest !== "string" || !DIGEST_RE.test(root.content_digest)) {
    fail("content_digest", "must be a 64-character lowercase hex digest");
  }
  const contentDigest = root.content_digest;
  const expectedId = importedArtifactId(kind, contentDigest);
  const id = assertString(root.id, "id", fail);
  if (id !== expectedId) fail("id", "does not match the kind/content digest identity");
  if (id.length > IMPORT_MAX_ID_LENGTH) {
    fail("id", `must be at most ${IMPORT_MAX_ID_LENGTH} characters`);
  }

  const sourceFilename = assertStringOrNull(root.source_filename, "source_filename", fail);
  if (sourceFilename !== null && (sourceFilename === "" || sourceFilename.length > IMPORT_MAX_FILENAME_LENGTH)) {
    fail("source_filename", `must be a non-empty name of at most ${IMPORT_MAX_FILENAME_LENGTH} characters, or null`);
  }

  const sourceRecordIdsRaw = root.source_record_ids;
  if (!Array.isArray(sourceRecordIdsRaw)) fail("source_record_ids", "must be an array");
  if (sourceRecordIdsRaw.length > IMPORT_MAX_COLLECTION_LENGTH) {
    fail("source_record_ids", `must contain at most ${IMPORT_MAX_COLLECTION_LENGTH} entries`);
  }
  const sourceRecordIds = sourceRecordIdsRaw.map((entry, index) => {
    const idValue = assertString(entry, `source_record_ids[${index}]`, fail);
    if (idValue === "" || idValue.length > IMPORT_MAX_ID_LENGTH) {
      fail(
        `source_record_ids[${index}]`,
        `must be a non-empty id of at most ${IMPORT_MAX_ID_LENGTH} characters`,
      );
    }
    return idValue;
  });

  const createdAt = assertString(root.created_at, "created_at", fail);
  if (!isValidIsoDate(createdAt)) fail("created_at", "must be a valid ISO 8601 datetime");

  return {
    id,
    kind,
    schema_version: IMPORTED_ARTIFACT_SCHEMA_VERSION,
    payload_schema_version: IMPORTED_PAYLOAD_SCHEMA_VERSION,
    source: "file_import",
    source_filename: sourceFilename,
    source_record_ids: sourceRecordIds,
    content_digest: contentDigest,
    created_at: createdAt,
  };
}

/** Parse and verify a full stored artifact, recomputing its identity from the payload. */
export async function parseImportedArtifact(
  value: unknown,
  fail: Fail = responseFail,
): Promise<ImportedArtifact> {
  const meta = parseImportedArtifactMeta(value, fail);
  const root = assertObject(value, "(root)", fail);
  const payload = parsePayloadForKind(root.payload, meta.kind, fail);
  const digest = await artifactContentDigest(payload);
  if (meta.content_digest !== digest) {
    fail("content_digest", "does not match the canonical payload");
  }
  const derivedIds = sourceRecordIdsFor(payload);
  if (stableStringify(meta.source_record_ids) !== stableStringify(derivedIds)) {
    fail("source_record_ids", "does not match the canonical payload");
  }
  return { ...meta, payload } as ImportedArtifact;
}

export async function parseSaveImportedArtifactResult(
  value: unknown,
  fail: Fail = responseFail,
): Promise<SaveImportedArtifactResult> {
  const root = assertObject(value, "(root)", fail);
  const artifact = await parseImportedArtifact(root.artifact, fail);
  if (typeof root.duplicate !== "boolean") fail("duplicate", "must be a boolean");
  if (!Array.isArray(root.warnings)) fail("warnings", "must be an array");
  const warnings = root.warnings.map((entry, index) =>
    parseWarning(entry, `warnings[${index}]`, fail),
  );
  return { artifact, duplicate: root.duplicate, warnings };
}

/* ------------------------------------------------------------------------- */
/* Cursors and list queries                                                  */
/* ------------------------------------------------------------------------- */

export function encodeArtifactCursor(cursor: ArtifactCursor): string {
  return JSON.stringify({
    v: 1,
    kind: cursor.kind,
    created_at: cursor.created_at,
    id: cursor.id,
  });
}

export function decodeArtifactCursor(
  value: string,
  expectedKind?: ImportedArtifactKind,
  fail: Fail = importFail,
): ArtifactCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("cursor", "is not valid");
  }
  if (!isObject(parsed)) fail("cursor", "is not valid");
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "created_at,id,kind,v") fail("cursor", "is not valid");
  if (parsed.v !== 1) fail("cursor", "uses an unsupported version");
  if (!isImportedArtifactKind(parsed.kind)) fail("cursor", "has an invalid kind");
  if (expectedKind !== undefined && parsed.kind !== expectedKind) {
    fail("cursor", "belongs to a different kind");
  }
  if (typeof parsed.created_at !== "string" || !isValidIsoDate(parsed.created_at)) {
    fail("cursor", "has an invalid created_at");
  }
  if (
    typeof parsed.id !== "string" ||
    parsed.id === "" ||
    parsed.id.length > IMPORT_MAX_ID_LENGTH
  ) {
    fail("cursor", "has an invalid id");
  }
  return { kind: parsed.kind, created_at: parsed.created_at, id: parsed.id };
}

export interface NormalizedListImportedArtifactsQuery {
  kind?: ImportedArtifactKind;
  limit: number;
  cursor: ArtifactCursor | null;
}

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Exact instant key in UTC microseconds.
 *
 * `Date.parse` truncates to milliseconds, so two distinct stored timestamps
 * can collide and the keyset would then fall back to the id. The key keeps the
 * full stored fraction (padded/truncated to microseconds) and normalizes
 * offsets, so equivalent instants in different representations compare equal
 * while sub-millisecond ordering is preserved. A date-only value is midnight
 * UTC. Inputs that do not match the accepted ISO shape fall back to
 * millisecond precision.
 */
function instantKey(value: string): bigint {
  const match = INSTANT_RE.exec(value);
  if (match === null) {
    return BigInt(Math.trunc(Date.parse(value))) * 1000n;
  }
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const millis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? "0"),
    Number(minute ?? "0"),
    Number(second ?? "0"),
  );
  let offsetSeconds = 0;
  if (offset !== undefined && offset !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const [offsetHours, offsetMinutes] = offset.slice(1).split(":");
    offsetSeconds = sign * (Number(offsetHours) * 3600 + Number(offsetMinutes) * 60);
  }
  const fractionMicros = BigInt(((fraction ?? "") + "000000").slice(0, 6));
  return BigInt(Math.floor(millis / 1000) - offsetSeconds) * 1_000_000n + fractionMicros;
}

/** Newest-first metadata order used by every backend: `(created_at DESC, id DESC)`. */
export function compareImportedArtifactMeta(
  a: ImportedArtifactMeta,
  b: ImportedArtifactMeta,
): number {
  const aKey = instantKey(a.created_at);
  const bKey = instantKey(b.created_at);
  if (aKey !== bKey) return aKey < bKey ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Apply the shared keyset window to already-loaded metadata rows. */
export function applyImportedArtifactKeyset(
  rows: ImportedArtifactMeta[],
  query: NormalizedListImportedArtifactsQuery,
): ImportedArtifactMeta[] {
  let filtered =
    query.kind === undefined ? rows : rows.filter((row) => row.kind === query.kind);
  filtered = [...filtered].sort(compareImportedArtifactMeta);
  const cursor = query.cursor;
  if (cursor !== null) {
    const cursorKey = instantKey(cursor.created_at);
    filtered = filtered.filter((row) => {
      const rowKey = instantKey(row.created_at);
      if (rowKey !== cursorKey) return rowKey < cursorKey;
      return row.id < cursor.id;
    });
  }
  return filtered.slice(0, query.limit);
}

export function normalizeListImportedArtifactsQuery(
  query: ListImportedArtifactsQuery = {},
  fail: Fail = importFail,
): NormalizedListImportedArtifactsQuery {
  if (query.kind !== undefined && !isImportedArtifactKind(query.kind)) {
    fail("kind", 'must be "analysis" or "plan"');
  }
  const limit = query.limit ?? IMPORT_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > IMPORT_LIST_MAX_LIMIT) {
    fail("limit", `must be an integer from 1 to ${IMPORT_LIST_MAX_LIMIT}`);
  }
  const cursor =
    query.cursor === undefined || query.cursor === null
      ? null
      : decodeArtifactCursor(query.cursor, query.kind, fail);
  return { ...(query.kind === undefined ? {} : { kind: query.kind }), limit, cursor };
}

export function parseListImportedArtifactsParams(
  params: URLSearchParams,
): NormalizedListImportedArtifactsQuery {
  for (const key of params.keys()) {
    if (key !== "kind" && key !== "limit" && key !== "cursor") {
      importFail("query", `contains an unknown parameter \`${key}\``);
    }
  }
  for (const key of ["kind", "limit", "cursor"]) {
    if (params.getAll(key).length > 1) importFail(key, "must appear at most once");
  }

  const kindRaw = params.get("kind");
  const kind =
    kindRaw === null
      ? undefined
      : isImportedArtifactKind(kindRaw)
        ? kindRaw
        : importFail("kind", 'must be "analysis" or "plan"');

  const limitRaw = params.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) importFail("limit", "must be a positive integer");
    limit = Number(limitRaw);
  }
  const cursorRaw = params.get("cursor");
  return normalizeListImportedArtifactsQuery(
    {
      ...(kind === undefined ? {} : { kind }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursorRaw === null ? {} : { cursor: cursorRaw }),
    },
    importFail,
  );
}

export function parseImportedArtifactPage(
  value: unknown,
  fail: Fail = responseFail,
): ImportedArtifactPage {
  const root = assertObject(value, "(root)", fail);
  if (!Array.isArray(root.items)) fail("items", "must be an array");
  if (root.items.length > IMPORT_LIST_MAX_LIMIT) {
    fail("items", `must contain at most ${IMPORT_LIST_MAX_LIMIT} entries`);
  }
  const items = root.items.map((entry, index) =>
    parseImportedArtifactMeta(entry, (field, reason) => fail(`items[${index}].${field}`, reason)),
  );
  let nextCursor: string | null;
  if (root.next_cursor === null) {
    nextCursor = null;
  } else if (typeof root.next_cursor === "string") {
    decodeArtifactCursor(root.next_cursor, undefined, fail);
    nextCursor = root.next_cursor;
  } else {
    fail("next_cursor", "must be a string or null");
  }
  return { items, next_cursor: nextCursor };
}

/* ------------------------------------------------------------------------- */
/* Selection / adoption guards                                               */
/* ------------------------------------------------------------------------- */

function assertArtifactId(value: unknown, field: string, fail: Fail): string {
  const id = assertString(value, field, fail);
  if (id === "" || id.length > IMPORT_MAX_ID_LENGTH) {
    fail(field, `must be a non-empty id of at most ${IMPORT_MAX_ID_LENGTH} characters`);
  }
  return id;
}

export function parseArtifactSelection(
  value: unknown,
  fail: Fail = responseFail,
): ArtifactSelection {
  const root = assertObject(value, "(root)", fail);
  if (root.artifact_id === null) return { artifact_id: null };
  return { artifact_id: assertArtifactId(root.artifact_id, "artifact_id", fail) };
}

/** Request guard for `PUT /import-selections/:kind` (400 on invalid input). */
export function parseArtifactSelectionRequest(value: unknown): ArtifactSelection {
  return parseArtifactSelection(value, importFail);
}

/** Strict id guard shared by routes and stores. */
export function parseImportedArtifactId(value: unknown): string {
  return assertArtifactId(value, "id", importFail);
}

export function parsePlanAdoptionRequest(value: unknown): PlanAdoptionInput | null {
  if (value === null) return null;
  const root = assertObject(value, "(root)", importFail);
  const artifactId = assertArtifactId(root.artifact_id, "artifact_id", importFail);
  const digest = assertString(root.confirmed_digest, "confirmed_digest", importFail);
  if (!DIGEST_RE.test(digest)) importFail("confirmed_digest", "must be a lowercase hex SHA-256 digest");
  return { artifact_id: artifactId, confirmed_digest: digest };
}

export function parsePlanAdoption(
  value: unknown,
  fail: Fail = responseFail,
): PlanAdoption | null {
  if (value === null) return null;
  const root = assertObject(value, "(root)", fail);
  const artifactId = assertArtifactId(root.artifact_id, "artifact_id", fail);
  const digest = assertString(root.confirmed_digest, "confirmed_digest", fail);
  if (!DIGEST_RE.test(digest)) fail("confirmed_digest", "must be a lowercase hex SHA-256 digest");
  const confirmedAt = assertString(root.confirmed_at, "confirmed_at", fail);
  if (!isValidIsoDate(confirmedAt)) fail("confirmed_at", "must be a valid ISO 8601 datetime");
  return { artifact_id: artifactId, confirmed_digest: digest, confirmed_at: confirmedAt };
}
