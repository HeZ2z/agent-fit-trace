import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { readSupabaseAuthConfig, useAuth } from "@/auth";
import {
  LANGUAGE_STORAGE_KEY,
  isLanguage,
  useI18n,
} from "@/i18n";
import { isSkinName } from "@/theme";
import { SKIN_STORAGE_KEY, useSkin } from "@/theme/skin";

import { readAccountMetadata, writeAccountMetadata } from "./accountPreferences";
import {
  decidePreferences,
  mergePreferenceMetadata,
  toPreferencesError,
  type LocalPreferences,
  type PartialPreferences,
  PreferencesError,
} from "./preferencesModel";

/**
 * Account-scoped skin + language preferences.
 *
 * The local stores remain the source of truth for how the app renders. This
 * provider only bridges them with `user_metadata`:
 *
 * - signed-in: reconcile once per identity, apply account values without
 *   echoing a write, upload local values the account is missing, and push
 *   later explicit local changes through;
 * - signed-out: no account calls at all; skin and language behave exactly as
 *   before.
 *
 * Every account failure is caught and surfaced as a non-blocking `error`
 * status; local choices are never erased and the app never crashes.
 */

export type PreferencesSyncStatus = "idle" | "syncing" | "synced" | "error";

export interface PreferencesContextValue {
  /** Sync lifecycle for the signed-in account (idle while signed out). */
  status: PreferencesSyncStatus;
  /** Last account failure, redacted; local preferences still apply. */
  error: PreferencesError | null;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * Read the persisted local choices without depending on the skin/language
 * providers having finished hydrating. This avoids uploading a default skin or
 * system language during the first-sign-in hand-off when AsyncStorage still
 * holds the real choice.
 */
async function readPersistedLocalPreferences(
  fallback: LocalPreferences,
): Promise<LocalPreferences> {
  try {
    const [storedSkin, storedLanguage] = await Promise.all([
      AsyncStorage.getItem(SKIN_STORAGE_KEY),
      AsyncStorage.getItem(LANGUAGE_STORAGE_KEY),
    ]);
    return {
      skin: isSkinName(storedSkin) ? storedSkin : fallback.skin,
      language: isLanguage(storedLanguage) ? storedLanguage : fallback.language,
    };
  } catch {
    return fallback;
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [config] = useState(() => readSupabaseAuthConfig());
  const { status: authStatus, user, getAccessToken } = useAuth();
  const { language, setLanguage } = useI18n();
  const { skin, setSkin } = useSkin();

  const [status, setStatus] = useState<PreferencesSyncStatus>("idle");
  const [error, setError] = useState<PreferencesError | null>(null);
  /**
   * False until a reconciliation attempt has installed the account baseline.
   * The write-through effect ignores local values before that point so a
   * sign-in never overwrites an existing account preference with device
   * defaults.
   */
  const [ready, setReady] = useState(false);

  const localRef = useRef<LocalPreferences>({ skin, language });
  // SkinProvider recreates `setSkin` whenever the skin changes. Keeping the
  // setters in a ref means applying an account value does not re-run the
  // reconcile effect (which only depends on identity/config).
  const settersRef = useRef({
    setSkin,
    setLanguage,
  });
  const identityRef = useRef<string | null>(null);
  const reconciledRef = useRef<string | null>(null);
  const baselineRef = useRef<LocalPreferences | null>(null);
  const metadataRef = useRef<Record<string, unknown> | null>(null);
  /** Values being applied from the account; suppresses an echo write. */
  const pendingApplyRef = useRef<PartialPreferences | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    localRef.current = { skin, language };
    settersRef.current = { setSkin, setLanguage };
  }, [language, setSkin, skin]);

  const clearAccountState = useCallback(() => {
    identityRef.current = null;
    reconciledRef.current = null;
    baselineRef.current = null;
    metadataRef.current = null;
    pendingApplyRef.current = null;
    setReady(false);
  }, []);

  // Reconcile once per signed-in identity. The account is read through the
  // verified user endpoint so a restored session gets the same treatment as a
  // fresh sign-in.
  useEffect(() => {
    const userId = user?.id ?? null;
    if (authStatus !== "signed-in" || userId === null) {
      if (identityRef.current !== null) {
        clearAccountState();
        setStatus("idle");
        setError(null);
      }
      return;
    }

    if (identityRef.current !== null && identityRef.current !== userId) {
      clearAccountState();
    }
    if (reconciledRef.current === userId) return;

    reconciledRef.current = userId;
    identityRef.current = userId;
    setStatus("syncing");
    setError(null);

    let cancelled = false;
    void (async () => {
      let storedLocal: LocalPreferences | null = null;
      try {
        const token = getAccessToken();
        if (config === null || token === null) {
          // No account transport; local preferences remain authoritative.
          baselineRef.current = localRef.current;
          setStatus("idle");
          setReady(true);
          return;
        }

        // Read the persisted choice first so a failed account read still
        // installs the right baseline; otherwise a later hydration could look
        // like a user edit and overwrite an account value we never saw.
        storedLocal = await readPersistedLocalPreferences(localRef.current);
        if (cancelled || identityRef.current !== userId) return;

        const metadata = await readAccountMetadata(config, token);
        if (cancelled || identityRef.current !== userId) return;

        const decision = decidePreferences(metadata, storedLocal);
        // The baseline is installed before the setters run so the resulting
        // skin/language render is recognised as "already reconciled". The
        // device may still be showing its pre-hydration defaults, so apply
        // every effective value that differs from the current context — this
        // is the same value hydration would install, just without waiting.
        const effectiveLocal: LocalPreferences = {
          ...storedLocal,
          ...decision.applyLocal,
        };
        baselineRef.current = effectiveLocal;
        metadataRef.current = metadata;

        const currentLocal = localRef.current;
        const toApply: PartialPreferences = {};
        if (effectiveLocal.skin !== currentLocal.skin) {
          toApply.skin = effectiveLocal.skin;
        }
        if (effectiveLocal.language !== currentLocal.language) {
          toApply.language = effectiveLocal.language;
        }
        if (toApply.skin !== undefined || toApply.language !== undefined) {
          pendingApplyRef.current = toApply;
          if (toApply.skin !== undefined) settersRef.current.setSkin(toApply.skin);
          if (toApply.language !== undefined) {
            settersRef.current.setLanguage(toApply.language);
          }
        }

        if (decision.uploadLocal !== undefined) {
          const written = await writeAccountMetadata(
            config,
            token,
            mergePreferenceMetadata(metadata, decision.uploadLocal),
          );
          if (cancelled || identityRef.current !== userId) return;
          metadataRef.current = written;
        }

        if (cancelled || identityRef.current !== userId) return;
        setStatus("synced");
        setError(null);
        setReady(true);
      } catch (cause) {
        if (cancelled || identityRef.current !== userId) return;
        // Keep local values, install the baseline once, and report softly.
        // `pendingApplyRef` deliberately survives: if the upload failed after
        // account values were applied, the next render must not echo them.
        baselineRef.current ??= storedLocal ?? localRef.current;
        setError(toPreferencesError(cause));
        setStatus("error");
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      // Allow StrictMode's double-invoked effect to run a real reconciliation.
      if (reconciledRef.current === userId) reconciledRef.current = null;
    };
  }, [
    authStatus,
    clearAccountState,
    config,
    getAccessToken,
    user?.id,
  ]);

  const pushPreferences = useCallback(
    (userId: string, patch: PartialPreferences): void => {
      const task = async (): Promise<void> => {
        if (identityRef.current !== userId) return;
        const token = getAccessToken();
        if (config === null || token === null) return;
        try {
          // Retry a failed initial read before writing: sending a fresh object
          // without the rest of user_metadata would drop unrelated fields.
          let metadata = metadataRef.current;
          if (metadata === null) {
            metadata = await readAccountMetadata(config, token);
            if (identityRef.current !== userId) return;
            metadataRef.current = metadata;
          }
          const written = await writeAccountMetadata(
            config,
            token,
            mergePreferenceMetadata(metadata, patch),
          );
          if (identityRef.current !== userId) return;
          metadataRef.current = written;
          setStatus("synced");
          setError(null);
        } catch (cause) {
          if (identityRef.current !== userId) return;
          setError(toPreferencesError(cause));
          setStatus("error");
        }
      };
      // Serialize writes so two quick taps merge onto the latest metadata
      // instead of racing stale responses.
      writeChainRef.current = writeChainRef.current.then(task, task);
    },
    [config, getAccessToken],
  );

  // Write later explicit local choices through to the account. Applying account
  // values clears `pendingApplyRef` first, so the resulting re-render cannot
  // echo the account value back as a PUT.
  useEffect(() => {
    if (authStatus !== "signed-in" || !ready) return;
    const userId = user?.id;
    const baseline = baselineRef.current;
    if (userId === undefined || baseline === null) return;

    const pending = pendingApplyRef.current;
    if (pending !== null) {
      const skinApplied = pending.skin === undefined || skin === pending.skin;
      const languageApplied =
        pending.language === undefined || language === pending.language;
      if (!skinApplied || !languageApplied) return;
      pendingApplyRef.current = null;
    }

    const patch: PartialPreferences = {};
    if (skin !== baseline.skin) patch.skin = skin;
    if (language !== baseline.language) patch.language = language;
    if (patch.skin === undefined && patch.language === undefined) return;

    baselineRef.current = { ...baseline, ...patch };
    setStatus("syncing");
    setError(null);
    pushPreferences(userId, patch);
  }, [authStatus, language, pushPreferences, ready, skin, user?.id]);

  const value = useMemo<PreferencesContextValue>(
    () => ({ status, error }),
    [error, status],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (value === null) {
    throw new Error("usePreferences must be used inside a PreferencesProvider.");
  }
  return value;
}
