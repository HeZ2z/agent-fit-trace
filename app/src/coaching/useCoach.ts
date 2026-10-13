import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "@pi-fit-trace/core";
import { ApiError, NetworkError } from "@pi-fit-trace/api-contracts";
import type {
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  CoachingTerminalStatus,
} from "@pi-fit-trace/api-contracts";
import { CoachingClient } from "../api/coachingClient.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import {
  clearCoachLogoutCleanup,
  retainCoachLogoutCleanup,
} from "./coachLogoutRegistry.ts";

/**
 * Item 4: persisted resume holds ONLY versioned, account-bound IDs in
 * sessionStorage — never tokens, transcripts, or native paths.
 */
const COACH_RESUME_STORAGE_KEY = "fit-trace.coach.resume.v1";
const COACH_RESUME_VERSION = 1;

interface CoachResumeRecord {
  version: number;
  accountId: string;
  sessionId: string;
  runId: string;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function readStoredCoachResume(): CoachResumeRecord | null {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return null;
    const raw = storage.getItem(COACH_RESUME_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== COACH_RESUME_VERSION) return null;
    if (!isNonBlank(record.accountId) || !isNonBlank(record.sessionId) || !isNonBlank(record.runId)) {
      return null;
    }
    return { version: COACH_RESUME_VERSION, accountId: record.accountId, sessionId: record.sessionId, runId: record.runId };
  } catch {
    // Storage unavailable or corrupt: resume is best-effort, never fatal.
    return null;
  }
}

function writeStoredCoachResume(record: CoachResumeRecord): void {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return;
    storage.setItem(COACH_RESUME_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage failures must not break the run; the live refs still win.
  }
}

function clearStoredCoachResume(): void {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined || storage === null) return;
    storage.removeItem(COACH_RESUME_STORAGE_KEY);
  } catch {
    // Best-effort only.
  }
}

function isMissingRunError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.code === "NOT_FOUND" ||
      error.code === "RUN_NOT_FOUND" ||
      error.code === "SESSION_NOT_FOUND" ||
      error.status === 404
    );
  }
  return false;
}

/**
 * Item 4: a stored resume whose session/run is gone or whose credentials
 * expired is a clean reset, never a hard error — the app was restarted or the
 * run aged out, and the user should simply see a fresh Coach form.
 */
function isStaleResumeError(error: unknown): boolean {
  if (isMissingRunError(error)) return true;
  if (error instanceof ApiError) {
    return (
      error.code === "SESSION_EXPIRED" ||
      error.code === "UNAUTHENTICATED" ||
      error.code === "UNAUTHORIZED"
    );
  }
  return false;
}

export type CoachPhase =
  | "idle"
  | "preparing"
  | "streaming"
  | "cancelling"
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
  from?: string;
  to?: string;
}

interface PendingSubmit {
  prompt: string;
  filter: { from?: string; to?: string };
  idempotencyKey: string;
  snapshotHandle: { snapshotId: string; source: string; accountId: string };
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
 * Small lifecycle hook over the approved {@link CoachingClient} transport.
 *
 * Owns bootstrap/session/snapshot/run/subscribe sequencing, per-submission
 * idempotency keys, last-consumed resume positions, and account-switch
 * cleanup. Rendering stays in `CoachScreen`.
 */
export function useCoach({ client: clientProp }: { client?: CoachingClient } = {}) {
  const { getAccessToken, user } = useAuth();
  const accountId = user?.id ?? null;
  // Item 3: the default client is bound to the account identity that created
  // it. After a switch the old instance's token accessor returns null so B's
  // bearer can never leak into A's cleanup (or vice versa); cleanup uses the
  // captured A credentials explicitly (see the account effect below).
  const accountRef = useRef<string | null | undefined>(undefined);
  const defaultClient = useMemo(() => {
    const boundAccount = accountId;
    const currentRef = accountRef;
    return new CoachingClient({
      getAccessToken: () => {
        if (currentRef.current !== undefined && currentRef.current !== boundAccount) return null;
        return getAccessToken();
      },
    });
  }, [accountId, getAccessToken]);
  const client = clientProp ?? defaultClient;
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
  const [canReconnect, setCanReconnect] = useState(false);
  const [canReloadFromStart, setCanReloadFromStart] = useState(false);
  const [expiredFirstSeq, setExpiredFirstSeq] = useState(0);
  // Item 3: the account whose fold is currently on screen. When `accountId`
  // changes, the visible fold is reset during render (below) so the previous
  // account's transcript can never paint under the new identity.
  const [renderedAccountId, setRenderedAccountId] = useState<string | null>(accountId);

  const phaseRef = useRef<CoachPhase>("idle");
  phaseRef.current = phase;
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
  const prevClientRef = useRef<CoachingClient | null>(null);
  // Last known bearer per account, captured while that account is current so
  // switch cleanup can replay A's token explicitly (never B's).
  const accountTokenRef = useRef<{ accountId: string | null; token: string | null }>({
    accountId,
    token: null,
  });
  // Item 4 restore runs once per account identity per mount.
  const restoreAttemptedRef = useRef<string | null | undefined>(undefined);
  // Retained, account-bound server-cleanup credentials. The Coach can unmount
  // (ordinary navigation) with its run still live server-side, so the
  // shell-owned registry must be able to cancel/logout at a LATER sign-out with
  // this account's captured credentials. Kept current while this account is on
  // screen; only ever holds the current account's data; reset on a switch.
  const retainedLogoutRef = useRef<{
    accountId: string | null;
    runId: string | null;
    capability: string | null;
    accessToken: string | null;
  }>({ accountId: null, runId: null, capability: null, accessToken: null });

  // Item 3: capture the live bearer while this account is current so an
  // account switch can replay the OLD account's credentials for cleanup and
  // never the new account's bearer. When `accountId` changes, the comparison
  // below no longer matches and the previous account's token is preserved
  // until the switch effect consumes it.
  if (accountTokenRef.current.accountId === accountId) {
    accountTokenRef.current.token = getAccessToken();
  }

  const persistResume = useCallback((): void => {
    const currentAccount = accountRef.current ?? accountId;
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (currentAccount === null || currentAccount === undefined) return;
    if (sessionId === null || runId === null) return;
    writeStoredCoachResume({ version: COACH_RESUME_VERSION, accountId: currentAccount, sessionId, runId });
  }, [accountId]);

  // Synchronous phase authority: set the ref NOW so rapid duplicate taps see
  // the in-flight operation before React re-renders (item 5).
  const beginPhase = useCallback((next: CoachPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearFold = useCallback(() => {
    setSnapshot(null);
    setText("");
    setTools([]);
    setAnalyses([]);
    setRunError(null);
    setTerminal(null);
    setError(null);
    setCanReconnect(false);
    setCanReloadFromStart(false);
  }, []);

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
          return;
      }
      // Advance only after a successful fold (item 1): reconnect resumes from
      // last consumed + 1 instead of replaying from 0.
      lastConsumedRef.current = envelope.seq;
    },
    [beginPhase],
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
      void subscription.done.then(
        (result) => {
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
          // (the transport rejects it); guard anyway.
          setError("The coach stream ended without a terminal event. Reconnect to resume.");
          setCanReconnect(true);
          lastConsumedRef.current = result.lastConsumed;
          beginPhase("failed");
        },
        (streamError: unknown) => {
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
            setCanReloadFromStart(true);
            setError(friendlyCoachError(streamError));
            beginPhase("failed");
            return;
          }
          if (streamError instanceof NetworkError) {
            // Disconnect before terminal: keep the folded text and offer an
            // explicit resume from last consumed + 1 (never a silent skip).
            // lastConsumed advanced per folded envelope, so reconnect never
            // replays delivered frames (item 1).
            setError(friendlyCoachError(streamError));
            setCanReconnect(true);
            beginPhase("failed");
            return;
          }
          setError(friendlyCoachError(streamError));
          beginPhase("failed");
        },
      );
    },
    [beginPhase, client, foldEvent],
  );

  const submit = useCallback(
    async (input: CoachSubmitInput): Promise<void> => {
      const question = input.question.trim();
      if (question === "") {
        setError("Enter an analysis question first.");
        return;
      }
      // Synchronous duplicate guard: a second tap before re-render sees the
      // in-flight phase immediately (item 5). An unconfirmed cancellation also
      // blocks a fresh submit — it must be resolved with the same key.
      if (
        phaseRef.current === "preparing" ||
        phaseRef.current === "streaming" ||
        phaseRef.current === "cancelling" ||
        phaseRef.current === "unconfirmed"
      )
        return;
      const gen = ++generationRef.current;
      beginPhase("preparing");
      cancelRequestedRef.current = false;
      cancelInflightRef.current = false;
      cancelUnconfirmedRef.current = false;
      postInflightRef.current = false;
      terminatedRef.current = false;
      lastConsumedRef.current = -1;
      pendingRetryRef.current = null;
      runIdRef.current = null;
      // Item 4: a fresh submit supersedes any persisted resume until the new
      // run is established below.
      clearStoredCoachResume();
      clearFold();
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
          beginPhase("idle");
          return;
        }
        const handle = { snapshotId: created.snapshotId, source: created.source, accountId: created.accountId };
        pendingRetryRef.current = { prompt: question, filter, idempotencyKey, snapshotHandle: handle };
        postDispatched = true;
        postInflightRef.current = true;
        const submitted = await client.submitRun({
          sessionId,
          prompt: question,
          idempotencyKey,
          snapshot: handle,
        });
        postInflightRef.current = false;
        postDispatched = false;
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
        postInflightRef.current = false;
        if (generationRef.current !== gen) return;
        if (cancelRequestedRef.current) {
          if (postDispatched) {
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
          beginPhase("cancelled");
          return;
        }
        setError(friendlyCoachError(caught));
        // pendingRetry stays set only when no run was established (ambiguous
        // submit); stream failures clear it above so only Retry shows there.
        beginPhase("failed");
      }
    },
    [attachStream, beginPhase, clearFold, client, persistResume],
  );

  /** Explicit retry of an AMBIGUOUS submit with the SAME key/snapshot (no implicit replay). */
  const retrySubmit = useCallback(async (): Promise<void> => {
    const pending = pendingRetryRef.current;
    const sessionId = sessionIdRef.current;
    if (pending === null || sessionId === null) return;
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
    const gen = ++generationRef.current;
    beginPhase("preparing");
    cancelRequestedRef.current = keepCancelIntent;
    cancelInflightRef.current = false;
    postInflightRef.current = false;
    terminatedRef.current = false;
    lastConsumedRef.current = -1;
    runIdRef.current = null;
    let postDispatched = false;
    clearStoredCoachResume();
    setText("");
    setTools([]);
    setAnalyses([]);
    setRunError(null);
    setTerminal(null);
    setError(null);
    setCanReconnect(false);
    setCanReloadFromStart(false);
    try {
      if (!client.isBootstrapped) await client.bootstrap();
      if (generationRef.current !== gen) return;
      if (cancelRequestedRef.current && !keepCancelIntent) {
        beginPhase("cancelled");
        return;
      }
      postDispatched = true;
      postInflightRef.current = true;
      const submitted = await client.submitRun({
        sessionId,
        prompt: pending.prompt,
        idempotencyKey: pending.idempotencyKey,
        snapshot: pending.snapshotHandle,
      });
      postInflightRef.current = false;
      postDispatched = false;
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
      postInflightRef.current = false;
      if (generationRef.current !== gen) return;
      if (cancelRequestedRef.current) {
        if (postDispatched) {
          // Same ambiguity as a first submit: the server may have accepted the
          // replayed key, so stay unconfirmed rather than claiming cancelled.
          cancelUnconfirmedRef.current = true;
          beginPhase("unconfirmed");
          return;
        }
        beginPhase("cancelled");
        return;
      }
      setError(friendlyCoachError(caught));
      beginPhase("failed");
    } finally {
      resolvingCancelRef.current = false;
    }
  }, [attachStream, beginPhase, client, persistResume]);

  /** Explicit resume of a disconnected stream from last consumed + 1. */
  const reconnect = useCallback((): void => {
    const sessionId = sessionIdRef.current;
    const runId = runIdRef.current;
    if (sessionId === null || runId === null || terminatedRef.current) return;
    if (phaseRef.current === "preparing" || phaseRef.current === "streaming" || phaseRef.current === "cancelling")
      return;
    const gen = generationRef.current;
    beginPhase("streaming");
    setError(null);
    setCanReconnect(false);
    // Refresh an expired capability without repeating the run POST (item 5).
    void (async (): Promise<void> => {
      try {
        if (!client.isBootstrapped) await client.bootstrap();
      } catch (caught) {
        if (generationRef.current !== gen) return;
        setError(friendlyCoachError(caught));
        beginPhase("failed");
        setCanReconnect(true);
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
    if (sessionId === null || runId === null || terminatedRef.current) return;
    if (phaseRef.current === "preparing" || phaseRef.current === "streaming" || phaseRef.current === "cancelling")
      return;
    const gen = generationRef.current;
    const fromSeq = expiredFirstSeq;
    lastConsumedRef.current = fromSeq - 1;
    setText("");
    setTools([]);
    setAnalyses([]);
    setRunError(null);
    setTerminal(null);
    setError(null);
    setCanReloadFromStart(false);
    beginPhase("streaming");
    void (async (): Promise<void> => {
      try {
        if (!client.isBootstrapped) await client.bootstrap();
      } catch (caught) {
        if (generationRef.current !== gen) return;
        setError(friendlyCoachError(caught));
        beginPhase("failed");
        setCanReloadFromStart(true);
        return;
      }
      if (generationRef.current !== gen || terminatedRef.current) return;
      attachStream(gen, sessionId, runId, fromSeq);
    })();
  }, [attachStream, beginPhase, client, expiredFirstSeq]);

  const cancel = useCallback(async (): Promise<void> => {
    const current = phaseRef.current;
    if (current !== "preparing" && current !== "streaming" && current !== "cancelling") return;
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
      if (postInflightRef.current) {
        // The submit POST is out but unresolved: the server may already have
        // accepted the run, so do NOT claim cancelled. Stay cancelling; the
        // submit path resolves it (established run -> server cancel; lost ack
        // -> unconfirmed). No date/state is fabricated.
        beginPhase("cancelling");
        return;
      }
      // Pre-POST cancel (bootstrap/snapshot in flight): no server run can
      // exist yet, so resolving locally to cancelled is honest.
      beginPhase("cancelling");
      beginPhase("cancelled");
      setCanReconnect(false);
      return;
    }
    beginPhase("cancelling");
    setCanReconnect(false);
    cancelInflightRef.current = true;
    try {
      if (!client.isBootstrapped) await client.bootstrap();
      await client.cancelRun(runId);
    } catch (caught) {
      cancelInflightRef.current = false;
      if (terminatedRef.current) return;
      // Never claim cancelled without server confirmation (item 2): surface
      // the failure and stay cancelling so the user can retry the cancel.
      // The subscription stays attached; a late completed terminal still wins.
      setError(friendlyCoachError(caught));
      return;
    }
    cancelInflightRef.current = false;
    if (terminatedRef.current) return;
    // Keep the subscription attached until the server terminal confirms the
    // cancellation — do not freeze the transcript early (item 2).
  }, [beginPhase, client]);

  /** Start over with a fresh question (the session is reused; the key is not). */
  const newAnalysis = useCallback((): void => {
    // Never abandon a running or unconfirmed run (item 2/5): only terminal
    // phases may reset. Checked synchronously so a double tap during a
    // stream cannot drop the transcript.
    const current = phaseRef.current;
    if (
      current === "preparing" ||
      current === "streaming" ||
      current === "cancelling" ||
      current === "unconfirmed"
    )
      return;
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
    beginPhase("idle");
  }, [beginPhase, clearFold]);

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
    // The old account's resume ids must never restore under the new account.
    clearStoredCoachResume();
    // Item 3: capture A's capability, then discard it SYNCHRONOUSLY so a stale
    // capability (or an in-flight A bootstrap) can never be reused, and only
    // then fire the server cleanup with A's explicit credentials. Skipped when
    // A's capability was already gone: cleanup then stays local instead of
    // sending another account's credentials.
    const previousCapability = previousClient.capabilitySnapshot();
    previousClient.discardCredentials();
    const previousToken = captured.accountId === previousAccountId ? captured.token : null;
    if (previousCapability !== null) {
      if (runId !== null) {
        void previousClient
          .cancelRun(runId, undefined, { capability: previousCapability, accessToken: previousToken })
          .catch(() => undefined);
      }
      void previousClient
        .logout({ capability: previousCapability, accessToken: previousToken })
        .catch(() => undefined);
    }
    // The retained teardown belonged to A: its server cleanup already ran
    // above, so drop the registry entry and reset the snapshot for B.
    clearCoachLogoutCleanup();
    retainedLogoutRef.current = { accountId, runId: null, capability: null, accessToken: null };
    // Adopt the new identity's client + live bearer for the next switch.
    prevClientRef.current = client;
    accountTokenRef.current = { accountId, token: getAccessToken() };
    clearFold();
    beginPhase("idle");
  }, [accountId, beginPhase, clearFold, client, getAccessToken]);

  // Keep the retained, account-bound cleanup credentials current while this
  // account is on screen (runs after every commit, so the last render before an
  // unmount is already reflected). Never writes another account's data.
  useEffect(() => {
    if (accountRef.current !== accountId) return;
    const retained = retainedLogoutRef.current;
    retained.accountId = accountId;
    retained.runId = runIdRef.current;
    const capability = client.capabilitySnapshot();
    if (capability !== null) retained.capability = capability;
    const token = getAccessToken();
    if (token !== null) retained.accessToken = token;
  });

  // Server teardown with the RETAINED credentials only: this runs even after
  // the Coach unmounted (ordinary navigation keeps the run alive), and never
  // reads a live bearer/getAccessToken — so a switched-in account's token can
  // never be replayed for the old account. No React state is touched.
  const runRetainedCoachCleanup = useCallback((): void => {
    const { capability, accessToken, runId } = retainedLogoutRef.current;
    if (capability === null) return;
    const activeClient = clientRef.current;
    if (runId !== null) {
      void activeClient
        .cancelRun(runId, undefined, { capability, accessToken })
        .catch(() => undefined);
    }
    void activeClient.logout({ capability, accessToken }).catch(() => undefined);
  }, []);

  // Registered logout teardown: the Layout runs it BEFORE `signOutSession`,
  // while the old session is still live, so the server-side cancel + logout
  // carry the OLD account's credentials (the request is dispatched
  // synchronously, before the auth sign-out). It also runs after an ordinary
  // navigation unmounted the Coach — hence the retained credentials above and
  // the deliberate absence of React state updates. Needs a live capability —
  // without one there is nothing server-side to tear down.
  const logoutCleanup = useCallback((): void => {
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
    // The account's resume ids must not restore a run after logout.
    clearStoredCoachResume();
    // Forget the live capability synchronously, then fire the server teardown
    // with the retained credentials (explicit capability, never the client's
    // current handle or a live bearer).
    clientRef.current.discardCredentials();
    runRetainedCoachCleanup();
  }, [runRetainedCoachCleanup]);

  useEffect(() => {
    retainCoachLogoutCleanup({ accountId, run: logoutCleanup });
  }, [accountId, logoutCleanup]);

  // Item 4: restore a persisted run once per account identity. Only versioned,
  // account-bound ids are stored; the transcript is reconstructed by reading
  // the session/run and replaying the events from seq 0 — never by POSTing a
  // fresh run. A stale (404) or expired store resets cleanly to idle.
  useEffect(() => {
    if (accountRef.current !== accountId) return;
    if (restoreAttemptedRef.current === accountId) return;
    restoreAttemptedRef.current = accountId;
    const record = readStoredCoachResume();
    if (record === null) return;
    if (record.accountId !== accountId) {
      clearStoredCoachResume();
      return;
    }
    const gen = ++generationRef.current;
    attemptRef.current += 1;
    terminatedRef.current = false;
    cancelRequestedRef.current = false;
    lastConsumedRef.current = -1;
    runIdRef.current = null;
    sessionIdRef.current = null;
    beginPhase("preparing");
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        if (!client.isBootstrapped) await client.bootstrap();
        if (cancelled || generationRef.current !== gen) return;
        // Ownership is verified server-side: a cross-account session read is
        // SESSION_NOT_FOUND (never returned). The public session contract is
        // id-only, so no client-side accountId check exists here.
        const session = await client.readSession(record.sessionId);
        if (cancelled || generationRef.current !== gen) return;
        const read = await client.readRun(record.runId);
        if (cancelled || generationRef.current !== gen) return;
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
        sessionIdRef.current = session.id;
        runIdRef.current = read.run.id;
        // Restore the source/scope metadata the refreshed result came from.
        setSnapshot(read.run.snapshot);
        beginPhase("streaming");
        attachStream(gen, session.id, read.run.id, 0);
      } catch (caught) {
        if (cancelled || generationRef.current !== gen) return;
        // Never leave a broken resume behind: clear and reset to idle. A
        // network/auth failure is surfaced honestly; a missing/expired run is
        // a clean reset (the store was restarted or the run aged out).
        clearStoredCoachResume();
        sessionIdRef.current = null;
        runIdRef.current = null;
        lastConsumedRef.current = -1;
        beginPhase("idle");
        if (!isStaleResumeError(caught)) setError(friendlyCoachError(caught));
      }
    })();
    return () => {
      cancelled = true;
      // Allow a StrictMode remount (or a genuine account change) to retry the
      // once-per-identity restore instead of being blocked by the reset guard.
      if (restoreAttemptedRef.current === accountId) restoreAttemptedRef.current = undefined;
    };
  }, [accountId, attachStream, beginPhase, client]);

  // Unmount (ordinary navigation, refresh, or logout) detaches the stream,
  // bumps the generation/attempt so every pending bootstrap/restore/submit
  // callback is rejected, and forgets the in-memory capability. The persisted
  // resume ids, the server-side run, AND the shell-owned logout teardown are
  // deliberately KEPT so a return or refresh restores progress, and a later
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

  return {
    phase,
    isRunning: phase === "preparing" || phase === "streaming" || phase === "cancelling",
    snapshot,
    text,
    tools,
    analyses,
    runError,
    terminal,
    error,
    canReconnect,
    canReloadFromStart,
    // Ambiguous-submit retry only: a run that reached the stream must
    // reconnect (or reload from retention), never resubmit (item 5). Never
    // offered after cancellation — the run is resolved, not ambiguous.
    canRetrySubmit:
      pendingRetryRef.current !== null && phase === "failed" && runIdRef.current === null,
    hasRun: runIdRef.current !== null,
    submit,
    retrySubmit,
    reconnect,
    reloadFromStart,
    cancel,
    newAnalysis,
  };
}

export type UseCoachResult = ReturnType<typeof useCoach>;
