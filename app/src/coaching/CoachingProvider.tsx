import type { ReactNode } from "react";
import type { CoachRunClient } from "./coachBackend.ts";
import { CoachingContext, useCoachSession } from "./useCoach.ts";

/**
 * Account-level owner of the coaching lifecycle.
 *
 * Mounted once by `Layout` (which survives child-route changes), so one
 * coaching client/session/run lives across Coach↔History navigation: no
 * re-bootstrap, no extra server session, and a sign-out can still tear the run
 * down with the account's captured credentials. `CoachScreen` only subscribes
 * through `useCoach()`.
 */
export function CoachingProvider({
  client,
  children,
}: {
  client?: CoachRunClient;
  children: ReactNode;
}) {
  const coach = useCoachSession({ client });
  return <CoachingContext.Provider value={coach}>{children}</CoachingContext.Provider>;
}
