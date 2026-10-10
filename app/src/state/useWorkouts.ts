import { useWorkoutStore } from "./WorkoutStoreContext.tsx";
import type { WorkoutContextValue } from "./WorkoutStoreContext.tsx";

/** Thin alias over the provider value. */
export function useWorkouts(): WorkoutContextValue {
  return useWorkoutStore();
}
