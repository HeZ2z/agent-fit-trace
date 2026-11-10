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
  defaultBackendSource: "runtime" | "automatic" | null;
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
   * Monotonic counter, bumped on every published snapshot.
   *
   * `useCoach` keys its own discovery on `mode:account:guest`, which a rescan
   * does not change — so without a signal it would keep rendering a stale
   * option list after the user pressed "Check again" and a backend became
   * available. Consumers watch this instead.
   */
  revision: number;
  /**
   * Bumped when a backend PREFERENCE is written.
   *
   * The preference lives in localStorage and `useCoach` reads it into its own
   * state at mount, so a write here would otherwise leave the Coach screen
   * submitting through the previous backend while this page showed the new one.
   * Consumers fold this into their selection state.
   */
  preferenceRevision: number;
  /** Announce that a backend preference was written. */
  notifyPreferenceChanged: () => void;
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
  client?: Pick<CoachingClient, "bootstrap" | "discoverBackends" | "isBootstrapped">;
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
  const { getAccessToken, status: authStatus, user } = useAuth();
  const accountId = user?.id ?? null;
  const client = useMemo(() => {
    if (clientProp !== undefined) return clientProp;
    if (mode === "inactive") return null;
    // Bound to the ACCOUNT, not just the token accessor. `getAccessToken` is a
    // stable function across identities, so keying only on it would hand account
    // B the client that still holds A's capability — and `logout()` discards
    // credentials in a `finally` block with no account check
    // (`coachingClient.ts:567`), so A's in-flight logout would erase B's
    // freshly acquired capability and every later B call would fail as
    // "missing capability", possibly mid-run.
    return new CoachingClient({ getAccessToken });
    // `accountId` is the discriminator: a new identity gets a new client.
  }, [clientProp, mode, getAccessToken, accountId]);

  const [state, setState] = useState<CoachDiscoveryState>({
    // Seed with whatever is knowable without the network, so the first paint has
    // a truthful value instead of an empty list that renders as "nothing".
    backends: initialBackendOptions({ mode, piAvailable: runtimePiAvailable() }),
    defaultBackendId: null,
    defaultBackendSource: null,
    status: mode === "inactive" ? "idle" : "loading",
    error: null,
    refreshing: false,
  });

  const [revision, setRevision] = useState(0);
  const [preferenceRevision, setPreferenceRevision] = useState(0);
  const notifyPreferenceChanged = useCallback((): void => {
    setPreferenceRevision((current) => current + 1);
  }, []);
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
          // Reuse a live capability. `bootstrap()` coalesces CONCURRENT calls
          // but does not reuse an existing credential, so calling it on every
          // rescan mints another 10-minute capability — and the daemon caps them
          // at `MAX_CAPABILITIES_PER_ACCOUNT = 5` per account, answering 503 at
          // the cap. Four rescans after the first load would therefore wedge
          // discovery until expiry. `isBootstrapped` is the lifecycle's own
          // guard; mirror it.
          if (!client.isBootstrapped) await client.bootstrap();
          return client.discoverBackends(isRefresh);
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
          defaultBackendSource: discovery.defaultBackendSource ?? null,
          status: "ready",
          error: null,
          refreshing: false,
        });
        setRevision((current) => current + 1);
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

  // Scope everything in flight to the CURRENT client (i.e. the current account).
  //
  // Without this, a sign-in as B while A's discovery is pending would have B's
  // automatic refresh return A's promise: the account change neither bumped
  // `generation` nor cleared `inFlight`, so A's eventual result — or A's
  // failure — would be accepted into B's snapshot, and no request would follow
  // when that promise settled. B would sit on stale availability or an
  // old-account error until the user rescanned by hand.
  //
  // Bumping the generation discards any late response from the previous client
  // (the `load` body compares it after every await), and clearing `inFlight`
  // lets B start its own attempt immediately.
  useEffect(() => {
    generation.current += 1;
    inFlight.current = null;
  }, [client]);

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
    () => ({
      ...state,
      refresh,
      mode,
      revision,
      preferenceRevision,
      notifyPreferenceChanged,
      client: client as CoachingClient | null,
    }),
    [state, refresh, mode, revision, preferenceRevision, notifyPreferenceChanged, client],
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

/**
 * Snapshot revision, or 0 without a provider.
 *
 * `useCoach` folds this into its discovery key so a rescan started from the
 * settings page invalidates the Coach screen's cached option list. Without a
 * provider it stays 0, which preserves the previous behaviour exactly.
 */
export function useCoachDiscoveryRevision(): number {
  return useContext(CoachDiscoveryContext)?.revision ?? 0;
}

/** Preference-write revision, or 0 without a provider. */
export function useCoachPreferenceRevision(): number {
  return useContext(CoachDiscoveryContext)?.preferenceRevision ?? 0;
}

/**
 * The shared backend option list, or `null` without a provider.
 *
 * `useCoach` uses this INSTEAD of running its own discovery when a provider is
 * present. Re-running discovery there produced a second, independently cached
 * list: a rescan in settings updated the provider's snapshot while Coach kept
 * rendering the old one with a newly available backend still disabled.
 */
export function useSharedBackendOptions(): readonly CoachBackendOption[] | null {
  const value = useContext(CoachDiscoveryContext);
  if (value === null) return null;
  return value.status === "ready" ? value.backends : null;
}

/** The server's current automatic or operator-selected local backend. */
export function useSharedDefaultBackend(): { id: string | null; source: "runtime" | "automatic" | null } {
  const value = useContext(CoachDiscoveryContext);
  return { id: value?.defaultBackendId ?? null, source: value?.defaultBackendSource ?? null };
}
