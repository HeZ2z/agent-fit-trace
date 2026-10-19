import type { SQLiteDatabase } from "expo-sqlite";
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

import { openWorkoutDatabase, WorkoutRepository } from "./workoutRepository";

/** Lifecycle of the single on-device database connection. */
export type WorkoutDataStatus = "loading" | "ready" | "error";

export interface WorkoutData {
  status: WorkoutDataStatus;
  /** Available only while `status` is `"ready"`. */
  repository: WorkoutRepository | null;
  /** Open/setup failure; the message is safe to surface in the UI. */
  error: Error | null;
  /** Retry opening the database after a failure. */
  reload: () => void;
}

interface WorkoutDataState {
  status: WorkoutDataStatus;
  repository: WorkoutRepository | null;
  error: Error | null;
}

const INITIAL_STATE: WorkoutDataState = {
  status: "loading",
  repository: null,
  error: null,
};

const WorkoutDataContext = createContext<WorkoutData | null>(null);

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const message = typeof cause === "string" && cause.trim() !== "" ? cause : "Unknown error.";
  return new Error(message);
}

/** Closing is always best effort; it must never turn into a crash or an open failure. */
async function closeQuietly(database: SQLiteDatabase): Promise<void> {
  try {
    await database.closeAsync();
  } catch {
    // The native handle may already be gone; there is nothing left to release.
  }
}

/**
 * Owns the local workout database connection for the whole app.
 *
 * The database is opened once on mount and exposed through `useWorkoutData`;
 * children render immediately and each screen owns its loading/error UI.
 * Opening never throws into the tree: a failure is stored as an `Error` and
 * `reload()` retries the open. Unmounting closes the connection, and a
 * connection that finishes opening after an unmount or a newer attempt is
 * closed immediately instead of being adopted.
 */
export function WorkoutDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkoutDataState>(INITIAL_STATE);
  const databaseRef = useRef<SQLiteDatabase | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  const openDatabase = useCallback(() => {
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setState(INITIAL_STATE);

    void (async () => {
      // A reload replaces the previous connection rather than layering a second
      // one on top of it.
      const previous = databaseRef.current;
      databaseRef.current = null;
      if (previous !== null) {
        await closeQuietly(previous);
      }

      try {
        const database = await openWorkoutDatabase();
        if (!mountedRef.current || attempt !== attemptRef.current) {
          await closeQuietly(database);
          return;
        }
        databaseRef.current = database;
        setState({
          status: "ready",
          repository: new WorkoutRepository(database),
          error: null,
        });
      } catch (cause) {
        if (!mountedRef.current || attempt !== attemptRef.current) return;
        setState({ status: "error", repository: null, error: toError(cause) });
      }
    })();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    openDatabase();
    return () => {
      mountedRef.current = false;
      // Invalidate an in-flight open; when it resolves it closes its connection.
      attemptRef.current += 1;
      const database = databaseRef.current;
      databaseRef.current = null;
      if (database !== null) {
        void closeQuietly(database);
      }
    };
  }, [openDatabase]);

  const value = useMemo<WorkoutData>(
    () => ({
      status: state.status,
      repository: state.repository,
      error: state.error,
      reload: openDatabase,
    }),
    [state, openDatabase],
  );

  return <WorkoutDataContext.Provider value={value}>{children}</WorkoutDataContext.Provider>;
}

/** Local workout repository plus its connection lifecycle. */
export function useWorkoutData(): WorkoutData {
  const value = useContext(WorkoutDataContext);
  if (value === null) {
    throw new Error("useWorkoutData must be used inside a WorkoutDataProvider");
  }
  return value;
}
