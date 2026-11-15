/**
 * Cloud destination settings for the desktop daemon (#87).
 *
 * The field is deliberately a separate section from backends and from workout
 * sync: pointing cloud coaching at another host is its own consent, and the
 * sync destination is not an implicit consent for it. Every check and
 * confirmation is a daemon round trip; this component never decides by itself
 * that a host is safe or compatible.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudDestinationCheck, CloudDestinationStatus } from "@agent-fit-trace/api-contracts";
import { useAuth } from "../auth/AuthContext.tsx";
import { useI18n } from "../i18n/useI18n.ts";
import {
  confirmCloudDestination,
  previewCloudDestination,
  readCloudDestination,
  resetCloudDestination,
} from "../api/cloudDestination.ts";

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The cloud server setting could not be updated.";
}

export interface CloudDestinationSettingsProps {
  /** Called after a successful change so discovery re-reads availability. */
  onChanged?: () => void;
}

export function CloudDestinationSettings({ onChanged }: CloudDestinationSettingsProps) {
  const { getAccessToken, user } = useAuth();
  const { t } = useI18n();
  const identity = user?.id ?? null;
  // `useAuth` is a hook-only module in tests and may return a fresh function on
  // every render; keep the latest getter without making it an effect dependency.
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  const [status, setStatus] = useState<CloudDestinationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [check, setCheck] = useState<CloudDestinationCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(identity);
  const requestGeneration = useRef(0);

  useEffect(() => {
    current.current = identity;
    requestGeneration.current += 1;
    setStatus(null);
    setLoading(identity !== null);
    setEditing(false);
    setAddress("");
    setCheck(null);
    setError(null);
    setNotice(null);
    setBusy(false);
  }, [identity]);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await readCloudDestination({ getAccessToken: getAccessTokenRef.current });
      if (requestGeneration.current !== requestId || current.current !== identity) return;
      setStatus(next);
    } catch (caught) {
      if (requestGeneration.current !== requestId || current.current !== identity) return;
      setError(messageOf(caught));
    } finally {
      if (requestGeneration.current === requestId && current.current === identity) setLoading(false);
    }
  }, [identity]);

  useEffect(() => {
    if (identity === null) return;
    void load();
  }, [identity, load]);

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (caught) {
      if (current.current === identity) setError(messageOf(caught));
    } finally {
      if (current.current === identity) setBusy(false);
    }
  }

  function beginEditing(): void {
    setEditing(true);
    setCheck(null);
    setError(null);
    setNotice(null);
    setAddress(status?.source === "user" ? status.destination ?? "" : "");
  }

  function cancelEditing(): void {
    setEditing(false);
    setCheck(null);
    setError(null);
    setAddress("");
  }

  async function checkAddress(): Promise<void> {
    await run(async () => {
      const next = await previewCloudDestination(address, {
        getAccessToken: getAccessTokenRef.current,
      });
      if (current.current !== identity) return;
      setCheck(next);
      if (!next.ok) {
        setError(next.error?.message ?? t("The cloud server could not be used."));
      }
    });
  }

  async function confirmAddress(): Promise<void> {
    if (check === null || !check.ok || check.destination === undefined || check.host === undefined) return;
    await run(async () => {
      const next = await confirmCloudDestination(check.destination as string, check.host as string, {
        getAccessToken: getAccessTokenRef.current,
      });
      if (current.current !== identity) return;
      setStatus(next);
      setEditing(false);
      setCheck(null);
      setAddress("");
      setNotice(t("Cloud server updated. New runs will use {host}.", { host: next.host ?? "" }));
      onChanged?.();
    });
  }

  /** Re-confirm the already-stored custom destination for THIS account. */
  async function confirmExisting(): Promise<void> {
    if (status === null || status.destination === null || status.host === null) return;
    await run(async () => {
      const next = await confirmCloudDestination(status.destination as string, status.host as string, {
        getAccessToken: getAccessTokenRef.current,
      });
      if (current.current !== identity) return;
      setStatus(next);
      setNotice(t("Server confirmed for this account."));
      onChanged?.();
    });
  }

  async function reset(): Promise<void> {
    await run(async () => {
      const next = await resetCloudDestination({ getAccessToken: getAccessTokenRef.current });
      if (current.current !== identity) return;
      setStatus(next);
      setEditing(false);
      setCheck(null);
      setAddress("");
      setNotice(
        next.source === "official"
          ? t("Reset to the official cloud server.")
          : t("The custom cloud server setting was removed."),
      );
      onChanged?.();
    });
  }

  if (identity === null) return null;

  const official = status?.source === "official";
  const custom = status?.source === "user";
  const invalid = status?.source === "invalid";
  const showForm = editing || (status !== null && status.source === "unset");
  const checkSucceeded = check?.ok === true;

  return (
    <div className="coach-settings-destination" data-testid="cloud-server-settings">
      <h3>{t("Cloud server")}</h3>
      <p className="coach-settings-note">
        {t(
          "Select which hosted Fit Trace server the cloud coach talks to. This does not change where workout sync uploads; a server only sees records hosted there.",
        )}
      </p>

      {loading && status === null ? (
        <p data-testid="cloud-server-checking">{t("Checking the cloud server setting…")}</p>
      ) : null}

      {status !== null && official ? (
        <p data-testid="cloud-server-official">
          {t("Official cloud server in use: {host}.", { host: status.host ?? "" })}
        </p>
      ) : null}

      {status !== null && custom ? (
        <p data-testid="cloud-server-custom">
          {t("Custom cloud server in use: {host}.", { host: status.host ?? "" })}
        </p>
      ) : null}

      {status !== null && custom && status.consent === "required" ? (
        <div role="alert" className="coach-settings-confirm" data-testid="cloud-server-unconfirmed">
          <p>
            {t(
              "This account has not confirmed {host}. Cloud prompts and synced workout records will be sent there after you confirm.",
              { host: status.host ?? "" },
            )}
          </p>
          <button type="button" disabled={busy} onClick={() => void confirmExisting()}>
            {t("Confirm {host}", { host: status.host ?? "" })}
          </button>
        </div>
      ) : null}

      {status !== null && custom && status.consent === "confirmed" ? (
        <p data-testid="cloud-server-consent">
          {t("This server is confirmed for this account.")}
        </p>
      ) : null}

      {status !== null && status.source === "unset" ? (
        <p data-testid="cloud-server-unset">
          {t(
            "No cloud server is configured. Enter the API base of a hosted Fit Trace deployment to use cloud coaching.",
          )}
        </p>
      ) : null}

      {invalid ? (
        <div role="alert" className="validation-warnings" data-testid="cloud-server-invalid">
          <p>{status?.error?.message ?? t("The stored cloud server setting is invalid.")}</p>
          <button type="button" disabled={busy} onClick={() => void reset()}>
            {status?.officialDestination !== null
              ? t("Reset to the official cloud server")
              : t("Reset the stored cloud server setting")}
          </button>
        </div>
      ) : null}

      {error !== null && !showForm ? (
        <div role="alert" className="validation-warnings" data-testid="cloud-server-error">
          <p>{error}</p>
          {status === null ? (
            <button type="button" disabled={busy || loading} onClick={() => void load()}>
              {t("Try again")}
            </button>
          ) : null}
        </div>
      ) : null}

      {!showForm && !invalid && status !== null ? (
        <div className="coach-settings-actions">
          <button type="button" disabled={busy} onClick={beginEditing}>
            {t("Use a different server")}
          </button>
          {custom ? (
            <button type="button" disabled={busy} onClick={() => void reset()}>
              {status.officialDestination !== null
                ? t("Reset to the official server")
                : t("Remove the custom server")}
            </button>
          ) : null}
        </div>
      ) : null}

      {showForm ? (
        <div className="coach-settings-inline-form">
          <div className="field">
            <label htmlFor="cloud-server-address">{t("Server API base")}</label>
            <input
              id="cloud-server-address"
              data-testid="cloud-server-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://coach.example.com/api/v1"
              value={address}
              disabled={busy}
              onChange={(event) => {
                setAddress(event.target.value);
                setCheck(null);
                setError(null);
              }}
            />
          </div>
          <p className="coach-settings-note">
            {t("HTTPS only, ending in /api/v1. The server must use the same account service as this app.")}
          </p>
          {error !== null ? (
            <p role="alert" className="validation-warnings" data-testid="cloud-server-form-error">
              {error}
            </p>
          ) : null}
          <div className="coach-settings-actions">
            <button
              type="button"
              disabled={busy || address.trim() === ""}
              onClick={() => void checkAddress()}
            >
              {busy && !checkSucceeded ? t("Checking…") : t("Check server")}
            </button>
            {editing ? (
              <button type="button" disabled={busy} onClick={cancelEditing}>
                {t("Cancel")}
              </button>
            ) : null}
          </div>
          {checkSucceeded && check !== null ? (
            <div className="coach-settings-confirm" data-testid="cloud-server-confirm">
              <p>
                {t(
                  "Cloud prompts and workout records synced to your account will be sent to {host}. This is a separate consent from workout sync.",
                  { host: check.host ?? "" },
                )}
              </p>
              <p>
                {check.official
                  ? t("This is the official server from this build.")
                  : t("This server uses the same account service as this app.")}
              </p>
              <div className="coach-settings-actions">
                <button type="button" disabled={busy} onClick={() => void confirmAddress()}>
                  {busy ? t("Saving…") : t("Confirm and use this server")}
                </button>
                <button type="button" disabled={busy} onClick={cancelEditing}>
                  {t("Cancel")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice !== null ? (
        <p role="status" data-testid="cloud-server-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
