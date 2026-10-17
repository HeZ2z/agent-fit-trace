import {
  COACHING_BACKEND_DEFINITIONS,
  isCoachingBackendId,
} from "@pi-fit-trace/api-contracts";
import type {
  CloudCapabilities,
  CoachingBackendDescriptor,
  CoachingBackendId,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingRuntimeId,
  SubmitCoachingRunInput,
} from "@pi-fit-trace/api-contracts";

/**
 * Backend selection is a UI concern only for THIS slice: the server remains
 * the authority for availability and entitlement. These helpers describe the
 * options the user may choose, never assert them to the server as facts.
 */

export type CoachMode = "explicit" | "launcher" | "browser" | "inactive";

export type CoachOrigin = "local" | "cloud";

export interface CoachBackendOption {
  id: CoachingBackendId;
  runtimeId: CoachingRuntimeId;
  label: string;
  location: CoachOrigin;
  available: boolean;
  unavailableReason?: { code: string; message: string };
}

/** The subset of the local/cloud clients the lifecycle owner drives. */
export interface CoachRunClient {
  readonly isBootstrapped: boolean;
  bootstrap(): Promise<unknown>;
  createSession(id?: string): Promise<{ id: string }>;
  createSnapshot(filter?: { from?: string; to?: string }): Promise<CoachingDataSnapshot>;
  submitRun(input: SubmitCoachingRunInput): Promise<{
    run: { id: string; sessionId: string; snapshot: CoachingDataSnapshot };
    lastSeq: number;
    replayed: boolean;
  }>;
  readSession(id: string): Promise<{ id: string }>;
  readRun(id: string): Promise<{
    run: { id: string; sessionId: string; snapshot: CoachingDataSnapshot };
    lastSeq: number;
    firstSeq?: number;
    expiresAt?: number;
  }>;
  cancelRun(
    runId: string,
    reason?: string,
    cleanup?: { accessToken?: string | null; capability?: string | null },
  ): Promise<unknown>;
  subscribeRunEvents(
    input: { runId: string; sessionId: string; fromSeq?: number },
    onEvent: (envelope: CoachingEventEnvelope) => void,
    options?: { signal?: AbortSignal },
  ): { close(): void; done: Promise<{ aborted: boolean; lastConsumed: number }> };
  capabilitySnapshot(): string | null;
  discardCredentials(): void;
  logout(cleanup?: { accessToken?: string | null; capability?: string | null }): Promise<unknown>;
}

const PREFERENCE_KEY_PREFIX = "fit-trace.coach.backend.v1:";

export function localPiOption(piAvailable: boolean | null): CoachBackendOption {
  if (piAvailable === false) {
    return {
      id: "local-pi",
      runtimeId: "pi",
      label: "pi CLI (local)",
      location: "local",
      available: false,
      unavailableReason: {
        code: "cli-not-installed",
        message: "pi is not installed on this machine. Install pi to run the local coach.",
      },
    };
  }
  return {
    id: "local-pi",
    runtimeId: "pi",
    label: "pi CLI (local)",
    location: "local",
    available: true,
  };
}

export function descriptorToOption(descriptor: CoachingBackendDescriptor): CoachBackendOption {
  return {
    id: descriptor.backendId,
    runtimeId: descriptor.runtimeId,
    label: descriptor.displayName,
    location: descriptor.executionLocation,
    available: descriptor.available,
    ...(descriptor.unavailableReason === undefined
      ? {}
      : { unavailableReason: { ...descriptor.unavailableReason } }),
  };
}

/**
 * Truthful cloud option derived ONLY from the server capability response.
 * The cloud backend is never advertised merely because the browser is in
 * HTTP mode.
 */
export function cloudOptionFromCapabilities(capabilities: CloudCapabilities): CoachBackendOption {
  const reason = cloudUnavailableReason(capabilities);
  return {
    id: "cloud-default",
    runtimeId: "hosted-sdk",
    label: "Cloud coach",
    location: "cloud",
    available: reason === null,
    ...(reason === null ? {} : { unavailableReason: reason }),
  };
}

export function unavailableCloudOption(message: string): CoachBackendOption {
  return {
    id: "cloud-default",
    runtimeId: "hosted-sdk",
    label: "Cloud coach",
    location: "cloud",
    available: false,
    unavailableReason: { code: "provider-unconfigured", message },
  };
}

function cloudUnavailableReason(
  capabilities: CloudCapabilities,
): { code: string; message: string } | null {
  if (!capabilities.enabled) {
    return { code: "provider-unconfigured", message: "Cloud coaching is not enabled on this server." };
  }
  if (!capabilities.accountFormal) {
    return {
      code: "guest-cloud-forbidden",
      message: "Cloud coaching requires a formal account. Guests can use a local coach only.",
    };
  }
  if (!capabilities.providerEnabled) {
    return {
      code: "provider-unconfigured",
      message: "Cloud coaching is disabled by the operator; no paid run will start.",
    };
  }
  if (!capabilities.providerConfigured) {
    return {
      code: "provider-unconfigured",
      message: "Cloud coaching has no configured provider or finite execution budget.",
    };
  }
  if (!capabilities.quotaConfigured || !capabilities.budgetConfigured) {
    return {
      code: "quota-not-configured",
      message: "Cloud coaching quota has no finite execution budget configured.",
    };
  }
  // Financial availability is server-derived and per-run: a positive balance
  // that cannot reserve one configured run budget must stay unavailable. Never
  // advertise cloud merely because tokensRemaining >= 1.
  const availableCredits = capabilities.tokensRemaining - capabilities.tokensReserved;
  if (
    capabilities.perRunTokenBudget > 0 &&
    availableCredits < capabilities.perRunTokenBudget
  ) {
    return {
      code: "quota-exhausted",
      message: `Not enough cloud coaching credits for one run (${String(
        Math.max(availableCredits, 0),
      )} available, ${String(capabilities.perRunTokenBudget)} required per run).`,
    };
  }
  if (availableCredits < 1) {
    return {
      code: "quota-exhausted",
      message: "No cloud coaching credits remain for this account.",
    };
  }
  if (
    capabilities.concurrentLimit > 0 &&
    capabilities.reservedCount >= capabilities.concurrentLimit
  ) {
    return {
      code: "quota-exhausted",
      message: "Cloud coaching is at its concurrency limit. Retry when an active run finishes.",
    };
  }
  return null;
}

export function initialBackendOptions(input: {
  mode: CoachMode;
  piAvailable: boolean | null;
}): CoachBackendOption[] {
  // The default local client is the legacy pi transport; explicit tests and
  // the launcher both opt into it. `inactive` only exists when the Coach route
  // is hidden, so mounting the screen directly (tests/embedding) keeps the
  // legacy default instead of advertising an empty selector.
  if (input.mode === "explicit" || input.mode === "launcher" || input.mode === "inactive") {
    return [localPiOption(input.piAvailable)];
  }
  return [];
}

export function defaultCoachBackend(input: {
  mode: CoachMode;
  accountId: string | null;
  guest: boolean;
}): CoachingBackendId | null {
  if (input.mode === "explicit" || input.mode === "launcher" || input.mode === "inactive") {
    return "local-pi";
  }
  if (input.mode !== "browser" || input.guest || input.accountId === null) return null;
  const stored = readBackendPreference(input.accountId);
  // The browser can select only the shared cloud backend in this slice. A
  // local-pi preference belongs to a launcher session and must not become a
  // browser selection.
  return stored === "cloud-default" ? stored : null;
}

/** Backend selection sent to the LOCAL submit route; legacy pi omits it. */
export function localBackendSelection(backendId: CoachingBackendId): {
  backendId?: CoachingBackendId;
  runtimeId?: CoachingRuntimeId;
} {
  if (backendId === "local-pi") return {};
  return { backendId, runtimeId: COACHING_BACKEND_DEFINITIONS[backendId].runtimeId };
}

export function isCloudBackend(backendId: CoachingBackendId): boolean {
  return COACHING_BACKEND_DEFINITIONS[backendId].executionLocation === "cloud";
}

/**
 * Mode-bound restore compatibility. The launcher serves BOTH the local
 * connector routes and the shared cloud routes, so it can replay either
 * origin. A plain browser cannot address a local launcher run; that record is
 * retained and surfaced as "start the original connector", never cleared or
 * replayed through cloud.
 */
export function isBackendSupportedInMode(
  backendId: CoachingBackendId,
  mode: CoachMode,
): boolean {
  if (mode === "explicit" || mode === "launcher") return true;
  if (mode === "browser") return isCloudBackend(backendId);
  return false;
}

export function readBackendPreference(accountId: string): CoachingBackendId | null {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return null;
    const raw = storage.getItem(`${PREFERENCE_KEY_PREFIX}${encodeURIComponent(accountId)}`);
    if (raw === null) return null;
    return isCoachingBackendId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeBackendPreference(
  accountId: string,
  backendId: CoachingBackendId,
): void {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return;
    storage.setItem(
      `${PREFERENCE_KEY_PREFIX}${encodeURIComponent(accountId)}`,
      backendId,
    );
  } catch {
    // Preference persistence is best-effort; the current selection still wins.
  }
}
