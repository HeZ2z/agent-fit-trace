import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { stableStringify } from "@pi-fit-trace/core";
import type { PlanDraft } from "@pi-fit-trace/core";
import { readTextFile } from "../api/fileTransport.ts";
import { parsePlanResponse } from "../api/responseParsers.ts";
import { useWorkouts } from "../state/useWorkouts.ts";

type PlanStatus = "draft" | "adopted";

function formatEvidenceValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function PlanView({ plan }: { plan: PlanDraft }) {
  const { based_on: basedOn } = plan;

  return (
    <>
      {plan.goal !== null && <p className="plan-goal">{`Goal: ${plan.goal}`}</p>}

      <p className="plan-based-on">
        {`Based on: ${basedOn.period.from ?? "n/a"} – ${basedOn.period.to ?? "n/a"}, ${basedOn.sessions} session(s), ${basedOn.source_records.length} source record(s)`}
      </p>

      <section>
        <h2>Recommendations</h2>
        {plan.recommendations.length === 0 ? (
          <p>No recommendations.</p>
        ) : (
          <ul className="plan-recommendations">
            {plan.recommendations.map((recommendation, index) => (
              <li
                key={`${recommendation.action}-${index}`}
                className="plan-recommendation"
                data-recommendation-action={recommendation.action}
              >
                <p className="plan-action">{recommendation.action}</p>
                <p className="plan-detail">{recommendation.detail}</p>
                <p className="plan-reason">{`Reason: ${recommendation.reason}`}</p>
                <ul className="plan-evidence">
                  {Object.entries(recommendation.evidence).map(([key, value]) => (
                    <li key={key}>{`${key}: ${formatEvidenceValue(value)}`}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Safety notes</h2>
        {plan.safety_notes.length === 0 ? (
          <p>No additional safety notes.</p>
        ) : (
          <ul className="plan-safety-notes">
            {plan.safety_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function PlanScreen() {
  const { client, records, status: historyStatus, loadError, reload } = useWorkouts();
  const [imported, setImported] = useState<PlanDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Confirmation is UI-only: it never touches stored workout records. Adoption
  // is bound to the exact plan that was confirmed, so it cannot go stale.
  const [adoptedFingerprint, setAdoptedFingerprint] = useState<string | null>(null);
  const [localPlan, setLocalPlan] = useState<PlanDraft | null>(null);
  const [planCallStatus, setPlanCallStatus] = useState<"loading" | "error" | "ready">("loading");
  const [planCallError, setPlanCallError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const generationRef = useRef(0);

  useEffect(() => {
    if (historyStatus !== "ready") return;
    const generation = ++generationRef.current;
    let cancelled = false;
    setPlanCallStatus("loading");
    setPlanCallError(null);
    client
      .createPlanDraft()
      .then((draft) => {
        if (cancelled || generationRef.current !== generation) return;
        setLocalPlan(draft);
        setPlanCallStatus("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled || generationRef.current !== generation) return;
        setPlanCallError(caught instanceof Error ? caught : new Error(String(caught)));
        setPlanCallStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, records, reloadToken, historyStatus]);

  // Single source of truth for rendering: local plan unless an import
  // succeeded. A failed import never changes this.
  const plan = imported ?? localPlan;
  const source = imported === null ? "local" : "imported";
  const showEmpty = historyStatus === "ready" && records.length === 0 && imported === null;

  // Deriving status from a fingerprint means a regenerated plan (for example
  // after workout history changes) can never inherit a stale "adopted" status.
  const planFingerprint = plan === null ? null : stableStringify(plan);
  const status: PlanStatus = adoptedFingerprint !== null && adoptedFingerprint === planFingerprint ? "adopted" : "draft";

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;

    try {
      const text = await readTextFile(file);
      const parsed = parsePlanResponse(text);
      // A successful source change always reverts to an unconfirmed draft.
      setImported(parsed);
      setAdoptedFingerprint(null);
      setError(null);
    } catch (caught) {
      // Keep the previously displayed plan; only surface the error.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      input.value = "";
    }
  }

  function showLocal(): void {
    setImported(null);
    setAdoptedFingerprint(null);
    setError(null);
  }

  function confirmPlan(): void {
    if (planFingerprint !== null) setAdoptedFingerprint(planFingerprint);
  }

  function discardPlan(): void {
    setAdoptedFingerprint(null);
  }

  return (
    <section>
      <h1>Training Plan</h1>

      <p data-testid="plan-source">{`Plan source: ${source}`}</p>

      <div className="field">
        <label htmlFor="plan-import">Import plan.json</label>
        <input
          id="plan-import"
          type="file"
          accept="application/json"
          onChange={handleFileChange}
        />
      </div>

      {imported !== null && (
        <button type="button" onClick={showLocal}>
          Show local plan
        </button>
      )}

      {error !== null && (
        <div role="alert" data-testid="plan-error" className="validation-summary">
          {error}
        </div>
      )}

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : historyStatus === "loading" || (historyStatus === "ready" && planCallStatus === "loading") ? (
        <p role="status">Loading plan…</p>
      ) : planCallStatus === "error" && imported === null ? (
        <div role="alert" data-testid="plan-error" className="validation-summary">
          <p>Could not load plan: {planCallError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : showEmpty || plan === null ? (
        <div className="empty-state">
          <p>No workout history to draft a plan from yet.</p>
          <Link to="/workout/new">Log your first workout</Link>
        </div>
      ) : (
        <>
          {plan.professional_care_prompt !== null && (
            <div role="alert" data-testid="care-prompt" className="care-prompt">
              <h2>Professional care</h2>
              <p>{plan.professional_care_prompt}</p>
            </div>
          )}

          <p data-testid="plan-status" className="plan-status">
            {`Plan status: ${status}`}
          </p>

          <div className="plan-actions">
            {status === "draft" ? (
              <button type="button" onClick={confirmPlan}>
                Confirm plan
              </button>
            ) : (
              <button type="button" onClick={discardPlan}>
                Discard confirmation
              </button>
            )}
          </div>

          <PlanView plan={plan} />
        </>
      )}
    </section>
  );
}
