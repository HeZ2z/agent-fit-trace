import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "@agent-fit-trace/core";
import { API_ERROR_CODES, ApiError, COACHING_ERROR_CODES, NetworkError, isCoachingBackendId } from "@agent-fit-trace/api-contracts";
import type {
  CoachingBackendId,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingTerminalStatus,
} from "@agent-fit-trace/api-contracts";
import { CloudCoachingClient } from "../api/cloudCoachingClient.ts";
import { CoachingClient } from "../api/coachingClient.ts";
import { isCoachingEnabled, isHttpModeActive, runtimePiAvailable } from "../api/runtimeMode.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  cloudOptionFromCapabilities,
  defaultCoachBackend,
  descriptorToOption,
  initialBackendOptions,
  isBackendSupportedInMode,
  isCloudBackend,
  localBackendSelection,
  localPiOption,
  unavailableCloudOption,
  writeBackendPreference,
} from "./coachBackend.ts";
import type { CoachBackendOption, CoachMode, CoachRunClient } from "./coachBackend.ts";
import { CoachClientRouter } from "./coachClientRouter.ts";

/**
 * Resume v1 remains the compact pi-compatible record. Resume v2 adds the
 * backend/origin and last-consumed cursor so a reload replays through the
 * backend that created the run, never through the current selector. Neither
 * version ever stores a prompt, transcript, token, or native path.
 */
const COACH_RESUME_STORAGE_KEY = "fit-trace.coach.resume.v1";
const COACH_RESUME_V2_STORAGE_KEY = "fit-trace.coach.resume.v2";

interface CoachResumeRecord {
  version: 1 | 2;
  accountId: string;
  backendId: CoachingBackendId;
  origin: "local" | "cloud";
  sessionId: string;
  runId: string;
  /** Highest folded event seq, or -1 before the first event. */
  lastSeq: number;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isResumeCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
}

function originFor(backendId: CoachingBackendId): "local" | "cloud" {
  return isCloudBackend(backendId) ? "cloud" : "local";
}

function resumeBackendName(backendId: CoachingBackendId): string {
  switch (backendId) {
    case "local-pi":
      return "the local pi coach";
    case "local-codex":
      return "the local Codex coach";
    case "local-opencode":
      return "the local OpenCode coach";
    case "cloud-default":
      return "the cloud coach";
  }
}

function readStoredCoachResume(): CoachResumeRecord | null {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return null;
    const v2Raw = storage.getItem(COACH_RESUME_V2_STORAGE_KEY);
    if (v2Raw !== null) {
      const parsed: unknown = JSON.parse(v2Raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
          record.version === 2 &&
          isNonBlank(record.accountId) &&
          isCoachingBackendId(record.backendId) &&
          isNonBlank(record.sessionId) &&
          isNonBlank(record.runId) &&
          isResumeCursor(record.lastSeq)
        ) {
          return {
            version: 2,
            accountId: record.accountId,
            backendId: record.backendId,
            origin: originFor(record.backendId),
            sessionId: record.sessionId,
            runId: record.runId,
            lastSeq: record.lastSeq,
          };
        }
      }
    }
    const raw = storage.getItem(COACH_RESUME_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return null;
    if (!isNonBlank(record.accountId) || !isNonBlank(record.sessionId) || !isNonBlank(record.runId)) {
      return null;
    }
    return {
      version: 1,
      accountId: record.accountId,
      backendId: "local-pi",
      origin: "local",
      sessionId: record.sessionId,
      runId: record.runId,
      lastSeq: -1,
    };
  } catch {
    // Storage unavailable or corrupt: resume is best-effort, never fatal.
    return null;
  }
}

function writeStoredCoachResume(record: CoachResumeRecord): void {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return;
    storage.setItem(
      COACH_RESUME_V2_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        accountId: record.accountId,
        backendId: record.backendId,
        origin: originFor(record.backendId),
        sessionId: record.sessionId,
        runId: record.runId,
        lastSeq: record.lastSeq,
      }),
    );
    // Old pi clients read only v1; keep the exact compact shape for local-pi
    // runs. Cloud/non-pi runs never masquerade as a pi resume.
    if (record.backendId === "local-pi") {
      storage.setItem(
        COACH_RESUME_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          accountId: record.accountId,
          sessionId: record.sessionId,
          runId: record.runId,
        }),
      );
    }
  } catch {
    // Storage failures must not break the run; the live refs still win.
  }
}

function clearStoredCoachResume(): void {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return;
    storage.removeItem(COACH_RESUME_STORAGE_KEY);
    storage.removeItem(COACH_RESUME_V2_STORAGE_KEY);
  } catch {
    // Best-effort only.
  }
}

/** Structured missing-run proof only: RUN_NOT_FOUND. Generic 404/network/auth never resets. */
function isDefinitiveMissingRunError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "RUN_NOT_FOUND";
}

/** Resume-read proof only: RUN_NOT_FOUND or SESSION_NOT_FOUND. Generic NOT_FOUND stays ambiguous. */
function isDefinitiveMissingResumeError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.code === "RUN_NOT_FOUND" || error.code === "SESSION_NOT_FOUND")
  );
}

/**
 * Trusted FIRST-submit rejection: the server answered with a known
 * pre-execution refusal, which proves no run was created under our key, so the
 * pending handle must not trap fresh work.
 *
 * Deliberately narrow — an unknown/proxy 5xx (`API_ERROR`), an idempotency
 * conflict, an auth refusal, a transport loss, or an unparsable success cannot
 * prove absence and must keep the same-key retry (never classify every
 * `ApiError` as definitive).
 */
const DEFINITIVE_SUBMIT_REJECTION_CODES: ReadonlySet<string> = new Set([
  API_ERROR_CODES.VALIDATION_ERROR,
  API_ERROR_CODES.FORBIDDEN,
  COACHING_ERROR_CODES.RUN_BUSY,
  COACHING_ERROR_CODES.SESSION_NOT_FOUND,
]);

function isDefinitiveSubmitRejection(error: unknown): boolean {
  return error instanceof ApiError && DEFINITIVE_SUBMIT_REJECTION_CODES.has(error.code);
}

/**
 * Definitive EXPIRED-REQUEST proof for an explicit SAME-KEY retry.
 *
 * Ordering dependency (`coachingService.submitRun`): the retained, owned
 * idempotent record is resolved BEFORE a live snapshot is required, and a
 * session referenced by a retained run survives idle expiry. So exactly two
 * structured refusals prove no retained run/result remains under the key:
 * - `SESSION_NOT_FOUND`: no retained run references that session.
 * - `SNAPSHOT_NOT_FOUND`: raised only after the idempotency lookup missed.
 *
 * Everything else — `IDEMPOTENCY_CONFLICT`, auth, network loss, parser failure,
 * a generic route `NOT_FOUND`, or an unknown 5xx — cannot prove absence and
 * must keep the pending key. `SNAPSHOT_NOT_FOUND` is used verbatim (the shared
 * constant set omits it, like `RUN_NOT_FOUND` above).
 */
function expiredUnknownSubmitProof(error: unknown): "session" | "snapshot" | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === COACHING_ERROR_CODES.SESSION_NOT_FOUND) return "session";
  if (error.code === "SNAPSHOT_NOT_FOUND") return "snapshot";
  return null;
}

/**
 * A stored resume whose session/run is definitively gone is a clean reset,
 * never a hard error — a network/auth failure cannot prove absence and must be
 * retried instead (see the restore effect).
 */
export type CoachPhase =
  | "idle"
  | "preparing"
  | "restoring"
  | "streaming"
  | "cancelling"
  | "disconnected"
  | "expired"
  | "done"
  | "failed"
  | "cancelled"
  /** Cancel was requested while the submit POST was unresolved and it then
   * failed: the server may have accepted it, so nothing is claimed cancelled. */
  | "unconfirmed";

export interface CoachToolActivity {
  tool: string;
  callId: string;
  phase: "started" | "ok" | "error";
  summary?: string;
  error?: string;
}

export interface CoachSubmitInput {
  question: string;
  conversationId?: string;
  from?: string;
  to?: string;
}

/** Transport-neutral submit result: local and cloud runs share these ids. */
type CoachSubmittedRun = Awaited<ReturnType<CoachRunClient["submitRun"]>>;

interface PendingSubmit {
  prompt: string;
  conversationId?: string;
  filter: { from?: string; to?: string };
  idempotencyKey: string;
  snapshotHandle: { snapshotId: string; source: string; accountId: string };
  /** Session the ambiguous POST was sent under; retry reuses it verbatim. */
  sessionId: string;
  /** Backend pinned for the ambiguous request; retry never switches. */
  backendId: CoachingBackendId;
}

function newIdempotencyKey(): string {
  try {
    const keyed = crypto as unknown as { randomUUID?: () => string };
    if (typeof keyed.randomUUID === "function") return keyed.randomUUID();
  } catch {
    // Fall through to the counter fallback below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Distinct, honest coaching failures: auth vs network vs validation vs server. */
export function friendlyCoachError(error: unknown): string {
  if (error instanceof NetworkError) {
    return `Connection failed: ${error.message} Check the local service and reconnect.`;
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
      case "UNAUTHORIZED":
      case "SESSION_EXPIRED":
        return `Coach sign-in expired (${error.code}). Refresh or sign in again, then retry.`;
      case "AUTH_UNAVAILABLE":
        return `Sign-in service is unavailable (${error.code}). Your session is kept; retry shortly.`;
      case "EXPIRED_CURSOR":
        return `Stream position expired (${error.code}). Reload from the earliest retained events; nothing is skipped.`;
      case "VALIDATION_ERROR":
        return `Invalid coach request (${error.code}): ${error.message}`;
      default:
        return `Coach failed (${error.code}): ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function toFilter(input: CoachSubmitInput): { from?: string; to?: string } {
  const filter: { from?: string; to?: string } = {};
  const from = input.from?.trim() ?? "";
  const to = input.to?.trim() ?? "";
  if (from !== "") filter.from = from;
  if (to !== "") filter.to = to;
  return filter;
}

/**
 * Account-level coaching owner over the approved local and cloud coaching
 * transports.
 *
 * One instance per account lives in `CoachingProvider` (mounted by `Layout`,
 * which survives child-route changes): it keeps a single client/session/run
 * across navigation, so repeated Coach↔History trips never re-bootstrap a
 * capability or allocate a new server session. It owns bootstrap/session/
 * snapshot/run/subscribe sequencing, per-submission idempotency keys,
 * last-consumed resume positions, and account-switch/logout cleanup with the
 * captured credentials. Rendering stays in `CoachScreen`, which only subscribes.
 *
 * Backend selection is for the NEXT run. A run pins its backend at
 * submit/resume time, and replay/cancel/cleanup keep addressing that pinned
 * transport even if the selector changes.
 */
export function useCoachSession({ client: clientProp }: { client?: CoachRunClient } = {}) {
  const { status, getAccessToken, user } = useAuth();
  const accountId = user?.id ?? null;
  const explicitClient = clientProp !== undefined;
  const launcherMode = !explicitClient && isCoachingEnabled();
  const browserMode = !explicitClient && !launcherMode && isHttpModeActive();
  const coachMode: CoachMode = explicitClient
    ? "explicit"
    : launcherMode
      ? "launcher"
      : browserMode
        ? "browser"
        : "inactive";
  // `isAnonymous === true` is the only verified guest signal. `undefined`/
  // missing classification fails cloud closed: it is never treated as formal.
  const isGuest = user?.isAnonymous === true;
  const identityUnverified = user !== null && user.isAnonymous !== false;
  // The owner must not touch coaching endpoints until the account is VERIFIED
  // signed-in and a coaching mode is active. An explicitly injected client
  // (tests / embedding) is an explicit opt-in. During auth `loading` (a
  // restored, unvalidated session) the provider stays inert and the persisted
  // resume is left untouched; plain local mode never restores a stale resume.
  const coachingActive = coachMode !== "inactive";
  const canOperate = coachingActive && status === "signed-in" && accountId !== null;
  // Item 3: the default clients are bound to the account identity that created
  // them. After a switch the old instance's token accessor returns null so B's
  // bearer can never leak into A's cleanup (or vice versa); cleanup uses the
  // captured A credentials explicitly (see the account effect below).
  const accountRef = useRef<string | null | undefined>(undefined);
  const boundTokenProvider = useMemo(() => {
    const boundAccount = accountId;
    const currentRef = accountRef;
    return (): string | null => {
      if (currentRef.current !== undefined && currentRef.current !== boundAccount) return null;
      return getAccessToken();
    };
  }, [accountId, getAccessToken]);
  const localClient = useMemo(
    () => new CoachingClient({ getAccessToken: boundTokenProvider }),
    [boundTokenProvider],
  );
  const cloudClient = useMemo(
    () => new CloudCoachingClient({ getAccessToken: boundTokenProvider }),
    [boundTokenProvider],
  );
  const router = useMemo(
    () => new CoachClientRouter({ local: localClient, cloud: cloudClient }),
    [localClient, cloudClient],
  );
  const client: CoachRunClient = clientProp ?? router;
  // Latest committed client for the unmount cleanup (which runs once and must
  // not re-run on client-identity changes).
  const clientRef = useRef(client);
  clientRef.current = client;

  const [phase, setPhase] = useState<CoachPhase>("idle");
  const [snapshot, setSnapshot] = useState<CoachingDataSnapshot | null>(null);
  const [text, setText] = useState("");
  const [tools, setTools] = useState<CoachToolActivity[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisResult[]>([]);
  const [runError, setRunError] = useState<{ code: string; message: string } | null>(null);
  const [terminal, setTerminal] = useState<CoachingTerminalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Expired-cursor retention start for reloadFromStart; the reconnect/reload/
  // cancel capabilities are DERIVED from the single phase, not duplicated state.
  const [expiredFirstSeq, setExpiredFirstSeq] = useState(0);
  // Backend selection (next run) is separate from the run's pinned backend.
  const [selectedBackend, setSelectedBackend] = useState<CoachingBackendId | null>(() =>
    defaultCoachBackend({ mode: coachMode, accountId, guest: isGuest }),
  );
  const [activeBackend, setActiveBackend] = useState<CoachingBackendId | null>(null);
  const [runConversationId, setRunConversationId] = useState<string | null>(null);
  const [backends, setBackends] = useState<CoachBackendOption[]>(() =>
    initialBackendOptions({ mode: coachMode, piAvailable: runtimePiAvailable() }),
  );
  const [discoveryNotice, setDiscoveryNotice] = useState<string | null>(null);
  // A transient availability failure must be recoverable without an app
  // reload. The attempt nonce re-runs discovery on demand; the failure flag
  // exposes the retry action only when discovery actually failed.
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  // A persisted run whose origin cannot be addressed in THIS session mode.
  // The v2 record (including its backend/origin) stays untouched: the user is
  // told to start the original connector instead of silently clearing it or
  // replaying it through the current backend.
  const [blockedResume, setBlockedResume] = useState<{
    backendId: CoachingBackendId;
    message: string;
  } | null>(null);
  // Item 3: the account whose fold is currently on screen. When `accountId`
  // changes, the visible fold is reset during render (below) so the previous
  // account's transcript can never paint under the new identity.
  const [renderedAccountId, setRenderedAccountId] = useState<string | null>(accountId);

  const phaseRef = useRef<CoachPhase>("idle");
  phaseRef.current = phase;
  // The selector is the NEXT run; the active/pinned backend belongs to the
  // run that is (or may be) live. They are deliberately separate so a
  // selection change never redirects an in-flight replay/cancel.
  const selectedBackendRef = useRef<CoachingBackendId | null>(selectedBackend);
  selectedBackendRef.current = selectedBackend;
  const activeBackendRef = useRef<CoachingBackendId | null>(null);
  const backendsRef = useRef<CoachBackendOption[]>(backends);
  backendsRef.current = backends;
  const generationRef = useRef(0);
  const attemptRef = useRef(0);
  const cancelInflightRef = useRef(false);
  const subscriptionRef = useRef<{ close(): void } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const terminatedRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const lastConsumedRef = useRef(-1);
  const pendingRetryRef = useRef<PendingSubmit | null>(null);
  // True while a submit POST is dispatched and its outcome is unknown. A cancel
  // during this window cannot resolve locally — the server may already have
  // accepted the run — so it waits for the submit outcome instead.
  const postInflightRef = useRef(false);
  // True when a cancel request collided with an unresolved submit POST that
  // then failed: the cancellation is unconfirmed and must be resolved through
  // the SAME idempotency key (never a fresh analysis).
  const cancelUnconfirmedRef = useRef(false);
  // True while the unconfirmed cancel is being resolved (same-key submit then
  // cancel); a stray cancel tap during that window is a no-op.
  const resolvingCancelRef = useRef(false);
  // Last committed client instance: on an account switch the `client` binding
  // above may already be the new per-account instance, so cleanup reads the
  // old capability from here (updated only after cleanup runs).
  const prevClientRef = useRef<CoachRunClient | null>(null);
  // Last known bearer per account, captured while that account is current so
  // switch cleanup can replay A's token explicitly (never B's).
  const accountTokenRef = useRef<{ accountId: string | null; token: string | null }>({
    accountId,
    token: null,
  });
  // Backend discovery runs once per (mode, account, classification) identity;
  // cleared by an account switch so B never inherits A's options.
  const discoveryKeyRef = useRef<string | null>(null);
  // Item 4 restore runs once per account identity per mount.
  const restoreAttemptedRef = useRef<string | null | undefined>(undefined);
  // Account identity whose restore already reached a verdict (verified run or
  // definitive reset). Survives the StrictMode attempt-guard reset so a
  // transient same-account re-run never re-reads and re-folds an established run.
  const restoreCompletedRef = useRef<string | null>(null);
  // Retained, account-bound server-cleanup credentials. The owner survives an
  // ordinary navigation with its run still live server-side, so a LATER
  // sign-out must be able to cancel/logout with this account's captured
  // credentials. Kept current while this account is on screen; only ever holds
  // the current account's data; reset on a switch.
  const retainedLogoutRef = useRef<{
    accountId: string | null;
    runId: string | null;
    capability: string | null;
    accessToken: string | null;
    backendId: CoachingBackendId | null;
    /** Client that owns the run; cleanup must not consult a later mutable router. */
    client: CoachRunClient | null;
  }>({
    accountId: null,
    runId: null,
    capability: null,
    accessToken: null,
    backendId: null,
    client: null,
  });
  // The in-flight restore's account-bound record, kept ONLY so an ambiguous
  // restore failure can be re-verified on an explicit retry without inventing
  // state. Cleared as soon as the run is verified (or definitively reset).
  const restoreRecordRef = useRef<CoachResumeRecord | null>(null);
  // True while a subscription is attached and has not settled: a cancel that
  // succeeds after a transport failure re-opens the tail only when it is false.
  const streamLiveRef = useRef(false);

  // Item 3: capture the live bearer while this account is current so an
  // account switch can replay the OLD account's credentials for cleanup and
  // never the new account's bearer. When `accountId` changes, the comparison
  // below no longer matches and the previous account's token is preserved
  // until the switch effect consumes it.
  if (accountTokenRef.current.accountId === accountId) {
    accountTokenRef.current.token = getAccessToken();
  }

  /**
   * Persist the v2 record with the run's own backend/origin and the highest
   * folded seq. A reload replays through THIS backend even if the next-run
   * selector has since changed. Local-pi runs also mirror v1 for old pi
   * clients; never a prompt, transcript, token, or native path.
   */
  const persistResume = useCallback((): void => {
    const currentAccount = accountRef.current ?? accountId;
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    const backendId = activeBackendRef.current;
    if (currentAccount === null || currentAccount === undefined) return;
    if (sessionId === null || runId === null || backendId === null) return;
    writeStoredCoachResume({
      version: 2,
      accountId: currentAccount,
      backendId,
      origin: originFor(backendId),
      sessionId,
      runId,
      lastSeq: lastConsumedRef.current,
    });
  }, [accountId]);

  // Synchronous phase authority: set the ref NOW so rapid duplicate taps see
  // the in-flight operation before React re-renders (item 5).
  const beginPhase = useCallback((next: CoachPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  /**
   * Pin every subsequent transport operation (bootstrap/read/replay/cancel) to
   * one backend BEFORE the first request of the run. The router is mutated
   * synchronously so an awaited callback cannot race a later selection.
   */
  const pinBackend = useCallback(
    (backendId: CoachingBackendId) => {
      activeBackendRef.current = backendId;
      if (!explicitClient) router.setActiveBackend(backendId);
      setActiveBackend(backendId);
    },
    [explicitClient, router],
  );

  const unpinBackend = useCallback(() => {
    activeBackendRef.current = null;
    setActiveBackend(null);
  }, []);

  /** True while a backend is pinned for an active/unresolved run. */
  const backendPinnedNow = useCallback((): boolean => {
    if (activeBackendRef.current === null) return false;
    if (pendingRetryRef.current !== null) return true;
    if (runIdRef.current !== null && !terminatedRef.current) return true;
    const current = phaseRef.current;
    return (
      current === "preparing" ||
      current === "restoring" ||
      current === "cancelling" ||
      current === "unconfirmed" ||
      current === "disconnected"
    );
  }, []);

  /**
   * Select the backend for the NEXT run. Pinned while a run is active/unknown:
   * switching mid-run would misroute reconnect/cancel, so it is ignored. The
   * preference is account-scoped, never global.
   */
  const selectBackend = useCallback(
    (backendId: CoachingBackendId): void => {
      if (backendPinnedNow()) return;
      const option = backendsRef.current.find((candidate) => candidate.id === backendId);
      if (option === undefined || !option.available) return;
      selectedBackendRef.current = backendId;
      setSelectedBackend(backendId);
      if (accountId !== null) writeBackendPreference(accountId, backendId);
    },
    [accountId, backendPinnedNow],
  );

  const clearFold = useCallback(() => {
    setRunConversationId(null);
    setSnapshot(null);
    setText("");
    setTools([]);
    setAnalyses([]);
    setRunError(null);
    setTerminal(null);
    setError(null);
  }, []);

  /**
   * Release a definitively-missing run. No-op on stale generation/run
   * identity or an already-terminal run — callers must verify operation
   * (generation/account/run) before invoking. Keeps coherent output, marks
   * it unavailable, and offers New analysis without a reload.
   */
  const releaseMissingRun = useCallback(
    (gen: number, expectedRunId: string, message: string): void => {
      if (generationRef.current !== gen) return;
      if (runIdRef.current !== expectedRunId) return;
      if (terminatedRef.current) return;
      try {
        subscriptionRef.current?.close();
      } catch {
        // Detach is best-effort.
      } finally {
        subscriptionRef.current = null;
      }
      // Invalidate old stream attempts so a late frame can never fold.
      attemptRef.current += 1;
      streamLiveRef.current = false;
      runIdRef.current = null;
      lastConsumedRef.current = -1;
      setExpiredFirstSeq(0);
      pendingRetryRef.current = null;
      restoreRecordRef.current = null;
      cancelRequestedRef.current = false;
      cancelInflightRef.current = false;
      cancelUnconfirmedRef.current = false;
      resolvingCancelRef.current = false;
      postInflightRef.current = false;
      terminatedRef.current = false;
      clearStoredCoachResume();
      setBlockedResume(null);
      unpinBackend();
      setError(message);
      beginPhase("failed");
    },
    [beginPhase, unpinBackend],
  );

  // Item 3: when the account identity changes, reset the visible fold during
  // render — before React paints — so a switch never flashes the previous
  // account's results, even for one frame. The server cleanup (cancel/logout
  // with the captured A credentials) stays in the effect below; the generation
  // bump there rejects any late A frames.
  if (renderedAccountId !== accountId) {
    setRenderedAccountId(accountId);
    clearFold();
    phaseRef.current = "idle";
    setPhase("idle");
  }

  const foldEvent = useCallback(
    (gen: number, attempt: number, expectedRunId: string, envelope: CoachingEventEnvelope): void => {
      if (generationRef.current !== gen) return;
      // Stream-attempt identity is distinct from the run identity: a stale
      // subscription that settles late (after reconnect) must not fold.
      if (attemptRef.current !== attempt) return;
      if (runIdRef.current !== expectedRunId) return;
      // Frozen after the terminal envelope: late/dup frames never mutate.
      if (terminatedRef.current) return;
      // Dedup: the transport delivers contiguous seqs, but a redelivered
      // frame after reconnect must never double-append text/tools.
      if (envelope.seq <= lastConsumedRef.current) return;
      const payload = envelope.event;
      switch (payload.type) {
        case "text_delta":
          // Whitespace preserved byte-for-byte; rendering uses pre-wrap.
          setText((prev) => prev + payload.delta);
          break;
        case "tool_start":
          setTools((prev) => {
            const next: CoachToolActivity = {
              tool: payload.tool,
              callId: payload.callId,
              phase: "started",
            };
            const index = prev.findIndex((activity) => activity.callId === payload.callId);
            if (index === -1) return [...prev, next];
            const copy = [...prev];
            copy[index] = next;
            return copy;
          });
          break;
        case "tool_end": {
          const next: CoachToolActivity = payload.ok
            ? { tool: payload.tool, callId: payload.callId, phase: "ok", summary: payload.summary }
            : { tool: payload.tool, callId: payload.callId, phase: "error", error: payload.error };
          setTools((prev) => {
            // Update the matching start row instead of appending a duplicate.
            const index = prev.findIndex((activity) => activity.callId === payload.callId);
            if (index === -1) return [...prev, next];
            const copy = [...prev];
            copy[index] = next;
            return copy;
          });
          break;
        }
        case "analysis_result":
          setAnalyses((prev) => [...prev, payload.result]);
          break;
        case "run_error":
          setRunError({ code: payload.code, message: payload.message });
          break;
        case "terminal":
          terminatedRef.current = true;
          setTerminal(payload.status);
          beginPhase(payload.status === "completed" ? "done" : payload.status === "cancelled" ? "cancelled" : "failed");
          if (payload.status === "failed" && payload.reason) setError(payload.reason);
          // A terminal that wins the race against a pending cancel keeps its
          // verdict: the cancelling UI resolves to the server truth.
          if (payload.status === "completed") cancelRequestedRef.current = false;
          lastConsumedRef.current = envelope.seq;
          persistResume();
          // A terminal rejects the backend: the next run may select another one.
          unpinBackend();
          return;
      }
      // Advance only after a successful fold (item 1): reconnect resumes from
      // last consumed + 1 instead of replaying from 0.
      lastConsumedRef.current = envelope.seq;
    },
    [beginPhase, persistResume, unpinBackend],
  );

  const attachStream = useCallback(
    (gen: number, sessionId: string, runId: string, fromSeq: number): void => {
      const attempt = ++attemptRef.current;
      try {
        subscriptionRef.current?.close();
      } catch {
        // Detach is best-effort.
      }
      const subscription = client.subscribeRunEvents(
        { runId, sessionId, fromSeq },
        (envelope) => foldEvent(gen, attempt, runId, envelope),
      );
      subscriptionRef.current = subscription;
      streamLiveRef.current = true;
      void subscription.done.then(
        (result) => {
          if (attemptRef.current === attempt) streamLiveRef.current = false;
          if (generationRef.current !== gen) return;
          if (attemptRef.current !== attempt) return;
          if (runIdRef.current !== runId) return;
          if (terminatedRef.current) {
            // The terminal envelope already set the final phase via foldEvent.
            // A clean transport settle afterwards changes nothing; a
            // completed terminal that wins the race against cancel keeps its
            // verdict (item 2).
            return;
          }
          if (result.aborted) {
            // Local detach only (reconnect/supersede): the run keeps going
            // server-side. Only an explicit user cancel resolves locally, and
            // only after the server terminal confirms (see cancel()).
            return;
          }
          // A non-aborted settle without a terminal envelope cannot happen
          // (the transport rejects it); treat it as a disconnect and keep the
          // run/resume so reconnect or cancel stays possible.
          setError("The coach stream ended without a terminal event. Reconnect to resume.");
          lastConsumedRef.current = result.lastConsumed;
          persistResume();
          beginPhase("disconnected");
        },
        (streamError: unknown) => {
          if (attemptRef.current === attempt) streamLiveRef.current = false;
          if (generationRef.current !== gen) return;
          if (attemptRef.current !== attempt) return;
          if (runIdRef.current !== runId) return;
          if (terminatedRef.current) return;
          if (streamError instanceof ApiError && streamError.code === "EXPIRED_CURSOR") {
            const details = streamError.details as { firstSeq?: unknown } | undefined;
            const firstSeq =
              typeof details?.firstSeq === "number" && Number.isSafeInteger(details.firstSeq) && details.firstSeq >= 0
                ? details.firstSeq
                : 0;
            setExpiredFirstSeq(firstSeq);
            setError(friendlyCoachError(streamError));
            beginPhase("expired");
            return;
          }
          if (isDefinitiveMissingRunError(streamError)) {
            // Structured proof the run is gone; identity already verified above.
            releaseMissingRun(
              gen,
              runId,
              "Coach run is no longer available (RUN_NOT_FOUND). Previous output is kept; start a new analysis.",
            );
            return;
          }
          // Any nonterminal stream failure is a disconnect: no terminal
          // envelope arrived (a real run failure IS a terminal ENVELOPE folded
          // into `terminatedRef`, handled above), so the run is still live
          // server-side. That covers a transport NetworkError (EOF before the
          // terminal, an interrupted read) and parser/API failures (a
          // malformed or oversized frame, a bad content-type, any
          // non-`EXPIRED_CURSOR` API error). Keep the folded text, the run id,
          // and the persisted resume, and offer reconnect/cancel — never
          // freeze the transcript into a terminal `failed` that would strand
          // the run without a recover action.
          setError(friendlyCoachError(streamError));
          beginPhase("disconnected");
        },
      );
    },
    [beginPhase, client, foldEvent, persistResume, releaseMissingRun],
  );

  /**
   * Central derived capability: any KNOWN nonterminal server run — or a
   * pre-run operation — blocks a fresh submit / new analysis. The phase label
   * alone is NOT enough: an EXPIRED_CURSOR or a generic stream failure still
   * leaves a live run server-side that must never be silently abandoned.
   * An ambiguous submit (accepted-but-unacked, pending same-key retry) also
   * blocks: the key must be resolved before any fresh key is minted.
   */
  const blocksFreshRun = useCallback((): boolean => {
    if (pendingRetryRef.current !== null) return true;
    if (runIdRef.current !== null && !terminatedRef.current) return true;
    const current = phaseRef.current;
    return (
      current === "preparing" ||
      current === "restoring" ||
      current === "streaming" ||
      current === "cancelling" ||
      current === "disconnected" ||
      current === "expired" ||
      current === "unconfirmed"
    );
  }, []);

  /**
   * Central derived cancel capability: a known active run, or a pre-run
   * operation that may yet create one. A recoverable restore failure with no
   * verified run is NOT cancellable — it is retried instead.
   */
  const canCancelNow = useCallback((): boolean => {
    if (runIdRef.current !== null && !terminatedRef.current) return true;
    const current = phaseRef.current;
    return current === "preparing" || current === "restoring" || current === "cancelling";
  }, []);

  const submit = useCallback(
    async (input: CoachSubmitInput): Promise<void> => {
      const question = input.question.trim();
      if (question === "") {
        setError("Enter an analysis question first.");
        return;
      }
      // Synchronous duplicate guard: a second tap before re-render sees the
      // in-flight phase immediately. Any known live run (including an expired
      // cursor or a failed tail) and an unconfirmed cancellation also block a
      // fresh submit — the active run must be resolved first.
      if (blocksFreshRun()) return;
      // The NEXT run's backend is only what the user explicitly selected. No
      // silent fallback: a missing/unavailable backend refuses before any
      // capability/snapshot/session allocation.
      const backendId = selectedBackendRef.current;
      const backendOption =
        backendId === null
          ? null
          : (backendsRef.current.find((option) => option.id === backendId) ?? null);
      if (backendId === null || backendOption === null || !backendOption.available) {
        setError(
          backendOption?.unavailableReason?.message ??
            (backendId === null
              ? "Choose a coaching backend before asking the coach."
              : "The selected coaching backend is not available."),
        );
        return;
      }
      // Pin the run to this backend BEFORE the first request. Replay, cancel,
      // and cleanup will keep addressing it even if the selector changes.
      pinBackend(backendId);
      const gen = ++generationRef.current;
      beginPhase("preparing");
      cancelRequestedRef.current = false;
      cancelInflightRef.current = false;
      cancelUnconfirmedRef.current = false;
      postInflightRef.current = false;
      terminatedRef.current = false;
      lastConsumedRef.current = -1;
      pendingRetryRef.current = null;
      restoreRecordRef.current = null;
      runIdRef.current = null;
      // Item 4: a fresh submit supersedes any persisted resume until the new
      // run is established below.
      clearStoredCoachResume();
      setBlockedResume(null);
      clearFold();
      setRunConversationId(isCloudBackend(backendId) ? input.conversationId ?? null : null);
      setError(null);
      // Stable for this submission: reused by the explicit retry below, never
      // regenerated after network ambiguity. A fresh question mints a new key.
      const idempotencyKey = newIdempotencyKey();
      const filter = toFilter(input);
      let postDispatched = false;
      try {
        if (!client.isBootstrapped) await client.bootstrap();
        if (generationRef.current !== gen) return;
        if (cancelRequestedRef.current) {
          beginPhase("cancelled");
          return;
        }
        let sessionId = sessionIdRef.current;
        if (sessionId === null) {
          const session = await client.createSession();
          if (generationRef.current !== gen) return;
          if (cancelRequestedRef.current) {
            beginPhase("cancelled");
            return;
          }
          sessionId = session.id;
          sessionIdRef.current = sessionId;
        }
        const created = await client.createSnapshot(filter);
        if (generationRef.current !== gen) return;
        if (cancelRequestedRef.current) {
          beginPhase("cancelled");
          return;
        }
        setSnapshot(created);
        if (created.recordCount === 0) {
          // Empty selected range: there is nothing to analyse and the server
          // would only produce a completed-empty run, so do NOT submit. The
          // Coach UI shows "record first" and keeps the form for a new range.
          pendingRetryRef.current = null;
          clearStoredCoachResume();
          unpinBackend();
          beginPhase("idle");
          return;
        }
        const handle = { snapshotId: created.snapshotId, source: created.source, accountId: created.accountId };
        pendingRetryRef.current = {
          prompt: question,
          ...(isCloudBackend(backendId) && input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          filter,
          idempotencyKey,
          snapshotHandle: handle,
          sessionId,
          backendId,
        };
        postDispatched = true;
        postInflightRef.current = true;
        let submitted: CoachSubmittedRun;
        try {
          submitted = await client.submitRun({
            sessionId,
            prompt: question,
            ...(isCloudBackend(backendId) && input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
            idempotencyKey,
            snapshot: handle,
            ...localBackendSelection(backendId),
          });
        } catch (caught) {
          // An idle sessions is deleted server-side after its retention TTL. A
          // definite SESSION_NOT_FOUND means NO run was created, so renew the
          // session ONCE and re-send the SAME key. An ambiguous network failure
          // is NOT renewed here — the caller's ambiguity path owns that and
          // must never silently re-POST an unknown write.
          if (!(caught instanceof ApiError && caught.code === "SESSION_NOT_FOUND")) throw caught;
          const renewed = await client.createSession();
          if (generationRef.current !== gen) return;
          if (cancelRequestedRef.current) {
            // A cancel landed during the awaited renewal. The FIRST POST was
            // definitively rejected (SESSION_NOT_FOUND) before creating any
            // run, so nothing exists server-side to cancel or stream: resolve
            // cancelled honestly and never dispatch the renewed POST.
            postInflightRef.current = false;
            postDispatched = false;
            pendingRetryRef.current = null;
            clearStoredCoachResume();
            unpinBackend();
            beginPhase("cancelled");
            return;
          }
          sessionId = renewed.id;
          sessionIdRef.current = sessionId;
          // The renewed session owns the same-key re-send: keep the pending
          // handle pointed at it so an ambiguous second POST retries here.
          if (pendingRetryRef.current !== null) {
            pendingRetryRef.current = { ...pendingRetryRef.current, sessionId };
          }
          submitted = await client.submitRun({
            sessionId,
            prompt: question,
            ...(isCloudBackend(backendId) && input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
            idempotencyKey,
            snapshot: handle,
            ...localBackendSelection(backendId),
          });
        }
        if (generationRef.current === gen) postInflightRef.current = false;
        if (generationRef.current === gen) postDispatched = false;
        if (generationRef.current !== gen) return;
        if (cancelRequestedRef.current) {
          // Cancel won the race while submit was in flight (item 2): the
          // server may have created the run under our key, so resolve the
          // ambiguity with a safe server cancellation instead of streaming.
          const ambiguousRunId = submitted.run.id;
          runIdRef.current = ambiguousRunId;
          pendingRetryRef.current = null;
          beginPhase("cancelling");
          try {
            await client.cancelRun(ambiguousRunId);
          } catch (caught) {
            if (generationRef.current !== gen) return;
            setError(friendlyCoachError(caught));
            // Stay cancelling so the user can retry the cancel; the run id
            // is known and the stream below carries the terminal verdict.
          }
          if (generationRef.current !== gen) return;
          attachStream(gen, sessionId, ambiguousRunId, 0);
          return;
        }
        runIdRef.current = submitted.run.id;
        // The run is established: the submit is no longer ambiguous, so a
        // later stream failure must reconnect — never resubmit (item 5).
        pendingRetryRef.current = null;
        // Item 4: persist ONLY the versioned, account-bound ids so a reload can
        // verify + replay this run instead of POSTing a new one.
        persistResume();
        beginPhase("streaming");
        attachStream(gen, sessionId, submitted.run.id, 0);
      } catch (caught) {
        if (generationRef.current === gen) postInflightRef.current = false;
        if (generationRef.current !== gen) return;
        // A trusted structured rejection proves no run was created: clear the
        // pending key so fresh work stays recoverable. Anything else is an
        // unknown outcome (lost ack / malformed success) and keeps same-key retry.
        const definitiveSubmitRejection = isDefinitiveSubmitRejection(caught);
        if (definitiveSubmitRejection) pendingRetryRef.current = null;
        if (cancelRequestedRef.current) {
          if (postDispatched && !definitiveSubmitRejection) {
            // The submit POST was dispatched and its outcome is unknown: the
            // server may have accepted the run. Keep the ambiguous same-key
            // handle and surface "cancellation unconfirmed" — never claim
            // cancelled without proof (item 3).
            cancelUnconfirmedRef.current = true;
            beginPhase("unconfirmed");
            return;
          }
          // Cancel before the POST was ever dispatched: no server run can
          // exist, so resolving locally to cancelled is honest.
          beginPhase("cancelling");
          try {
            if (!client.isBootstrapped) await client.bootstrap();
          } catch {
            // Capability refresh is best-effort here; the cancelling state
            // already prevents new work.
          }
          if (generationRef.current !== gen) return;
          unpinBackend();
          beginPhase("cancelled");
          return;
        }
        setError(friendlyCoachError(caught));
        // pendingRetry stays set only when no run was established (ambiguous
        // submit); stream failures clear it above so only Retry shows there.
        // With no pending key and no run, nothing is pinned any more.
        if (pendingRetryRef.current === null && runIdRef.current === null) unpinBackend();
        beginPhase("failed");
      }
    },
    [
      attachStream,
      beginPhase,
      blocksFreshRun,
      clearFold,
      client,
      persistResume,
      pinBackend,
      unpinBackend,
    ],
  );

  /** Explicit retry of an AMBIGUOUS submit with the SAME key/snapshot (no implicit replay). */
  const retrySubmit = useCallback(async (): Promise<void> => {
    const pending = pendingRetryRef.current;
    if (pending === null) return;
    // The retry resolves the ORIGINAL unknown request: same session, same
    // snapshot handle, same idempotency key. Never mints a fresh key.
    const sessionId = pending.sessionId;
    // A retry is only meaningful while no run is established: stream errors
    // reconnect and run cancellation never resubmits (item 5).
    if (runIdRef.current !== null) return;
    if (
      phaseRef.current === "preparing" ||
      phaseRef.current === "streaming" ||
      phaseRef.current === "cancelling"
    )
      return;
    // A resolve after an unconfirmed cancel keeps the cancel intent: the retry
    // re-submits the SAME key, then cancels the run it resolves to.
    const keepCancelIntent = cancelUnconfirmedRef.current;
    cancelUnconfirmedRef.current = false;
    resolvingCancelRef.current = keepCancelIntent;
    // The retry resolves the ORIGINAL request on its ORIGINAL backend: a
    // selector change meanwhile must never redirect the same-key re-POST.
    pinBackend(pending.backendId);
    const gen = ++generationRef.current;
    beginPhase("preparing");
    cancelRequestedRef.current = keepCancelIntent;
    cancelInflightRef.current = false;
    postInflightRef.current = false;
    terminatedRef.current = false;
    lastConsumedRef.current = -1;
    runIdRef.current = null;
    clearStoredCoachResume();
    setText("");
    setTools([]);
    setAnalyses([]);
    setRunError(null);
    setTerminal(null);
    setError(null);
    try {
      // Reuse a still-valid capability. Every bootstrap MINTS a new short-TTL
      // capability that the server retains until it expires (bounded per
      // account), so an unconditional refresh would exhaust that cap across
      // repeated same-key Retries and turn an unknown submit into a permanent
      // 503. Only a missing/expired capability is renewed here; a structured
      // UNAUTHENTICATED below drops the REJECTED capability for the NEXT
      // explicit Retry. Bootstrap creates nothing — the run POST below stays
      // the single same-key retry.
      if (!client.isBootstrapped) await client.bootstrap();
      if (generationRef.current !== gen) return;
      if (cancelRequestedRef.current) {
        // The original accept is still unknown: a local cancelled here would
        // be dishonest while the server may hold the run. Carry the intent
        // through the same-key POST below, which resolves the run then
        // cancels it (or lands unconfirmed on another ambiguous failure).
        // Never clears the pending key before the POST resolves.
        resolvingCancelRef.current = true;
      }
      postInflightRef.current = true;
      const submitted = await client.submitRun({
        sessionId,
        prompt: pending.prompt,
        ...(pending.conversationId === undefined ? {} : { conversationId: pending.conversationId }),
        idempotencyKey: pending.idempotencyKey,
        snapshot: pending.snapshotHandle,
        ...localBackendSelection(pending.backendId),
      });
      if (generationRef.current === gen) postInflightRef.current = false;
      if (generationRef.current !== gen) return;
      if (cancelRequestedRef.current) {
        const ambiguousRunId = submitted.run.id;
        runIdRef.current = ambiguousRunId;
        pendingRetryRef.current = null;
        beginPhase("cancelling");
        try {
          await client.cancelRun(ambiguousRunId);
        } catch (caught) {
          if (generationRef.current !== gen) return;
          setError(friendlyCoachError(caught));
        }
        if (generationRef.current !== gen) return;
        attachStream(gen, sessionId, ambiguousRunId, 0);
        return;
      }
      runIdRef.current = submitted.run.id;
      pendingRetryRef.current = null;
      persistResume();
      beginPhase("streaming");
      attachStream(gen, sessionId, submitted.run.id, 0);
    } catch (caught) {
      if (generationRef.current === gen) postInflightRef.current = false;
      if (generationRef.current !== gen) return;
      // The capability this retry presented was refused. It is dropped for the
      // NEXT explicit retry (which then bootstraps fresh), but the run POST is
      // never auto-repeated and the ORIGINAL key is never touched.
      if (caught instanceof ApiError && caught.code === API_ERROR_CODES.UNAUTHENTICATED) {
        client.discardCredentials();
      }
      // A structured expiry proves only that no retained run/result remains
      // under the key — not that the request was refused before acceptance, nor
      // that no other run is active. Release the pending/cancel flags the same
      // way for both an ordinary retry and a preserved cancel intent, and show
      // the honest unavailable state: never a fabricated cancelled/completed.
      // Clear the session only on SESSION_NOT_FOUND; a live session is reused.
      const expiredProof = expiredUnknownSubmitProof(caught);
      if (expiredProof !== null) {
        pendingRetryRef.current = null;
        if (expiredProof === "session") sessionIdRef.current = null;
        cancelUnconfirmedRef.current = false;
        cancelRequestedRef.current = false;
        setError(
          `The earlier coach request and its saved result are no longer available (${
            expiredProof === "session" ? "SESSION_NOT_FOUND" : "SNAPSHOT_NOT_FOUND"
          }). Start a new analysis.`,
        );
        unpinBackend();
        beginPhase("failed");
        return;
      }
      // A same-key retry rejection otherwise CANNOT prove the ORIGINAL accepted
      // run is absent: an idempotency conflict, a transient auth/capability
      // failure, a route/transport error, or an unknown 5xx is not proof, so
      // the original key is never erased here. A cancel stays unconfirmed;
      // otherwise the same-key Retry remains offered until the original
      // request is resolved.
      if (cancelRequestedRef.current) {
        // Same ambiguity as a first submit: the server may have accepted the
        // replayed key, so stay unconfirmed rather than claiming cancelled.
        // Covers a dispatched retry POST and a bootstrap failure while the
        // ORIGINAL request is still unknown.
        cancelUnconfirmedRef.current = true;
        beginPhase("unconfirmed");
        return;
      }
      setError(friendlyCoachError(caught));
      // An unresolved same-key retry keeps the pin (pendingRetryRef); once the
      // key is released with no run, nothing remains pinned.
      if (pendingRetryRef.current === null && runIdRef.current === null) unpinBackend();
      beginPhase("failed");
    } finally {
      if (generationRef.current === gen) resolvingCancelRef.current = false;
    }
  }, [attachStream, beginPhase, client, persistResume, pinBackend, unpinBackend]);

  /** Explicit resume of a disconnected stream from last consumed + 1. */
  const reconnect = useCallback((): void => {
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (phaseRef.current !== "disconnected") return;
    if (sessionId === null || runId === null || terminatedRef.current) return;
    const gen = generationRef.current;
    beginPhase("streaming");
    setError(null);
    // Refresh an expired capability without repeating the run POST (item 5).
    void (async (): Promise<void> => {
      try {
        if (!client.isBootstrapped) await client.bootstrap();
      } catch (caught) {
        if (generationRef.current !== gen) return;
        // Still disconnected: reconnect stays offered, never a resubmit.
        setError(friendlyCoachError(caught));
        beginPhase("disconnected");
        return;
      }
      if (generationRef.current !== gen || terminatedRef.current) return;
      attachStream(gen, sessionId, runId, lastConsumedRef.current + 1);
    })();
  }, [attachStream, beginPhase, client]);

  /** Honest expired-cursor recovery: reset the fold and replay from retention start. */
  const reloadFromStart = useCallback((): void => {
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (phaseRef.current !== "expired") return;
    if (sessionId === null || runId === null || terminatedRef.current) return;
    const gen = generationRef.current;
    const fromSeq = expiredFirstSeq;
    lastConsumedRef.current = fromSeq - 1;
    setText("");
    setTools([]);
    setAnalyses([]);
    setRunError(null);
    setTerminal(null);
    setError(null);
    beginPhase("streaming");
    void (async (): Promise<void> => {
      try {
        if (!client.isBootstrapped) await client.bootstrap();
      } catch (caught) {
        if (generationRef.current !== gen) return;
        setError(friendlyCoachError(caught));
        beginPhase("expired");
        return;
      }
      if (generationRef.current !== gen || terminatedRef.current) return;
      attachStream(gen, sessionId, runId, fromSeq);
    })();
  }, [attachStream, beginPhase, client, expiredFirstSeq]);

  const cancel = useCallback(async (): Promise<void> => {
    const current = phaseRef.current;
    // Centralized cancellability: a known active run in ANY phase, or a
    // pre-run operation. A recoverable restore failure with no verified run is
    // not cancellable (it is retried), so it never claims a false cancelled.
    if (!canCancelNow()) return;
    // Synchronous duplicate guard: concurrent cancel taps share one server
    // attempt until it fails and releases the inflight flag (item 5).
    if (cancelInflightRef.current) return;
    // While an unconfirmed cancel is being resolved (same-key submit then
    // cancel), a stray tap must not resolve anything locally.
    if (resolvingCancelRef.current) return;
    const runId = runIdRef.current;
    if (terminatedRef.current) return;
    cancelRequestedRef.current = true;
    // A terminal that already won the race keeps its verdict.
    if (runId === null) {
      if (current === "restoring" || restoreRecordRef.current !== null) {
        // A restore is verifying a KNOWN run (or a cancel already recorded
        // that intent and moved to cancelling while the restore is still
        // pending): keep the cancel intent and let the restore continuation
        // cancel the ACTUAL run once ownership is verified — never a local
        // cancelled that later resumes the stream. Repeated taps stay
        // idempotent until ownership is verified.
        beginPhase("cancelling");
        return;
      }
      if (postInflightRef.current) {
        // The submit POST is out but unresolved: the server may already have
        // accepted the run, so do NOT claim cancelled. Stay cancelling; the
        // submit path resolves it (established run -> server cancel; lost ack
        // -> unconfirmed). No date/state is fabricated.
        beginPhase("cancelling");
        return;
      }
      if (pendingRetryRef.current !== null) {
        // An ambiguous submit owns an unresolved request (original accept
        // unknown, retry perhaps bootstrapping): a local cancelled would be
        // dishonest. Hold cancelling; the same-key retry continuation resolves
        // the run then cancels it (or lands unconfirmed on failure).
        beginPhase("cancelling");
        return;
      }
      // Pre-POST cancel (bootstrap/snapshot in flight): no server run can
      // exist yet, so resolving locally to cancelled is honest.
      beginPhase("cancelling");
      beginPhase("cancelled");
      return;
    }
    const resumeFrom = current === "expired" ? expiredFirstSeq : lastConsumedRef.current + 1;
    beginPhase("cancelling");
    cancelInflightRef.current = true;
    // Operation identity: a late bootstrap/cancel settlement after an account
    // switch, logout, teardown, or superseding run must never touch the new
    // owner's inflight flag, error, or stream. Checked after every await
    // BEFORE shared state is touched or the tail is reattached.
    const opGen = generationRef.current;
    const opAccount = accountRef.current;
    const opRunId = runId;
    try {
      if (!client.isBootstrapped) await client.bootstrap();
      if (generationRef.current !== opGen) return;
      if (accountRef.current !== opAccount) return;
      if (runIdRef.current !== opRunId) return;
      await client.cancelRun(opRunId);
    } catch (caught) {
      if (generationRef.current !== opGen) return;
      if (accountRef.current !== opAccount) return;
      if (runIdRef.current !== opRunId) return;
      // Terminal wins over a late cancel reply: never change done/cancelled/failed.
      if (terminatedRef.current) {
        cancelInflightRef.current = false;
        return;
      }
      if (isDefinitiveMissingRunError(caught)) {
        // Structured proof the target is gone; ownership verified above.
        releaseMissingRun(
          opGen,
          opRunId,
          "Coach run is no longer available (RUN_NOT_FOUND). Previous output is kept; start a new analysis.",
        );
        return;
      }
      cancelInflightRef.current = false;
      // Never claim cancelled without server confirmation (item 2): surface
      // the failure and stay cancelling so the user can retry the cancel.
      // The subscription stays attached; a late completed terminal still wins.
      setError(friendlyCoachError(caught));
      return;
    }
    if (generationRef.current !== opGen) return;
    if (accountRef.current !== opAccount) return;
    if (runIdRef.current !== opRunId) return;
    cancelInflightRef.current = false;
    if (terminatedRef.current) return;
    if (!streamLiveRef.current) {
      // No live tail (disconnect/expired/failed): re-open from the resume
      // position so the server terminal that confirms the cancellation is
      // observed. A live streaming tail is kept and simply folds the terminal.
      const sessionId = sessionIdRef.current;
      if (sessionId !== null) attachStream(generationRef.current, sessionId, runId, resumeFrom);
    }
    // Otherwise keep the subscription attached until the server terminal
    // confirms the cancellation — do not freeze the transcript early (item 2).
  }, [attachStream, beginPhase, canCancelNow, client, expiredFirstSeq, releaseMissingRun]);

  /** Start over with a fresh question (the session is reused; the key is not). */
  const newAnalysis = useCallback((): void => {
    // Never abandon a running, unconfirmed, or known nonterminal run (item 2/5):
    // only a terminal or idle state may reset. Checked synchronously so a double
    // tap during a stream cannot drop the transcript.
    if (blocksFreshRun()) return;
    generationRef.current += 1;
    attemptRef.current += 1;
    cancelRequestedRef.current = false;
    cancelInflightRef.current = false;
    cancelUnconfirmedRef.current = false;
    resolvingCancelRef.current = false;
    postInflightRef.current = false;
    terminatedRef.current = false;
    lastConsumedRef.current = -1;
    pendingRetryRef.current = null;
    restoreRecordRef.current = null;
    runIdRef.current = null;
    clearStoredCoachResume();
    try {
      subscriptionRef.current?.close();
    } catch {
      // Detach is best-effort.
    } finally {
      subscriptionRef.current = null;
    }
    clearFold();
    setBlockedResume(null);
    unpinBackend();
    beginPhase("idle");
  }, [beginPhase, blocksFreshRun, clearFold, unpinBackend]);

  // Account switch / logout: abort the subscription, cancel the own active
  // run, forget credentials, and clear session/results/drafts + resume ids.
  // Old replies are ignored via the generation bump. Cleanup replays the OLD
  // account's captured bearer + capability, never the new account's (item 3).
  useEffect(() => {
    if (accountRef.current === undefined) {
      accountRef.current = accountId;
      prevClientRef.current = client;
      accountTokenRef.current = { accountId, token: getAccessToken() };
      return;
    }
    if (accountRef.current === accountId) {
      // Same identity: keep the capability handle current for the next switch.
      prevClientRef.current = client;
      return;
    }
    const previousAccountId = accountRef.current;
    const previousClient = prevClientRef.current ?? client;
    const previousBackend = activeBackendRef.current;
    // `previousClient` may be the mutable router, whose active backend can be
    // changed by a later selection. Capture the leaf transport that owns the
    // run so cleanup can never be redirected.
    const cleanupClient =
      previousClient === router && previousBackend !== null
        ? isCloudBackend(previousBackend)
          ? cloudClient
          : localClient
        : previousClient;
    const captured = accountTokenRef.current;
    accountRef.current = accountId;
    generationRef.current += 1;
    attemptRef.current += 1;
    cancelRequestedRef.current = false;
    cancelInflightRef.current = false;
    cancelUnconfirmedRef.current = false;
    resolvingCancelRef.current = false;
    postInflightRef.current = false;
    terminatedRef.current = false;
    try {
      subscriptionRef.current?.close();
    } catch {
      // Detach is best-effort.
    } finally {
      subscriptionRef.current = null;
    }
    const runId = runIdRef.current;
    runIdRef.current = null;
    sessionIdRef.current = null;
    lastConsumedRef.current = -1;
    pendingRetryRef.current = null;
    restoreRecordRef.current = null;
    // The old account's resume ids must never restore under the new account.
    // A null -> A transition (sign-in) is not a switch away from a known
    // account, so a same-account resume is left for the restore effect; the
    // account change on logout or A -> B clears it.
    if (previousAccountId !== null) clearStoredCoachResume();
    // Item 3: capture A's capability, then discard it SYNCHRONOUSLY so a stale
    // capability (or an in-flight A bootstrap) can never be reused, and only
    // then fire the server cleanup with A's explicit credentials. Skipped when
    // A's capability was already gone: cleanup then stays local instead of
    // sending another account's credentials.
    const previousCapability = cleanupClient.capabilitySnapshot();
    cleanupClient.discardCredentials();
    const previousToken = captured.accountId === previousAccountId ? captured.token : null;
    // A cloud run carries no capability, so its teardown is authorized by the
    // captured bearer only. `cleanupClient` is the account-bound leaf that
    // already pins the run's backend; a later mutable selection/router must not
    // redirect this cleanup.
    const previousWasCloud = previousBackend !== null && isCloudBackend(previousBackend);
    if (previousCapability !== null || (previousWasCloud && previousToken !== null)) {
      if (runId !== null) {
        void cleanupClient
          .cancelRun(runId, undefined, { capability: previousCapability, accessToken: previousToken })
          .catch(() => undefined);
      }
      void cleanupClient
        .logout({ capability: previousCapability, accessToken: previousToken })
        .catch(() => undefined);
    }
    // The retained teardown belonged to A: its server cleanup already ran
    // above, so reset the snapshot for B.
    retainedLogoutRef.current = {
      accountId,
      runId: null,
      capability: null,
      accessToken: null,
      backendId: null,
      client: null,
    };
    // Adopt the new identity's client + live bearer for the next switch.
    prevClientRef.current = client;
    accountTokenRef.current = { accountId, token: getAccessToken() };
    // The next account starts from ITS OWN preference (never A's selection),
    // with no pin and no inherited discovery result.
    unpinBackend();
    const nextDefault = defaultCoachBackend({ mode: coachMode, accountId, guest: isGuest });
    selectedBackendRef.current = nextDefault;
    setSelectedBackend(nextDefault);
    setBackends(initialBackendOptions({ mode: coachMode, piAvailable: runtimePiAvailable() }));
    discoveryKeyRef.current = null;
    setDiscoveryNotice(null);
    setDiscoveryFailed(false);
    setBlockedResume(null);
    clearFold();
    beginPhase("idle");
  }, [
    accountId,
    beginPhase,
    clearFold,
    client,
    cloudClient,
    coachMode,
    getAccessToken,
    isGuest,
    localClient,
    router,
    unpinBackend,
  ]);

  // Keep the retained, account-bound cleanup credentials current while this
  // account is on screen (runs after every commit, so the last render before an
  // unmount is already reflected). Never writes another account's data.
  useEffect(() => {
    if (accountRef.current !== accountId) return;
    const retained = retainedLogoutRef.current;
    retained.accountId = accountId;
    retained.runId = runIdRef.current;
    const active = activeBackendRef.current;
    retained.backendId = active;
    // Capture the LEAF transport that owns this account/run. Teardown must not
    // consult a later mutable router or `clientRef.current`, which an account
    // switch or selection change could have redirected.
    if (active !== null) {
      retained.client = explicitClient
        ? client
        : isCloudBackend(active)
          ? cloudClient
          : localClient;
    }
    const ownerClient = retained.client ?? client;
    const capability = ownerClient.capabilitySnapshot();
    if (capability !== null) retained.capability = capability;
    const token = getAccessToken();
    if (token !== null) retained.accessToken = token;
  });

  // Server teardown with the RETAINED credentials only: it never reads a live
  // bearer/getAccessToken, so a switched-in account's token can never be
  // replayed for the old account. No React state is touched.
  const runRetainedCoachCleanup = useCallback((): void => {
    const { capability, accessToken, runId, backendId, client: cleanupClient } =
      retainedLogoutRef.current;
    const isCloudRun = backendId !== null && isCloudBackend(backendId);
    // A local capability is mandatory for the local transport; a cloud run is
    // cleaned up with its captured bearer and has no capability at all.
    if (capability === null && !(isCloudRun && accessToken !== null)) return;
    if (cleanupClient === null) return;
    // `cleanupClient` was captured from the account/backend that owns the run.
    // Never route this through a later mutable active client/router.
    if (runId !== null) {
      void cleanupClient
        .cancelRun(runId, undefined, { capability, accessToken })
        .catch(() => undefined);
    }
    void cleanupClient.logout({ capability, accessToken }).catch(() => undefined);
  }, []);

  // Sign-out teardown: `Layout` runs it BEFORE `signOutSession`, while the old
  // session is still live, so the server-side cancel + logout carry the OLD
  // account's credentials (dispatched synchronously, before the auth sign-out).
  // It also runs after an ordinary navigation unmounted the Coach — the owner
  // itself survives navigation, and the retained credentials cover the case
  // where the run outlived the last render. Idempotent: once the retained
  // capability is dropped, the account-change effect below skips a second
  // server teardown.
  const teardown = useCallback((): void => {
    generationRef.current += 1;
    attemptRef.current += 1;
    cancelRequestedRef.current = false;
    cancelInflightRef.current = false;
    cancelUnconfirmedRef.current = false;
    resolvingCancelRef.current = false;
    postInflightRef.current = false;
    terminatedRef.current = false;
    try {
      subscriptionRef.current?.close();
    } catch {
      // Detach is best-effort.
    }
    subscriptionRef.current = null;
    runIdRef.current = null;
    sessionIdRef.current = null;
    lastConsumedRef.current = -1;
    pendingRetryRef.current = null;
    restoreRecordRef.current = null;
    // The account's resume ids must not restore a run after logout.
    clearStoredCoachResume();
    setBlockedResume(null);
    // Forget the live capability synchronously, then fire the server teardown
    // with the retained credentials (explicit capability, never the client's
    // current handle or a live bearer).
    clientRef.current.discardCredentials();
    runRetainedCoachCleanup();
    retainedLogoutRef.current.backendId = null;
    unpinBackend();
  }, [runRetainedCoachCleanup, unpinBackend]);

  /**
   * Verify a persisted resume server-side, then replay it (or, if a cancel was
   * recorded meanwhile, cancel the ACTUAL verified run). Ownership is verified
   * the server-side: a cross-account read is a 404, never returned, so no
   * client-side account check is trusted here.
   */
  const runRestore = useCallback(
    async (gen: number, record: CoachResumeRecord): Promise<void> => {
      try {
        if (!client.isBootstrapped) await client.bootstrap();
        if (generationRef.current !== gen) return;
        const session = await client.readSession(record.sessionId);
        if (generationRef.current !== gen) return;
        const read = await client.readRun(record.runId);
        if (generationRef.current !== gen) return;
        if (read.run.sessionId !== session.id) {
          throw new ApiError({
            code: "RUN_NOT_FOUND",
            message: "Stored coaching run does not belong to the stored session.",
          });
        }
        // The server-resolved snapshot must be bound to the same account:
        // never restore another identity's data into this session.
        if (read.run.snapshot.accountId !== accountId) {
          throw new ApiError({
            code: "SESSION_NOT_FOUND",
            message: "Stored coaching run belongs to another account.",
          });
        }
        // Ownership verified: the run is real and ours, so a later failure is
        // a reconnect (never an ambiguous restore).
        restoreRecordRef.current = null;
        restoreCompletedRef.current = accountId;
        sessionIdRef.current = session.id;
        runIdRef.current = read.run.id;
        // The server verifies account ownership and supplies this association;
        // never trust an unverified conversation id from browser storage.
        setRunConversationId(isCloudBackend(record.backendId) ? read.run.conversationId ?? null : null);
        // Migrate/refresh the v2 record with the verified ids, origin, and
        // cursor. Replay always comes from this record, not the selector.
        persistResume();
        // Restore the source/scope metadata the refreshed result came from.
        setSnapshot(read.run.snapshot);
        if (cancelRequestedRef.current) {
          // A cancel recorded while bootstrap/session/read were in flight: the
          // run is now verified, so cancel the ACTUAL run and await its
          // terminal on the stream — never a local "cancelled" that later
          // resumes the restored run.
          beginPhase("cancelling");
          try {
            await client.cancelRun(read.run.id);
          } catch (caught) {
            if (generationRef.current !== gen) return;
            setError(friendlyCoachError(caught));
          }
          if (generationRef.current !== gen) return;
          attachStream(gen, session.id, read.run.id, 0);
          return;
        }
        beginPhase("streaming");
        attachStream(gen, session.id, read.run.id, 0);
      } catch (caught) {
        if (generationRef.current !== gen) return;
        if (isDefinitiveMissingResumeError(caught)) {
          // DEFINITIVE: the stored session/run does not exist for this account
          // (gone, or owned by another identity). Only this may reset — and a
          // cancel with no verifiable run is honestly cancelled.
          clearStoredCoachResume();
          restoreRecordRef.current = null;
          restoreCompletedRef.current = accountId;
          sessionIdRef.current = null;
          runIdRef.current = null;
          lastConsumedRef.current = -1;
          setBlockedResume(null);
          unpinBackend();
          const wasCancelling = cancelRequestedRef.current;
          cancelRequestedRef.current = false;
          beginPhase(wasCancelling ? "cancelled" : "idle");
          return;
        }
        // AMBIGUOUS (network/auth): cannot prove the run is absent or
        // terminated. Keep the account-bound resume AND any cancel intent and
        // surface a recoverable state with an explicit retry — never a false
        // cancelled and never a reset.
        setError(friendlyCoachError(caught));
        beginPhase("disconnected");
      }
    },
    [accountId, attachStream, beginPhase, client, persistResume, unpinBackend],
  );

  /** Begin a restore attempt for `record` under a fresh generation. */
  const startRestore = useCallback(
    (record: CoachResumeRecord): void => {
      // The stored record owns the origin: replay pinning never consults the
      // current selector, so a changed selection cannot redirect a restore.
      pinBackend(record.backendId);
      const gen = ++generationRef.current;
      attemptRef.current += 1;
      streamLiveRef.current = false;
      terminatedRef.current = false;
      lastConsumedRef.current = -1;
      runIdRef.current = null;
      sessionIdRef.current = null;
      restoreRecordRef.current = record;
      setError(null);
      beginPhase("restoring");
      void runRestore(gen, record);
    },
    [beginPhase, pinBackend, runRestore],
  );

  /**
   * Retry an AMBIGUOUS restore failure. The account-bound resume is still
   * stored, so this re-verifies the SAME run and carries the preserved cancel
   * intent through — it never POSTs a fresh run.
   */
  const retryRestore = useCallback((): void => {
    if (phaseRef.current !== "disconnected") return;
    if (runIdRef.current !== null && !terminatedRef.current) return;
    const record = restoreRecordRef.current;
    if (record === null) return;
    if (record.accountId !== accountId) {
      clearStoredCoachResume();
      restoreRecordRef.current = null;
      return;
    }
    startRestore(record);
  }, [accountId, startRestore]);

  // Item 4: restore a persisted run once the account is VERIFIED signed-in and
  // coaching is enabled. Only versioned, account-bound ids are stored; the
  // transcript is reconstructed by reading the session/run and replaying the
  // events — never by POSTing a fresh run. The persisted resume is NOT read or
  // cleared while the account is unverified (auth `loading`) or coaching is
  // disabled, so a restored signed-in user never loses their run before
  // validation completes. A stale (404) or foreign resume resets cleanly; an
  // ambiguous failure keeps the resume for an explicit retry.
  useEffect(() => {
    if (!canOperate) return;
    if (accountRef.current !== accountId) return;
    if (restoreCompletedRef.current === accountId) return;
    if (restoreAttemptedRef.current === accountId) return;
    const record = readStoredCoachResume();
    if (record === null) return;
    restoreAttemptedRef.current = accountId;
    if (record.accountId !== accountId) {
      clearStoredCoachResume();
      restoreCompletedRef.current = accountId;
      return;
    }
    // A plain browser cannot address a local launcher run. Keep the v2 record
    // (backend/origin included) and tell the user to start the original
    // connector; never clear it or replay it through the current/cloud backend.
    if (!isBackendSupportedInMode(record.backendId, coachMode)) {
      restoreCompletedRef.current = accountId;
      const localRun = !isCloudBackend(record.backendId);
      setBlockedResume({
        backendId: record.backendId,
        message: localRun
          ? `A saved run belongs to ${resumeBackendName(
              record.backendId,
            )}, which is unavailable in this browser session. Start the original local connector with \`agent-fit-trace start\` on the machine that owns the run to resume it. Its saved resume was kept and it was not replayed through another backend.`
          : `A saved run belongs to ${resumeBackendName(
              record.backendId,
            )}, which is unavailable in this session. Start the cloud-enabled app to resume it. Its saved resume was kept and it was not replayed through another backend.`,
      });
      return;
    }
    // Fresh attempt: a stale cancel intent from a previous identity must not
    // leak into this restore.
    cancelRequestedRef.current = false;
    setBlockedResume(null);
    startRestore(record);
    return () => {
      // Allow a StrictMode remount (or a genuine account change) to retry the
      // once-per-identity restore instead of being blocked by the guard. The
      // first attempt is invalidated by the unmount effect's generation bump.
      if (restoreAttemptedRef.current === accountId) restoreAttemptedRef.current = undefined;
    };
  }, [accountId, canOperate, coachMode, startRestore]);

  /**
   * Retry backend availability after a transient discovery failure. Bounded by
   * construction: one re-run per explicit click, never an unbounded background
   * retry loop. The identity key is cleared so the discovery effect re-runs.
   */
  const retryBackendDiscovery = useCallback((): void => {
    discoveryKeyRef.current = null;
    setDiscoveryNotice(null);
    setDiscoveryAttempt((current) => current + 1);
  }, []);

  /**
   * Discover the backends this session may choose from. Launcher mode asks the
   * local capability route (falling back to the legacy local-pi option); plain
   * browser mode asks the shared cloud capability route for FORMAL accounts
   * only. Guests and unverified identities never issue a cloud request.
   */
  const discoveryKey = `${coachMode}:${accountId ?? "none"}:${
    isGuest ? "guest" : identityUnverified ? "unverified" : "formal"
  }`;
  useEffect(() => {
    if (!canOperate) return;
    if (accountRef.current !== accountId) return;
    if (coachMode === "explicit") return;
    if (discoveryKeyRef.current === discoveryKey) return;
    discoveryKeyRef.current = discoveryKey;
    const key = discoveryKey;
    if (coachMode === "browser" && (isGuest || identityUnverified)) {
      // No cloud request: a guest can only be told how to run a local coach.
      setBackends([]);
      setDiscoveryNotice(null);
      setDiscoveryFailed(false);
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        if (coachMode === "browser") {
          const capabilities = await cloudClient.readCapabilities();
          if (cancelled) return;
          setBackends([cloudOptionFromCapabilities(capabilities)]);
        } else {
          if (!client.isBootstrapped) await client.bootstrap();
          if (cancelled) return;
          const discovery = await localClient.discoverBackends();
          if (cancelled) return;
          const piAvailable = runtimePiAvailable();
          setBackends(
            discovery.backends.map((descriptor) =>
              descriptor.backendId === "local-pi" && piAvailable === false
                ? localPiOption(false)
                : descriptorToOption(descriptor),
            ),
          );
        }
        if (cancelled) return;
        setDiscoveryNotice(null);
        setDiscoveryFailed(false);
      } catch (caught) {
        if (cancelled) return;
        if (coachMode === "browser") {
          setBackends([
            unavailableCloudOption("Cloud availability could not be verified; cloud coaching stays off."),
          ]);
          setDiscoveryNotice(
            `Cloud availability could not be verified (${friendlyCoachError(caught)}). Cloud coaching stays off.`,
          );
          // A transient failure must not disable cloud until reload: surface a
          // bounded, explicit retry instead of a dead end.
          setDiscoveryFailed(true);
        } else {
          // Keep the already-truthful local default instead of inventing a
          // backend: the launcher already published whether pi is present.
          setDiscoveryNotice(
            `Backend discovery failed (${friendlyCoachError(
              caught,
            )}). Showing the local pi default.`,
          );
          setDiscoveryFailed(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      // Let a StrictMode/same-identity re-run retry discovery; an account
      // switch has already cleared the key.
      if (discoveryKeyRef.current === key) discoveryKeyRef.current = null;
    };
  }, [
    accountId,
    canOperate,
    client,
    cloudClient,
    coachMode,
    discoveryAttempt,
    discoveryKey,
    identityUnverified,
    isGuest,
    localClient,
  ]);

  // Unmount (ordinary navigation, refresh, or logout) detaches the stream,
  // bumps the generation/attempt so every pending bootstrap/restore/submit
  // callback is rejected, and forgets the in-memory capability. The persisted
  // resume ids, the server-side run, AND the owner's retained logout teardown
  // are deliberately KEPT so a return or refresh restores progress, and a later
  // sign-out can still cancel/logout with the retained account credentials —
  // an ordinary navigation never logs out.
  useEffect(
    () => () => {
      generationRef.current += 1;
      attemptRef.current += 1;
      cancelRequestedRef.current = false;
      cancelInflightRef.current = false;
      cancelUnconfirmedRef.current = false;
      resolvingCancelRef.current = false;
      postInflightRef.current = false;
      terminatedRef.current = false;
      try {
        subscriptionRef.current?.close();
      } catch {
        // Detach is best-effort.
      }
      subscriptionRef.current = null;
      clientRef.current.discardCredentials();
    },
    [],
  );

  const hasActiveRun = runIdRef.current !== null && !terminatedRef.current;
  const selectedOption =
    selectedBackend === null
      ? null
      : (backends.find((option) => option.id === selectedBackend) ?? null);
  const isBackendPinned = backendPinnedNow();
  // Ask is offered only for an explicitly chosen, AVAILABLE backend. There is
  // no implicit default: the cloud is opt-in and a guest has no cloud option.
  const canAsk =
    status === "signed-in" &&
    accountId !== null &&
    selectedOption !== null &&
    selectedOption.available;
  const backendNotice = useMemo((): string | null => {
    if (coachMode === "browser") {
      if (isGuest) {
        return "Cloud coaching requires a formal account. Guests can use their own local coach only: install pi, then run `agent-fit-trace start` on this machine.";
      }
      if (identityUnverified) {
        return "Cloud coaching is unavailable until your account identity is verified.";
      }
    }
    if (discoveryNotice !== null) return discoveryNotice;
    if (selectedOption === null) {
      if (coachMode === "browser") {
        return "Cloud coaching is off by default because every run spends cloud coaching credits. Select Cloud coach for the next run.";
      }
      return null;
    }
    if (!selectedOption.available) {
      return selectedOption.unavailableReason?.message ?? "The selected coach backend is unavailable.";
    }
    if (coachMode === "browser" && selectedOption.location === "cloud") {
      return "Cloud coaching is selected for the next run. It uses your cloud coaching credits.";
    }
    return null;
  }, [coachMode, discoveryNotice, identityUnverified, isGuest, selectedOption]);
  // Only a failed browser discovery offers the bounded retry; guests and
  // unverified identities make no cloud request at all.
  const canRetryBackendDiscovery = coachMode === "browser" && discoveryFailed;
  return {
    phase,
    mode: coachMode,
    isGuest,
    identityUnverified,
    backends,
    selectedBackend,
    runConversationId,
    // The run's own backend, exposed only while it is pinned (active,
    // unresolved, restoring, cancelling, or awaiting a same-key retry).
    activeBackend: isBackendPinned ? activeBackend : null,
    isBackendPinned,
    canAsk,
    backendNotice,
    canRetryBackendDiscovery,
    retryBackendDiscovery,
    blockedResume,
    selectBackend,
    // Every button capability is DERIVED from the single phase plus the live
    // run, never a scattered duplicate boolean. A known nonterminal run keeps
    // `isRunning` true in ANY phase (expired/disconnected/unconfirmed included,
    // plus an ambiguous submit holding a same-key retry) so fresh work is
    // blocked and cancel/reconnect stay offered. Single shared guard with
    // submit/newAnalysis via blocksFreshRun().
    isRunning: hasActiveRun || blocksFreshRun(),
    snapshot,
    text,
    tools,
    analyses,
    runError,
    terminal,
    error,
    canReconnect: phase === "disconnected" && hasActiveRun,
    canReloadFromStart: phase === "expired" && hasActiveRun,
    // A recoverable (ambiguous) restore failure keeps the resume and is retried
    // explicitly; it is never locally cancelled.
    canRetryRestore:
      phase === "disconnected" && restoreRecordRef.current !== null && runIdRef.current === null,
    // Cancellable: a known active run in any phase, or a pre-run operation.
    canCancel:
      hasActiveRun ||
      phase === "preparing" ||
      phase === "restoring" ||
      phase === "cancelling",
    // Ambiguous-submit retry only: a run that reached the stream must
    // reconnect (or reload from retention), never resubmit (item 5). Never
    // offered after cancellation — the run is resolved, not ambiguous.
    canRetrySubmit:
      pendingRetryRef.current !== null && phase === "failed" && runIdRef.current === null,
    hasRun: runIdRef.current !== null,
    submit,
    retrySubmit,
    retryRestore,
    reconnect,
    reloadFromStart,
    cancel,
    newAnalysis,
    teardown,
  };
}

export type UseCoachResult = ReturnType<typeof useCoachSession>;

export const CoachingContext = createContext<UseCoachResult | null>(null);

/** Subscribe to the account-level coaching owner; throws outside a provider. */
export function useCoach(): UseCoachResult {
  const value = useContext(CoachingContext);
  if (value === null) {
    throw new Error("useCoach must be used within a <CoachingProvider>.");
  }
  return value;
}
