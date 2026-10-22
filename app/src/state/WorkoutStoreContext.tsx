import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WorkoutRecord } from "@agent-fit-trace/core";
import { sortRecords } from "@agent-fit-trace/core";
import type { FitTraceClient } from "@agent-fit-trace/api-contracts";
import { createFitTraceClient } from "../api/createFitTraceClient.ts";

export interface WorkoutContextValue {
  client: FitTraceClient;
  status: "loading" | "error" | "ready";
  records: readonly WorkoutRecord[];
  loadError: Error | null;
  reload: () => void;
  saveWorkout: (input: unknown) => Promise<WorkoutRecord>;
  saveStatus: "idle" | "saving" | "error";
  saveError: Error | null;
}

const WorkoutStoreContext = createContext<WorkoutContextValue | null>(null);

export interface WorkoutStoreProviderProps {
  client?: FitTraceClient;
  children: ReactNode;
}

/**
 * Provide an async `FitTraceClient` to the subtree.
 *
 * History is loaded on mount and whenever `client` changes; stale responses
 * are discarded via a request-generation guard. The default client is
 * mode-aware (`VITE_FIT_TRACE_MODE=http` selects the HTTP client, anything
 * else stays local).
 */
export function WorkoutStoreProvider({ client: clientProp, children }: WorkoutStoreProviderProps) {
  // The parameter default `= createFitTraceClient()` would evaluate on
  // every render; keep one fallback per provider instance instead so the
  // resolved client identity stays stable.
  const [fallbackClient] = useState(() => createFitTraceClient());
  const client = clientProp ?? fallbackClient;
  const [status, setStatus] = useState<WorkoutContextValue["status"]>("loading");
  const [records, setRecords] = useState<readonly WorkoutRecord[]>([]);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saveStatus, setSaveStatus] = useState<WorkoutContextValue["saveStatus"]>("idle");
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const generationRef = useRef(0);
  const clientRef = useRef(client);
  clientRef.current = client;

  // Single guarded loader for ALL history reads. Captures the resolved
  // client and a fresh generation at request start; applies results only
  // when both are still current. Any successful current read means history
  // is fine, so it sets records, settles status to ready, and clears the
  // error — including a silent refresh after a failed load. A silent
  // failure touches nothing.
  const loadHistory = useCallback((mode: "visible" | "silent"): void => {
    const requestClient = clientRef.current;
    const generation = ++generationRef.current;
    if (mode === "visible") {
      setStatus("loading");
      setLoadError(null);
    }
    void requestClient.listWorkouts().then(
      (loaded) => {
        if (generationRef.current !== generation) return;
        if (requestClient !== clientRef.current) return;
        setRecords(loaded);
        setStatus("ready");
        setLoadError(null);
      },
      (error: unknown) => {
        if (generationRef.current !== generation) return;
        if (requestClient !== clientRef.current) return;
        if (mode === "silent") return;
        setRecords([]);
        setLoadError(error instanceof Error ? error : new Error(String(error)));
        setStatus("error");
      },
    );
  }, []);

  useEffect(() => {
    loadHistory("visible");
  }, [client, reloadToken, loadHistory]);

  // A replaced client owns fresh save state: the previous client's late
  // save completion skips all updates (guarded in saveWorkout), so reset
  // here to avoid leaving saveStatus stuck at "saving".
  useEffect(() => {
    setSaveStatus("idle");
    setSaveError(null);
  }, [client]);

  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  const saveWorkout = useCallback(
    async (input: unknown): Promise<WorkoutRecord> => {
      const saveClient = clientRef.current;
      setSaveStatus("saving");
      setSaveError(null);
      try {
        const result = await saveClient.createWorkout(input as WorkoutRecord);
        const saved = result.record;
        // The client may have been replaced while saving; skip every state
        // update in that case (the caller still receives the record).
        if (saveClient !== clientRef.current) return saved;
        // Invalidate in-flight history requests BEFORE merging so an older
        // refresh resolving later cannot clobber the just-saved record.
        generationRef.current += 1;
        // Incorporate immediately so the record is present even before the
        // background refresh resolves.
        setRecords((prev) => {
          const merged = [
            ...prev.filter((entry) => entry.id !== saved.id),
            saved,
          ];
          return sortRecords(merged);
        });
        setSaveStatus("idle");
        // Settle a still-loading history so a save during the initial load
        // does not leave status stuck: the in-flight visible read was
        // invalidated above and will never settle it. Only loading settles
        // here — an existing "error" keeps its real loadError until the
        // silent refresh below resolves it (clearing it here would degrade
        // the message to "Unknown error").
        setStatus((prev) => (prev === "loading" ? "ready" : prev));
        // Background refresh; a failure here must not surface as a save
        // failure nor drop the just-saved record.
        loadHistory("silent");
        return saved;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (saveClient === clientRef.current) {
          setSaveStatus("error");
          setSaveError(err);
        }
        throw err;
      }
    },
    [loadHistory],
  );

  const value: WorkoutContextValue = {
    client,
    status,
    records,
    loadError,
    reload,
    saveWorkout,
    saveStatus,
    saveError,
  };

  return <WorkoutStoreContext.Provider value={value}>{children}</WorkoutStoreContext.Provider>;
}

/** Read the provided workout client value, failing loudly outside a provider. */
export function useWorkoutStore(): WorkoutContextValue {
  const value = useContext(WorkoutStoreContext);
  if (value === null) {
    throw new Error("useWorkoutStore must be used within a <WorkoutStoreProvider>.");
  }
  return value;
}
