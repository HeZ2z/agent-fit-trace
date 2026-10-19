import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useAuth } from "@/auth";
import {
  CoachError,
  MobileCloudCoachClient,
  applyCoachEvent,
  coachErrorMessage,
  coachResumeFromSeq,
  createCoachChatState,
  isCoachError,
  readCoachConfig,
  type CoachChatState,
  type CoachStatusEntry,
  type CoachSubscription,
} from "@/coach";
import {
  COACH_PROMPT_MAX_LENGTH,
  INITIAL_COACH_TURN_STATE,
  canCancelCoachTurn,
  canStartCoachTurn,
  cancelCoachTurnBeforeRun,
  clearCoachTurnCancel,
  coachActivityMessage,
  coachErrorCopy,
  coachPromptIssueMessage,
  coachStatusMessage,
  coachTurnCancelPlan,
  completeCoachTurn,
  failCoachTurn,
  isCoachTurnActive,
  markCoachRunStarted,
  rememberCoachSession,
  requestCoachTurnCancel,
  resetCoachTurn,
  resolveCoachGate,
  startCoachTurn,
  validateCoachPrompt,
  type CoachErrorCopy,
  type CoachTurnState,
} from "@/coach/coachScreenModel";
import { useI18n } from "@/i18n";
import { SPACING } from "@/theme";
import { Banner, Body, Button, Card, Display, Field, Kicker, Screen, Title } from "@/ui";

/**
 * Coach tab: hosted cloud coaching for a verified signed-in account.
 *
 * Everything network-visible lives behind the `ready` gate. The screen owns
 * one reusable coaching session and one active turn: it lazily creates the
 * session, materializes a fresh read-only snapshot of the account for every
 * ask (mirroring the web flow), submits exactly one run with a stable
 * idempotency key, and folds the replay-only SSE stream into the transport
 * reducer. A cancel sends the explicit server cancel; a detach alone never
 * cancels a run. Mobile never starts a local CLI agent.
 */

const copy = {
  kicker: "COACH",
  title: "Coach",
  lede: "Ask about training, review the evidence, and shape the next block with a coach.",
  unconfiguredTitle: "Cloud coach is not configured",
  signedOutMessage:
    "Sign in to start a hosted cloud coaching conversation. Mobile coaching always runs in the cloud; the local CLI coach stays on desktop.",
  disclosure:
    "The coach runs in the hosted cloud and reads a read-only snapshot of your account.",
  signIn: "Sign in",
  questionLabel: "Your question",
  placeholder: "How is my squat progressing?",
  send: "Send",
  cancel: "Cancel",
  newConversation: "New conversation",
  answer: "Answer",
  activity: "Coach activity",
  emptyHistory: "No workouts to analyse yet. Log a workout first, then ask the coach.",
  streamEnded: "The coaching stream ended before the run finished. Cancel the run to resolve it.",
  runError:
    "The coaching run reported an error. Start a new conversation to try again.",
};

type CoachSubmitInput = Parameters<MobileCloudCoachClient["submitRun"]>[0];

interface PendingSubmit {
  /** The exact input whose POST may already have reached the server. */
  readonly input: CoachSubmitInput;
  readonly prompt: string;
}

function newIdempotencyKey(): string {
  try {
    const keyed = globalThis.crypto as unknown as { randomUUID?: () => string };
    if (typeof keyed.randomUUID === "function") return keyed.randomUUID();
  } catch {
    // Fall through to the counter fallback below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export default function CoachScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const { status: authStatus, user, getAccessToken } = useAuth();
  const [config] = useState(readCoachConfig);
  const gate = resolveCoachGate({ authStatus, coachConfigured: config.configured });
  const client = useMemo(
    () => new MobileCloudCoachClient({ config, getAccessToken }),
    [config, getAccessToken],
  );

  const [turn, setTurnState] = useState<CoachTurnState>(INITIAL_COACH_TURN_STATE);
  const turnRef = useRef<CoachTurnState>(INITIAL_COACH_TURN_STATE);
  const [chat, setChatState] = useState<CoachChatState>(() => createCoachChatState(""));
  const chatRef = useRef<CoachChatState>(chat);
  /** Finished turns kept only for display; the current turn streams in `chat`. */
  const [history, setHistory] = useState<readonly CoachChatState[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<CoachErrorCopy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const subscriptionRef = useRef<CoachSubscription | null>(null);
  /** Invalidates every async continuation on cancel/account change/unmount. */
  const generationRef = useRef(0);
  /** The lazily created coaching session, reused for later asks. */
  const sessionIdRef = useRef<string | null>(null);
  const submitDispatchedRef = useRef(false);
  /** A submit whose outcome was ambiguous; only an explicit same-prompt retry reuses it. */
  const pendingSubmitRef = useRef<PendingSubmit | null>(null);
  const cancelInflightRef = useRef(false);

  const updateTurn = useCallback((next: CoachTurnState): void => {
    turnRef.current = next;
    setTurnState(next);
  }, []);

  const updateChat = useCallback((next: CoachChatState): void => {
    chatRef.current = next;
    setChatState(next);
  }, []);

  const restoreQuestionToDraft = useCallback(
    (question: string): void => {
      updateChat(createCoachChatState(""));
      setDraft(question);
    },
    [updateChat],
  );

  const attachStream = useCallback(
    (generation: number, sessionId: string, runId: string, fromSeq: number): void => {
      subscriptionRef.current?.close();
      const subscription = client.subscribeRunEvents(
        { sessionId, runId, fromSeq },
        (envelope) => {
          if (generationRef.current !== generation) return;
          if (turnRef.current.runId !== runId) return;
          const result = applyCoachEvent(chatRef.current, envelope);
          // The client already guarantees a contiguous, identity-checked
          // stream; a gap/duplicate/terminal-frozen fold is ignored rather
          // than weakening the transcript.
          if (result.status !== "applied") return;
          updateChat(result.state);
          if (envelope.event.type === "terminal") {
            updateTurn(completeCoachTurn(turnRef.current, envelope.event.status));
            subscriptionRef.current = null;
          }
        },
      );
      subscriptionRef.current = subscription;
      void subscription.done.then(
        (result) => {
          if (subscriptionRef.current === subscription) subscriptionRef.current = null;
          if (generationRef.current !== generation) return;
          if (turnRef.current.runId !== runId) return;
          if (chatRef.current.terminal !== null) return;
          if (result.aborted) return;
          // No terminal envelope: this is a disconnect, never a completion.
          // Keep the run id so the explicit Cancel action stays available.
          const streamError = coachErrorCopy(new CoachError("timeout"));
          if (streamError !== null) {
            setError({ ...streamError, source: copy.streamEnded });
          }
        },
        (cause: unknown) => {
          if (subscriptionRef.current === subscription) subscriptionRef.current = null;
          if (generationRef.current !== generation) return;
          if (turnRef.current.runId !== runId) return;
          if (chatRef.current.terminal !== null) return;
          const streamError = coachErrorCopy(cause);
          if (streamError !== null) setError(streamError);
        },
      );
    },
    [client, updateChat, updateTurn],
  );

  /**
   * Re-open the tail from the last folded seq so a server cancel can deliver
   * its terminal. Never repeats the run POST.
   */
  const reattachStream = useCallback(
    (generation: number, runId: string): void => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null || subscriptionRef.current !== null) return;
      if (chatRef.current.terminal !== null) return;
      if (generationRef.current !== generation) return;
      attachStream(generation, sessionId, runId, coachResumeFromSeq(chatRef.current));
    },
    [attachStream],
  );

  /**
   * One explicit attempt for one ask: reusable session -> fresh snapshot ->
   * ONE idempotent submit -> stream. The only auto-retry is a stream page
   * resume inside the client; the POST itself is never retried here.
   */
  const runTurn = useCallback(
    async (generation: number, question: string): Promise<void> => {
      let dispatched = false;
      let submitInput: CoachSubmitInput | null = null;
      try {
        const pending = pendingSubmitRef.current;
        let input: CoachSubmitInput;

        if (pending !== null && pending.prompt === question) {
          // Explicit retry of an ambiguous POST: same key, session and
          // snapshot, exactly as the server's idempotency contract expects.
          input = pending.input;
          submitInput = input;
          sessionIdRef.current = input.sessionId;
          updateTurn(rememberCoachSession(turnRef.current, input.sessionId));
        } else {
          if (pending !== null) pendingSubmitRef.current = null;
          let sessionId = sessionIdRef.current;
          if (sessionId === null) {
            const created = await client.createSession();
            if (generationRef.current !== generation) return;
            sessionId = created.id;
            sessionIdRef.current = sessionId;
            updateTurn(rememberCoachSession(turnRef.current, sessionId));
          }

          // A cancel that landed during setup, before any POST, is a local
          // cancellation: no run can exist yet.
          if (turnRef.current.cancelRequested) {
            generationRef.current += 1;
            restoreQuestionToDraft(question);
            updateTurn(cancelCoachTurnBeforeRun(turnRef.current));
            return;
          }

          const snapshot = await client.createSnapshot();
          if (generationRef.current !== generation) return;
          if (turnRef.current.cancelRequested) {
            generationRef.current += 1;
            restoreQuestionToDraft(question);
            updateTurn(cancelCoachTurnBeforeRun(turnRef.current));
            return;
          }
          if (snapshot.recordCount === 0) {
            restoreQuestionToDraft(question);
            updateTurn(failCoachTurn(turnRef.current));
            setNotice(copy.emptyHistory);
            return;
          }

          input = {
            sessionId,
            prompt: question,
            idempotencyKey: newIdempotencyKey(),
            snapshot: {
              snapshotId: snapshot.snapshotId,
              source: snapshot.source,
              accountId: snapshot.accountId,
            },
          };
          submitInput = input;
        }

        if (turnRef.current.cancelRequested) {
          generationRef.current += 1;
          restoreQuestionToDraft(question);
          updateTurn(cancelCoachTurnBeforeRun(turnRef.current));
          return;
        }

        dispatched = true;
        submitDispatchedRef.current = true;
        const submitted = await client.submitRun(input);
        if (generationRef.current !== generation) return;
        dispatched = false;
        submitDispatchedRef.current = false;
        pendingSubmitRef.current = null;

        const runId = submitted.run.id;
        updateTurn(markCoachRunStarted(turnRef.current, runId));
        if (turnRef.current.cancelRequested) {
          // Cancel won the race with the submit: address the created run
          // explicitly, then let the attached stream fold its terminal.
          try {
            await client.cancelRun(runId);
          } catch (cause) {
            if (generationRef.current !== generation) return;
            const cancelError = coachErrorCopy(cause);
            if (cancelError !== null) setError(cancelError);
            // The run is still live: do not keep showing "cancelling" after a
            // failed explicit cancel. The stream stays attached for its verdict.
            updateTurn(clearCoachTurnCancel(turnRef.current));
          }
          if (generationRef.current !== generation) return;
        }
        attachStream(generation, input.sessionId, runId, 0);
      } catch (cause) {
        if (generationRef.current !== generation) return;
        dispatched = false;
        submitDispatchedRef.current = false;
        const caught = coachErrorCopy(cause);
        if (caught !== null) setError(caught);
        if (turnRef.current.phase === "creating") {
          restoreQuestionToDraft(question);
        }
        updateTurn(failCoachTurn(turnRef.current));

        // Hold the stable key ONLY for a retryable failure of a POST that was
        // actually dispatched. An explicit same-prompt Send reuses it; any
        // edit starts a fresh key. Definite refusals release it.
        if (
          dispatched &&
          submitInput !== null &&
          isCoachError(cause) &&
          cause.retryable
        ) {
          pendingSubmitRef.current = { input: submitInput, prompt: question };
        } else {
          pendingSubmitRef.current = null;
        }
        if (isCoachError(cause) && cause.code === "not-found") {
          sessionIdRef.current = null;
        }
      }
    },
    [attachStream, client, restoreQuestionToDraft, updateTurn],
  );

  const beginTurn = useCallback(
    (question: string): void => {
      if (gate !== "ready") return;
      const previousTurn = turnRef.current;
      if (!canStartCoachTurn(previousTurn)) return;

      const previousChat = chatRef.current;
      if (
        previousChat.question !== "" &&
        (previousTurn.phase === "terminal" || previousTurn.phase === "cancelled")
      ) {
        setHistory((entries) => [...entries, previousChat]);
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      submitDispatchedRef.current = false;
      cancelInflightRef.current = false;
      setError(null);
      setNotice(null);
      setDraft("");
      updateTurn(startCoachTurn({ ...previousTurn, sessionId: sessionIdRef.current }));
      updateChat(createCoachChatState(question));
      void runTurn(generation, question);
    },
    [gate, runTurn, updateChat, updateTurn],
  );

  const handleSend = useCallback((): void => {
    if (gate !== "ready") return;
    const validation = validateCoachPrompt(draft);
    if (!validation.ok) return;
    beginTurn(validation.prompt);
  }, [beginTurn, draft, gate]);

  const handleCancel = useCallback(async (): Promise<void> => {
    const state = turnRef.current;
    if (!canCancelCoachTurn(state)) return;
    const plan = coachTurnCancelPlan(state, {
      terminal: chatRef.current.terminal,
      streamActive: subscriptionRef.current !== null,
    });

    if (!plan.postCancel) {
      if (plan.abortStream) {
        subscriptionRef.current?.close();
        subscriptionRef.current = null;
      }
      if (state.phase !== "creating") return;
      if (submitDispatchedRef.current) {
        // The POST may already be accepted; do not claim a local cancel. The
        // submit continuation cancels the actual run once it resolves.
        updateTurn(requestCoachTurnCancel(state));
        return;
      }
      // No run can exist yet: this is the one honest local cancellation.
      generationRef.current += 1;
      submitDispatchedRef.current = false;
      restoreQuestionToDraft(chatRef.current.question);
      updateTurn(cancelCoachTurnBeforeRun(requestCoachTurnCancel(state)));
      setError(null);
      return;
    }

    const runId = state.runId;
    if (runId === null) return;
    updateTurn(requestCoachTurnCancel(state));
    if (cancelInflightRef.current) return;
    cancelInflightRef.current = true;
    setError(null);
    const generation = generationRef.current;
    // The plan asks for an explicit server cancel. Detach the current tail and
    // re-open from the last folded seq afterwards so the server terminal that
    // confirms the cancellation is still observed (a detach alone would not
    // cancel anything, and never count as the verdict).
    if (plan.abortStream) {
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
    }
    try {
      await client.cancelRun(runId);
    } catch (cause) {
      if (generationRef.current !== generation) return;
      const cancelError = coachErrorCopy(cause);
      if (cancelError !== null) setError(cancelError);
      if (turnRef.current.runId === runId && chatRef.current.terminal === null) {
        updateTurn(clearCoachTurnCancel(turnRef.current));
      }
    } finally {
      cancelInflightRef.current = false;
      if (generationRef.current === generation && turnRef.current.runId === runId) {
        reattachStream(generation, runId);
      }
    }
  }, [client, reattachStream, restoreQuestionToDraft, updateTurn]);

  const handleNewConversation = useCallback((): void => {
    const previousTurn = turnRef.current;
    if (!canStartCoachTurn(previousTurn)) return;
    const previousChat = chatRef.current;
    if (
      previousChat.question !== "" &&
      (previousTurn.phase === "terminal" || previousTurn.phase === "cancelled")
    ) {
      setHistory((entries) => [...entries, previousChat]);
    }
    updateChat(createCoachChatState(""));
    updateTurn(resetCoachTurn(previousTurn));
    setError(null);
    setNotice(null);
    setDraft("");
    pendingSubmitRef.current = null;
  }, [updateChat, updateTurn]);

  // Sign-out / account switch / auth restore must never keep the previous
  // account's session, transcript, token-bound async work or stream alive.
  useEffect(() => {
    generationRef.current += 1;
    subscriptionRef.current?.close();
    subscriptionRef.current = null;
    sessionIdRef.current = null;
    submitDispatchedRef.current = false;
    pendingSubmitRef.current = null;
    cancelInflightRef.current = false;
    const freshChat = createCoachChatState("");
    chatRef.current = freshChat;
    setChatState(freshChat);
    turnRef.current = INITIAL_COACH_TURN_STATE;
    setTurnState(INITIAL_COACH_TURN_STATE);
    setHistory([]);
    setDraft("");
    setError(null);
    setNotice(null);
  }, [authStatus, user?.id]);

  // Unmount (or a tab remount) detaches the stream; it never cancels a run.
  useEffect(
    () => () => {
      generationRef.current += 1;
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
    },
    [],
  );

  const busy = isCoachTurnActive(turn);
  const promptValidation = validateCoachPrompt(draft);
  const canSend = gate === "ready" && !busy && promptValidation.ok;
  const promptIssue =
    draft.trim() !== "" && !promptValidation.ok ? promptValidation.issue : null;
  const finished = turn.phase === "terminal" || turn.phase === "cancelled";
  const statusMessage = t(coachStatusMessage(turn, chat));

  return (
    <Screen testID="screen-coach">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>

      {gate === "unconfigured" ? (
        <Card testID="coach-unconfigured">
          <Title>{t(copy.unconfiguredTitle)}</Title>
          <Body>{t(coachErrorMessage("unconfigured"))}</Body>
        </Card>
      ) : gate === "loading" ? (
        <Body accessibilityLiveRegion="polite" testID="coach-loading">
          {t("Restoring your account…")}
        </Body>
      ) : gate === "signed-out" ? (
        <Card>
          <Title>{t("Cloud coach requires sign-in")}</Title>
          <Body>{t(copy.signedOutMessage)}</Body>
          <Button
            accessibilityLabel={t(copy.signIn)}
            label={t(copy.signIn)}
            onPress={() => router.push("/auth/sign-in")}
            testID="coach-sign-in"
          />
        </Card>
      ) : (
        <>
          <Body>{t(copy.disclosure)}</Body>

          {history.map((past, index) => (
            <Card key={`coach-history-${index}`} testID={`coach-history-${index}`}>
              <Kicker>{t(copy.questionLabel)}</Kicker>
              <Body tone="default">{past.question}</Body>
              {past.assistantText !== "" ? (
                <>
                  <Kicker>{t(copy.answer)}</Kicker>
                  <Body tone="default">{past.assistantText}</Body>
                </>
              ) : null}
            </Card>
          ))}

          {chat.question !== "" ? (
            <Card testID="coach-question">
              <Kicker>{t(copy.questionLabel)}</Kicker>
              <Body tone="default">{chat.question}</Body>
            </Card>
          ) : null}

          <Card>
            <Body
              accessibilityLiveRegion="polite"
              testID="coach-status"
              tone={turn.phase === "terminal" && chat.terminal?.status === "failed" ? "warn" : "default"}>
              {statusMessage}
            </Body>

            {chat.statuses.length > 0 ? (
              <View style={styles.activity}>
                <Title>{t(copy.activity)}</Title>
                {chat.statuses.map((entry) => (
                  <Body key={statusKey(entry)} tone="muted">
                    {t(
                      coachActivityMessage(entry),
                      entry.kind === "tool-start" || entry.kind === "tool-end"
                        ? { tool: entry.tool }
                        : undefined,
                    )}
                  </Body>
                ))}
              </View>
            ) : null}

            {chat.runError !== null ? (
              <Banner message={t(copy.runError)} testID="coach-run-error" tone="warn" />
            ) : null}

            {chat.assistantText !== "" ? (
              <View style={styles.answer}>
                <Kicker>{t(copy.answer)}</Kicker>
                <Body testID="coach-answer" tone="default">
                  {chat.assistantText}
                </Body>
              </View>
            ) : null}

            {error !== null ? (
              <Banner message={t(error.source)} testID="coach-error" tone="danger" />
            ) : null}

            {notice !== null ? (
              <Banner message={t(notice)} testID="coach-notice" tone="info" />
            ) : null}

            {finished ? (
              <Button
                label={t(copy.newConversation)}
                onPress={handleNewConversation}
                testID="coach-new"
                variant="secondary"
              />
            ) : null}
          </Card>

          <Card>
            <Field
              editable={!busy}
              hint={promptIssue !== null ? t(coachPromptIssueMessage(promptIssue)) : undefined}
              inputStyle={styles.input}
              label={t(copy.questionLabel)}
              maxLength={COACH_PROMPT_MAX_LENGTH}
              multiline
              numberOfLines={4}
              onChangeText={setDraft}
              placeholder={t(copy.placeholder)}
              testID="coach-input"
              value={draft}
            />
            <View style={styles.actions}>
              <Button
                accessibilityLabel={t(copy.send)}
                disabled={!canSend}
                label={t(copy.send)}
                onPress={handleSend}
                testID="coach-send"
              />
              {busy ? (
                <Button
                  label={t(copy.cancel)}
                  onPress={() => {
                    void handleCancel();
                  }}
                  testID="coach-cancel"
                  variant="secondary"
                />
              ) : null}
            </View>
          </Card>
        </>
      )}
    </Screen>
  );
}

function statusKey(entry: CoachStatusEntry): string {
  if (entry.kind === "tool-start" || entry.kind === "tool-end") {
    return `${entry.seq}-${entry.kind}-${entry.callId}`;
  }
  return `${entry.seq}-${entry.kind}`;
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING[2],
  },
  activity: { gap: SPACING[1] },
  answer: { gap: SPACING[1] },
  input: {
    minHeight: 96,
    textAlignVertical: "top",
  },
});
