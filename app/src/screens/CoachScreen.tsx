import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { filterRecords } from "@pi-fit-trace/core";
import type { CoachingBackendId } from "@pi-fit-trace/api-contracts";
import { runtimePiAvailable } from "../api/runtimeMode.ts";
import { AnalysisView } from "../components/AnalysisView.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useCoach } from "../coaching/useCoach.ts";
import { isCloudBackend } from "../coaching/coachBackend.ts";

export function CoachScreen() {
  const { records, status: historyStatus, loadError, reload } = useWorkouts();
  const coach = useCoach();
  const [question, setQuestion] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

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

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (piUnavailable || !coach.canAsk) return;
    void coach.submit({ question, from, to });
  }

  return (
    <section>
      <h1>Coach</h1>
      <p className="coach-lede">
        Read-only analysis of your stored workouts. The coach reads a backend-issued snapshot of this
        account and the selected range — your records are never rewritten by a run.
      </p>

      {coach.mode === "browser" && coach.isGuest && (
        <div
          role="note"
          data-testid="coach-guest-local"
          className="validation-warnings"
        >
          Guests can use their own local coach only: install pi, then run{" "}
          <code>agent-fit-trace start</code> from this machine. Cloud coaching requires a formal
          account.
        </div>
      )}

      {coach.mode !== "inactive" && (
        <div className="field coach-backend">
          <label htmlFor="coach-backend">Coach backend</label>
          {coach.backends.length === 0 ? (
            <p className="coach-meta" data-testid="coach-no-backends">
              No coach backend is available in this session.
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
                  Select a backend
                </option>
              )}
              {coach.backends.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.available
                    ? option.label
                    : `${option.label} — unavailable${
                        option.unavailableReason === undefined
                          ? ""
                          : `: ${option.unavailableReason.message}`
                      }`}
                </option>
              ))}
            </select>
          )}
          {coach.activeBackend !== null && (
            <p className="coach-meta" data-testid="coach-active-backend">
              {`This run is pinned to ${disclosedLabel ?? coach.activeBackend}. Replay, cancel, and restore keep using that backend even if the selection changes.`}
            </p>
          )}
        </div>
      )}

      {coach.backendNotice !== null && !(coach.mode === "browser" && coach.isGuest) && (
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
              Retry availability
            </button>
          )}
        </>
      )}

      {disclosedBackend !== null && disclosedLocation !== null && (
        <p
          className="coach-meta"
          data-testid={
            disclosedLocation === "cloud" ? "coach-cloud-disclosure" : "coach-local-disclosure"
          }
        >
          {disclosedLocation === "cloud"
            ? "Cloud coach: the run executes in the hosted cloud and spends cloud coaching credits. Your question and the selected workout snapshot are sent to the configured cloud provider."
            : `Local coach (${disclosedLabel ?? disclosedBackend}): the run executes on this machine through that local CLI. Your question and snapshot go to the model provider configured for it; workout storage stays local.`}
        </p>
      )}

      {coach.blockedResume !== null && (
        <div role="alert" data-testid="coach-resume-blocked" className="validation-warnings">
          {coach.blockedResume.message}
        </div>
      )}

      {piUnavailable && (
        <div role="alert" data-testid="coach-pi-unavailable" className="validation-warnings">
          pi is not installed on this machine, so the local pi coach cannot run. Select an available
          cloud or other local backend, install pi, or keep using workout logging and history.
        </div>
      )}

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : historyStatus === "loading" ? (
        <p role="status">Loading workout history…</p>
      ) : historyEmpty && coach.snapshot === null ? (
        <div className="empty-state">
          <p>No workout history to analyse yet.</p>
          <Link to="/workout/new">Log your first workout</Link>
        </div>
      ) : (
        <>
          <p data-testid="coach-history-count" className="coach-meta">
            {`${records.length} workout(s) in history.`}
          </p>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="coach-question">Analysis question</label>
              <textarea
                id="coach-question"
                value={question}
                onChange={(event) => setQuestion(event.currentTarget.value)}
                placeholder="How is my squat progressing?"
                disabled={coach.isRunning || piUnavailable}
              />
              {!coach.canAsk && !piUnavailable && (
                <p className="coach-meta" data-testid="coach-backend-required">
                  Select an available coach backend to ask.
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="coach-from">From (optional)</label>
              <input
                id="coach-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.currentTarget.value)}
                disabled={coach.isRunning || piUnavailable}
              />
            </div>
            <div className="field">
              <label htmlFor="coach-to">To (optional)</label>
              <input
                id="coach-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.currentTarget.value)}
                disabled={coach.isRunning || piUnavailable}
              />
            </div>
            <button
              type="submit"
              disabled={
                coach.isRunning ||
                piUnavailable ||
                !coach.canAsk ||
                question.trim() === ""
              }
            >
              {coach.phase === "preparing" || coach.phase === "streaming" || coach.phase === "cancelling"
                ? "Coach is working…"
                : "Ask coach"}
            </button>{" "}
            {coach.canCancel && (
              <button type="button" onClick={() => void coach.cancel()}>
                {coach.phase === "cancelling" ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </form>

          {snapshot !== null && (
            <p data-testid="coach-source" className="coach-meta">
              {`Snapshot ${snapshot.snapshotId}: ${snapshot.source} · ${String(
                snapshot.recordCount,
              )} record(s)${
                snapshot.from !== undefined || snapshot.to !== undefined
                  ? ` · ${snapshot.from ?? "…"} – ${snapshot.to ?? "…"}`
                  : ""
              }`}
            </p>
          )}

          {rangeEmpty && (
            <div className="empty-state" data-testid="coach-range-empty">
              <p>No workouts in the selected range. Record a workout for this period first.</p>
              <Link to="/workout/new">Log a workout</Link>
            </div>
          )}

          {snapshotStale && snapshot !== null && (
            <div className="validation-warnings" role="note" data-testid="coach-stale">
              Workout history changed since snapshot {snapshot.snapshotId} (
              {`${String(snapshot.recordCount)} records then`}). Results below reflect the earlier
              snapshot, not the current history.
            </div>
          )}

          {(coach.phase === "streaming" || coach.phase === "preparing") && (
            <p role="status">Coach is working…</p>
          )}
          {coach.phase === "cancelling" && <p role="status">Cancelling coach run…</p>}

          {coach.tools.length > 0 && (
            <section aria-label="Coach activity">
              <h2>Activity</h2>
              <ul className="coach-tools">
                {coach.tools.map((activity) => (
                  <li key={activity.callId}>
                    {activity.phase === "started"
                      ? `Running ${activity.tool}…`
                      : activity.phase === "ok"
                        ? `Finished ${activity.tool}${activity.summary ? `: ${activity.summary}` : ""}`
                        : `Tool ${activity.tool} failed: ${activity.error ?? "unknown error"}`}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {coach.text !== "" && (
            <section aria-label="Coach answer">
              <h2>Answer</h2>
              <pre className="coach-text" data-testid="coach-text">
                {coach.text}
              </pre>
            </section>
          )}

          {coach.runError !== null && (
            <div role="alert" data-testid="coach-run-error" className="validation-warnings">
              {`Coach tool reported ${coach.runError.code}: ${coach.runError.message}`}
            </div>
          )}

          {coach.analyses.map((analysis, index) => (
            <section key={index} aria-label={index === 0 ? "Coach analysis" : `Coach analysis ${String(index + 1)}`}>
              <AnalysisView analysis={analysis} />
            </section>
          ))}

          {coach.phase === "cancelled" && (
            <div role="status" data-testid="coach-cancelled" className="validation-warnings">
              <p>Coach run cancelled. Partial output above is frozen.</p>
              <button type="button" onClick={coach.newAnalysis}>
                New analysis
              </button>
            </div>
          )}

          {coach.phase === "unconfirmed" && (
            <div role="alert" data-testid="coach-cancel-unconfirmed" className="validation-warnings">
              <p>
                Cancellation unconfirmed — the submit may already have been accepted by the server, so
                no run is claimed cancelled yet.
              </p>
              <p>Resolve it with the same request key, then cancel; a fresh analysis would abandon it.</p>
              <button type="button" onClick={() => void coach.retrySubmit()}>
                Resolve cancellation
              </button>
            </div>
          )}

          {coach.error !== null && (
            <div role="alert" data-testid="coach-error" className="validation-summary">
              <p>{coach.error}</p>
              <div className="plan-actions">
                {coach.canRetrySubmit && (
                  <button type="button" onClick={() => void coach.retrySubmit()}>
                    Retry
                  </button>
                )}
                {coach.canReconnect && (
                  <button type="button" onClick={coach.reconnect}>
                    Reconnect
                  </button>
                )}
                {coach.canRetryRestore && (
                  <button type="button" onClick={coach.retryRestore}>
                    Retry restore
                  </button>
                )}
                {coach.canReloadFromStart && (
                  <button type="button" onClick={coach.reloadFromStart}>
                    Reload from earliest events
                  </button>
                )}
                {!coach.isRunning &&
                  (coach.phase === "done" || coach.phase === "failed" || coach.phase === "cancelled") && (
                    <button type="button" onClick={coach.newAnalysis}>
                      New analysis
                    </button>
                  )}
              </div>
            </div>
          )}

          {(coach.phase === "done" || coach.phase === "failed") && !coach.isRunning && coach.error === null && (
            <div className="plan-actions">
              <button type="button" onClick={coach.newAnalysis}>
                New analysis
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
