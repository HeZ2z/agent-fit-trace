import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { ValidationWarning } from "@agent-fit-trace/core";
import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import {
  IMPORT_MAX_FILE_BYTES,
  parseAnalysisImportFile,
  parsePlanImportFile,
  parseWorkoutImportFile,
} from "@agent-fit-trace/api-contracts";
import type {
  ImportArtifactInput,
  ImportedArtifactKind,
  SaveImportedArtifactResult,
} from "@agent-fit-trace/api-contracts";
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
import { useI18n } from "../i18n/useI18n.ts";
import { displayValidationMessage, displayWarning } from "../i18n/domain.ts";
import type { AppLanguage } from "../i18n/i18n.ts";

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
  const { language, t } = useI18n();
  if (warnings.length === 0) return null;
  return (
    <div className="validation-hints" data-testid="import-warnings">
      <p>{t("Warnings (records are still imported in normalized form):")}</p>
      <ul>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${warning.path ?? ""}-${index}`}>
            {warning.path !== undefined && <code>{warning.path}</code>}
            {warning.path !== undefined ? ": " : ""}
            {displayWarning(language, warning)}
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
  const { language, t } = useI18n();
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

  const title = kind === "analysis" ? t("Import progress analysis") : t("Import a training plan");

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
        message: `${caught instanceof Error ? caught.message : String(caught)} ${t("The snapshot may already be saved; retrying this same file is safe.")}`,
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
        t("Could not open the saved {kind} snapshot: {error}. It is still saved.", {
          kind: t(kind),
          error: caught instanceof Error ? caught.message : String(caught),
        }),
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
      <div className="field">
        <label htmlFor={`me-${kind}-file`}>{t("Choose {kind} file", { kind: t(kind) })}</label>
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
          <p>
            {t("Could not read the {kind} file: {error}", {
              kind: t(kind),
              error: displayValidationMessage(language, readError),
            })}
          </p>
        </div>
      )}

      {preview !== null && (
        <div className="me-panel" data-testid={`me-${kind}-preview`}>
          <p>
            <strong>{preview.filename}</strong>{" "}
            {preview.kind === "analysis" && "period" in preview.input.payload
              ? t("covers {from} – {to}.", {
                  from: preview.input.payload.period.from ?? t("n/a"),
                  to: preview.input.payload.period.to ?? t("n/a"),
                })
              : "recommendations" in preview.input.payload
                ? t("has {count} recommendation(s) and remains a draft.", {
                    count: preview.input.payload.recommendations.length,
                  })
                : "."}
          </p>
          <Warnings warnings={preview.warnings} />
          <button
            type="button"
            onClick={() => void saveSnapshot()}
            disabled={saving || reading}
          >
            {saving ? t("Saving…") : t("Save {kind} snapshot", { kind: t(kind) })}
          </button>
        </div>
      )}

      {save?.state === "error" && (
        <div role="alert" className="validation-summary" data-testid={`me-${kind}-save-error`}>
          <p>
            {t("Could not confirm the {kind} snapshot save: {error}", {
              kind: t(save.kind),
              error: save.message,
            })}
          </p>
        </div>
      )}

      {save?.state === "saved" && (
        <div className="me-panel" data-testid={`me-${kind}-saved`} aria-live="polite">
          <p>
            {save.result.duplicate
              ? t("This snapshot was already saved (duplicate). The original filename and creation time are unchanged.")
              : t("Snapshot saved.")}
            {kind === "plan" ? t(" The imported plan remains a draft and was not adopted.") : ""}
          </p>
          <p className="me-meta">
            {t("ID {id} · stored file {file} · imported {createdAt}", {
              id: save.result.artifact.id,
              file: save.result.artifact.source_filename ?? t("(none)"),
              createdAt: save.result.artifact.created_at,
            })}
          </p>
          <Warnings warnings={save.warnings} />
          <button
            type="button"
            onClick={() => void viewSnapshot()}
            disabled={viewing}
          >
            {viewing ? t("Opening…") : t("View saved {kind} snapshot", { kind: t(kind) })}
          </button>
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

const LANGUAGE_OPTIONS: readonly {
  id: AppLanguage;
  label: string;
  preview: string;
  description: string;
}[] = [
  {
    id: "en",
    label: "English",
    preview: "EN",
    description: "Source language. Data and exports stay in English.",
  },
  {
    id: "zh",
    label: "简体中文",
    preview: "中",
    description:
      "Display layer only: interface copy in Chinese; records and exports stay canonical English.",
  },
];

const APPEARANCE_OPTIONS: readonly {
  id: ThemeName;
  label: string;
}[] = [
  {
    id: "pixel",
    label: "Pixel",
  },
  {
    id: "glass",
    label: "Glass",
  },
];

type WorkoutPreviewState = WorkoutImportPreview & {
  owner: string;
  client: FitTraceClient;
};

export function MeScreen() {
  const { client, records, status: historyStatus, reload } = useWorkouts();
  const { user, authSurface } = useAuth();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
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
  // On the daemon the HTTP transport talks to this machine's local service,
  // so "on the server" would be a lie — snapshots stay on this device.
  const daemonLocal = authSurface === "guest-local" || authSurface === "daemon-optional";
  const storageSubject =
    user === null
      ? t("the current session")
      : user.isAnonymous === true
        ? t("this guest identity")
        : t("the signed-in account");
  const scope = daemonLocal
    ? t("Storage scope: local daemon. Snapshots and selections belong to {subject} in this machine's local store.", {
        subject: storageSubject,
      })
    : httpMode
      ? t("Storage scope: HTTP mode. Snapshots and selections belong to {subject} on the server.{devNote}", {
          subject: storageSubject,
          devNote: import.meta.env.DEV
            ? t(" The development in-memory API clears on restart.")
            : "",
        })
      : t("Storage scope: local mode. Snapshots and selections stay in this browser on this device; they do not sync to another device.");

  return (
    <section data-screen="me">
      <h1>{t("Me")}</h1>

      <section className="me-section" aria-labelledby="me-account">
        <h2 id="me-account">{t("Account and storage")}</h2>
        {user !== null ? (
          <p data-testid="me-account-identity">
            {t("Signed in as {identity}", { identity: user.email ?? user.id })}
            {user.isAnonymous === true ? t(" (guest identity)") : ""}
          </p>
        ) : (
          <p data-testid="me-account-identity">{t("Local session (no signed-in account).")}</p>
        )}
        {user?.isAnonymous === true && !daemonLocal && (
          <p className="me-help">
            {t(
              "This guest keeps data under its guest identity. Another device can recover it only after the same guest is upgraded to a permanent account; signing in as a different account never merges it.",
            )}
          </p>
        )}
        <GuestUpgradePasswordNotice />
        {user?.isAnonymous === true && <GuestAccountControls />}
        <p className="me-help">{scope}</p>
      </section>

      <section className="me-section" aria-labelledby="me-export">
        <h2 id="me-export">{t("Export workouts")}</h2>
        <button type="button" onClick={exportWorkouts} disabled={records.length === 0}>
          {t("Export workouts (JSON)")}
        </button>
        {exportError !== null && (
          <div role="alert" className="validation-summary" data-testid="me-export-error">
            <p>{t("Could not export workouts: {error}", { error: exportError })}</p>
          </div>
        )}
        {exportResult !== null && (
          <p role="status" className="me-help" data-testid="me-export-result">
            {exportResult.files === 0
              ? t("No backup files were downloaded; {count} record(s) could not be exported.", {
                  count: exportResult.excluded.length,
                })
              : exportResult.files === 1
                ? t("Downloaded 1 backup file with {count} record(s).", {
                    count: exportResult.records,
                  })
                : t(
                    "Downloaded {files} backup files with {records} record(s) total. Restore each file separately; the numbered filenames keep them in order.",
                    { files: exportResult.files, records: exportResult.records },
                  )}
          </p>
        )}
        {exportResult !== null && exportResult.excluded.length > 0 && (
          <div role="alert" className="validation-summary" data-testid="me-export-excluded">
            <p>
              {exportResult.excluded.length === 1
                ? t(
                    "1 workout record was left out of this backup because it cannot be represented in a restorable file:",
                  )
                : t(
                    "{count} workout records were left out of this backup because they cannot be represented in restorable files:",
                    { count: exportResult.excluded.length },
                  )}
            </p>
            <ul>
              {exportResult.excluded.map((entry, index) => (
                <li key={`${entry.id}:${index}`}>
                  <code title={entry.id}>{shortRecordId(entry.id)}</code>: {entry.reason}
                </li>
              ))}
            </ul>
            <p>
              {t(
                "The rest of your history was exported. The listed records remain in your history and are not lost, but this backup is incomplete.",
              )}
            </p>
          </div>
        )}
      </section>

      <section className="me-section" aria-labelledby="me-import-workouts">
        <h2 id="me-import-workouts">{t("Import workouts")}</h2>
        <div className="field">
          <label htmlFor="me-workout-file">{t("Choose workout backup file")}</label>
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
              ? t("Loading workout history before import…")
              : t("Workout history could not be loaded; import stays disabled until it is ready.")}
          </p>
        )}

        {workoutFileError !== null && (
          <div role="alert" className="validation-summary" data-testid="me-workout-file-error">
            <p>
              {t("Could not read the workout backup: {error}", {
                error: displayValidationMessage(language, workoutFileError),
              })}
            </p>
          </div>
        )}

        {workoutPreview !== null && (
          <div className="me-panel" data-testid="me-workout-preview">
            <p>
              {t("{records} unique record(s), {indexes} file index(es).", {
                records: workoutPreview.totalEntries,
                indexes: workoutPreview.totalIndexes,
              })}
            </p>
            {workoutPreview.totalEntries === 0 ? (
              <p role="status" data-testid="me-workout-noop">
                {t("This backup has no workout records; there is nothing to import.")}
              </p>
            ) : (
              <>
                <ul>
                  <li>{t("New: {count}", { count: workoutPreview.newIds.length })}</li>
                  <li>
                    {t("Already present with identical content: {count}", {
                      count: workoutPreview.duplicateIds.length,
                    })}
                  </li>
                  <li>{t("Conflicts: {count}", { count: workoutPreview.conflictIds.length })}</li>
                </ul>
                {workoutPreview.conflictIds.length > 0 && (
                  <div role="alert" className="validation-summary">
                    <p>
                      {t(
                        "These ids already exist with different content and block the whole import: {ids}.",
                        { ids: workoutPreview.conflictIds.join(", ") },
                      )}
                    </p>
                  </div>
                )}
                <Warnings warnings={workoutPreview.warnings} />
                <p className="me-help">
                  {t(
                    "Confirming appends each new record to the current account. Identical ids are no-ops. A conflict or failure stops later records. Cancel stops only records that have not been submitted.",
                  )}
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
                {importing ? t("Importing…") : t("Confirm append to current account")}
              </button>
              {importing && (
                <button type="button" onClick={() => (cancelRef.current = true)}>
                  {t("Stop after current record")}
                </button>
              )}
            </div>
          </div>
        )}

        {workoutRunError !== null && (
          <div role="alert" className="validation-summary">
            <p>
              {t("Workout import stopped unexpectedly: {error}", {
                error: displayValidationMessage(language, workoutRunError),
              })}
            </p>
          </div>
        )}

        {workoutReceipt !== null && (
          <div className="me-panel" data-testid="me-workout-receipt" aria-live="polite">
            <h3>{t("Import receipt")}</h3>
            <p>
              {t(
                "Created {created} · duplicate {duplicate} · conflict {conflict} · failed {failed} · unknown {unknown} · not attempted {notAttempted}",
                {
                  created: workoutReceipt.counts.created,
                  duplicate: workoutReceipt.counts.duplicate,
                  conflict: workoutReceipt.counts.conflict,
                  failed: workoutReceipt.counts.failed,
                  unknown: workoutReceipt.counts.unknown,
                  notAttempted: workoutReceipt.counts.not_attempted,
                },
              )}
            </p>
            {workoutReceipt.cancelled && <p>{t("Stopped after the current record by request.")}</p>}
            <ul>
              {workoutReceipt.items.map((item) => (
                <li key={item.index}>
                  <code>{`records[${item.index}]`}</code> {item.recordId}: {item.status}
                  {item.readback === "present" ? t(" (confirmed present on readback)") : ""}
                  {item.readback === "absent" ? t(" (not found on readback)") : ""}
                  {item.readback === "unavailable" ? t(" (readback unavailable)") : ""}
                  {item.error !== null
                    ? ` — ${displayValidationMessage(language, item.error)}`
                    : ""}
                </li>
              ))}
            </ul>
            <p className="me-help">
              {t(
                "Re-select the same file to retry: identical ids are idempotent no-ops, and no new ids are derived automatically.",
              )}
            </p>
          </div>
        )}

        {reloadAfterWriteFailed && (
          <div role="alert" className="validation-summary" data-testid="me-workout-reload-error">
            <p>
              {t(
                "The write receipts above are known, but workout history could not be refreshed. Reload the page to see the stored records.",
              )}
            </p>
          </div>
        )}
      </section>

      <section className="me-section" aria-labelledby="me-appearance">
        <h2 id="me-appearance">{t("Appearance")}</h2>
        <div className="theme-options" role="group" aria-label={t("Appearance theme")}>
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
                      {t("On")}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="me-section" aria-labelledby="me-language">
        <h2 id="me-language">{t("Language")}</h2>
        <p className="me-help">
          {t(
            "Choose the interface language. Workout records, saved snapshots and exported JSON keep their original English; only the interface is translated.",
          )}
        </p>
        <div className="theme-options" role="group" aria-label={t("Interface language")}>
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = language === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className="theme-option"
                aria-pressed={selected}
                aria-label={option.label}
                data-testid={`language-option-${option.id}`}
                onClick={() => setLanguage(option.id)}
              >
                <span
                  className="theme-preview theme-preview-lang"
                  aria-hidden="true"
                >
                  {option.preview}
                </span>
                <span className="theme-option-copy">
                  <span className="theme-option-name">
                    {option.label}
                    <span className="theme-option-flag" aria-hidden="true">
                      {t("On")}
                    </span>
                  </span>
                  <span className="theme-option-desc">{t(option.description)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <ImportArtifactSection kind="analysis" />
      <ImportArtifactSection kind="plan" />

    </section>
  );
}
