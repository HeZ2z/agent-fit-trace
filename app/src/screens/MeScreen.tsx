import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ValidationWarning } from "@pi-fit-trace/core";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import {
  IMPORT_MAX_FILE_BYTES,
  parseAnalysisImportFile,
  parsePlanImportFile,
  parseWorkoutImportFile,
} from "@pi-fit-trace/api-contracts";
import type {
  ImportArtifactInput,
  ImportedArtifactKind,
  SaveImportedArtifactResult,
} from "@pi-fit-trace/api-contracts";
import { isHttpModeActive } from "../api/runtimeMode.ts";
import { readTextFile } from "../api/fileTransport.ts";
import { useWorkoutExport } from "../api/useWorkoutExport.ts";
import {
  previewWorkoutImport,
  runWorkoutImport,
} from "../api/workoutImport.ts";
import type {
  WorkoutImportPreview,
  WorkoutImportReceipt,
} from "../api/workoutImport.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  GuestAccountControls,
  GuestUpgradePasswordNotice,
} from "../auth/GuestAccountControls.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useTheme } from "../theme/useTheme.ts";
import type { ThemeName } from "../theme/theme.ts";

/** Deduplicate only exact repeats; preview and server warnings both survive. */
function mergeWarnings(...lists: readonly ValidationWarning[][]): ValidationWarning[] {
  const seen = new Set<string>();
  const merged: ValidationWarning[] = [];
  for (const warning of lists.flat()) {
    const key = `${warning.code}\u0000${warning.path ?? ""}\u0000${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(warning);
  }
  return merged;
}

/** Keep an over-bound legacy id readable without rendering kilobytes of text. */
function shortRecordId(id: string): string {
  return id.length <= 80 ? id : `${id.slice(0, 77)}…`;
}

function Warnings({ warnings }: { warnings: readonly ValidationWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="validation-hints" data-testid="import-warnings">
      <p>Warnings (records are still imported in normalized form):</p>
      <ul>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${warning.path ?? ""}-${index}`}>
            {warning.path !== undefined && <code>{warning.path}</code>}
            {warning.path !== undefined ? ": " : ""}
            {warning.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

type ArtifactPreview = {
  kind: ImportedArtifactKind;
  input: ImportArtifactInput;
  warnings: ValidationWarning[];
  filename: string;
  /** Owner/client captured when the file was read; a different owner never saves it. */
  owner: string;
  client: FitTraceClient;
};

type ArtifactSave =
  | {
      state: "saved";
      result: SaveImportedArtifactResult;
      warnings: ValidationWarning[];
      filename: string;
      owner: string;
      client: FitTraceClient;
    }
  | { state: "error"; kind: ImportedArtifactKind; message: string; owner: string };

function ImportArtifactSection({ kind }: { kind: ImportedArtifactKind }) {
  const { client } = useWorkouts();
  const { user } = useAuth();
  const navigate = useNavigate();
  const owner = user?.id ?? "local";
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [save, setSave] = useState<ArtifactSave | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  const clientRef = useRef(client);
  clientRef.current = client;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const mountedRef = useRef(true);
  // Bumped on unmount and whenever the owning identity/client changes. Every
  // async task captures the epoch plus the actual client/owner it started with.
  const scopeRef = useRef(0);
  const readTokenRef = useRef(0);
  const saveTokenRef = useRef(0);
  const viewTokenRef = useRef(0);
  const savingRef = useRef(false);
  const viewingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeRef.current += 1;
      readTokenRef.current += 1;
      saveTokenRef.current += 1;
      viewTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    scopeRef.current += 1;
    readTokenRef.current += 1;
    saveTokenRef.current += 1;
    viewTokenRef.current += 1;
    savingRef.current = false;
    viewingRef.current = false;
    setPreview(null);
    setSave(null);
    setSaving(false);
    setReading(false);
    setViewing(false);
    setReadError(null);
    setViewError(null);
  }, [client, owner]);

  const isScopeCurrent = (scope: number, capturedClient: FitTraceClient, capturedOwner: string) =>
    mountedRef.current &&
    scope === scopeRef.current &&
    capturedClient === clientRef.current &&
    capturedOwner === ownerRef.current;

  const title = kind === "analysis" ? "Import progress analysis" : "Import a training plan";

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    const capturedClient = clientRef.current;
    const capturedOwner = ownerRef.current;
    const scope = scopeRef.current;
    const token = ++readTokenRef.current;
    const isCurrent = () => isScopeCurrent(scope, capturedClient, capturedOwner) && token === readTokenRef.current;

    setReading(true);
    setReadError(null);
    setPreview(null);
    setSave(null);
    setViewError(null);
    try {
      const text = await readTextFile(file, IMPORT_MAX_FILE_BYTES);
      if (!isCurrent()) return;
      // The shared common input validator owns the filename guard and includes
      // the final name in the normalized request-byte bound before Save.
      const parsed =
        kind === "analysis"
          ? parseAnalysisImportFile(text, { sourceFilename: file.name })
          : parsePlanImportFile(text, { sourceFilename: file.name });
      if (!isCurrent()) return;
      setPreview({
        kind,
        input: parsed.input,
        warnings: parsed.warnings,
        filename: parsed.input.source_filename ?? file.name,
        owner: capturedOwner,
        client: capturedClient,
      });
    } catch (caught) {
      if (!isCurrent()) return;
      setReadError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent()) setReading(false);
      // Re-selecting the same file must fire change again.
      input.value = "";
    }
  }

  async function saveSnapshot(): Promise<void> {
    if (preview === null || savingRef.current) return;
    if (preview.owner !== ownerRef.current || preview.client !== clientRef.current) {
      // The preview belongs to an identity that is no longer current.
      setPreview(null);
      return;
    }
    const capturedClient = clientRef.current;
    const capturedOwner = ownerRef.current;
    const scope = scopeRef.current;
    const token = ++saveTokenRef.current;
    const isCurrent = () => isScopeCurrent(scope, capturedClient, capturedOwner) && token === saveTokenRef.current;

    savingRef.current = true;
    setSaving(true);
    setSave(null);
    setViewError(null);
    try {
      const result = await capturedClient.saveImportedArtifact(preview.input);
      if (!isCurrent()) return;
      setSave({
        state: "saved",
        result,
        warnings: mergeWarnings(preview.warnings, result.warnings),
        filename: preview.filename,
        owner: capturedOwner,
        client: capturedClient,
      });
      // Saving is deliberately not viewing and never adopts a plan.
    } catch (caught) {
      if (!isCurrent()) return;
      setSave({
        state: "error",
        kind,
        owner: capturedOwner,
        // The write may have committed before the transport failed. The user
        // retries the same file; identical content is an idempotent duplicate.
        message: `${caught instanceof Error ? caught.message : String(caught)} The snapshot may already be saved; retrying this same file is safe.`,
      });
    } finally {
      if (token === saveTokenRef.current) {
        savingRef.current = false;
        if (isCurrent()) setSaving(false);
      }
    }
  }

  async function viewSnapshot(): Promise<void> {
    if (save?.state !== "saved" || viewingRef.current) return;
    if (save.owner !== ownerRef.current || save.client !== clientRef.current) return;
    const capturedClient = clientRef.current;
    const capturedOwner = ownerRef.current;
    const scope = scopeRef.current;
    const token = ++viewTokenRef.current;
    const isCurrent = () => isScopeCurrent(scope, capturedClient, capturedOwner) && token === viewTokenRef.current;
    const artifact = save.result.artifact;

    viewingRef.current = true;
    setViewing(true);
    setViewError(null);
    try {
      await capturedClient.setArtifactSelection(artifact.kind, artifact.id);
      if (!isCurrent()) return;
      navigate(artifact.kind === "analysis" ? "/analysis" : "/plan");
    } catch (caught) {
      if (!isCurrent()) return;
      setViewError(
        `Could not open the saved ${artifact.kind} snapshot: ${
          caught instanceof Error ? caught.message : String(caught)
        }. It is still saved.`,
      );
    } finally {
      if (token === viewTokenRef.current) {
        viewingRef.current = false;
        if (isCurrent()) setViewing(false);
      }
    }
  }

  return (
    <section className="me-section" aria-labelledby={`me-${kind}-import`}>
      <h2 id={`me-${kind}-import`}>{title}</h2>
      <p className="me-help">
        Accepts <code>{kind}.json</code> or a saved v1 {kind} snapshot envelope. The
        whole file is validated before you can save it. Snapshots are immutable; saving
        uses content identity, so an identical re-import is a duplicate and never
        overwrites or renames the original.
      </p>
      <div className="field">
        <label htmlFor={`me-${kind}-file`}>Choose {kind} file</label>
        <input
          id={`me-${kind}-file`}
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleFileChange(event)}
          disabled={saving || reading}
        />
      </div>

      {readError !== null && (
        <div role="alert" className="validation-summary" data-testid={`me-${kind}-read-error`}>
          <p>Could not read the {kind} file: {readError}</p>
        </div>
      )}

      {preview !== null && (
        <div className="me-panel" data-testid={`me-${kind}-preview`}>
          <p>
            <strong>{preview.filename}</strong>{" "}
            {preview.kind === "analysis" && "period" in preview.input.payload
              ? `covers ${preview.input.payload.period.from ?? "n/a"} – ${preview.input.payload.period.to ?? "n/a"}.`
              : "recommendations" in preview.input.payload
                ? `has ${preview.input.payload.recommendations.length} recommendation(s) and remains a draft.`
                : "."}
          </p>
          <Warnings warnings={preview.warnings} />
          <p className="me-help">
            Saving creates an immutable account snapshot. It does not change what is
            selected for viewing and never adopts a plan.
          </p>
          <button
            type="button"
            onClick={() => void saveSnapshot()}
            disabled={saving || reading}
          >
            {saving ? "Saving…" : `Save ${kind} snapshot`}
          </button>
        </div>
      )}

      {save?.state === "error" && (
        <div role="alert" className="validation-summary" data-testid={`me-${kind}-save-error`}>
          <p>Could not confirm the {save.kind} snapshot save: {save.message}</p>
        </div>
      )}

      {save?.state === "saved" && (
        <div className="me-panel" data-testid={`me-${kind}-saved`} aria-live="polite">
          <p>
            {save.result.duplicate
              ? "This snapshot was already saved (duplicate). The original filename and creation time are unchanged."
              : "Snapshot saved."}
            {kind === "plan" ? " The imported plan remains a draft and was not adopted." : ""}
          </p>
          <p className="me-meta">
            {`ID ${save.result.artifact.id} · stored file ${save.result.artifact.source_filename ?? "(none)"} · imported ${save.result.artifact.created_at}`}
          </p>
          <Warnings warnings={save.warnings} />
          <button
            type="button"
            onClick={() => void viewSnapshot()}
            disabled={viewing}
          >
            {viewing ? "Opening…" : `View saved ${kind} snapshot`}
          </button>
          <p className="me-help">Viewing selects this snapshot explicitly. Saving itself did not.</p>
        </div>
      )}

      {viewError !== null && (
        <div role="alert" className="validation-summary">
          <p>{viewError}</p>
        </div>
      )}
    </section>
  );
}

const APPEARANCE_OPTIONS: readonly {
  id: ThemeName;
  label: string;
  description: string;
}[] = [
  {
    id: "pixel",
    label: "Pixel",
    description: "3px rules · offset shadows · blueprint grid",
  },
  {
    id: "glass",
    label: "Glass",
    description: "Hairlines · soft shadows · frosted chrome",
  },
];

type WorkoutPreviewState = WorkoutImportPreview & {
  owner: string;
  client: FitTraceClient;
};

export function MeScreen() {
  const { client, records, status: historyStatus, reload } = useWorkouts();
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { exportWorkouts, error: exportError, result: exportResult } = useWorkoutExport(records);
  const owner = user?.id ?? "local";
  const [workoutFileText, setWorkoutFileText] = useState<string | null>(null);
  const [workoutFileError, setWorkoutFileError] = useState<string | null>(null);
  const [workoutPreview, setWorkoutPreview] = useState<WorkoutPreviewState | null>(null);
  const [workoutReceipt, setWorkoutReceipt] = useState<WorkoutImportReceipt | null>(null);
  const [workoutRunError, setWorkoutRunError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [reloadAfterWriteFailed, setReloadAfterWriteFailed] = useState(false);

  const clientRef = useRef(client);
  clientRef.current = client;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const historyStatusRef = useRef(historyStatus);
  historyStatusRef.current = historyStatus;
  const mountedRef = useRef(true);
  const scopeRef = useRef(0);
  const readTokenRef = useRef(0);
  const runTokenRef = useRef(0);
  const runActiveRef = useRef(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeRef.current += 1;
      readTokenRef.current += 1;
      runTokenRef.current += 1;
      // Stop the next not-yet-submitted record; an in-flight write is never
      // withdrawn, and its result is discarded because the component is gone.
      cancelRef.current = true;
    };
  }, []);

  useEffect(() => {
    scopeRef.current += 1;
    readTokenRef.current += 1;
    runTokenRef.current += 1;
    runActiveRef.current = false;
    cancelRef.current = true;
    setWorkoutFileText(null);
    setWorkoutFileError(null);
    setWorkoutPreview(null);
    setWorkoutReceipt(null);
    setWorkoutRunError(null);
    setImporting(false);
    setReading(false);
    setReloadAfterWriteFailed(false);
  }, [client, owner]);

  // Keep the advisory preview aligned with the current history so a later
  // reload cannot leave an old "all new" confirmation on screen. The server
  // create conflict remains the authority at submit time.
  useEffect(() => {
    if (historyStatus !== "ready") return;
    setWorkoutPreview((previous) => {
      if (previous === null) return previous;
      return {
        ...previewWorkoutImport(
          { entries: previous.entries, warnings: previous.warnings },
          records,
        ),
        owner: previous.owner,
        client: previous.client,
      };
    });
  }, [historyStatus, records]);

  const isScopeCurrent = (
    scope: number,
    capturedClient: FitTraceClient,
    capturedOwner: string,
  ) =>
    mountedRef.current &&
    scope === scopeRef.current &&
    capturedClient === clientRef.current &&
    capturedOwner === ownerRef.current;

  useEffect(() => {
    if (workoutReceipt !== null && historyStatus === "error") {
      setReloadAfterWriteFailed(true);
    }
  }, [historyStatus, workoutReceipt]);

  async function handleWorkoutFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    const capturedClient = clientRef.current;
    const capturedOwner = ownerRef.current;
    const scope = scopeRef.current;
    const token = ++readTokenRef.current;
    const isCurrent = () =>
      isScopeCurrent(scope, capturedClient, capturedOwner) && token === readTokenRef.current;

    setReading(true);
    setWorkoutFileText(null);
    setWorkoutPreview(null);
    setWorkoutReceipt(null);
    setWorkoutFileError(null);
    setWorkoutRunError(null);
    setReloadAfterWriteFailed(false);
    try {
      const text = await readTextFile(file, IMPORT_MAX_FILE_BYTES);
      if (!isCurrent()) return;
      // History may have settled while the file was being read. Preview
      // against the settled records, never the ones captured before the await.
      if (historyStatusRef.current !== "ready") {
        setWorkoutFileError(
          "Workout history is not ready yet. Wait for it to load before importing.",
        );
        return;
      }
      const parsed = parseWorkoutImportFile(text);
      if (!isCurrent()) return;
      setWorkoutFileText(text);
      setWorkoutPreview({
        ...previewWorkoutImport(parsed, recordsRef.current),
        owner: capturedOwner,
        client: capturedClient,
      });
    } catch (caught) {
      if (!isCurrent()) return;
      // Invalid file: nothing was written, and no stale preview may be confirmed.
      setWorkoutFileText(null);
      setWorkoutPreview(null);
      setWorkoutFileError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent()) setReading(false);
      input.value = "";
    }
  }

  async function confirmWorkoutImport(): Promise<void> {
    // `workoutFileText` proves a full, validated file is still the current input.
    if (workoutPreview === null || workoutFileText === null) return;
    // Synchronous re-entry guard: two clicks in one tick never start two runs.
    if (runActiveRef.current) return;
    if (
      workoutPreview.owner !== ownerRef.current ||
      workoutPreview.client !== clientRef.current
    ) {
      setWorkoutPreview(null);
      return;
    }
    if (historyStatusRef.current !== "ready") {
      setWorkoutRunError("Workout history is not ready yet. Wait for it to load before importing.");
      return;
    }

    // Re-check the confirmation against current records. The preview is
    // advisory; the per-record server conflict remains authoritative.
    const latest = previewWorkoutImport(
      { entries: workoutPreview.entries, warnings: workoutPreview.warnings },
      recordsRef.current,
    );
    if (!latest.canConfirm) {
      setWorkoutPreview({
        ...latest,
        owner: workoutPreview.owner,
        client: workoutPreview.client,
      });
      setWorkoutRunError(
        latest.totalEntries === 0
          ? null
          : "Workout history changed since the preview. Review the current conflicts before importing.",
      );
      return;
    }

    const capturedClient = clientRef.current;
    const capturedOwner = ownerRef.current;
    const scope = scopeRef.current;
    const token = ++runTokenRef.current;
    const isCurrent = () =>
      isScopeCurrent(scope, capturedClient, capturedOwner) && token === runTokenRef.current;

    runActiveRef.current = true;
    cancelRef.current = false;
    setImporting(true);
    setWorkoutRunError(null);
    setReloadAfterWriteFailed(false);
    try {
      const receipt = await runWorkoutImport({
        client: capturedClient,
        entries: latest.entries,
        existing: recordsRef.current,
        isCurrent,
        isCancelled: () => cancelRef.current,
      });
      if (receipt.invalidated || !isCurrent()) return;
      setWorkoutReceipt(receipt);
      // Refresh only after the sequential batch settles. A refresh failure is
      // reported separately; it never rewrites the known write receipts.
      reload();
    } catch (caught) {
      if (!isCurrent()) return;
      setWorkoutRunError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (token === runTokenRef.current) {
        runActiveRef.current = false;
        if (isCurrent()) setImporting(false);
      }
    }
  }

  const httpMode = isHttpModeActive(
    (import.meta.env as Record<string, string | undefined> | undefined)?.VITE_FIT_TRACE_MODE,
  );
  const storageSubject =
    user === null
      ? "the current session"
      : user.isAnonymous === true
        ? "this guest identity"
        : "the signed-in account";
  const scope = httpMode
    ? `Storage scope: HTTP mode. Snapshots and selections belong to ${storageSubject} on the server.${import.meta.env.DEV ? " The development in-memory API clears on restart." : ""}`
    : "Storage scope: local mode. Snapshots and selections stay in this browser on this device; they do not sync to another device.";

  return (
    <section data-screen="me">
      <h1>Me</h1>
      <p className="me-lede">
        One place to export and restore workout data and to save imported analysis or
        plan snapshots. Training history is never overwritten.
      </p>

      <section className="me-section" aria-labelledby="me-account">
        <h2 id="me-account">Account and storage</h2>
        {user !== null ? (
          <p data-testid="me-account-identity">
            {`Signed in as ${user.email ?? user.id}`}
            {user.isAnonymous === true ? " (guest identity)" : ""}
          </p>
        ) : (
          <p data-testid="me-account-identity">Local session (no signed-in account).</p>
        )}
        {user?.isAnonymous === true && (
          <p className="me-help">
            This guest keeps data under its guest identity. Another device can recover it
            only after the same guest is upgraded to a permanent account; signing in as a
            different account never merges it.
          </p>
        )}
        <GuestUpgradePasswordNotice />
        {user?.isAnonymous === true && <GuestAccountControls />}
        <p className="me-help">{scope}</p>
      </section>

      <section className="me-section" aria-labelledby="me-export">
        <h2 id="me-export">Export workouts</h2>
        <p className="me-help">
          Downloads every restorable record as <code>workout.json</code> in the v1
          backup format. Histories that exceed the restore limits are split into numbered
          files, each within 1 MiB and 1000 records, so every downloaded file can be
          restored. A record that cannot be represented in a restorable file is left out
          and reported explicitly instead of blocking the rest of the backup.
        </p>
        <button type="button" onClick={exportWorkouts} disabled={records.length === 0}>
          Export workouts (JSON)
        </button>
        {exportError !== null && (
          <div role="alert" className="validation-summary" data-testid="me-export-error">
            <p>Could not export workouts: {exportError}</p>
          </div>
        )}
        {exportResult !== null && (
          <p role="status" className="me-help" data-testid="me-export-result">
            {exportResult.files === 0
              ? `No backup files were downloaded; ${exportResult.excluded.length} record(s) could not be exported.`
              : exportResult.files === 1
                ? `Downloaded 1 backup file with ${exportResult.records} record(s).`
                : `Downloaded ${exportResult.files} backup files with ${exportResult.records} record(s) total. Restore each file separately; the numbered filenames keep them in order.`}
          </p>
        )}
        {exportResult !== null && exportResult.excluded.length > 0 && (
          <div role="alert" className="validation-summary" data-testid="me-export-excluded">
            <p>
              {exportResult.excluded.length === 1
                ? "1 workout record was left out of this backup because it cannot be represented in a restorable file:"
                : `${exportResult.excluded.length} workout records were left out of this backup because they cannot be represented in restorable files:`}
            </p>
            <ul>
              {exportResult.excluded.map((entry, index) => (
                <li key={`${entry.id}:${index}`}>
                  <code title={entry.id}>{shortRecordId(entry.id)}</code>: {entry.reason}
                </li>
              ))}
            </ul>
            <p>
              The rest of your history was exported. The listed records remain in your
              history and are not lost, but this backup is incomplete.
            </p>
          </div>
        )}
      </section>

      <section className="me-section" aria-labelledby="me-import-workouts">
        <h2 id="me-import-workouts">Import workouts</h2>
        <p className="me-help">
          Accepts a <code>{`{ schema_version: 1, records }`}</code> backup. Every record
          must keep its original id. The file is validated in full first; confirmation
          appends records one at a time. The import is not atomic: some records may be
          saved before a failure, and existing records are never overwritten.
        </p>
        <div className="field">
          <label htmlFor="me-workout-file">Choose workout backup file</label>
          <input
            id="me-workout-file"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void handleWorkoutFile(event)}
            disabled={importing || reading || historyStatus !== "ready"}
          />
        </div>

        {historyStatus !== "ready" && (
          <p role="status" data-testid="me-workout-history-status" className="me-help">
            {historyStatus === "loading"
              ? "Loading workout history before import…"
              : "Workout history could not be loaded; import stays disabled until it is ready."}
          </p>
        )}

        {workoutFileError !== null && (
          <div role="alert" className="validation-summary" data-testid="me-workout-file-error">
            <p>Could not read the workout backup: {workoutFileError}</p>
          </div>
        )}

        {workoutPreview !== null && (
          <div className="me-panel" data-testid="me-workout-preview">
            <p>
              {`${workoutPreview.totalEntries} unique record(s), ${workoutPreview.totalIndexes} file index(es).`}
            </p>
            {workoutPreview.totalEntries === 0 ? (
              <p role="status" data-testid="me-workout-noop">
                This backup has no workout records; there is nothing to import.
              </p>
            ) : (
              <>
                <ul>
                  <li>{`New: ${workoutPreview.newIds.length}`}</li>
                  <li>{`Already present with identical content: ${workoutPreview.duplicateIds.length}`}</li>
                  <li>{`Conflicts: ${workoutPreview.conflictIds.length}`}</li>
                </ul>
                {workoutPreview.conflictIds.length > 0 && (
                  <div role="alert" className="validation-summary">
                    <p>
                      These ids already exist with different content and block the whole
                      import: {workoutPreview.conflictIds.join(", ")}.
                    </p>
                  </div>
                )}
                <Warnings warnings={workoutPreview.warnings} />
                <p className="me-help">
                  Confirming appends each new record to the current account. Identical ids
                  are no-ops. A conflict or failure stops later records. Cancel stops only
                  records that have not been submitted.
                </p>
              </>
            )}
            <div className="plan-actions">
              <button
                type="button"
                onClick={() => void confirmWorkoutImport()}
                disabled={
                  !workoutPreview.canConfirm ||
                  importing ||
                  reading ||
                  historyStatus !== "ready"
                }
              >
                {importing ? "Importing…" : "Confirm append to current account"}
              </button>
              {importing && (
                <button type="button" onClick={() => (cancelRef.current = true)}>
                  Stop after current record
                </button>
              )}
            </div>
          </div>
        )}

        {workoutRunError !== null && (
          <div role="alert" className="validation-summary">
            <p>Workout import stopped unexpectedly: {workoutRunError}</p>
          </div>
        )}

        {workoutReceipt !== null && (
          <div className="me-panel" data-testid="me-workout-receipt" aria-live="polite">
            <h3>Import receipt</h3>
            <p>
              {`Created ${workoutReceipt.counts.created} · duplicate ${workoutReceipt.counts.duplicate} · conflict ${workoutReceipt.counts.conflict} · failed ${workoutReceipt.counts.failed} · unknown ${workoutReceipt.counts.unknown} · not attempted ${workoutReceipt.counts.not_attempted}`}
            </p>
            {workoutReceipt.cancelled && <p>Stopped after the current record by request.</p>}
            <ul>
              {workoutReceipt.items.map((item) => (
                <li key={item.index}>
                  <code>{`records[${item.index}]`}</code> {item.recordId}: {item.status}
                  {item.readback === "present" ? " (confirmed present on readback)" : ""}
                  {item.readback === "absent" ? " (not found on readback)" : ""}
                  {item.readback === "unavailable" ? " (readback unavailable)" : ""}
                  {item.error !== null ? ` — ${item.error}` : ""}
                </li>
              ))}
            </ul>
            <p className="me-help">
              Re-select the same file to retry: identical ids are idempotent no-ops, and
              no new ids are derived automatically.
            </p>
          </div>
        )}

        {reloadAfterWriteFailed && (
          <div role="alert" className="validation-summary" data-testid="me-workout-reload-error">
            <p>
              The write receipts above are known, but workout history could not be
              refreshed. Reload the page to see the stored records.
            </p>
          </div>
        )}
      </section>

      <section className="me-section" aria-labelledby="me-appearance">
        <h2 id="me-appearance">Appearance</h2>
        <p className="me-help">
          Pixel draws structure with 3px rules, offset shadows and a blueprint grid. Glass
          keeps the same hierarchy with hairlines, soft shadows and a frosted chrome. The
          choice is stored in this browser and never changes workout data.
        </p>
        <div className="theme-options" role="group" aria-label="Appearance theme">
          {APPEARANCE_OPTIONS.map((option) => {
            const selected = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className="theme-option"
                aria-pressed={selected}
                aria-label={option.label}
                data-testid={`theme-option-${option.id}`}
                onClick={() => setTheme(option.id)}
              >
                <span
                  className={`theme-preview theme-preview-${option.id}`}
                  aria-hidden="true"
                />
                <span className="theme-option-copy">
                  <span className="theme-option-name">
                    {option.label}
                    <span className="theme-option-flag" aria-hidden="true">
                      On
                    </span>
                  </span>
                  <span className="theme-option-desc">{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <ImportArtifactSection kind="analysis" />
      <ImportArtifactSection kind="plan" />

      <p className="me-help">
        Jump to <Link to="/analysis">Analysis</Link> or <Link to="/plan">Plan</Link> to
        switch between current calculations and saved snapshots.
      </p>
    </section>
  );
}
