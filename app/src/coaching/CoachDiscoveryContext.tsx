/**
 * Shared coaching-backend discovery.
 *
 * Why this is a provider and not a hook inside a screen: discovery is not free.
 * `GET /coaching/capabilities` requires a capability credential, the capability
 * is minted by a separate `POST /coaching/bootstrap`, it expires after ten
 * minutes (`DEFAULT_CAPABILITY_TTL_MS`, `coachingServer.ts:90`), and the daemon
 * caps how many may be outstanding per account and in total
 * (`MAX_CAPABILITIES_PER_ACCOUNT = 5`, `:93`) — at the cap it answers 503
 * "Capability capacity reached" rather than evicting a live one.
 *
 * So two screens each bootstrapping their own client would burn a slot each,
 * could exhaust the budget on repeated mounts, and could show two different
 * answers for the same question. One provider owns the bootstrap, the TTL, and
 * a single in-flight request; every consumer reads the same snapshot.
 *
 * The provider deliberately owns NO selection state. Choosing a backend stays in
 * `useCoach` (the Coach screen owns run semantics) and the settings page writes
 * the same preference key through the same helper. Duplicating the selection
 * rules here would be the "second selection system" ADR 0008 warns against.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CoachingCapabilityDiscovery } from "@agent-fit-trace/api-contracts";
import { useAuth } from "../auth/AuthContext.tsx";
import { CoachingClient } from "../api/coachingClient.ts";
import { isCoachingEnabled, isHttpModeActive, runtimePiAvailable } from "../api/runtimeMode.ts";
import {
  descriptorToOption,
  initialBackendOptions,
  localPiOption,
} from "./coachBackend.ts";
import type { CoachBackendOption, CoachMode } from "./coachBackend.ts";

/** Why the snapshot is what it is. `error` is a message, never a raw exception. */
export interface CoachDiscoveryState {
  backends: readonly CoachBackendOption[];
  /** Backend the server suggests for a run that names none (ADR 0008 §discovery). */
  defaultBackendId: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  /** Present when `status === "failed"`; safe to render. */
  error: string | null;
  /** True while a refresh is in flight (a manual rescan). */
  refreshing: boolean;
}

export interface CoachDiscoveryContextValue extends CoachDiscoveryState {
  /** Re-run discovery. Coalesced: a call during an in-flight one returns it. */
  refresh: () => Promise<void>;
  /** The mode discovery resolved to, so consumers agree on launcher vs browser. */
  mode: CoachMode;
  /**
   * The ONE local coaching client for this app instance.
   *
   * Exposed so `useCoach` can run its capability-bound calls through the same
   * client this provider already bootstrapped. Two clients would each call
   * `/coaching/bootstrap`, mint two capabilities against the daemon's
   * per-account cap, and — as `App.coachNavigation.test.tsx` asserts — a user
   * navigating between Coach and History would burn through them.
   *
   * `null` when this build has no addressable coaching surface.
   */
  client: CoachingClient | null;
}

const CoachDiscoveryContext = createContext<CoachDiscoveryContextValue | null>(null);

export interface CoachDiscoveryProviderProps {
  /** Test/embedding seam; production builds its own client. */
  client?: Pick<CoachingClient, "bootstrap" | "discoverBackends">;
  /** Test seam: skips the automatic first load. */
  autoLoad?: boolean;
  children: ReactNode;
}

/**
 * Resolve the mode the same way `useCoach` does, so the two surfaces cannot
 * disagree about which backend family is even addressable.
 *
 * `launcher` wins when the daemon injected same-origin coaching; otherwise a
 * valid HTTP deployment is `browser`; nothing else is addressable.
 */
function resolveMode(): CoachMode {
  if (isCoachingEnabled()) return "launcher";
  if (isHttpModeActive()) return "browser";
  return "inactive";
}

export function CoachDiscoveryProvider({
  client: clientProp,
  autoLoad = true,
  children,
}: CoachDiscoveryProviderProps) {
  const mode = useMemo(resolveMode, []);
  // The token must be live: `useCoach` runs its capability-bound calls through
  // this same client, so a null provider here would make every run unauthenticated.
  const { getAccessToken, status: authStatus } = useAuth();
  const client = useMemo(() => {
    if (clientProp !== undefined) return clientProp;
    if (mode === "inactive") return null;
    return new CoachingClient({ getAccessToken });
  }, [clientProp, mode, getAccessToken]);

  const [state, setState] = useState<CoachDiscoveryState>({
    // Seed with whatever is knowable without the network, so the first paint has
    // a truthful value instead of an empty list that renders as "nothing".
    backends: initialBackendOptions({ mode, piAvailable: runtimePiAvailable() }),
    defaultBackendId: null,
    status: mode === "inactive" ? "idle" : "loading",
    error: null,
    refreshing: false,
  });

  const inFlight = useRef<Promise<void> | null>(null);
  /** Guards a late response from a superseded request (account switch, rescan). */
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Any in-flight response is now irrelevant: bump so it is discarded.
      generation.current += 1;
    };
  }, []);

  const load = useCallback(
    async (isRefresh: boolean): Promise<void> => {
      if (client === null) return;
      generation.current += 1;
      const requestGeneration = generation.current;
      if (mounted.current) {
        setState((previous) => ({
          ...previous,
          status: previous.backends.length === 0 ? "loading" : previous.status,
          refreshing: isRefresh,
          error: null,
        }));
      }
      try {
        if (mode === "browser") {
          // The cloud client has no capability handshake; discovery there is
          // driven by cloud capabilities, which this provider does not own
          // (the Coach screen already derives them). Nothing to fetch.
          if (mounted.current && requestGeneration === generation.current) {
            setState((previous) => ({ ...previous, status: "ready", refreshing: false }));
          }
          return;
        }
        const discovery: CoachingCapabilityDiscovery = await (async () => {
          await client.bootstrap();
          return client.discoverBackends();
        })();
        if (!mounted.current || requestGeneration !== generation.current) return;
        const piAvailable = runtimePiAvailable();
        setState({
          backends: discovery.backends.map((descriptor) => {
            if (descriptor.backendId !== "local-pi" || piAvailable !== false) {
              return descriptorToOption(descriptor);
            }
            // Prefer the SERVER's reason: it separates a missing CLI from a
            // missing or broken extension, and only the former is fixed by
            // installing pi (see #67).
            const option = descriptorToOption(descriptor);
            if (option.available === false && option.unavailableReason !== undefined) {
              return option;
            }
            return localPiOption(false);
          }),
          defaultBackendId: discovery.defaultBackendId ?? null,
          status: "ready",
          error: null,
          refreshing: false,
        });
      } catch (caught) {
        if (!mounted.current || requestGeneration !== generation.current) return;
        setState((previous) => ({
          ...previous,
          status: "failed",
          refreshing: false,
          error: caught instanceof Error ? caught.message : "Coaching discovery failed.",
        }));
      }
    },
    [client, mode],
  );

  const refresh = useCallback((): Promise<void> => {
    // Coalesce: a rescan pressed twice must not mint a second capability.
    if (inFlight.current !== null) return inFlight.current;
    const attempt = load(true).finally(() => {
      if (inFlight.current === attempt) inFlight.current = null;
    });
    inFlight.current = attempt;
    return attempt;
  }, [load]);

  useEffect(() => {
    if (!autoLoad) return;
    // Wait for a VERIFIED signed-in session. Bootstrapping while auth is still
    // loading mints a capability for no principal (or with a null token, which
    // the daemon rejects as UNAUTHENTICATED) and wastes a slot from the
    // per-account budget that `App.coachNavigation.test.tsx` pins at one.
    if (authStatus !== "signed-in") return;
    // Not awaited: the first paint must not block on the network. `refresh`'s
    // coalescing means a caller arriving in the same tick shares this attempt.
    void refresh();
  }, [autoLoad, authStatus, refresh]);

  const value = useMemo<CoachDiscoveryContextValue>(
    () => ({ ...state, refresh, mode, client: client as CoachingClient | null }),
    [state, refresh, mode, client],
  );

  return <CoachDiscoveryContext.Provider value={value}>{children}</CoachDiscoveryContext.Provider>;
}

/**
 * Read the shared discovery snapshot.
 *
 * Throws when there is no provider, deliberately: a silent empty fallback would
 * render "no backends" for a wiring mistake, which is indistinguishable from the
 * real "nothing is installed" state and would be debugged as the wrong problem.
 */
export function useCoachDiscovery(): CoachDiscoveryContextValue {
  const value = useContext(CoachDiscoveryContext);
  if (value === null) {
    throw new Error("useCoachDiscovery must be used inside CoachDiscoveryProvider");
  }
  return value;
}

/**
 * The shared client, or `null` when no provider is mounted.
 *
 * `useCoach` must survive being rendered without a provider (a test or an
 * embedding that mounts only the Coach screen), so this variant returns `null`
 * instead of throwing and lets the caller build its own client. The strict
 * `useCoachDiscovery` above stays strict for consumers that genuinely need the
 * shared snapshot.
 */
export function useCoachDiscoveryClient(): CoachingClient | null {
  return useContext(CoachDiscoveryContext)?.client ?? null;
}
