/**
 * Per-run read-only snapshot input files.
 *
 * Each coached run gets an isolated temp dir containing exactly one
 * `snapshot.json`: a VALIDATED `WorkoutRecord` store file shaped
 * `{ schema_version, records }` — the same shape `WorkoutStore` expects —
 * so the coached extension reads it with the normal validated load path.
 * Records are re-validated here before writing; anything malformed throws
 * and no directory leaks (validation precedes `mkdtemp`).
 *
 * The file resolves server-side from the authenticated upstream, never from
 * the prompt path: `snapshot.json` is a fixed name inside the fresh temp
 * dir. Serialization is an explicit domain selection — only known
 * `WorkoutRecord`/`Exercise`/`WorkoutSet`/`PainReport` fields are written,
 * so unknown keys (including any credential-bearing keys) are dropped by
 * construction rather than scanned for with a denylist. Malformed records
 * still throw and nothing is written.
 *
 * The file is created mode `0600`; a write failure removes the whole temp
 * dir (cleanup failures never mask the original error). After the child
 * exits the adapter unlinks the snapshot file (run-scoped temp only —
 * never the repo, never unrestricted persistence); the controlled session
 * dir is retained for explicit resume and removed by the owner via
 * {@link cleanupSnapshotDir}.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, validateWorkoutRecord } from "@pi-fit-trace/core";
import type { Exercise, PainReport, WorkoutRecord, WorkoutSet } from "@pi-fit-trace/core";

export interface SnapshotDir {
  dir: string;
  snapshotFile: string;
}

/** Fixed snapshot file name inside the per-run temp dir (never caller input). */
const SNAPSHOT_FILE_NAME = "snapshot.json";

function canonicalizeSet(set: WorkoutSet): WorkoutSet {
  const out: WorkoutSet = { reps: set.reps };
  if (set.weight !== undefined) out.weight = set.weight;
  if (set.rpe !== undefined) out.rpe = set.rpe;
  return out;
}

function canonicalizeExercise(exercise: Exercise): Exercise {
  return { name: exercise.name, sets: exercise.sets.map(canonicalizeSet) };
}

function canonicalizePain(pain: PainReport): PainReport {
  const out: PainReport = {};
  if (pain.area !== undefined) out.area = pain.area;
  if (pain.level !== undefined) out.level = pain.level;
  return out;
}

/**
 * Explicit serialized domain selection: only known record fields reach
 * disk. Unknown keys on the validated record are dropped here, so
 * credential-bearing keys can never be persisted.
 */
function canonicalizeRecord(record: WorkoutRecord): WorkoutRecord {
  const out: WorkoutRecord = {
    id: record.id,
    schema_version: record.schema_version,
    date: record.date,
    session_type: record.session_type,
    exercises: record.exercises.map(canonicalizeExercise),
  };
  if (record.duration_minutes !== undefined) out.duration_minutes = record.duration_minutes;
  if (record.sleep_hours !== undefined) out.sleep_hours = record.sleep_hours;
  if (record.pain !== undefined) out.pain = record.pain.map(canonicalizePain);
  if (record.notes !== undefined) out.notes = record.notes;
  return out;
}

/**
 * Validate `records` and write them as a `{schema_version, records}` store
 * file into a fresh isolated temp dir. Invalid records throw (nothing is
 * written and no directory is created).
 */
export async function writeSnapshotDir(records: unknown[]): Promise<SnapshotDir> {
  const validated: WorkoutRecord[] = records.map((entry) => validateWorkoutRecord(entry).record);
  const canonical: WorkoutRecord[] = validated.map(canonicalizeRecord);
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-coach-"));
  const snapshotFile = join(dir, SNAPSHOT_FILE_NAME);
  try {
    await writeFile(
      snapshotFile,
      `${JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, records: canonical }, null, 2)}\n`,
      { encoding: "utf8", mode: 0x180 },
    );
  } catch (error) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; the original write error is what matters.
    }
    throw error;
  }
  return { dir, snapshotFile };
}

/** Remove a per-run temp dir (snapshot + controlled session dir). Idempotent. */
export async function cleanupSnapshotDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
