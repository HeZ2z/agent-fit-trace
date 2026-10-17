/**
 * Backend/runtime registry and capability discovery (issue #7, slice A/B).
 *
 * This module is the seam between the coaching service and execution
 * engines. It owns NO process or provider code: an adapter is injected as a
 * {@link RuntimeFactory}. A registration is truthful metadata plus an
 * optional factory:
 *
 * - Only registered, available backends with a factory can launch a run.
 * - Discovery returns EVERY contract backend, marking unimplemented or
 *   unconfigured ones unavailable WITH a reason. Planned CLI integrations are
 *   never advertised as available.
 * - `local-pi` remains the legacy path: a service constructed with the old
 *   `runtimeFactory` option gets an implicit local-pi registration.
 * - `cloud-default` additionally passes the fail-closed qualification helper
 *   (trusted identity + configured quota + provider). Discovery metadata is
 *   server-derived; the browser cannot assert availability or entitlement.
 */
import type {
  CoachingAvailabilityReason,
  CoachingBackendCapabilities,
  CoachingBackendDescriptor,
  CoachingBackendId,
  CoachingCloudQuota,
  CoachingCapabilityDiscovery,
  CoachingExecutionLocation,
  CoachingRuntimeId,
  CoachingTrustedIdentity,
} from "@pi-fit-trace/api-contracts";
import {
  COACHED_TOOL_NAMES,
  COACHING_BACKEND_DEFINITIONS,
  COACHING_BACKEND_IDS,
  COACHING_CAPABILITY_VERSION,
  COACHING_DISCOVERY_VERSION,
  COACHING_PROTOCOL_VERSION,
  COACHING_SSE_TERMINAL_RESERVE_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  qualifyCloudBackend,
} from "@pi-fit-trace/api-contracts";

/** Terminal report from the runtime, with exit confirmation. */
export interface RuntimeDoneInfo {
  /** pi-specific native session file. Never a Codex/OpenCode thread id. */
  sessionFile?: string;
  /**
   * Opaque native continuation handle for engines whose session is not a
   * file (for example a Codex thread id). Bound to the run's backend and
   * product session; never passed across backends or accounts.
   */
  nativeSessionHandle?: string;
  processExitConfirmed?: boolean;
}

export interface RuntimeHandle {
  start(): void;
  cancel(reason?: string): void;
  close(): Promise<void>;
}

export interface RuntimeLaunchOptions {
  sessionId: string;
  runId: string;
  prompt: string;
  snapshotFile: string;
  snapshotDir: string;
  /** Fixed per-product-session native session dir (never the snapshot default). */
  sessionDir: string;
  /** Native pi session file to resume (same product session/account only). */
  resumeSessionFile?: string;
  /**
   * Opaque native continuation handle for non-file engines, passed only when
   * the stored handle belongs to this same backend + product session.
   */
  resumeNativeSessionHandle?: string;
  onEvent(payload: import("@pi-fit-trace/api-contracts").CoachingEventPayload): void;
  onDone(
    status: import("@pi-fit-trace/api-contracts").CoachingTerminalStatus,
    reason?: string,
    info?: RuntimeDoneInfo,
  ): void;
}

export type RuntimeFactory = (options: RuntimeLaunchOptions) => RuntimeHandle;

export interface CoachingRuntimeRegistration {
  backendId: CoachingBackendId;
  runtimeId: CoachingRuntimeId;
  executionLocation: CoachingExecutionLocation;
  displayName: string;
  available: boolean;
  /** Required when unavailable; forbidden when available. */
  unavailableReason?: CoachingAvailabilityReason;
  version?: string;
  /** Absent for discovery-only planned backends. */
  factory?: RuntimeFactory;
  /**
   * Verified capability overrides for an implemented adapter. Omitted fields
   * keep the conservative backend defaults; unimplemented backends should not
   * set these at all.
   */
  capabilities?: Partial<CoachingBackendCapabilities>;
}

export interface CoachingRuntimeRegistry {
  get(backendId: CoachingBackendId): CoachingRuntimeRegistration | undefined;
  list(): readonly CoachingRuntimeRegistration[];
}

/**
 * Build a validated registry. Duplicate backends and mismatched
 * backend/runtime pairs throw here, at wiring time, not per request.
 */
export function createCoachingRuntimeRegistry(
  registrations: readonly CoachingRuntimeRegistration[],
): CoachingRuntimeRegistry {
  const byBackend = new Map<CoachingBackendId, CoachingRuntimeRegistration>();
  for (const registration of registrations) {
    const definition = COACHING_BACKEND_DEFINITIONS[registration.backendId];
    if (definition === undefined) {
      throw new Error(`unknown coaching backend ${JSON.stringify(registration.backendId)}`);
    }
    if (definition.runtimeId !== registration.runtimeId) {
      throw new Error(
        `backend ${registration.backendId} requires runtime ${definition.runtimeId}, not ${registration.runtimeId}`,
      );
    }
    if (definition.executionLocation !== registration.executionLocation) {
      throw new Error(
        `backend ${registration.backendId} requires executionLocation ${definition.executionLocation}`,
      );
    }
    if (registration.displayName.trim() === "") {
      throw new Error(`backend ${registration.backendId} needs a display name`);
    }
    if (registration.available && registration.unavailableReason !== undefined) {
      throw new Error(`available backend ${registration.backendId} must not carry an unavailable reason`);
    }
    if (!registration.available && registration.unavailableReason === undefined) {
      throw new Error(`unavailable backend ${registration.backendId} must state a reason`);
    }
    if (registration.available && registration.factory === undefined) {
      throw new Error(`available backend ${registration.backendId} must provide a runtime factory`);
    }
    if (byBackend.has(registration.backendId)) {
      throw new Error(`duplicate coaching backend ${registration.backendId}`);
    }
    byBackend.set(registration.backendId, Object.freeze({ ...registration }));
  }
  const list = Object.freeze([...byBackend.values()]);
  return {
    get(backendId: CoachingBackendId): CoachingRuntimeRegistration | undefined {
      return byBackend.get(backendId);
    },
    list(): readonly CoachingRuntimeRegistration[] {
      return list;
    },
  };
}

/** Normalize the option seam: an already-built registry or a registration list. */
export function asCoachingRuntimeRegistry(
  value: CoachingRuntimeRegistry | readonly CoachingRuntimeRegistration[] | undefined,
): CoachingRuntimeRegistry {
  if (value === undefined) return createCoachingRuntimeRegistry([]);
  if (Array.isArray(value)) return createCoachingRuntimeRegistry(value);
  return value as CoachingRuntimeRegistry;
}

/**
 * Native continuation compatibility marker per backend. A stored native
 * handle (pi session file or engine thread/session id) is replayed only when
 * the backend, runtime, and this marker all still match; changing any of them
 * starts a fresh native session instead of crossing protocol versions.
 */
export const NATIVE_SESSION_VERSION_BY_BACKEND: Partial<Record<CoachingBackendId, string>> = {
  "local-pi": "pi-rpc-v1",
  "local-codex": "codex-app-server-v1",
  "local-opencode": "opencode-server-v1",
};

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_EVENTS = 1000;
const MAX_EVENT_BYTES = MAX_COACHING_SSE_TOTAL_BYTES - COACHING_SSE_TERMINAL_RESERVE_BYTES;

/**
 * Conservative capability defaults. Native continuation and cancel
 * confirmation are only advertised when an implemented adapter has proven
 * them; unimplemented engines keep `false`/`unsupported` even while planned.
 */
export function defaultCapabilitiesFor(backendId: CoachingBackendId): CoachingBackendCapabilities {
  const { executionLocation } = COACHING_BACKEND_DEFINITIONS[backendId];
  const isPi = backendId === "local-pi";
  return {
    capabilityVersion: COACHING_CAPABILITY_VERSION,
    protocolVersion: COACHING_PROTOCOL_VERSION,
    tools: [...COACHED_TOOL_NAMES],
    // Only in-process replay is implemented. There is no durable journal yet,
    // so the product must not promise replay across a server restart.
    productReplay: false,
    nativeContinuation: isPi,
    cancelConfirmation: isPi ? "process-exit" : "unsupported",
    maxInputBytes: MAX_INPUT_BYTES,
    maxEvents: MAX_EVENTS,
    maxEventBytes: MAX_EVENT_BYTES,
    accountEligibility: executionLocation === "cloud" ? "required" : "not-required",
    quotaReservation: executionLocation === "cloud" ? "required" : "not-required",
    // A local CLI runs on the user's device but still sends prompts and
    // snapshot-derived context to that CLI's configured model provider.
    dataDestination: executionLocation === "cloud" ? "vendor-api" : "cli-provider",
  };
}

function capabilitiesFor(registration: CoachingRuntimeRegistration): CoachingBackendCapabilities {
  const defaults = defaultCapabilitiesFor(registration.backendId);
  if (registration.capabilities === undefined) return defaults;
  return {
    ...defaults,
    ...registration.capabilities,
    // The tool surface is never widened by a registration.
    tools: [...defaults.tools],
    capabilityVersion: COACHING_CAPABILITY_VERSION,
    protocolVersion: COACHING_PROTOCOL_VERSION,
  };
}

function unavailableReason(
  code: CoachingAvailabilityReason["code"],
  message: string,
): CoachingAvailabilityReason {
  return { code, message };
}

function registrationDescriptor(registration: CoachingRuntimeRegistration): CoachingBackendDescriptor {
  const descriptor: CoachingBackendDescriptor = {
    backendId: registration.backendId,
    runtimeId: registration.runtimeId,
    executionLocation: registration.executionLocation,
    displayName: registration.displayName,
    available: registration.available,
    capabilities: capabilitiesFor(registration),
  };
  if (registration.unavailableReason !== undefined) {
    descriptor.unavailableReason = { ...registration.unavailableReason };
  }
  if (registration.version !== undefined) descriptor.version = registration.version;
  return descriptor;
}

function plannedDescriptor(
  backendId: CoachingBackendId,
  reason: CoachingAvailabilityReason,
): CoachingBackendDescriptor {
  const definition = COACHING_BACKEND_DEFINITIONS[backendId];
  return {
    backendId,
    runtimeId: definition.runtimeId,
    executionLocation: definition.executionLocation,
    displayName: displayNameFor(backendId),
    available: false,
    unavailableReason: reason,
    capabilities: defaultCapabilitiesFor(backendId),
  };
}

function displayNameFor(backendId: CoachingBackendId): string {
  switch (backendId) {
    case "local-pi":
      return "pi CLI (local)";
    case "local-codex":
      return "Codex CLI (local)";
    case "local-opencode":
      return "OpenCode CLI (local)";
    case "cloud-default":
      return "Cloud coach";
  }
}

export interface CoachingDiscoveryOptions {
  registry: CoachingRuntimeRegistry;
  /** Legacy local-pi factory from `CoachingServiceOptions.runtimeFactory`. */
  legacyLocalPiFactory?: RuntimeFactory;
  /** Trusted classification; must originate from the verified identity layer (#5). */
  identity?: CoachingTrustedIdentity | null;
  cloudQuota?: CoachingCloudQuota | null;
  cloudProviderConfigured?: boolean;
}

/**
 * Build the versioned discovery payload for one verified caller.
 *
 * Every known backend is present. `local-pi` is available only when a
 * registration (or the legacy factory) exists and is available. Cloud is
 * available only when qualification passes AND a cloud adapter is registered;
 * this slice registers none, so it stays explicitly unavailable.
 */
export function buildCoachingDiscovery(options: CoachingDiscoveryOptions): CoachingCapabilityDiscovery {
  const backends: CoachingBackendDescriptor[] = [];
  for (const backendId of COACHING_BACKEND_IDS) {
    const registration = options.registry.get(backendId);
    if (backendId === "cloud-default") {
      const qualification = qualifyCloudBackend({
        identity: options.identity,
        quota: options.cloudQuota,
        providerConfigured: options.cloudProviderConfigured,
      });
      if (!qualification.eligible) {
        backends.push(
          plannedDescriptor(
            backendId,
            qualification.reason ?? unavailableReason("identity-unverified", "Cloud eligibility could not be verified."),
          ),
        );
        continue;
      }
      if (registration === undefined || registration.factory === undefined) {
        backends.push(
          plannedDescriptor(
            backendId,
            unavailableReason("adapter-not-implemented", "Cloud coaching is eligible but no cloud adapter is configured."),
          ),
        );
        continue;
      }
      backends.push(registrationDescriptor(registration));
      continue;
    }

    if (registration !== undefined) {
      backends.push(registrationDescriptor(registration));
      continue;
    }
    if (backendId === "local-pi" && options.legacyLocalPiFactory !== undefined) {
      backends.push({
        backendId,
        runtimeId: "pi",
        executionLocation: "local",
        displayName: displayNameFor(backendId),
        available: true,
        capabilities: defaultCapabilitiesFor(backendId),
      });
      continue;
    }
    backends.push(
      plannedDescriptor(
        backendId,
        unavailableReason(
          "adapter-not-implemented",
          `${displayNameFor(backendId)} is not implemented on this server.`,
        ),
      ),
    );
  }
  return {
    discoveryVersion: COACHING_DISCOVERY_VERSION,
    protocolVersion: COACHING_PROTOCOL_VERSION,
    tools: [...COACHED_TOOL_NAMES],
    backends,
  };
}
