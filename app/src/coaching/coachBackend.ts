import {
  COACHING_BACKEND_DEFINITIONS,
  isCoachingBackendId,
} from "@agent-fit-trace/api-contracts";
import type {
  CloudCapabilities,
  CoachingBackendDescriptor,
  CoachingBackendId,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingRuntimeId,
  SubmitCoachingRunInput,
} from "@agent-fit-trace/api-contracts";

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
  submitRun(input: SubmitCoachingRunInput & { conversationId?: string }): Promise<{
    run: { id: string; sessionId: string; snapshot: CoachingDataSnapshot };
    lastSeq: number;
    replayed: boolean;
  }>;
  readSession(id: string): Promise<{ id: string }>;
  readRun(id: string): Promise<{
    run: { id: string; sessionId: string; snapshot: CoachingDataSnapshot; conversationId?: string | null };
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
  // Financial availability is server-derived and per-run. The server already
  // returns `tokensRemaining` NET of `tokensReserved`; subtracting the reserve
  // again would halve the visible balance and disable affordable runs.
  // A positive balance that cannot reserve one configured run budget must
  // stay unavailable. Never advertise cloud merely because tokensRemaining >= 1.
  const availableCredits = capabilities.tokensRemaining;
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
  /** The daemon advertises a reviewed cloud proxy (`cloud: true`). */
  cloudProxy?: boolean;
}): CoachingBackendId | null {
  if (input.mode === "explicit" || input.mode === "inactive") {
    return "local-pi";
  }
  // Launcher mode now honours a stored local preference. It previously returned
  // `local-pi` unconditionally, so choosing another local backend in settings
  // survived until the next reload and then silently reverted — the radio said
  // Codex while the run used pi.
  if (input.mode === "launcher") {
    if (input.accountId === null) return null;
    const stored = readBackendPreference(input.accountId);
    // A saved choice survives, even when it is currently unavailable: silently
    // switching to another backend would change the cost/privacy boundary.
    // A cloud preference still belongs to a browser/proxied-daemon session;
    // the legacy launcher (no cloud proxy) cannot address it.
    if (stored !== null) return stored === "cloud-default" && input.cloudProxy !== true ? null : stored;
    // Cloud is the preferred default when the daemon proxies it, unless the
    // account is a guest (whose only option is a local CLI).
    if (input.cloudProxy === true && !input.guest) return "cloud-default";
    return null;
  }
  if (input.mode !== "browser" || input.guest || input.accountId === null) return null;
  const stored = readBackendPreference(input.accountId);
  // The browser can select only the shared cloud backend in this slice. A
  // local-pi preference belongs to a launcher session and must not become a
  // browser selection.
  return stored === "cloud-default" ? stored : null;
}

/** Preserve an explicit server selection; otherwise use only verified local options. */
export type LocalSelectionSource = "preference" | "runtime" | "automatic" | "server" | "cloud-default" | "none";

/** A user preference outranks the server's explicit runtime and automatic choice. */
export function resolveLocalBackendChoice(input: {
  preference: CoachingBackendId | null;
  defaultId: string | null;
  defaultSource?: "runtime" | "automatic" | null;
  options: readonly CoachBackendOption[];
}): { backendId: CoachingBackendId | null; source: LocalSelectionSource } {
  if (input.preference !== null && input.preference !== "cloud-default") return { backendId: input.preference, source: "preference" };
  if (input.defaultId !== null && isCoachingBackendId(input.defaultId) && input.defaultId !== "cloud-default") {
    return { backendId: input.defaultId, source: input.defaultSource ?? "server" };
  }
  for (const id of ["local-pi", "local-codex", "local-opencode"] as const) {
    if (input.options.some((option) => option.id === id && option.available)) return { backendId: id, source: "automatic" };
  }
  return { backendId: null, source: "none" };
}

export function selectLocalBackend(defaultId: string | null, options: readonly CoachBackendOption[]): CoachingBackendId | null {
  return resolveLocalBackendChoice({ preference: null, defaultId, options }).backendId;
}

/**
 * Pick the selection for the NEXT run.
 *
 * Ordering is deliberate (ADR 0008):
 * 1. a saved preference always wins, even if it is currently unavailable —
 *    submission is then blocked instead of silently changing cost/privacy;
 * 2. cloud is the preferred default ONLY when the daemon proxies it and the
 *    server reports it available;
 * 3. otherwise the existing local ordering applies.
 */
export function preferredBackendChoice(input: {
  preference: CoachingBackendId | null;
  defaultId: string | null;
  defaultSource?: "runtime" | "automatic" | null;
  options: readonly CoachBackendOption[];
  cloudProxy: boolean;
}): { backendId: CoachingBackendId | null; source: LocalSelectionSource } {
  if (input.preference !== null) return { backendId: input.preference, source: "preference" };
  if (input.cloudProxy && input.options.some((option) => option.id === "cloud-default" && option.available)) {
    return { backendId: "cloud-default", source: "cloud-default" };
  }
  return resolveLocalBackendChoice({
    preference: null,
    defaultId: input.defaultId,
    defaultSource: input.defaultSource,
    options: input.options,
  });
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
 * Mode-bound restore compatibility. The launcher serves only the local
 * connector routes; it does not mount `/api/v1/coaching/cloud`. A cloud origin
 * is therefore not replayable there. A plain browser cannot address a local
 * launcher run. In both cases the v2 record is retained and surfaced as
 * "start the original connector", never cleared or replayed through another
 * backend.
 */
export function isBackendSupportedInMode(
  backendId: CoachingBackendId,
  mode: CoachMode,
  cloudProxy = false,
): boolean {
  if (mode === "explicit") return true;
  // A daemon with a cloud proxy can address cloud runs in launcher mode; the
  // legacy launcher (no `cloud` runtime marker) still cannot.
  if (mode === "launcher") return cloudProxy || !isCloudBackend(backendId);
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
