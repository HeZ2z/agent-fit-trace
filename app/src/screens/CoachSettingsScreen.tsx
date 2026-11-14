import { WorkoutSyncSettings } from "./WorkoutSyncSettings.tsx";
/**
 * Coaching backend settings.
 *
 * The page exists because choosing an agent backend is a configuration
 * decision, not a chat affordance, and ADR 0008 requires the choice to be made
 * somewhere the user can see what is actually installed: which CLI, which
 * version, which binary, and — when it cannot be used — why.
 *
 * What this page deliberately does NOT do:
 *
 * - **It does not run discovery itself.** It reads `useCoachDiscovery`, which
 *   owns the single `bootstrap` + `capabilities` round trip. Bootstrapping here
 *   would mint a second capability against the daemon's per-account cap
 *   (`MAX_CAPABILITIES_PER_ACCOUNT = 5`) and could show a different answer than
 *   the Coach screen for the same machine.
 * - **It does not own selection state.** `selectBackend` in `useCoach` already
 *   validates availability, refuses while a run is pinned, and writes the
 *   preference. This page calls the same pure helpers and the same preference
 *   writer, so there is one rule set rather than two that can drift.
 * - **It never asserts availability.** Every entry comes from the server's
 *   descriptors; the page only renders them and refuses to select a disabled
 *   one.
 *
 * Guest behaviour follows ADR 0008: the local CLI section renders normally
 * (probing needs no account), and the cloud section is a placeholder rather than
 * a blank, because absence reads as "broken" and that is the wrong assumption to
 * leave a user with.
 */

import { useMemo } from "react";
import { useAuth } from "../auth/AuthContext.tsx";
import { useI18n } from "../i18n/useI18n.ts";
import { useCoachDiscovery } from "../coaching/CoachDiscoveryContext.tsx";
import { isCloudCoachingProxied } from "../api/runtimeMode.ts";
import { preferredBackendChoice, readBackendPreference, writeBackendPreference } from "../coaching/coachBackend.ts";
import type { CoachBackendOption } from "../coaching/coachBackend.ts";

/** One selectable backend, with its evidence and its refusal reason. */
function BackendRow({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: CoachBackendOption;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const selectable = option.available && !disabled;
  return (
    <li className="coach-backend-row" data-backend={option.id}>
      <label>
        <input
          type="radio"
          name="coach-backend"
          value={option.id}
          checked={selected}
          disabled={!selectable}
          onChange={onSelect}
        />
        <span className="coach-backend-label">{option.label}</span>
      </label>
      {option.available ? null : (
        <p className="coach-backend-reason" data-testid={`reason-${option.id}`}>
          {option.unavailableReason?.message ?? t("Unavailable for an unspecified reason.")}
        </p>
      )}
    </li>
  );
}

export function CoachSettingsScreen() {
  const { user, authSurface } = useAuth();
  const { t } = useI18n();
  const {
    backends,
    status,
    error,
    refreshing,
    refresh,
    defaultBackendId,
    defaultBackendSource,
    mode,
    preferenceRevision,
    notifyPreferenceChanged,
  } = useCoachDiscovery();
  const accountId = user?.id ?? null;
  const isGuest = user?.isAnonymous !== false;
  // The daemon's reviewed proxy to the approved hosted destination. It is a
  // transport capability; the hosted route still decides entitlement.
  const cloudProxy = isCloudCoachingProxied();

  const localOptions = useMemo(
    () => backends.filter((option) => option.location === "local"),
    [backends],
  );
  const cloudOptions = useMemo(
    () => backends.filter((option) => option.location === "cloud"),
    [backends],
  );

  // The preference is per account; a guest has none, so the server's suggestion
  // (or the eventual default) is what the radio shows.
  const selection = useMemo(() => {
    return preferredBackendChoice({
      preference: accountId === null ? null : readBackendPreference(accountId),
      defaultId: defaultBackendId,
      defaultSource: defaultBackendSource,
      options: backends,
      cloudProxy,
      cloudSupported: cloudProxy || mode === "browser",
    });
    // `preferenceRevision` is not read directly; it is the invalidation signal
    // that makes this recompute after `writeBackendPreference`.
  }, [accountId, backends, defaultBackendId, defaultBackendSource, cloudProxy, mode, preferenceRevision]);
  const selected = selection.backendId;

  function select(id: CoachBackendOption["id"]): void {
    const option = backends.find((candidate) => candidate.id === id);
    // Re-check availability here rather than trusting the disabled attribute:
    // a stale render could otherwise persist an unavailable choice.
    if (option === undefined || !option.available) return;
    if (accountId === null) return;
    writeBackendPreference(accountId, id);
    // Announce it: `useCoach` holds its own selection state read at mount, so
    // without this the radio would show the new backend while the next run
    // still used the old one.
    notifyPreferenceChanged();
  }

  return (
    <section data-screen="coach-settings" data-selection-source={selection.source}>
      <section className="me-section" aria-labelledby="coach-settings-cli">
        <h2 id="coach-settings-cli">{t("Local coaching")}</h2>
        <p>
          {t(
            "A local coach runs on this machine using your own agent CLI. Nothing leaves your device through this path; the CLI uses whatever model provider you configured for it.",
          )}
        </p>

        {status === "failed" ? (
          <div role="alert" className="validation-warnings">
            {t("Could not read which agent CLIs are installed: {error}", {
              error: error ?? "",
            })}
            <button type="button" onClick={() => void refresh()} disabled={refreshing}>
              {t("Try again")}
            </button>
          </div>
        ) : null}

        {localOptions.length === 0 ? (
          <p data-testid="no-local-backends">
            {status === "loading" ? t("Checking which agent CLIs are installed…") : t("No local coaching backend is configured.")}
          </p>
        ) : (
          <ul className="coach-backend-list">
            {localOptions.map((option) => (
              <BackendRow
                key={option.id}
                option={option}
                selected={selected === option.id}
                // A guest can look but not persist: the preference key is
                // per account, and silently dropping the write would look like
                // a broken radio button.
                disabled={accountId === null}
                onSelect={() => select(option.id)}
              />
            ))}
          </ul>
        )}

        {accountId === null ? (
          <p className="coach-settings-note" data-testid="local-needs-account">
            {t("Sign in to remember this choice. You can still change it per session from the Coach screen.")}
          </p>
        ) : null}

        <button type="button" onClick={() => void refresh()} disabled={refreshing || status === "loading"}>
          {refreshing ? t("Checking…") : t("Check again")}
        </button>
      </section>

      {authSurface === "daemon-optional" ? <WorkoutSyncSettings /> : null}
      <section className="me-section" aria-labelledby="coach-settings-cloud">
        <h2 id="coach-settings-cloud">{t("Cloud coaching")}</h2>
        {isGuest ? (
          // ADR 0008: a placeholder, not a blank. A missing section is
          // indistinguishable from a broken one, and "broken" is the cheaper
          // assumption for a user to reach.
          <p data-testid="cloud-placeholder">
            {t(
              "Cloud coaching runs on the hosted service and needs a signed-in account, so it is not available as a guest. Sign in from the Me screen to enable it.",
            )}
          </p>
        ) : !cloudProxy ? (
          <p data-testid="cloud-not-wired">
            {t(
              "This build has no approved cloud server destination, so cloud coaching is unavailable. Only local coaching can run.",
            )}
          </p>
        ) : (
          <p data-testid="cloud-history-disclosure">
            {t(
              "The hosted coach reads the workout records synced to your account. Records that exist only on this device are not visible to it until you sync them.",
            )}
          </p>
        )}
        {cloudOptions.length > 0 ? (
          <ul className="coach-backend-list">
            {cloudOptions.map((option) => (
              <BackendRow
                key={option.id}
                option={option}
                selected={selected === option.id}
                disabled={accountId === null}
                onSelect={() => select(option.id)}
              />
            ))}
          </ul>
        ) : cloudProxy && !isGuest && status === "loading" ? (
          <p data-testid="cloud-checking">{t("Checking cloud availability…")}</p>
        ) : null}
        {mode === "inactive" ? (
          <p className="coach-settings-note">
            {t("This build has no coaching surface configured.")}
          </p>
        ) : null}
      </section>
    </section>
  );
}
