import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { filterRecords } from "@agent-fit-trace/core";
import type { CoachingBackendId } from "@agent-fit-trace/api-contracts";
import { runtimePiAvailable } from "../api/runtimeMode.ts";
import { AnalysisView } from "../components/AnalysisView.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useCoach } from "../coaching/useCoach.ts";
import { isCloudBackend } from "../coaching/coachBackend.ts";
import { useI18n } from "../i18n/useI18n.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { useCloudConversations } from "../coaching/useCloudConversations.ts";

export function CoachScreen() {
  const { t } = useI18n();
  const { user, getAccessToken } = useAuth();
  const { records, status: historyStatus, loadError, reload } = useWorkouts();
  const coach = useCoach();
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState<{ accountId: string | undefined; text: string } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const cloudSelected = (coach.activeBackend ?? coach.selectedBackend ?? (coach.runConversationId === null ? null : "cloud-default")) === "cloud-default";
  const conversationsEnabled = cloudSelected && user?.isAnonymous === false;
  const conversations = useCloudConversations(user?.id ?? null, conversationsEnabled, getAccessToken);
  const submitting = useRef(false);
  // One-shot guard for restoring a run's server-verified conversation. It is
  // keyed by account and dropped whenever the conversation store is disabled:
  // switching to a local backend clears the selection and messages, so a guard
  // that survived would let the switch back show the completed run's answer
  // with no conversation selected, and a follow-up would start a NEW
  // conversation without the history the user is looking at.
  const attemptedResume = useRef<{ accountId: string; id: string } | null>(null);

  useEffect(() => {
    if (!conversationsEnabled) attemptedResume.current = null;
  }, [conversationsEnabled]);
  useEffect(() => {
    const id = coach.runConversationId;
    if (!conversationsEnabled || id === null || !conversations.initialized || conversations.loading) return;
    const accountId = user?.id ?? "none";
    if (attemptedResume.current?.accountId === accountId && attemptedResume.current.id === id) return;
    attemptedResume.current = { accountId, id };
    if (conversations.selectedId !== id) void conversations.select(id);
  }, [coach.runConversationId, conversationsEnabled, user?.id, conversations.initialized, conversations.loading, conversations.selectedId, conversations.select]);

  useEffect(() => {
    if (coach.phase === "done" && cloudSelected) void conversations.refresh();
  }, [coach.phase, cloudSelected, conversations.refresh]);

  // The run's own backend wins for disclosure while one is pinned; otherwise
  // show what the NEXT run would use. Backend availability is per-option:
  // a missing pi CLI must never disable an available cloud/Codex/OpenCode
  // backend.
  const disclosedBackend: CoachingBackendId | null = coach.activeBackend ?? coach.selectedBackend;
  const disclosedOption =
    coach.backends.find((option) => option.id === disclosedBackend) ?? null;
  const disclosedLabel = disclosedOption?.label ?? disclosedBackend;
  const disclosedLocation =
    disclosedOption?.location ??
    (disclosedBackend === null ? null : isCloudBackend(disclosedBackend) ? "cloud" : "local");
  // piAvailable === false means the launcher published a presence probe that
  // found no pi CLI. Scope that to the local pi backend actually in use: the
  // cloud and other local runtimes stay selectable when they are available.
  const piUnavailable = disclosedBackend === "local-pi" && runtimePiAvailable() === false;
  // The notice text must use the SERVER's reason when there is one. A packaged
  // build whose extension is missing reports that path; telling the user to
  // "install pi" would send them to fix something that is already installed.
  const piUnavailableMessage =
    disclosedOption?.available === false && disclosedOption.unavailableReason?.message !== undefined
      ? disclosedOption.unavailableReason.message
      : "pi is not installed on this machine, so the local pi coach cannot run. Select an available cloud or other local backend, install pi, or keep using workout logging and history.";
  const backendLocked = coach.isBackendPinned || coach.isRunning;

  const historyEmpty = historyStatus === "ready" && records.length === 0;

  // A snapshot is stale only when the history that MATCHES its own date scope
  // changed — never merely because a filtered range holds fewer records than
  // the whole history. Compare the snapshot's record-id set against the
  // currently matching ids (order-independent).
  const snapshot = coach.snapshot;
  const snapshotStale = useMemo(() => {
    if (snapshot === null || historyStatus !== "ready") return false;
    const scoped = filterRecords([...records], { from: snapshot.from, to: snapshot.to });
    const currentIds = new Set(scoped.map((record) => record.id));
    if (snapshot.recordIds.length !== currentIds.size) return true;
    return snapshot.recordIds.some((id) => !currentIds.has(id));
  }, [snapshot, records, historyStatus]);

  const rangeEmpty = snapshot !== null && snapshot.recordCount === 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (piUnavailable || !coach.canAsk || coach.isRunning || question.trim() === "" || submitting.current || conversations.loading) return;
    submitting.current = true;
    try {
      const conversationId = cloudSelected ? conversations.selectedId ?? await conversations.create() : null;
      if (cloudSelected && conversationId === null) return;
      setSubmittedQuestion({ accountId: user?.id, text: question.trim() });
      void coach.submit({ question, from, to, ...(conversationId === null ? {} : { conversationId }) });
    } finally {
      submitting.current = false;
    }
  }

  return (
    <section data-screen="coach">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>{t("Coach")}</h1>
        </div>
        {/* The backend choice lives in settings, not here: it is a
            configuration decision, and the page that shows which CLIs are
            installed belongs beside it. This link is the discovery path for it —
            without one the settings route would be unreachable. */}
        <Link to="/coach/settings" data-testid="coach-settings-link">
          {t("Coach settings")}
        </Link>
      </div>

      {coach.mode === "browser" && coach.isGuest && (
        <div
          role="note"
          data-testid="coach-guest-local"
          className="validation-warnings"
        >
          {t("Guests can use their own local coach only: install pi, then run")}{" "}
          <code>agent-fit-trace start</code>{t(" from this machine. Cloud coaching requires a formal account.")}
        </div>
      )}

      {coach.mode !== "inactive" && (
        <div className="field coach-backend">
          <label htmlFor="coach-backend">{t("Coach backend")}</label>
          {coach.backends.length === 0 ? (
            <p className="coach-meta" data-testid="coach-no-backends">
              {t("No coach backend is available in this session.")}
            </p>
          ) : (
            <select
              id="coach-backend"
              data-testid="coach-backend-select"
              value={coach.selectedBackend ?? ""}
              disabled={backendLocked}
              onChange={(event) =>
                coach.selectBackend(event.currentTarget.value as CoachingBackendId)
              }
            >
              {coach.selectedBackend === null && (
                <option value="" disabled>
                  {t("Select a backend")}
                </option>
              )}
              {coach.backends.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.available
                    ? option.label
                    : option.unavailableReason === undefined
                      ? t("{label} — unavailable", { label: option.label })
                      : t("{label} — unavailable: {reason}", {
                          label: option.label,
                          reason: option.unavailableReason.message,
                        })}
                </option>
              ))}
            </select>
          )}
          {coach.activeBackend !== null && (
            <p className="coach-meta" data-testid="coach-active-backend">
              {t(
                "{backend} · active",
                { backend: disclosedLabel ?? coach.activeBackend },
              )}
            </p>
          )}
        </div>
      )}

      {coach.backendNotice !== null && !(coach.mode === "browser" && coach.isGuest) && (!coach.canAsk || coach.canRetryBackendDiscovery) && (
        <>
          <p role="note" data-testid="coach-backend-notice" className="coach-meta">
            {coach.backendNotice}
          </p>
          {coach.canRetryBackendDiscovery && (
            <button
              type="button"
              data-testid="coach-retry-backend-discovery"
              onClick={coach.retryBackendDiscovery}
            >
              {t("Retry availability")}
            </button>
          )}
        </>
      )}

      {disclosedBackend !== null && disclosedLocation !== null && (
        <p
          className="coach-disclosure"
          data-testid={
            disclosedLocation === "cloud" ? "coach-cloud-disclosure" : "coach-local-disclosure"
          }
        >
          {disclosedLocation === "cloud"
            ? t(
                "Hosted cloud coaching uses credits and sends your question and workout data to the provider.",
              )
            : t(
                "{backend} runs locally. Your question and workout data are sent to its model provider.",
                { backend: disclosedLabel ?? disclosedBackend },
              )}
        </p>
      )}

      {coach.blockedResume !== null && (
        <div role="alert" data-testid="coach-resume-blocked" className="validation-warnings">
          {coach.blockedResume.message}
        </div>
      )}

      {piUnavailable && (
        <div role="alert" data-testid="coach-pi-unavailable" className="validation-warnings">
          {t(piUnavailableMessage)}
        </div>
      )}

          {cloudSelected && user?.isAnonymous === false && (
            <div className="coach-history" aria-label={t("Conversation history")}>
              <div className="coach-history-heading">
                <h2>{t("Conversations")}</h2>
                <button type="button" disabled={coach.isRunning || conversations.loading} onClick={() => { coach.newAnalysis(); setSubmittedQuestion(null); void conversations.create(); }}>
                  {t("New conversation")}
                </button>
              </div>
              {conversations.conversations.length > 0 && (
                <select aria-label={t("Select conversation")} value={conversations.selectedId ?? ""} disabled={coach.isRunning || conversations.loading} onChange={(event) => {
                  if (event.currentTarget.value) {
                    coach.newAnalysis();
                    setSubmittedQuestion(null);
                    void conversations.select(event.currentTarget.value);
                  }
                }}>
                  <option value="">{t("Select conversation")}</option>
                  {conversations.conversations.map((item) => <option key={item.id} value={item.id}>{new Date(item.updatedAt).toLocaleString()}</option>)}
                </select>
              )}
              {conversations.selectedId !== null && (
                <button type="button" disabled={coach.isRunning || conversations.loading} onClick={() => {
                  if (window.confirm(t("Delete this conversation and its messages?"))) {
                    void conversations.remove().then((removed) => {
                      if (removed) {
                        coach.newAnalysis();
                        setSubmittedQuestion(null);
                      }
                    });
                  }
                }}>{t("Delete conversation")}</button>
              )}
              {conversations.error !== null && (
                <button type="button" disabled={conversations.loading} onClick={() => void conversations.reloadList()}>{t("Retry")}</button>
              )}
              {conversations.loading && <p role="status">{t("Loading conversations…")}</p>}
              {conversations.error !== null && <p role="alert">{conversations.error}</p>}
            </div>
          )}
      {cloudSelected && conversations.messages.length > 0 && (
        <div className="coach-conversation" aria-label={t("Conversation history")}>
          {conversations.messages.map((message) => (
            <div key={message.id} className={`coach-message ${message.role === "user" ? "coach-message-user" : "coach-message-answer"}`}>
              <span className="coach-message-label">{message.role === "user" ? t("You") : t("Coach")}</span>
              <p>{message.content}</p>
            </div>
          ))}
        </div>
      )}

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>
            {t("Could not load workout history: {error}", {
              error: loadError?.message ?? t("Unknown error."),
            })}
          </p>
          <button type="button" onClick={reload}>
            {t("Retry")}
          </button>
        </div>
      ) : historyStatus === "loading" ? (
        <p role="status">{t("Loading workout history…")}</p>
      ) : historyEmpty && coach.snapshot === null ? (
        <div className="empty-state">
          <p>{t("No workout history to analyse yet.")}</p>
          <Link to="/workout/new">{t("Log your first workout")}</Link>
        </div>
      ) : (
        <>
          <p data-testid="coach-history-count" className="coach-screen-reader-only">
            {t("{count} workout(s) in history.", { count: records.length })}
          </p>

          <div className="coach-conversation" aria-label={t("Coach conversation")}>

            {submittedQuestion !== null && submittedQuestion.accountId === user?.id && (!cloudSelected || coach.isRunning || coach.phase !== "done" || !conversations.messages.some((message) => message.role === "user" && message.content === submittedQuestion.text)) && (
              <div className="coach-message coach-message-user">
                <span className="coach-message-label">{t("You")}</span>
                <p>{submittedQuestion.text}</p>
              </div>
            )}

          {snapshot !== null && (
            <details className="coach-source-details">
            <summary>{t("Analysis details")}</summary>
            <p data-testid="coach-source" className="coach-meta">
              {t("Snapshot {id}: {source} · {count} record(s){range}", {
                id: snapshot.snapshotId,
                source: snapshot.source,
                count: snapshot.recordCount,
                range:
                  snapshot.from !== undefined || snapshot.to !== undefined
                    ? ` · ${snapshot.from ?? "…"} – ${snapshot.to ?? "…"}`
                    : "",
              })}
            </p>
            </details>
          )}

          {rangeEmpty && (
            <div className="empty-state" data-testid="coach-range-empty">
              <p>{t("No workouts in the selected range. Record a workout for this period first.")}</p>
              <Link to="/workout/new">{t("Log a workout")}</Link>
            </div>
          )}

          {snapshotStale && snapshot !== null && (
            <div className="validation-warnings" role="note" data-testid="coach-stale">
              {t(
                "Workout history changed since snapshot {id} ({count} records then). Results below reflect the earlier snapshot, not the current history.",
                { id: snapshot.snapshotId, count: snapshot.recordCount },
              )}
            </div>
          )}

          {(coach.phase === "streaming" || coach.phase === "preparing") && (
            <p role="status">{t("Coach is working…")}</p>
          )}
          {coach.phase === "cancelling" && <p role="status">{t("Cancelling coach run…")}</p>}

          {coach.tools.length > 0 && (
            <details className="coach-activity" aria-label={t("Coach activity")}>
              <summary>{t("Activity")}</summary>
              <ul className="coach-tools">
                {coach.tools.map((activity) => (
                  <li key={activity.callId}>
                    {activity.phase === "started"
                      ? t("Running {tool}…", { tool: activity.tool })
                      : activity.phase === "ok"
                        ? activity.summary
                          ? t("Finished {tool}: {summary}", {
                              tool: activity.tool,
                              summary: activity.summary,
                            })
                          : t("Finished {tool}", { tool: activity.tool })
                        : t("Tool {tool} failed: {error}", {
                            tool: activity.tool,
                            error: activity.error ?? t("unknown error"),
                          })}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {coach.text !== "" && (!cloudSelected || !conversations.messages.some((message) => message.role === "assistant" && message.content === coach.text)) && (
            <section className="coach-message coach-message-answer" aria-label={t("Coach answer")}>
              <h2>{t("Answer")}</h2>
              <pre className="coach-text" data-testid="coach-text">
                {coach.text}
              </pre>
            </section>
          )}

          {coach.runError !== null && (
            <div role="alert" data-testid="coach-run-error" className="validation-warnings">
              {t("Coach tool reported {code}: {message}", {
                code: coach.runError.code,
                message: coach.runError.message,
              })}
            </div>
          )}

          {coach.analyses.map((analysis, index) => (
            <section key={index} aria-label={index === 0 ? t("Coach analysis") : t("Coach analysis {number}", { number: index + 1 })}>
              <AnalysisView analysis={analysis} />
            </section>
          ))}

          {coach.phase === "cancelled" && (
            <div role="status" data-testid="coach-cancelled" className="validation-warnings">
              <p>{t("Coach run cancelled. Partial output above is frozen.")}</p>
              <button type="button" onClick={coach.newAnalysis}>
                {t("New analysis")}
              </button>
            </div>
          )}

          {coach.phase === "unconfirmed" && (
            <div role="alert" data-testid="coach-cancel-unconfirmed" className="validation-warnings">
              <p>
                {t(
                  "Cancellation unconfirmed — the submit may already have been accepted by the server, so no run is claimed cancelled yet.",
                )}
              </p>
              <p>{t("Resolve it with the same request key, then cancel; a fresh analysis would abandon it.")}</p>
              <button type="button" onClick={() => void coach.retrySubmit()}>
                {t("Resolve cancellation")}
              </button>
            </div>
          )}

          {coach.error !== null && (
            <div role="alert" data-testid="coach-error" className="validation-summary">
              <p>{coach.error}</p>
              <div className="plan-actions">
                {coach.canRetrySubmit && (
                  <button type="button" onClick={() => void coach.retrySubmit()}>
                    {t("Retry")}
                  </button>
                )}
                {coach.canReconnect && (
                  <button type="button" onClick={coach.reconnect}>
                    {t("Reconnect")}
                  </button>
                )}
                {coach.canRetryRestore && (
                  <button type="button" onClick={coach.retryRestore}>
                    {t("Retry restore")}
                  </button>
                )}
                {coach.canReloadFromStart && (
                  <button type="button" onClick={coach.reloadFromStart}>
                    {t("Reload from earliest events")}
                  </button>
                )}
                {!coach.isRunning &&
                  (coach.phase === "done" || coach.phase === "failed" || coach.phase === "cancelled") && (
                    <button type="button" onClick={coach.newAnalysis}>
                      {t("New analysis")}
                    </button>
                  )}
              </div>
            </div>
          )}

          {(coach.phase === "done" || coach.phase === "failed") && !coach.isRunning && coach.error === null && (
            <div className="plan-actions">
              <button type="button" onClick={coach.newAnalysis}>
                {t("New analysis")}
              </button>
            </div>
          )}
          </div>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="coach-question">{t("Analysis question")}</label>
              <textarea
                id="coach-question"
                value={question}
                onChange={(event) => setQuestion(event.currentTarget.value)}
                placeholder={t("How is my squat progressing?")}
                disabled={coach.isRunning || piUnavailable}
              />
            </div>
            <details className="coach-range">
              <summary>{t("Date range")}</summary>
              <div className="coach-range-fields">
            <div className="field">
              <label htmlFor="coach-from">{t("From (optional)")}</label>
              <input
                id="coach-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.currentTarget.value)}
                disabled={coach.isRunning || piUnavailable}
              />
            </div>
            <div className="field">
              <label htmlFor="coach-to">{t("To (optional)")}</label>
              <input
                id="coach-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.currentTarget.value)}
                disabled={coach.isRunning || piUnavailable}
              />
            </div>
              </div>
            </details>
            <button
              type="submit"
              disabled={
                coach.isRunning ||
                piUnavailable ||
                !coach.canAsk ||
                question.trim() === "" ||
                (cloudSelected && conversations.loading)
              }
            >
              {coach.phase === "preparing" || coach.phase === "streaming" || coach.phase === "cancelling"
                ? t("Coach is working…")
                : t("Ask coach")}
            </button>{" "}
            {coach.canCancel && (
              <button type="button" onClick={() => void coach.cancel()}>
                {coach.phase === "cancelling" ? t("Cancelling…") : t("Cancel")}
              </button>
            )}
          </form>

        </>
      )}
    </section>
  );
}
