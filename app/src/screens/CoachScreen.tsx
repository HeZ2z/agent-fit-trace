import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { filterRecords } from "@pi-fit-trace/core";
import type { CoachingClient } from "../api/coachingClient.ts";
import { runtimePiAvailable } from "../api/runtimeMode.ts";
import { AnalysisView } from "../components/AnalysisView.tsx";
import { useWorkouts } from "../state/useWorkouts.ts";
import { useCoach } from "../coaching/useCoach.ts";

export function CoachScreen({ client }: { client?: CoachingClient } = {}) {
  const { records, status: historyStatus, loadError, reload } = useWorkouts();
  const coach = useCoach({ client });
  const [question, setQuestion] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // piAvailable === false means the launcher published a presence probe that
  // found no pi CLI: coaching cannot run, so asking is disabled with a clear
  // notice — workout history/tracking stays fully usable.
  const piUnavailable = runtimePiAvailable() === false;

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
    if (piUnavailable) return;
    void coach.submit({ question, from, to });
  }

  return (
    <section>
      <h1>Coach</h1>
      <p className="coach-lede">
        Read-only analysis of your stored workouts. The coach reads a backend-issued snapshot of this
        account and the selected range — your records are never rewritten by a run.
      </p>

      {piUnavailable && (
        <div role="alert" data-testid="coach-pi-unavailable" className="validation-warnings">
          pi is not installed on this machine, so coaching cannot run. Workout logging and history
          still work — install pi to enable the coach.
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
                coach.phase === "unconfirmed" ||
                question.trim() === ""
              }
            >
              {coach.phase === "preparing" || coach.phase === "streaming" || coach.phase === "cancelling"
                ? "Coach is working…"
                : "Ask coach"}
            </button>{" "}
            {coach.isRunning && (
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
                {coach.canReloadFromStart && (
                  <button type="button" onClick={coach.reloadFromStart}>
                    Reload from earliest events
                  </button>
                )}
                {(coach.phase === "done" || coach.phase === "failed" || coach.phase === "cancelled") && (
                  <button type="button" onClick={coach.newAnalysis}>
                    New analysis
                  </button>
                )}
              </div>
            </div>
          )}

          {(coach.phase === "done" || coach.phase === "failed") && !coach.isRunning && (
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
