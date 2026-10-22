import {
  MalformedResponseError,
  applyImportedArtifactKeyset,
  compareImportedArtifactMeta,
  parseArtifactSelection,
  parseImportedArtifact,
  parsePlanAdoption,
} from "@agent-fit-trace/api-contracts";
import type {
  ArtifactCursor,
  ArtifactSelection,
  ImportedArtifact,
  ImportedArtifactKind,
  ImportedArtifactMeta,
  PlanAdoption,
} from "@agent-fit-trace/api-contracts";
import type { StorageAdapter } from "./adapter.ts";
import { StorageUnavailableError } from "./adapter.ts";

/**
 * Browser-local persistence for imported snapshots and their mutable state.
 *
 * One key per immutable artifact, exactly like workouts, so a save can never
 * read-modify-write another snapshot. Every read re-validates the stored JSON
 * and its content identity; a malformed or tampered value raises
 * {@link ImportStorageCorruptionError} instead of being treated as empty.
 * Keys are namespaced by an owner id so two identities on one browser never
 * see each other's artifacts or selections.
 */

export const IMPORT_STORAGE_KEY_PREFIX = "agent-fit-trace:import:v1:";

export class ImportStorageCorruptionError extends Error {
  code = "CORRUPT_STORE";
  key: string;
  artifactId: string | null;

  constructor(reason: string, key: string, artifactId: string | null = null) {
    super(`Stored imported artifact at key "${key}" is invalid: ${reason}`);
    this.name = "ImportStorageCorruptionError";
    this.key = key;
    this.artifactId = artifactId;
  }
}

function encode(part: string): string {
  return encodeURIComponent(part);
}

function namespace(ownerId: string): string {
  return `${IMPORT_STORAGE_KEY_PREFIX}${encode(ownerId)}:`;
}

export function importedArtifactKey(ownerId: string, id: string): string {
  return `${namespace(ownerId)}artifact:${encode(id)}`;
}

export function artifactSelectionKey(ownerId: string, kind: ImportedArtifactKind): string {
  return `${namespace(ownerId)}selection:${kind}`;
}

export function planAdoptionKey(ownerId: string): string {
  return `${namespace(ownerId)}plan-adoption`;
}

async function parseStoredArtifact(
  raw: string,
  key: string,
  expectedId: string,
): Promise<ImportedArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ImportStorageCorruptionError("contains invalid JSON", key, expectedId);
  }
  try {
    const artifact = await parseImportedArtifact(parsed);
    if (artifact.id !== expectedId) {
      throw new MalformedResponseError("id", "does not match the storage key");
    }
    return artifact;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ImportStorageCorruptionError(reason, key, expectedId);
  }
}

/** Load one stored artifact; `null` only when the key genuinely does not exist. */
export async function loadImportedArtifact(
  adapter: StorageAdapter,
  ownerId: string,
  id: string,
): Promise<ImportedArtifact | null> {
  const key = importedArtifactKey(ownerId, id);
  const raw = adapter.read(key);
  if (raw === null) return null;
  return parseStoredArtifact(raw, key, id);
}

/** Load every artifact in an owner namespace, newest first. */
export async function loadImportedArtifacts(
  adapter: StorageAdapter,
  ownerId: string,
): Promise<ImportedArtifact[]> {
  const prefix = `${namespace(ownerId)}artifact:`;
  const artifacts: ImportedArtifact[] = [];
  for (const key of adapter.keys(prefix)) {
    const raw = adapter.read(key);
    if (raw === null) {
      throw new ImportStorageCorruptionError("artifact is empty", key);
    }
    let expectedId: string;
    try {
      expectedId = decodeURIComponent(key.slice(prefix.length));
    } catch {
      throw new ImportStorageCorruptionError("has an undecodable id suffix", key);
    }
    artifacts.push(await parseStoredArtifact(raw, key, expectedId));
  }
  return artifacts.sort(compareNewestFirst);
}

export function saveImportedArtifactRecord(
  adapter: StorageAdapter,
  ownerId: string,
  artifact: ImportedArtifact,
): void {
  adapter.write(
    importedArtifactKey(ownerId, artifact.id),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
}

export function metadataFor(artifact: ImportedArtifact): ImportedArtifactMeta {
  return {
    id: artifact.id,
    kind: artifact.kind,
    schema_version: artifact.schema_version,
    payload_schema_version: artifact.payload_schema_version,
    source: artifact.source,
    source_filename: artifact.source_filename,
    source_record_ids: artifact.source_record_ids,
    content_digest: artifact.content_digest,
    created_at: artifact.created_at,
  };
}

export function compareNewestFirst(a: ImportedArtifactMeta, b: ImportedArtifactMeta): number {
  return compareImportedArtifactMeta(a, b);
}

/** Apply the same keyset window every backend uses for `(created_at DESC, id DESC)`. */
export function pageArtifacts(
  artifacts: ImportedArtifactMeta[],
  query: { kind?: ImportedArtifactKind; limit: number; cursor: ArtifactCursor | null },
): ImportedArtifactMeta[] {
  return applyImportedArtifactKeyset(artifacts, query);
}

export async function loadArtifactSelection(
  adapter: StorageAdapter,
  ownerId: string,
  kind: ImportedArtifactKind,
): Promise<ArtifactSelection> {
  const key = artifactSelectionKey(ownerId, kind);
  const raw = adapter.read(key);
  if (raw === null) return { artifact_id: null };
  let selection: ArtifactSelection;
  try {
    selection = parseArtifactSelection(JSON.parse(raw) as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ImportStorageCorruptionError(reason, key);
  }
  if (selection.artifact_id !== null) {
    const artifact = await loadImportedArtifact(adapter, ownerId, selection.artifact_id);
    if (artifact === null || artifact.kind !== kind) {
      throw new ImportStorageCorruptionError(
        "selection points at a missing or differently-kinded artifact",
        key,
        selection.artifact_id,
      );
    }
  }
  return selection;
}

export function saveArtifactSelection(
  adapter: StorageAdapter,
  ownerId: string,
  kind: ImportedArtifactKind,
  selection: ArtifactSelection,
): void {
  adapter.write(artifactSelectionKey(ownerId, kind), `${JSON.stringify(selection)}\n`);
}

export async function loadPlanAdoptionRecord(
  adapter: StorageAdapter,
  ownerId: string,
): Promise<PlanAdoption | null> {
  const key = planAdoptionKey(ownerId);
  const raw = adapter.read(key);
  if (raw === null) return null;
  let adoption: PlanAdoption | null;
  try {
    adoption = parsePlanAdoption(JSON.parse(raw) as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ImportStorageCorruptionError(reason, key);
  }
  if (adoption !== null) {
    const artifact = await loadImportedArtifact(adapter, ownerId, adoption.artifact_id);
    if (
      artifact === null ||
      artifact.kind !== "plan" ||
      artifact.content_digest !== adoption.confirmed_digest
    ) {
      throw new ImportStorageCorruptionError(
        "adoption points at a missing or changed plan artifact",
        key,
        adoption.artifact_id,
      );
    }
  }
  return adoption;
}

export function savePlanAdoptionRecord(
  adapter: StorageAdapter,
  ownerId: string,
  adoption: PlanAdoption,
): void {
  adapter.write(planAdoptionKey(ownerId), `${JSON.stringify(adoption)}\n`);
}

export function clearPlanAdoptionRecord(adapter: StorageAdapter, ownerId: string): void {
  const key = planAdoptionKey(ownerId);
  adapter.remove(key);
  // Never report a revoke as successful while the key survives (some
  // adapters/backends can silently ignore a remove).
  if (adapter.read(key) !== null) {
    throw new StorageUnavailableError("Unable to remove the stored plan adoption.");
  }
}
