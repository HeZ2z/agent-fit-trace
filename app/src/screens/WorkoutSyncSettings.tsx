import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.tsx";
import { CAPABILITY_KEY, connectWorkoutSync, workoutSyncRequest } from "../api/workoutSync.ts";
import { useWorkoutStore } from "../state/WorkoutStoreContext.tsx";
import { useI18n } from "../i18n/useI18n.ts";

interface Status { endpoint: string; enabled: boolean; pendingCount: number; lastSuccessAt: string | null }

/** Decoded only to reset UI; the daemon independently verifies every token. */
function viewIdentity(token: string, principal: string): string {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part)) as { session_id?: unknown };
    if (typeof claims.session_id === "string" && claims.session_id !== "") return `${principal}:${claims.session_id}`;
  } catch { /* Unknown tokens reset on rotation. */ }
  return `${principal}:${token}`;
}

export function WorkoutSyncSettings() {
  const { authSurface, session, user } = useAuth();
  const { t } = useI18n();
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === CAPABILITY_KEY) setCapabilityRevision(value => value + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  if (authSurface !== "daemon-optional") return null;
  if (!session || user?.isAnonymous !== false) return <section className="me-section"><h2>{t("Workout sync")}</h2><p>{t("Sign in to sync this account's workouts.")}</p></section>;
  const identity = viewIdentity(session.accessToken, user.id);
  return <WorkoutSyncControls key={`${identity}:${capabilityRevision}`} identity={identity} token={session.accessToken} />;
}

function WorkoutSyncControls({ identity, token }: { identity: string; token: string }) {
  const { reload } = useWorkoutStore();
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ copies: number; duplicates: number; conflicts: number; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(identity);
  useEffect(() => {
    current.current = identity;
    return () => { current.current = null; };
  }, [identity]);
  const execute = async (task: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await task(); }
    catch (error) { if (current.current === identity) setMessage(error instanceof Error ? error.message : t("Sync could not be confirmed.")); }
    finally { if (current.current === identity) setBusy(false); }
  };
  const readStatus = async () => {
    const value = await workoutSyncRequest("status", token) as Status;
    if (current.current === identity) setStatus(value);
  };
  return <section className="me-section" aria-labelledby="workout-sync-title">
    <h2 id="workout-sync-title">{t("Workout sync")}</h2>
    <p>{t("Sync is manual. It shares this account's workout history with the selected service. Guest workouts stay on this device unless you explicitly import them.")}</p>
    <p>{t("MCP and pi do not automatically follow your desktop account. By default they continue using the guest store; already running processes keep the store they opened. Explicit store or principal settings select a separate store.")}</p>
    {!status ? <button type="button" disabled={busy} onClick={() => void execute(async () => { await connectWorkoutSync(token); await readStatus(); })}>{t("Connect sync")}</button> : <>
      <p>{t("Destination")}: {status.endpoint}</p>
      <button type="button" disabled={busy} onClick={() => void execute(async () => {
        const value = await workoutSyncRequest("guest-preview", token) as { copies: number; duplicates: number; conflicts: number; fingerprint: string };
        if (current.current === identity) setPreview(value);
      })}>{t("Preview guest import")}</button>
      {preview ? <div>
        <p>{t("To copy")}: {preview.copies}; {t("already present")}: {preview.duplicates}; {t("conflicts kept unchanged")}: {preview.conflicts}.</p>
        <p>{t("Import keeps the guest originals and allows this account's workouts to be uploaded to the destination below when you manually sync.")}</p>
        <button type="button" disabled={busy} onClick={() => void execute(async () => {
          const result = await workoutSyncRequest("guest-import", token, { fingerprint: preview.fingerprint }) as { copied: number; conflicts: number };
          if (current.current !== identity) return;
          setPreview(null); reload(); await readStatus();
          if (current.current === identity) setMessage(t("Guest import finished. Copied {copied}; conflicts {conflicts}.", { copied: result.copied, conflicts: result.conflicts }));
        })}>{t("Import guest workouts and allow sync")}</button>
      </div> : null}

      <p>{status.enabled ? t("Sync is enabled for this account and destination.") : t("Sync is not enabled.")}</p>
      {status.enabled ? <>
        <p>{t("Pending workouts")}: {status.pendingCount}</p>
        <button type="button" disabled={busy} onClick={() => void execute(async () => {
          const result = await workoutSyncRequest("run", token) as { status?: string; counts?: { pulled?: number; pushed?: number; conflicts?: number } };
          if (current.current !== identity) return;
          reload(); await readStatus();
          if (current.current === identity) setMessage(result.status === "done"
            ? t("Sync finished. Pulled {pulled}, uploaded {pushed}, conflicts {conflicts}.", { pulled: result.counts?.pulled ?? 0, pushed: result.counts?.pushed ?? 0, conflicts: result.counts?.conflicts ?? 0 })
            : t("Sync did not finish. An upload may already have reached the service; retry to reconcile."));
        })}>{t("Sync now")}</button>{" "}
        <button type="button" disabled={busy} onClick={() => void execute(async () => { await workoutSyncRequest("revoke-consent", token); await readStatus(); })}>{t("Stop syncing")}</button>
      </> : <button type="button" disabled={busy} onClick={() => void execute(async () => { await workoutSyncRequest("consent", token, { endpoint: status.endpoint }); await readStatus(); })}>{t("Allow sync for this account")}</button>}
    </>}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
