import type { ReactNode } from "react";
import type { CoachingClient } from "../api/coachingClient.ts";
import { CoachingContext, useCoachSession } from "./useCoach.ts";

/**
 * Account-level owner of the coaching lifecycle.
 *
 * Mounted once by `Layout` (which survives child-route changes), so one
 * `CoachingClient` + session + run live across Coach↔History navigation: no
 * re-bootstrap, no extra server session, and a sign-out can still tear the run
 * down with the account's captured credentials. `CoachScreen` only subscribes
 * through `useCoach()`.
 */
export function CoachingProvider({
  client,
  children,
}: {
  client?: CoachingClient;
  children: ReactNode;
}) {
  const coach = useCoachSession({ client });
  return <CoachingContext.Provider value={coach}>{children}</CoachingContext.Provider>;
}
