/**
 * Framework-thin access to the account's persisted session draft.
 *
 * The editor will own every draft decision; this provider only binds the
 * storage repository to one owner identity so screens never pass an owner id
 * around. The provider is keyed by the signed-in owner in `App.tsx`, so an
 * account change remounts it and no cross-account callback can survive.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SessionDraft } from "@agent-fit-trace/workout-session";
import { LocalStorageAdapter } from "../storage/adapter.ts";
import type { StorageAdapter } from "../storage/adapter.ts";
import {
  clearSessionDraft,
  loadSessionDraft,
  saveSessionDraft,
} from "../storage/sessionDraftRepository.ts";

export interface SessionDraftContextValue {
  /** The owner's stored draft, or `null`; corruption and storage errors throw. */
  load: () => SessionDraft | null;
  /** Persist one draft synchronously, replacing the previous one. */
  save: (draft: SessionDraft) => void;
  /** Delete the owner's draft. */
  clear: () => void;
}

const SessionDraftContext = createContext<SessionDraftContextValue | null>(null);

export interface SessionDraftProviderProps {
  ownerId: string;
  /** Test/non-browser override; defaults to `localStorage`. */
  adapter?: StorageAdapter;
  children: ReactNode;
}

export function SessionDraftProvider({ ownerId, adapter, children }: SessionDraftProviderProps) {
  // Resolve the default once per provider instance: a parameter default would
  // construct a new `LocalStorageAdapter` on every render.
  const [defaultAdapter] = useState(() => new LocalStorageAdapter());
  const resolvedAdapter = adapter ?? defaultAdapter;

  // Stable per owner/adapter: changing either rebuilds all three callbacks, so
  // a stale account's callback can never write into the current one's key.
  const load = useCallback(
    () => loadSessionDraft(resolvedAdapter, ownerId),
    [resolvedAdapter, ownerId],
  );
  const save = useCallback(
    (draft: SessionDraft) => saveSessionDraft(resolvedAdapter, draft, ownerId),
    [resolvedAdapter, ownerId],
  );
  const clear = useCallback(
    () => clearSessionDraft(resolvedAdapter, ownerId),
    [resolvedAdapter, ownerId],
  );

  const value = useMemo<SessionDraftContextValue>(
    () => ({ load, save, clear }),
    [load, save, clear],
  );

  return <SessionDraftContext.Provider value={value}>{children}</SessionDraftContext.Provider>;
}

/** Read the draft storage callbacks, failing loudly outside a provider. */
export function useSessionDraft(): SessionDraftContextValue {
  const value = useContext(SessionDraftContext);
  if (value === null) {
    throw new Error("useSessionDraft must be used within a <SessionDraftProvider>.");
  }
  return value;
}
