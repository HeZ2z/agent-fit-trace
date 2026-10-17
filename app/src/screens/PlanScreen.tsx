import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { stableStringify } from "@pi-fit-trace/core";
import type { PlanDraft } from "@pi-fit-trace/core";
import type { FitTraceClient, PlanAdoption } from "@pi-fit-trace/api-contracts";
import {
  ArtifactSnapshotMeta,
  ArtifactSourceSelector,
} from "../components/ArtifactSourceSelector.tsx";
import { useArtifactSource } from "../state/useArtifactSource.ts";
import { useWorkouts } from "../state/useWorkouts.ts";

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

type AdoptionState = {
  status: "loading" | "ready" | "error";
  adoption: PlanAdoption | null;
  error: string | null;
  /** The client that produced this payload; a swapped client never shows it. */
  client: FitTraceClient;
};

export function PlanScreen() {
  const { client, records, status: historyStatus, loadError, reload } = useWorkouts();
  const source = useArtifactSource("plan", client);
  const [adoption, setAdoption] = useState<AdoptionState>({
    status: "loading",
    adoption: null,
    error: null,
    client,
  });
  const [adoptionToken, setAdoptionToken] = useState(0);
  const [adoptionSaving, setAdoptionSaving] = useState(false);
  const [adoptionActionError, setAdoptionActionError] = useState<string | null>(null);
  // Generated confirmation is deliberately UI-only. It is scoped to this
  // rendered plan and never writes an adoption or an archive snapshot.
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);
  const [localPlan, setLocalPlan] = useState<PlanDraft | null>(null);
  const [planCallStatus, setPlanCallStatus] = useState<"loading" | "error" | "ready">("loading");
  const [planCallError, setPlanCallError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const generationRef = useRef(0);
  // Separate read/write epochs: a mutation invalidates older adoption GETs,
  // and its own completion invalidates any GET started during the write.
  const adoptionReadRef = useRef(0);
  const adoptionWriteRef = useRef(0);
  const adoptionClientRef = useRef(client);
  const clientRef = useRef(client);
  clientRef.current = client;
  const mountedRef = useRef(true);
  const adoptionSavingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      adoptionReadRef.current += 1;
      adoptionWriteRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (historyStatus !== "ready") return;
    const generation = ++generationRef.current;
    let cancelled = false;
    setLocalPlan(null);
    setConfirmedFingerprint(null);
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

  useEffect(() => {
    const generation = ++adoptionReadRef.current;
    const captured = client;
    if (adoptionClientRef.current !== captured) {
      // Scope change invalidates any in-flight adoption write and its busy flag.
      adoptionClientRef.current = captured;
      adoptionWriteRef.current += 1;
      adoptionSavingRef.current = false;
      setAdoptionSaving(false);
      setAdoptionActionError(null);
    }
    setAdoption({ status: "loading", adoption: null, error: null, client: captured });
    captured
      .getPlanAdoption()
      .then((saved) => {
        if (
          !mountedRef.current ||
          adoptionReadRef.current !== generation ||
          clientRef.current !== captured
        ) {
          return;
        }
        setAdoption({ status: "ready", adoption: saved, error: null, client: captured });
      })
      .catch((caught: unknown) => {
        if (
          !mountedRef.current ||
          adoptionReadRef.current !== generation ||
          clientRef.current !== captured
        ) {
          return;
        }
        setAdoption({
          status: "error",
          adoption: null,
          error: caught instanceof Error ? caught.message : String(caught),
          client: captured,
        });
      });
  }, [client, source.refreshVersion, adoptionToken]);

  // Never paint another client's adoption while the new scoped read settles.
  const currentAdoption: Omit<AdoptionState, "client"> =
    adoption.client === client
      ? adoption
      : { status: "loading", adoption: null, error: null };

  const snapshot = source.selected;
  const plan = snapshot?.payload ?? localPlan;
  const sourceBlocked =
    snapshot === null &&
    (source.selectionStatus !== "ready" ||
      source.selectionBusy ||
      source.selectionError !== null ||
      source.selection !== null);
  const showEmpty =
    historyStatus === "ready" &&
    records.length === 0 &&
    snapshot === null &&
    source.selection === null &&
    source.selectionError === null;

  const planFingerprint = plan === null ? null : stableStringify(plan);
  const generatedConfirmed =
    snapshot === null &&
    confirmedFingerprint !== null &&
    confirmedFingerprint === planFingerprint;
  const adoptedSnapshot =
    snapshot !== null &&
    currentAdoption.adoption !== null &&
    currentAdoption.adoption.artifact_id === snapshot.id &&
    currentAdoption.adoption.confirmed_digest === snapshot.content_digest;

  async function confirmImportedPlan(): Promise<void> {
    if (snapshot === null || adoptionSavingRef.current) return;
    if (currentAdoption.status !== "ready") return;
    const captured = clientRef.current;
    // A mutation starts a new write operation and invalidates any older GET
    // completion that would otherwise undo this confirmation.
    const generation = ++adoptionWriteRef.current;
    adoptionReadRef.current += 1;
    adoptionSavingRef.current = true;
    setAdoptionSaving(true);
    setAdoptionActionError(null);
    try {
      const saved = await captured.setPlanAdoption({
        artifact_id: snapshot.id,
        confirmed_digest: snapshot.content_digest,
      });
      if (
        !mountedRef.current ||
        adoptionWriteRef.current !== generation ||
        clientRef.current !== captured
      ) {
        return;
      }
      // Invalidate any GET that started while the write was in flight.
      adoptionReadRef.current += 1;
      setAdoption({ status: "ready", adoption: saved, error: null, client: captured });
    } catch (caught) {
      if (
        !mountedRef.current ||
        adoptionWriteRef.current !== generation ||
        clientRef.current !== captured
      ) {
        return;
      }
      setAdoptionActionError(
        `Could not adopt this plan snapshot: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      if (adoptionWriteRef.current === generation) {
        adoptionSavingRef.current = false;
        if (mountedRef.current && clientRef.current === captured) setAdoptionSaving(false);
      }
    }
  }

  async function revokeImportedPlan(): Promise<void> {
    if (adoptionSavingRef.current) return;
    const captured = clientRef.current;
    const generation = ++adoptionWriteRef.current;
    adoptionReadRef.current += 1;
    adoptionSavingRef.current = true;
    setAdoptionSaving(true);
    setAdoptionActionError(null);
    try {
      await captured.setPlanAdoption(null);
      if (
        !mountedRef.current ||
        adoptionWriteRef.current !== generation ||
        clientRef.current !== captured
      ) {
        return;
      }
      // Invalidate any GET that started while the write was in flight.
      adoptionReadRef.current += 1;
      // Revoking clears only adoption metadata; no workout or payload changes.
      setAdoption({ status: "ready", adoption: null, error: null, client: captured });
    } catch (caught) {
      if (
        !mountedRef.current ||
        adoptionWriteRef.current !== generation ||
        clientRef.current !== captured
      ) {
        return;
      }
      setAdoptionActionError(
        `Could not revoke the adopted plan: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      if (adoptionWriteRef.current === generation) {
        adoptionSavingRef.current = false;
        if (mountedRef.current && clientRef.current === captured) setAdoptionSaving(false);
      }
    }
  }

  return (
    <section>
      <h1>Training Plan</h1>

      <p>
        <Link to="/me">Manage imports and exports</Link>
      </p>

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>Could not load workout history: {loadError?.message ?? "Unknown error."}</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <ArtifactSourceSelector source={source} />

          <section className="plan-adoption" aria-labelledby="plan-adoption-heading">
            <h2 id="plan-adoption-heading">Saved plan adoption</h2>
            {currentAdoption.status === "loading" && <p role="status">Loading saved adoption…</p>}
            {currentAdoption.status === "error" && (
              <div role="alert" className="validation-summary" data-testid="plan-adoption-error">
                <p>
                  Could not load the saved plan adoption: {currentAdoption.error}. No adoption is
                  claimed while this fails.
                </p>
                <button type="button" onClick={() => setAdoptionToken((token) => token + 1)}>
                  Retry adoption
                </button>
              </div>
            )}
            {currentAdoption.status === "ready" && (
              <p data-testid="current-adoption">
                {currentAdoption.adoption === null
                  ? "Currently adopted plan snapshot: none."
                  : `Currently adopted plan snapshot: ${currentAdoption.adoption.artifact_id} (confirmed ${currentAdoption.adoption.confirmed_at}).`}
              </p>
            )}
            {currentAdoption.status === "ready" && currentAdoption.adoption !== null && (
              <div className="plan-actions">
                <button
                  type="button"
                  onClick={() => void revokeImportedPlan()}
                  disabled={adoptionSaving}
                >
                  Revoke saved adoption (metadata only)
                </button>
              </div>
            )}
            {snapshot !== null && (
              <p data-testid="selected-snapshot-adoption">
                {currentAdoption.status !== "ready"
                  ? `Selected saved snapshot ${snapshot.id}: the saved adoption is ${currentAdoption.status}. Viewing this snapshot never changes it.`
                  : adoptedSnapshot
                    ? `Selected saved snapshot ${snapshot.id} is the currently adopted plan.`
                    : `Selected saved snapshot ${snapshot.id} is not adopted. Viewing a snapshot never adopts it; a new import does not inherit the previous adoption.`}
              </p>
            )}
            {snapshot !== null && !adoptedSnapshot && (
              <div className="plan-actions">
                <button
                  type="button"
                  onClick={() => void confirmImportedPlan()}
                  disabled={adoptionSaving || currentAdoption.status !== "ready"}
                >
                  Confirm adopting this exact saved snapshot
                </button>
              </div>
            )}
            {snapshot !== null && adoptedSnapshot && (
              <p className="me-help">
                Use Revoke above to clear the saved adoption; viewing any source never changes
                it.
              </p>
            )}
            {snapshot !== null && (
              <p className="me-help">
                Adoption binds this exact artifact id and content digest. It never changes
                the snapshot&rsquo;s draft flags and never writes workout records.
              </p>
            )}
            {adoptionActionError !== null && (
              <div role="alert" className="validation-summary">
                <p>{adoptionActionError}</p>
              </div>
            )}
          </section>

          {snapshot !== null ? (
            <>
              <ArtifactSnapshotMeta artifact={snapshot} records={records} />
              <p data-testid="plan-snapshot-draft" className="plan-status">
                {`Snapshot status: draft flags is_draft=${snapshot.payload.is_draft}, requires_confirmation=${snapshot.payload.requires_confirmation}. ${
                  adoptedSnapshot
                    ? "The saved adoption is separate and does not change these flags."
                    : "Viewing this snapshot does not adopt it."
                }`}
              </p>
              {snapshot.payload.professional_care_prompt !== null && (
                <div role="alert" data-testid="care-prompt" className="care-prompt">
                  <h2>Professional care</h2>
                  <p>{snapshot.payload.professional_care_prompt}</p>
                </div>
              )}
              <PlanView plan={snapshot.payload} />
            </>
          ) : sourceBlocked ? null : historyStatus === "loading" ||
            (historyStatus === "ready" && planCallStatus === "loading") ? (
            <p role="status">Loading plan…</p>
          ) : planCallStatus === "error" ? (
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
                {generatedConfirmed
                  ? "Plan status: confirmed only in this view (not saved or adopted)"
                  : "Plan status: draft (generated current plan, not saved or adopted)"}
              </p>

              <div className="plan-actions">
                {generatedConfirmed ? (
                  <button type="button" onClick={() => setConfirmedFingerprint(null)}>
                    Discard this-view confirmation
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => planFingerprint !== null && setConfirmedFingerprint(planFingerprint)}
                  >
                    Confirm plan for this view only
                  </button>
                )}
              </div>

              <PlanView plan={plan} />
            </>
          )}
        </>
      )}
    </section>
  );
}
