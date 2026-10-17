import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  analyzeProgress,
  generateNextPlan,
  stableStringify,
  validateWorkoutRecord,
} from "@pi-fit-trace/core";
import type { AnalysisResult, PlanDraft, WorkoutRecord } from "@pi-fit-trace/core";
import {
  API_ERROR_CODES,
  IMPORT_MAX_FILENAME_LENGTH,
  IMPORT_MAX_JSON_KEY_LENGTH,
  IMPORT_MAX_REQUEST_BYTES,
  WORKOUT_MAX_ID_BYTES,
  WORKOUT_MAX_REQUEST_BYTES,
  artifactContentDigest,
  applyImportedArtifactKeyset,
  buildImportedArtifact,
  compareImportedArtifactMeta,
  decodeArtifactCursor,
  encodeArtifactCursor,
  importedArtifactId,
  parseArtifactImportFile,
  parseImportArtifactInput,
  parseImportedArtifact,
  parseImportedArtifactMeta,
  parsePlanImportFile,
  parseWorkoutImportFile,
  sha256Hex,
} from "@pi-fit-trace/api-contracts";
import type {
  ImportArtifactInput,
  ImportedArtifact,
  ImportedArtifactMeta,
  NormalizedListImportedArtifactsQuery,
} from "@pi-fit-trace/api-contracts";
import { createMemoryHandler } from "@pi-fit-trace/api-contracts/testing";
import { LocalFitTraceClient } from "../app/src/api/localFitTraceClient.ts";
import { MemoryStorageAdapter, StorageUnavailableError } from "../app/src/storage/adapter.ts";
import {
  artifactSelectionKey,
  importedArtifactKey,
  planAdoptionKey,
} from "../app/src/storage/importRepository.ts";
import { createSupabaseImportMethods } from "../server/db/supabaseImports.ts";
import { createInMemoryWorkoutStore } from "../server/inMemoryWorkoutStore.ts";

/**
 * Unit coverage for the import boundary: shared identity/bounds, file
 * parsers, local persistence, the in-memory store + routes, and the mocked
 * Supabase RPC mapping. Cross-client parity lives in the contract suite;
 * real RLS is only proven by the opt-in Supabase integration test.
 */

function seedRecord(over: Partial<WorkoutRecord> & { id: string; date: string }): WorkoutRecord {
  return validateWorkoutRecord({
    schema_version: 1,
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
    ...over,
  }).record;
}

const workout = seedRecord({ id: "w-import-1", date: "2026-09-01" });

function analysisPayload(over: { weight?: number; date?: string } = {}): AnalysisResult {
  return analyzeProgress([
    seedRecord({
      id: `w-analysis-${over.weight ?? 80}`,
      date: over.date ?? "2026-09-01",
      exercises: [{ name: "bench_press", sets: [{ weight: over.weight ?? 80, reps: 5, rpe: 7 }] }],
    }),
  ]);
}

function planPayload(): PlanDraft {
  return generateNextPlan([workout], { goal: "add 5 kg to bench" });
}

/** Build a valid analysis whose normalized request body is close to `target` bytes. */
function analysisAtRequestSize(target: number): AnalysisResult {
  const payload = analysisPayload();
  payload.flags = [];
  const request = {
    kind: "analysis" as const,
    payload_schema_version: 1,
    payload,
  };
  const encoder = new TextEncoder();
  const size = () => encoder.encode(stableStringify(request)).length;
  let index = 0;
  while (size() < target - 3_200) {
    payload.flags.push({
      code: `F${index}`,
      severity: "info",
      message: "m".repeat(3_000),
      evidence: {},
    });
    index += 1;
  }
  const last = { code: "LAST", severity: "info" as const, message: "", evidence: {} };
  payload.flags.push(last);
  last.message = "m".repeat(Math.max(1, target - size()));
  return payload;
}

function analysisInput(): ImportArtifactInput<"analysis"> {
  return { kind: "analysis", payload_schema_version: 1, payload: analysisPayload() };
}

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Upper bound for PostgreSQL's `jsonb::text` size: the compact stable JSON
 * plus the one space it inserts after every comma and colon. (Object key order
 * does not change the length.)
 */
function estimateJsonbTextBytes(value: unknown): number {
  let separators = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      separators += Math.max(0, node.length - 1);
      node.forEach(walk);
      return;
    }
    if (typeof node === "object" && node !== null) {
      const members = Object.entries(node);
      separators += members.length + Math.max(0, members.length - 1);
      for (const [, child] of members) walk(child);
    }
  };
  walk(value);
  return byteLengthUtf8(stableStringify(value)) + separators;
}

function planInput(): ImportArtifactInput<"plan"> {
  return { kind: "plan", payload_schema_version: 1, payload: planPayload() };
}

function errorCode(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "resolved",
    (error: unknown) => String((error as { code?: string }).code),
  );
}

/* ------------------------------------------------------------------------- */
/* Shared identity and bounds                                                */
/* ------------------------------------------------------------------------- */

test("sha256Hex matches standard and Node crypto vectors, including multi-block input", async () => {
  const vectors = [
    "",
    "abc",
    "a".repeat(1000),
    "unicode-你好-🏋️",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(4096),
  ];
  for (const input of vectors) {
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    assert.equal(await sha256Hex(input), expected, `digest mismatch for ${input.length} bytes`);
  }
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    await sha256Hex("a".repeat(1000)),
    "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
  );
});

test("artifact ids are canonical payload digests, not caller-supplied", async () => {
  const payload = analysisPayload();
  const canonical = stableStringify(payload);
  const digest = await artifactContentDigest(payload);
  assert.equal(digest, createHash("sha256").update(canonical, "utf8").digest("hex"));
  assert.equal(digest, await sha256Hex(canonical));
  assert.equal(importedArtifactId("analysis", digest), `analysis:v1:${digest}`);

  const artifact = await buildImportedArtifact(analysisInput(), {
    created_at: "2026-10-17T00:00:00.000Z",
  });
  assert.equal(artifact.id, `analysis:v1:${digest}`);
  assert.equal(artifact.content_digest, digest);
  assert.deepEqual(artifact.source_record_ids, ["w-analysis-80"]);
  assert.deepEqual(await parseImportedArtifact(artifact), artifact);
});

test("payload bounds reject unsupported versions, invalid values, and oversized requests", () => {
  const badVersion = { ...analysisInput(), payload_schema_version: 2 };
  assert.throws(() => parseImportArtifactInput(badVersion), /payload_schema_version/);

  const badDate = structuredClone(analysisPayload());
  badDate.period.from = "not-a-date";
  assert.throws(
    () => parseImportArtifactInput({ ...analysisInput(), payload: badDate }),
    /period\.from/,
  );

  const fractional = structuredClone(analysisPayload());
  fractional.metrics.sessions = 1.5;
  assert.throws(
    () => parseImportArtifactInput({ ...analysisInput(), payload: fractional }),
    /metrics\.sessions/,
  );

  const badRpe = structuredClone(analysisPayload());
  badRpe.metrics.avg_rpe = 11;
  assert.throws(
    () => parseImportArtifactInput({ ...analysisInput(), payload: badRpe }),
    /metrics\.avg_rpe/,
  );

  const longId = structuredClone(analysisPayload());
  longId.source_records = ["x".repeat(257)];
  assert.throws(
    () => parseImportArtifactInput({ ...analysisInput(), payload: longId }),
    /source_records\[0\]/,
  );

  const oversized = structuredClone(analysisPayload());
  oversized.flags = Array.from({ length: 20 }, (_, index) => ({
    code: `F${index}`,
    severity: "info" as const,
    message: "m".repeat(4000),
    evidence: {},
  }));
  assert.throws(
    () => parseImportArtifactInput({ ...analysisInput(), payload: oversized }),
    /\(request\)/,
  );

  const deep = { ...analysisPayload() } as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> = deep;
  for (let i = 0; i < 20; i += 1) {
    const next: Record<string, unknown> = {};
    cursor.extra = next;
    cursor = next;
  }
  assert.throws(() => parseImportArtifactInput({ ...analysisInput(), payload: deep }), /depth/);
});

test("untrusted extras and filenames are bounded before normalization", () => {
  // A huge unknown root field would be dropped by normalization; it must
  // still count toward the transport limit.
  assert.throws(
    () =>
      parseImportArtifactInput({
        ...analysisInput(),
        extra: Array.from({ length: 20 }, () => "x".repeat(4000)),
      }),
    /\(request\)/,
  );

  // Deep unknown root payloads are bounded before normalization too.
  const deepRoot: Record<string, unknown> = { ...analysisInput() };
  let cursor: Record<string, unknown> = deepRoot;
  for (let depth = 0; depth < 20; depth += 1) {
    const next: Record<string, unknown> = {};
    cursor.unknown = next;
    cursor = next;
  }
  assert.throws(() => parseImportArtifactInput(deepRoot), /depth/);

  // Object keys themselves are bounded.
  const longKey = "k".repeat(IMPORT_MAX_JSON_KEY_LENGTH + 1);
  assert.throws(
    () =>
      parseImportArtifactInput({
        ...analysisInput(),
        [longKey]: true,
      }),
    /object key/,
  );

  // The raw filename is bounded before basename normalization, so a long
  // path prefix cannot smuggle bytes past the check.
  assert.throws(
    () =>
      parseImportArtifactInput({
        ...analysisInput(),
        source_filename: `${"d".repeat(IMPORT_MAX_FILENAME_LENGTH)}/analysis.json`,
      }),
    /before path normalization/,
  );

  const { warnings } = parseImportArtifactInput({
    ...analysisInput(),
    extra: true,
    payload: { ...analysisPayload(), extra: true },
  });
  assert.ok(warnings.some((warning) => warning.path === "(root).extra"));
  assert.ok(warnings.some((warning) => warning.path === "extra"));
});

test("non-finite analysis metrics are rejected by the core validator", () => {
  const badWeight = structuredClone(analysisPayload()) as unknown as {
    metrics: { volume_kg: number };
  };
  badWeight.metrics.volume_kg = Number.NaN;
  assert.throws(
    () => parseImportArtifactInput({ ...analysisInput(), payload: badWeight }),
    /finite/,
  );
});

/* ------------------------------------------------------------------------- */
/* File parsers                                                              */
/* ------------------------------------------------------------------------- */

function workoutFile(records: unknown[], schemaVersion: unknown = 1): string {
  return JSON.stringify({ schema_version: schemaVersion, records });
}

test("workout files keep original ids, merge identical repeats, and reject conflicts", () => {
  const second = seedRecord({ id: "w-import-2", date: "2026-09-02" });
  const parsed = parseWorkoutImportFile(workoutFile([workout, workout, second]));
  assert.deepEqual(
    parsed.entries.map((entry) => ({ id: entry.record.id, indexes: entry.indexes })),
    [
      { id: workout.id, indexes: [0, 1] },
      { id: second.id, indexes: [2] },
    ],
  );

  const conflicting = seedRecord({
    id: workout.id,
    date: workout.date,
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }],
  });
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([workout, conflicting])),
    /duplicates id/,
  );
});

test("workout files keep warnings for every original duplicate index", () => {
  const warned = { ...workout, extra: true };
  const reordered = Object.fromEntries(Object.entries(warned).reverse());

  const parsed = parseWorkoutImportFile(workoutFile([warned, reordered]));
  assert.deepEqual(parsed.entries[0]?.indexes, [0, 1]);
  assert.deepEqual(
    parsed.warnings.map((warning) => warning.path),
    ["records[0].extra", "records[1].extra"],
  );

  const conflict = { ...warned, date: "2026-09-02" };
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([warned, conflict])),
    /duplicates id/,
  );
});

test("workout files enforce version, record count, byte size, and per-record validity", () => {
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([], 2)),
    /version 2 is not supported/,
  );
  assert.throws(
    () => parseWorkoutImportFile(workoutFile(Array.from({ length: 1001 }, () => ({})))),
    /at most 1000/,
  );
  assert.throws(
    () => parseWorkoutImportFile(" ".repeat(1024 * 1024 + 1)),
    /byte file limit/,
  );
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([{ ...workout, exercises: [] }])),
    /records\[0\]/,
  );
});

test("workout files accept large valid records that local saves allow", () => {
  const hugeRecord = seedRecord({
    id: "w-huge",
    date: "2026-09-01",
    exercises: Array.from({ length: 100 }, (_, exerciseIndex) => ({
      name: `exercise-${exerciseIndex}`,
      sets: Array.from({ length: 100 }, () => ({ weight: 1, reps: 1 })),
    })),
  });
  // The snapshot request cap is deliberately tighter than the workout restore
  // bound; this valid workout must not be rejected merely for exceeding it.
  const requestBytes = new TextEncoder().encode(stableStringify({ record: hugeRecord })).length;
  assert.ok(requestBytes > IMPORT_MAX_REQUEST_BYTES, "fixture must exceed the snapshot cap");
  assert.ok(requestBytes <= WORKOUT_MAX_REQUEST_BYTES);
  assert.equal(
    parseWorkoutImportFile(workoutFile([hugeRecord])).entries[0]?.record.id,
    "w-huge",
  );

  // Locally saved records are only bounded by the workout validator and the
  // file byte cap, so import must not impose tighter string/exercise/set caps.
  const notesRecord = seedRecord({
    id: "w-notes",
    date: "2026-09-02",
    notes: "n".repeat(50_000),
  });
  assert.equal(
    parseWorkoutImportFile(workoutFile([notesRecord])).entries[0]?.record.notes?.length,
    50_000,
  );

  const manyExercises = seedRecord({
    id: "w-many",
    date: "2026-09-03",
    exercises: Array.from({ length: 101 }, (_, index) => ({
      name: `exercise-${index}`,
      sets: [{ weight: 1, reps: 1 }],
    })),
  });
  assert.equal(
    parseWorkoutImportFile(workoutFile([manyExercises])).entries[0]?.record.exercises.length,
    101,
  );
});

test("workout files accept 300-character ids and enforce the btree-safe byte bound", () => {
  // Workout ids index the Supabase `workouts` primary key `(owner_id, id)`.
  // PostgreSQL sizes btree entries in UTF-8 bytes, and 1024 bytes stays far
  // below the roughly 2.7 KiB btree entry limit. The wider bound keeps an
  // existing 300-character id restorable instead of letting the backup/restore
  // contract reject history the app once accepted.
  assert.equal(WORKOUT_MAX_ID_BYTES, 1024);
  const legacy = seedRecord({ id: "w".repeat(300), date: "2026-09-01" });
  assert.equal(
    parseWorkoutImportFile(workoutFile([legacy])).entries[0]?.record.id.length,
    300,
  );

  // Without the bound, an 8 KiB id would pass the 1 MiB file bound and preview,
  // then fail the Supabase `workouts` primary key during a sequential restore
  // after earlier records had already been saved.
  const oversized = seedRecord({ id: "w".repeat(8 * 1024), date: "2026-09-02" });
  // The first record is valid; the whole file must still fail preview, so the
  // sequential restore can never save it and then stop at the oversized id.
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([workout, oversized])),
    new RegExp(
      `\`records\\[1\\]\\.id\` must be at most ${WORKOUT_MAX_ID_BYTES} UTF-8 bytes`,
    ),
  );

  // The bound counts bytes, not UTF-16 code units: two-byte characters cost
  // two bytes each. 512 of them is exactly at the inclusive bound.
  const atByteBound = seedRecord({ id: "é".repeat(512), date: "2026-09-03" });
  assert.equal(
    parseWorkoutImportFile(workoutFile([atByteBound])).entries[0]?.record.id.length,
    512,
  );
  const overByteBound = seedRecord({ id: "é".repeat(513), date: "2026-09-04" });
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([overByteBound])),
    new RegExp(`at most ${WORKOUT_MAX_ID_BYTES} UTF-8 bytes`),
  );

  // The id bound only applies to the indexed id: a normal id with notes beyond
  // every snapshot field cap stays restorable.
  const largeNotes = seedRecord({
    id: "w-large-notes",
    date: "2026-09-05",
    notes: "n".repeat(50_000),
  });
  assert.equal(
    parseWorkoutImportFile(workoutFile([largeNotes])).entries[0]?.record.notes?.length,
    50_000,
  );
});

test("workout files preserve fractional weights but reject fractional reps", () => {
  const fractionalWeight = {
    ...workout,
    id: "w-fractional",
    exercises: [
      {
        name: "squat",
        sets: [
          { weight: 1.25, reps: 5 },
          { weight: 2.5, reps: 3 },
        ],
      },
    ],
  };
  const parsed = parseWorkoutImportFile(workoutFile([fractionalWeight]));
  assert.deepEqual(
    parsed.entries[0]?.record.exercises[0]?.sets.map((set) => ({
      weight: set.weight,
      reps: set.reps,
    })),
    [
      { weight: 1.25, reps: 5 },
      { weight: 2.5, reps: 3 },
    ],
  );

  const fractionalReps = {
    ...workout,
    id: "w-fractional-reps",
    exercises: [{ name: "squat", sets: [{ weight: 2.5, reps: 2.5 }] }],
  };
  assert.throws(
    () => parseWorkoutImportFile(workoutFile([fractionalReps])),
    /records\[0\]/,
  );
});

test("analysis and plan files support bare payloads and the explicit v1 envelope", () => {
  const bare = parseArtifactImportFile(JSON.stringify(analysisPayload()), "analysis");
  assert.deepEqual(bare.input.payload, analysisPayload());
  assert.equal(bare.input.kind, "analysis");

  const enveloped = parsePlanImportFile(
    JSON.stringify({
      kind: "plan",
      schema_version: 1,
      payload_schema_version: 1,
      payload: planPayload(),
    }),
  );
  assert.deepEqual(enveloped.input.payload, planPayload());

  assert.throws(
    () =>
      parseArtifactImportFile(
        JSON.stringify({ kind: "plan", schema_version: 1, payload_schema_version: 1, payload: planPayload() }),
        "analysis",
      ),
    /this file was selected as analysis/,
  );
  assert.throws(
    () =>
      parseArtifactImportFile(
        JSON.stringify({ kind: "analysis", schema_version: 1, payload_schema_version: 2, payload: analysisPayload() }),
        "analysis",
      ),
    /payload_schema_version/,
  );

  const bareWarnings = parseArtifactImportFile(
    JSON.stringify({ ...analysisPayload(), extra: true }),
    "analysis",
  );
  assert.deepEqual(
    bareWarnings.warnings.map((warning) => warning.path),
    ["extra"],
  );
  const envelopeWarnings = parsePlanImportFile(
    JSON.stringify({
      kind: "plan",
      schema_version: 1,
      payload_schema_version: 1,
      payload: { ...planPayload(), extra: true },
    }),
  );
  assert.deepEqual(
    envelopeWarnings.warnings.map((warning) => warning.path),
    ["payload.extra"],
  );
});

test("artifact files count unknown envelope metadata toward the request bound", () => {
  const oversized = structuredClone(analysisPayload());
  oversized.flags = Array.from({ length: 20 }, (_, index) => ({
    code: `F${index}`,
    severity: "info" as const,
    message: "m".repeat(4000),
    evidence: {},
  }));
  assert.throws(
    () => parseArtifactImportFile(JSON.stringify(oversized), "analysis"),
    /\(request\)/,
  );

  // Small unknown envelope metadata is still bounded by the request limit and
  // reported as a warning; it is not silently dropped from the size check.
  const accepted = parseArtifactImportFile(
    JSON.stringify({
      kind: "analysis",
      schema_version: 1,
      payload_schema_version: 1,
      payload: analysisPayload(),
      metadata: true,
    }),
    "analysis",
  );
  assert.equal(accepted.input.kind, "analysis");
  assert.deepEqual(accepted.input.payload, analysisPayload());
  assert.deepEqual(
    accepted.warnings.map((warning) => warning.path),
    ["metadata"],
  );

  const oversizedMetadata = Array.from({ length: 30 }, () => "m".repeat(3000));
  assert.throws(
    () =>
      parseArtifactImportFile(
        JSON.stringify({
          kind: "analysis",
          schema_version: 1,
          payload_schema_version: 1,
          payload: analysisPayload(),
          metadata: oversizedMetadata,
        }),
        "analysis",
      ),
    /\(request\)/,
  );
});

test("artifact files validate and include their final source filename", () => {
  const text = JSON.stringify(analysisPayload());

  const named = parseArtifactImportFile(text, "analysis", {
    sourceFilename: "/tmp/exports/analysis.json",
  });
  assert.equal(named.input.source_filename, "analysis.json");

  assert.throws(
    () =>
      parseArtifactImportFile(text, "analysis", {
        sourceFilename: "f".repeat(IMPORT_MAX_FILENAME_LENGTH + 1),
      }),
    /source_filename/,
  );

  // The normalized request bound must include the final filename: a payload
  // that just fits without the name must not sneak past once it is attached.
  // Leave room for the normalized `source_filename: null` envelope field; the
  // attached 255-character name still pushes the same payload over the bound.
  const nearLimit = analysisAtRequestSize(IMPORT_MAX_REQUEST_BYTES - 100);
  const nearLimitText = JSON.stringify(nearLimit);
  assert.doesNotThrow(() => parseArtifactImportFile(nearLimitText, "analysis"));
  assert.throws(
    () =>
      parseArtifactImportFile(nearLimitText, "analysis", {
        sourceFilename: "f".repeat(IMPORT_MAX_FILENAME_LENGTH),
      }),
    /\(request\)/,
  );
});

test("the shared request cap stays below both SQL jsonb text guards", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/20261017000000_imported_artifacts.sql", import.meta.url),
    "utf8",
  );
  const guards = [...sql.matchAll(/octet_length\(p(?:_payload|ayload)?::text\)\s*(?:<=|>)\s*(\d+)/g)]
    .map((match) => Number(match[1]));
  assert.equal(guards.length, 2, "expected the table and RPC payload guards");
  assert.deepEqual([...new Set(guards)], [65536]);

  // PostgreSQL inserts one space after every comma/colon. Even the worst case
  // (arrays of one-byte values) therefore adds at most 50%, so the largest
  // accepted request remains below the 64 KiB SQL checks instead of passing
  // preview and failing at save time.
  const worstCaseJsonbTextBytes = Math.ceil(IMPORT_MAX_REQUEST_BYTES * 1.5);
  assert.ok(
    worstCaseJsonbTextBytes <= guards[0]!,
    `${IMPORT_MAX_REQUEST_BYTES} B compact can expand to ${worstCaseJsonbTextBytes} B jsonb text`,
  );
});

test("separator-heavy payloads are rejected by the shared cap, not the database", () => {
  const payload = analysisPayload();
  payload.flags = [
    ...Array.from({ length: 14 }, (_, index) => ({
      code: `ZERO_${index}`,
      severity: "info" as const,
      message: "zeros",
      evidence: { zeros: Array.from({ length: 1000 }, () => 0) },
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      code: `MESSAGE_${index}`,
      severity: "info" as const,
      message: "m".repeat(2800),
      evidence: {},
    })),
  ];
  const input = { kind: "analysis" as const, payload_schema_version: 1, payload };

  // Shape of the reported bug: compact JSON fits under the old 60 KiB cap but
  // PostgreSQL's separator spaces would push it over the 64 KiB SQL guard.
  assert.ok(byteLengthUtf8(stableStringify(input)) < 60 * 1024);
  assert.ok(estimateJsonbTextBytes(payload) > 65536);

  // The aligned shared cap rejects it during preview/file validation, so it
  // never reaches the SQL save path with a false "valid" result.
  assert.throws(() => parseImportArtifactInput(input), /\(request\)/);
});

test("whitespace-only source filenames normalize to null", () => {
  for (const source_filename of ["   ", "\t", "dir/   "]) {
    const { input } = parseImportArtifactInput({
      ...analysisInput(),
      source_filename,
    });
    assert.equal(input.source_filename, null);
  }
});

test("cursors are strict JSON and bound to their kind", () => {
  const cursor = { kind: "analysis" as const, created_at: "2026-10-17T00:00:00.000Z", id: "a" };
  const encoded = encodeArtifactCursor(cursor);
  assert.deepEqual(decodeArtifactCursor(encoded), cursor);
  assert.throws(() => decodeArtifactCursor(encoded, "plan"), /different kind/);
  assert.throws(() => decodeArtifactCursor("not-json"), /not valid/);
  assert.throws(
    () => decodeArtifactCursor(JSON.stringify({ ...cursor, extra: true })),
    /not valid/,
  );
  assert.throws(
    () =>
      decodeArtifactCursor(
        JSON.stringify({ v: 1, kind: "analysis", created_at: "nope", id: "a" }),
      ),
    /created_at/,
  );
});

test("artifact ordering compares exact instants, not raw strings", () => {
  const meta = (over: Pick<ImportedArtifactMeta, "id" | "created_at">): ImportedArtifactMeta => ({
    kind: "analysis",
    schema_version: 1,
    payload_schema_version: 1,
    source: "file_import",
    source_filename: null,
    source_record_ids: [],
    content_digest: "0".repeat(64),
    ...over,
  });

  const later = meta({ id: "a", created_at: "2026-10-17T00:00:00.000001Z" });
  const earlier = meta({ id: "b", created_at: "2026-10-17T00:00:00.000000Z" });
  assert.ok(compareImportedArtifactMeta(later, earlier) < 0);
  assert.ok(compareImportedArtifactMeta(earlier, later) > 0);

  // Equivalent instants in different offsets tie and fall back to id DESC.
  const utc = meta({ id: "z", created_at: "2026-10-17T00:00:00.000Z" });
  const offset = meta({ id: "a", created_at: "2026-10-17T02:00:00.000+02:00" });
  assert.ok(compareImportedArtifactMeta(utc, offset) < 0);
  assert.ok(compareImportedArtifactMeta(offset, utc) > 0);

  // A row one microsecond older than the cursor must still be included even
  // though Date.parse truncates both to the same millisecond; the id order
  // alone would have excluded it.
  const query: NormalizedListImportedArtifactsQuery = {
    limit: 10,
    cursor: { kind: "analysis", created_at: "2026-10-17T00:00:00.000001Z", id: "a" },
  };
  const olderMicro = meta({ id: "z", created_at: "2026-10-17T00:00:00.000000Z" });
  const newerMicro = meta({ id: "0", created_at: "2026-10-17T00:00:00.000002Z" });
  assert.deepEqual(
    applyImportedArtifactKeyset([olderMicro, newerMicro], query).map((row) => row.id),
    ["z"],
  );
});

/* ------------------------------------------------------------------------- */
/* Local persistence                                                         */
/* ------------------------------------------------------------------------- */

test("local artifacts are owner-namespaced and survive a client restart", async () => {
  const adapter = new MemoryStorageAdapter();
  const ownerA = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });
  const saved = await ownerA.saveImportedArtifact(analysisInput());

  const restarted = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });
  assert.deepEqual(await restarted.getImportedArtifact(saved.artifact.id), saved.artifact);

  const ownerB = new LocalFitTraceClient(adapter, { ownerId: "owner-b" });
  assert.deepEqual(await ownerB.listImportedArtifacts(), { items: [], next_cursor: null });
  assert.equal(
    await errorCode(() => ownerB.getImportedArtifact(saved.artifact.id)),
    API_ERROR_CODES.NOT_FOUND,
  );
});

test("corrupted or tampered local artifacts surface as CORRUPT_STORE", async () => {
  const adapter = new MemoryStorageAdapter();
  const client = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });
  const saved = await client.saveImportedArtifact(analysisInput());

  adapter.write(importedArtifactKey("owner-a", saved.artifact.id), "{not json");
  assert.equal(
    await errorCode(() => client.getImportedArtifact(saved.artifact.id)),
    API_ERROR_CODES.CORRUPT_STORE,
  );

  const tampered = structuredClone(saved.artifact) as unknown as {
    payload: { metrics: { sessions: number } };
  };
  tampered.payload.metrics.sessions += 1;
  adapter.write(
    importedArtifactKey("owner-a", saved.artifact.id),
    JSON.stringify(tampered),
  );
  assert.equal(
    await errorCode(() => client.getImportedArtifact(saved.artifact.id)),
    API_ERROR_CODES.CORRUPT_STORE,
  );
});

test("local selection does not adopt and revocation leaves the selection intact", async () => {
  const adapter = new MemoryStorageAdapter();
  const client = new LocalFitTraceClient(adapter, {
    ownerId: "owner-a",
    now: () => new Date("2026-10-17T00:00:00.000Z"),
  });
  const analysis = (await client.saveImportedArtifact(analysisInput())).artifact;
  const plan = (await client.saveImportedArtifact(planInput())).artifact;

  await client.setArtifactSelection("plan", plan.id);
  assert.equal(await client.getPlanAdoption(), null);

  const adopted = await client.setPlanAdoption({
    artifact_id: plan.id,
    confirmed_digest: plan.content_digest,
  });
  assert.equal(adopted?.confirmed_at, "2026-10-17T00:00:00.000Z");

  await client.setArtifactSelection("analysis", analysis.id);
  assert.equal((await client.getPlanAdoption())?.artifact_id, plan.id);

  await client.setPlanAdoption(null);
  assert.equal(await client.getPlanAdoption(), null);
  assert.deepEqual(await client.getArtifactSelection("analysis"), { artifact_id: analysis.id });
});

test("local artifact key/id mismatches surface as CORRUPT_STORE", async () => {
  const adapter = new MemoryStorageAdapter();
  const client = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });
  const saved = await client.saveImportedArtifact(analysisInput());

  const otherId = `analysis:v1:${"0".repeat(64)}`;
  adapter.write(importedArtifactKey("owner-a", otherId), JSON.stringify(saved.artifact));
  assert.equal(
    await errorCode(() => client.listImportedArtifacts()),
    API_ERROR_CODES.CORRUPT_STORE,
  );
});

test("present but empty stored values are CORRUPT_STORE, not absent", async () => {
  const adapter = new MemoryStorageAdapter();
  const client = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });
  const saved = await client.saveImportedArtifact(analysisInput());

  adapter.write(importedArtifactKey("owner-a", saved.artifact.id), "   ");
  assert.equal(
    await errorCode(() => client.getImportedArtifact(saved.artifact.id)),
    API_ERROR_CODES.CORRUPT_STORE,
  );

  adapter.write(artifactSelectionKey("owner-a", "analysis"), "\t");
  assert.equal(
    await errorCode(() => client.getArtifactSelection("analysis")),
    API_ERROR_CODES.CORRUPT_STORE,
  );

  adapter.write(planAdoptionKey("owner-a"), "");
  assert.equal(
    await errorCode(() => client.getPlanAdoption()),
    API_ERROR_CODES.CORRUPT_STORE,
  );
});

test("concurrent identical saves are serialized per memory store", async () => {
  const store = createInMemoryWorkoutStore();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => store.saveImportedArtifact(analysisInput())),
  );
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 9);
  assert.equal(new Set(results.map((result) => result.artifact.id)).size, 1);
  assert.equal((await store.listImportedArtifacts({ limit: 10 })).items.length, 1);
});

test("concurrent local saves are serialized per client and keep the first filename", async () => {
  const adapter = new MemoryStorageAdapter();
  const client = new LocalFitTraceClient(adapter, {
    ownerId: "owner-a",
    now: () => new Date("2026-10-17T00:00:00.000Z"),
  });
  const first = { ...analysisInput(), source_filename: "first.json" };
  const duplicate = { ...analysisInput(), source_filename: "second.json" };
  const results = await Promise.all([
    client.saveImportedArtifact(first),
    ...Array.from({ length: 9 }, () => client.saveImportedArtifact(duplicate)),
  ]);
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 9);
  assert.equal(new Set(results.map((result) => result.artifact.id)).size, 1);
  assert.ok(results.every((result) => result.artifact.source_filename === "first.json"));
  assert.equal((await client.listImportedArtifacts({ limit: 10 })).items.length, 1);
});

class ToggledAdapter extends MemoryStorageAdapter {
  failWrites = false;
  throwQuota = false;
  ignoreRemove = false;

  override write(key: string, value: string): void {
    if (this.throwQuota) throw new DOMException("quota exceeded", "QuotaExceededError");
    if (this.failWrites) throw new StorageUnavailableError("blocked");
    super.write(key, value);
  }

  override remove(key: string): void {
    if (this.ignoreRemove) return;
    super.remove(key);
  }
}

test("local write failures map to STORAGE_UNAVAILABLE without fallbacks", async () => {
  const adapter = new ToggledAdapter();
  const client = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });

  adapter.failWrites = true;
  assert.equal(
    await errorCode(() => client.saveImportedArtifact(analysisInput())),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  assert.deepEqual(await client.listImportedArtifacts(), { items: [], next_cursor: null });

  adapter.failWrites = false;
  const analysis = (await client.saveImportedArtifact(analysisInput())).artifact;
  const plan = (await client.saveImportedArtifact(planInput())).artifact;

  adapter.failWrites = true;
  assert.equal(
    await errorCode(() => client.setArtifactSelection("analysis", analysis.id)),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  assert.deepEqual(await client.getArtifactSelection("analysis"), { artifact_id: null });

  assert.equal(
    await errorCode(() =>
      client.setPlanAdoption({ artifact_id: plan.id, confirmed_digest: plan.content_digest }),
    ),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  assert.equal(await client.getPlanAdoption(), null);
});

test("raw storage DOMExceptions map to STORAGE_UNAVAILABLE without fallbacks", async () => {
  const adapter = new ToggledAdapter();
  const client = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });

  adapter.throwQuota = true;
  assert.equal(
    await errorCode(() => client.saveImportedArtifact(analysisInput())),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  adapter.throwQuota = false;
  assert.deepEqual(await client.listImportedArtifacts(), { items: [], next_cursor: null });

  const analysis = (await client.saveImportedArtifact(analysisInput())).artifact;
  const plan = (await client.saveImportedArtifact(planInput())).artifact;

  adapter.throwQuota = true;
  assert.equal(
    await errorCode(() => client.setArtifactSelection("analysis", analysis.id)),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  adapter.throwQuota = false;
  assert.deepEqual(await client.getArtifactSelection("analysis"), { artifact_id: null });

  adapter.throwQuota = true;
  assert.equal(
    await errorCode(() =>
      client.setPlanAdoption({ artifact_id: plan.id, confirmed_digest: plan.content_digest }),
    ),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  adapter.throwQuota = false;
  assert.equal(await client.getPlanAdoption(), null);
});

test("a silently ignored adoption revoke maps to STORAGE_UNAVAILABLE", async () => {
  const adapter = new ToggledAdapter();
  const client = new LocalFitTraceClient(adapter, { ownerId: "owner-a" });
  const plan = (await client.saveImportedArtifact(planInput())).artifact;
  await client.setPlanAdoption({
    artifact_id: plan.id,
    confirmed_digest: plan.content_digest,
  });

  adapter.ignoreRemove = true;
  assert.equal(
    await errorCode(() => client.setPlanAdoption(null)),
    API_ERROR_CODES.STORAGE_UNAVAILABLE,
  );
  assert.equal((await client.getPlanAdoption())?.artifact_id, plan.id);
});

/* ------------------------------------------------------------------------- */
/* In-memory store + routes                                                  */
/* ------------------------------------------------------------------------- */

test("memory store and routes expose the import lifecycle with correct statuses", async () => {
  const store = createInMemoryWorkoutStore({
    now: () => new Date("2026-10-17T00:00:00.000Z"),
  });
  const handler = createMemoryHandler(store);

  const created = await handler("/imports", {
    method: "POST",
    body: JSON.stringify(analysisInput()),
  });
  assert.equal(created.status, 201);
  const saved = (JSON.parse(created.body) as { data: { artifact: { id: string; created_at: string }; duplicate: boolean } }).data;
  assert.equal(saved.duplicate, false);
  assert.equal(saved.artifact.created_at, "2026-10-17T00:00:00.000Z");

  const duplicate = await handler("/imports", {
    method: "POST",
    body: JSON.stringify(analysisInput()),
  });
  assert.equal(duplicate.status, 200);

  const list = await handler("/imports?kind=analysis&limit=10");
  assert.equal(list.status, 200);
  const page = JSON.parse(list.body) as { data: { items: ImportedArtifactMeta[] } };
  assert.equal(page.data.items.length, 1);
  assert.equal((page.data.items[0] as unknown as Record<string, unknown>).payload, undefined);
  assert.equal(page.data.items[0]?.id, saved.artifact.id);

  const read = await handler(`/imports/${encodeURIComponent(saved.artifact.id)}`);
  assert.equal(read.status, 200);

  const missing = await handler(`/imports/${encodeURIComponent("analysis:v1:" + "0".repeat(64))}`);
  assert.equal(missing.status, 404);
  assert.equal((JSON.parse(missing.body) as { error: { code: string } }).error.code, API_ERROR_CODES.NOT_FOUND);

  const selected = await handler("/import-selections/analysis", {
    method: "PUT",
    body: JSON.stringify({ artifact_id: saved.artifact.id }),
  });
  assert.equal(selected.status, 200);
  const selectedRead = await handler("/import-selections/analysis");
  assert.deepEqual((JSON.parse(selectedRead.body) as { data: unknown }).data, {
    artifact_id: saved.artifact.id,
  });

  const plan = (await store.saveImportedArtifact(planInput())).artifact;
  const adopted = await handler("/plan-adoption", {
    method: "PUT",
    body: JSON.stringify({ artifact_id: plan.id, confirmed_digest: plan.content_digest }),
  });
  assert.equal(adopted.status, 200);
  assert.equal(
    (JSON.parse(adopted.body) as { data: { artifact_id: string } }).data.artifact_id,
    plan.id,
  );
  const adoptionRead = await handler("/plan-adoption");
  assert.equal((JSON.parse(adoptionRead.body) as { data: { artifact_id: string } }).data.artifact_id, plan.id);
});

test("memory routes reject invalid imports, query parameters, and oversized bodies", async () => {
  const store = createInMemoryWorkoutStore();
  const handler = createMemoryHandler(store);

  const invalid = await handler("/imports", {
    method: "POST",
    body: JSON.stringify({ kind: "analysis", payload_schema_version: 2, payload: analysisPayload() }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (JSON.parse(invalid.body) as { error: { code: string } }).error.code,
    API_ERROR_CODES.VALIDATION_ERROR,
  );

  const unknownQuery = await handler("/imports?kind=analysis&owner_id=other");
  assert.equal(unknownQuery.status, 400);

  const tiny = createMemoryHandler(store, { maxBodyBytes: 10 });
  const oversized = await tiny("/imports", {
    method: "POST",
    body: JSON.stringify(analysisInput()),
  });
  assert.equal(oversized.status, 400);
});

test("import routes warn about unknown fields dropped during normalization", async () => {
  const store = createInMemoryWorkoutStore();
  const handler = createMemoryHandler(store);
  const response = await handler("/imports", {
    method: "POST",
    body: JSON.stringify({
      ...analysisInput(),
      extra: true,
      payload: { ...analysisPayload(), extra: true },
    }),
  });
  assert.equal(response.status, 201);
  const body = JSON.parse(response.body) as {
    data: { warnings: { code: string; path?: string }[] };
  };
  assert.equal(body.data.warnings[0]?.code, "UNKNOWN_FIELD");
  assert.deepEqual(
    body.data.warnings.map((warning) => warning.path),
    ["(root).extra", "extra"],
  );
});

/* ------------------------------------------------------------------------- */
/* Supabase RPC mapping (mocked PostgREST)                                   */
/* ------------------------------------------------------------------------- */

interface RpcCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function rpcMock(
  respond: (name: string, body: Record<string, unknown>) => Response,
): { fetchImpl: typeof fetch; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({
      url: input,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const name = String(input).split("/rpc/")[1] ?? "";
    return respond(name, body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function supabaseStore(fetchImpl: typeof fetch) {
  return createSupabaseImportMethods(
    { id: "user-1" },
    {
      supabaseUrl: "http://db.invalid",
      publishableKey: "pub-key",
      accessToken: "user-token",
      fetchImpl,
    },
  );
}

async function storedAnalysis(
  weight: number,
  createdAt = "2026-10-17T00:00:00.000Z",
  ownerId = "user-1",
): Promise<ImportedArtifact<"analysis"> & { owner_id: string }> {
  const normalized = parseImportArtifactInput({
    kind: "analysis",
    payload_schema_version: 1,
    payload: analysisPayload({ weight }),
  }).input;
  return {
    ...(await buildImportedArtifact(normalized as ImportArtifactInput<"analysis">, {
      created_at: createdAt,
    })),
    owner_id: ownerId,
  };
}

async function storedArtifact(
  createdAt = "2026-10-17T00:00:00.000Z",
  ownerId = "user-1",
): Promise<ImportedArtifact<"analysis"> & { owner_id: string }> {
  return storedAnalysis(80, createdAt, ownerId);
}

async function storedPlan(
  createdAt = "2026-10-17T00:00:00.000Z",
  ownerId = "user-1",
): Promise<ImportedArtifact<"plan"> & { owner_id: string }> {
  const normalized = parseImportArtifactInput(planInput()).input;
  return {
    ...(await buildImportedArtifact(normalized as ImportArtifactInput<"plan">, {
      created_at: createdAt,
    })),
    owner_id: ownerId,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

test("supabase save uses the caller token, sends no owner, and maps duplicates", async () => {
  const artifact = await storedArtifact();
  const { fetchImpl, calls } = rpcMock(() => json(200, { created: true, artifact }));
  const result = await supabaseStore(fetchImpl).saveImportedArtifact(analysisInput());

  assert.equal(result.duplicate, false);
  assert.equal(result.artifact.id, artifact.id);
  assert.equal(calls[0]?.url, "http://db.invalid/rest/v1/rpc/save_imported_artifact");
  assert.equal(calls[0]?.headers.Authorization, "Bearer user-token");
  assert.equal(calls[0]?.headers.apikey, "pub-key");
  const body = calls[0]?.body ?? {};
  assert.equal(body.p_id, artifact.id);
  assert.equal(body.p_kind, "analysis");
  assert.equal(body.p_content_digest, artifact.content_digest);
  assert.deepEqual(body.p_payload, artifact.payload);
  assert.ok(!("owner_id" in body) && !("p_owner_id" in body));

  const duplicate = await supabaseStore(
    rpcMock(() => json(200, { created: false, artifact })).fetchImpl,
  ).saveImportedArtifact(analysisInput());
  assert.equal(duplicate.duplicate, true);
  const { owner_id: _ownerId, ...artifactWithoutOwner } = artifact;
  assert.deepEqual(duplicate.artifact, artifactWithoutOwner);
});

test("supabase save verifies owner and the full canonical payload, not just the digest", async () => {
  const foreign = await storedArtifact("2026-10-17T00:00:00.000Z", "user-2");
  const crossOwner = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, { created: true, artifact: foreign })).fetchImpl)
      .saveImportedArtifact(analysisInput()),
  );
  assert.equal(crossOwner, API_ERROR_CODES.CORRUPT_STORE);

  const original = await storedArtifact();
  // Same id/digest, but a payload the read guard cannot detect as different
  // until it is compared canonically: swap a semantically valid value while
  // retaining the original payload digest/id.
  const forged = structuredClone(original);
  forged.payload.metrics.sessions += 1;
  const forgedResult = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, { created: true, artifact: forged })).fetchImpl)
      .saveImportedArtifact(analysisInput()),
  );
  assert.equal(forgedResult, API_ERROR_CODES.CORRUPT_STORE);

  const missingOwner = await errorCode(() =>
    supabaseStore(
      rpcMock(() => json(200, { created: true, artifact: { ...original, owner_id: undefined } }))
        .fetchImpl,
    ).saveImportedArtifact(analysisInput()),
  );
  assert.equal(missingOwner, API_ERROR_CODES.CORRUPT_STORE);
});

test("supabase maps RPC errors without leaking raw bodies", async () => {
  const conflict = await errorCode(() =>
    supabaseStore(
      rpcMock(() => json(409, { code: "23505", message: "IMPORT_CONFLICT" })).fetchImpl,
    ).saveImportedArtifact(analysisInput()),
  );
  assert.equal(conflict, API_ERROR_CODES.CONFLICT);

  const invalid = await errorCode(() =>
    supabaseStore(
      rpcMock(() => json(400, { code: "22023", message: "IMPORT_INVALID secret details" })).fetchImpl,
    ).saveImportedArtifact(analysisInput()),
  );
  assert.equal(invalid, API_ERROR_CODES.VALIDATION_ERROR);

  const missingRpc = await errorCode(() =>
    supabaseStore(rpcMock(() => json(404, { code: "PGRST202" })).fetchImpl).listImportedArtifacts(),
  );
  assert.equal(missingRpc, API_ERROR_CODES.STORAGE_UNAVAILABLE);

  const notFound = await errorCode(() =>
    supabaseStore(
      rpcMock(() => json(404, { code: "P0002", message: "IMPORT_ARTIFACT_NOT_FOUND" })).fetchImpl,
    ).getImportedArtifact("analysis:v1:" + "0".repeat(64)),
  );
  assert.equal(notFound, API_ERROR_CODES.NOT_FOUND);
});

test("supabase list pages metadata only and forwards strict cursors", async () => {
  const first = await storedArtifact("2026-10-17T00:00:00.000Z");
  const second = await storedPlan("2026-10-17T00:00:00.000Z");
  const rows = [parseImportedArtifactMeta(first), parseImportedArtifactMeta(second)]
    .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1))
    .map((meta) => ({ ...meta, owner_id: "user-1" }));
  const metas = rows;

  const { fetchImpl, calls } = rpcMock((_name, body) => {
    const afterId = body.p_after_id;
    if (afterId === null) return json(200, [rows[0]]);
    if (afterId === metas[0]?.id) return json(200, [rows[1]]);
    return json(200, []);
  });
  const store = supabaseStore(fetchImpl);

  const page = await store.listImportedArtifacts({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, metas[0]?.id);
  assert.ok(page.next_cursor !== null);
  assert.equal((page.items[0] as unknown as Record<string, unknown>).payload, undefined);
  assert.deepEqual(
    calls.map((call) => call.body.p_after_id),
    [null, metas[0]?.id],
  );

  const secondPage = await store.listImportedArtifacts({ limit: 1, cursor: page.next_cursor });
  assert.equal(secondPage.items[0]?.id, metas[1]?.id);
  assert.equal(secondPage.next_cursor, null);
});

test("supabase get verifies ownership and canonical payload on read", async () => {
  const artifact = await storedArtifact();
  const badOwner = await errorCode(() =>
    supabaseStore(
      rpcMock(() => json(200, [{ ...artifact, owner_id: "user-2" }])).fetchImpl,
    ).getImportedArtifact(artifact.id),
  );
  assert.equal(badOwner, API_ERROR_CODES.CORRUPT_STORE);

  const tampered = { ...artifact, payload: { ...artifact.payload, source_records: [] }, owner_id: "user-1" };
  const badPayload = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, [tampered])).fetchImpl).getImportedArtifact(artifact.id),
  );
  assert.equal(badPayload, API_ERROR_CODES.CORRUPT_STORE);
});

test("supabase selection and adoption stay separate RPC calls", async () => {
  const plan = await storedPlan();
  const { fetchImpl, calls } = rpcMock((name, body) => {
    if (name === "get_artifact_selection") return json(200, { artifact_id: null });
    if (name === "set_artifact_selection") return json(200, { artifact_id: body.p_artifact_id });
    if (name === "get_plan_adoption") return json(200, null);
    if (name === "set_plan_adoption") {
      if (body.p_artifact_id === null) return json(200, null);
      return json(200, {
        artifact_id: body.p_artifact_id,
        confirmed_digest: body.p_confirmed_digest,
        confirmed_at: "2026-10-17T00:00:00.000Z",
      });
    }
    return json(500, {});
  });
  const store = supabaseStore(fetchImpl);

  assert.deepEqual(await store.getArtifactSelection("analysis"), { artifact_id: null });
  assert.deepEqual(await store.setArtifactSelection("plan", plan.id), { artifact_id: plan.id });
  assert.equal(await store.getPlanAdoption(), null);

  const adopted = await store.setPlanAdoption({
    artifact_id: plan.id,
    confirmed_digest: plan.content_digest,
  });
  assert.equal(adopted?.artifact_id, plan.id);
  assert.equal(await store.setPlanAdoption(null), null);

  assert.deepEqual(
    calls.map((call) => call.url.split("/rpc/")[1]),
    [
      "get_artifact_selection",
      "set_artifact_selection",
      "get_plan_adoption",
      "set_plan_adoption",
      "set_plan_adoption",
    ],
  );
  assert.deepEqual(calls[1]?.body, { p_kind: "plan", p_artifact_id: plan.id });
  assert.deepEqual(calls[4]?.body, { p_artifact_id: null, p_confirmed_digest: null });
});

test("supabase list rejects cross-owner and malformed metadata rows", async () => {
  const row = { ...parseImportedArtifactMeta(await storedArtifact()), owner_id: "user-1" };

  const crossOwner = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, [{ ...row, owner_id: "user-2" }])).fetchImpl)
      .listImportedArtifacts(),
  );
  assert.equal(crossOwner, API_ERROR_CODES.CORRUPT_STORE);

  const missingOwner = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, [{ ...row, owner_id: undefined }])).fetchImpl)
      .listImportedArtifacts(),
  );
  assert.equal(missingOwner, API_ERROR_CODES.CORRUPT_STORE);

  const malformed = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, [{ ...row, id: "not-content-addressed" }])).fetchImpl)
      .listImportedArtifacts(),
  );
  assert.equal(malformed, API_ERROR_CODES.CORRUPT_STORE);
});

test("supabase list treats short max_rows pages as partial and never repeats a cursor", async () => {
  const rows = [
    { ...parseImportedArtifactMeta(await storedAnalysis(80, "2026-10-17T03:00:00.000Z")), owner_id: "user-1" },
    { ...parseImportedArtifactMeta(await storedAnalysis(90, "2026-10-17T02:00:00.000Z")), owner_id: "user-1" },
    { ...parseImportedArtifactMeta(await storedPlan("2026-10-17T01:00:00.000Z")), owner_id: "user-1" },
  ];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const { fetchImpl, calls } = rpcMock((_name, body) => {
    const after = body.p_after_id;
    if (after === null) return json(200, [rows[0]]);
    const index = rows.findIndex((row) => row.id === after);
    const next = index >= 0 ? rows[index + 1] : undefined;
    return json(200, next === undefined ? [] : [next]);
  });
  const store = supabaseStore(fetchImpl);

  // limit=2 asks for 3 rows including look-ahead, but the server caps each
  // response at 1 row; the client must keep paging instead of ending early.
  const page = await store.listImportedArtifacts({ limit: 2 });
  assert.deepEqual(
    page.items.map((item) => item.id),
    [rows[0]?.id, rows[1]?.id],
  );
  assert.ok(page.next_cursor !== null);
  assert.deepEqual(
    calls.map((call) => call.body.p_after_id),
    [null, rows[0]?.id, rows[1]?.id],
  );
  assert.equal(byId.get(page.items[0]?.id ?? "")?.owner_id, "user-1");

  const repeated = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, [rows[0]])).fetchImpl).listImportedArtifacts({ limit: 2 }),
  );
  assert.equal(repeated, API_ERROR_CODES.CORRUPT_STORE);
});

test("supabase validates selection/adoption requests and response shapes", async () => {
  const invalidKind = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, { artifact_id: null })).fetchImpl).getArtifactSelection(
      "nope" as never,
    ),
  );
  assert.equal(invalidKind, API_ERROR_CODES.VALIDATION_ERROR);

  const invalidAdoption = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, null)).fetchImpl).setPlanAdoption({
      artifact_id: "plan:v1:" + "0".repeat(64),
      confirmed_digest: "not-a-digest",
    }),
  );
  assert.equal(invalidAdoption, API_ERROR_CODES.VALIDATION_ERROR);

  const emptyId = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, null)).fetchImpl).setArtifactSelection("plan", ""),
  );
  assert.equal(emptyId, API_ERROR_CODES.VALIDATION_ERROR);

  const malformedSelection = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, { artifact_id: 5 })).fetchImpl)
      .getArtifactSelection("plan"),
  );
  assert.equal(malformedSelection, API_ERROR_CODES.CORRUPT_STORE);

  const malformedAdoption = await errorCode(() =>
    supabaseStore(
      rpcMock(() =>
        json(200, {
          artifact_id: "plan:v1:" + "0".repeat(64),
          confirmed_digest: "x",
          confirmed_at: "not-a-date",
        }),
      ).fetchImpl,
    ).getPlanAdoption(),
  );
  assert.equal(malformedAdoption, API_ERROR_CODES.CORRUPT_STORE);

  const notFound = await errorCode(() =>
    supabaseStore(
      rpcMock(() => json(404, { code: "P0002", message: "IMPORT_ARTIFACT_NOT_FOUND" })).fetchImpl,
    ).setArtifactSelection("plan", "plan:v1:" + "0".repeat(64)),
  );
  assert.equal(notFound, API_ERROR_CODES.NOT_FOUND);
});

test("supabase maps auth, storage, network, and malformed save failures", async () => {
  const unauthorized = await errorCode(() =>
    supabaseStore(rpcMock(() => json(401, { message: "expired" })).fetchImpl).listImportedArtifacts(),
  );
  assert.equal(unauthorized, API_ERROR_CODES.UNAUTHENTICATED);

  const forbidden = await errorCode(() =>
    supabaseStore(rpcMock(() => json(403, { message: "denied" })).fetchImpl)
      .getArtifactSelection("analysis"),
  );
  assert.equal(forbidden, API_ERROR_CODES.FORBIDDEN);

  const serverError = await errorCode(() =>
    supabaseStore(rpcMock(() => json(500, { message: "boom" })).fetchImpl).listImportedArtifacts(),
  );
  assert.equal(serverError, API_ERROR_CODES.STORAGE_UNAVAILABLE);

  const network = await errorCode(() =>
    supabaseStore((async () => {
      throw new Error("offline");
    }) as typeof fetch).listImportedArtifacts(),
  );
  assert.equal(network, API_ERROR_CODES.STORAGE_UNAVAILABLE);

  const stored = await storedArtifact();
  const badCreated = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, { created: "yes", artifact: stored })).fetchImpl)
      .saveImportedArtifact(analysisInput()),
  );
  assert.equal(badCreated, API_ERROR_CODES.CORRUPT_STORE);

  const badArtifact = await errorCode(() =>
    supabaseStore(rpcMock(() => json(200, { created: true, artifact: { id: "x" } })).fetchImpl)
      .saveImportedArtifact(analysisInput()),
  );
  assert.equal(badArtifact, API_ERROR_CODES.CORRUPT_STORE);
});

test("supabase rejects invalid list kinds, limits, and cursors before calling RPC", async () => {
  const { fetchImpl, calls } = rpcMock(() => json(200, []));
  const store = supabaseStore(fetchImpl);

  assert.equal(
    await errorCode(() => store.listImportedArtifacts({ kind: "nope" as never })),
    API_ERROR_CODES.VALIDATION_ERROR,
  );
  assert.equal(
    await errorCode(() => store.listImportedArtifacts({ limit: 0 })),
    API_ERROR_CODES.VALIDATION_ERROR,
  );
  assert.equal(
    await errorCode(() => store.listImportedArtifacts({ limit: 101 })),
    API_ERROR_CODES.VALIDATION_ERROR,
  );
  const analysisCursor = encodeArtifactCursor({
    kind: "analysis",
    created_at: "2026-10-17T00:00:00.000Z",
    id: "analysis:v1:" + "0".repeat(64),
  });
  assert.equal(
    await errorCode(() => store.listImportedArtifacts({ kind: "plan", cursor: analysisCursor })),
    API_ERROR_CODES.VALIDATION_ERROR,
  );
  assert.equal(
    await errorCode(() => store.listImportedArtifacts({ cursor: "not-a-cursor" })),
    API_ERROR_CODES.VALIDATION_ERROR,
  );
  assert.equal(calls.length, 0);
});
