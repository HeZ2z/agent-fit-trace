import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { stableStringify } from "@agent-fit-trace/core";
import type { PlanDraft } from "@agent-fit-trace/core";
import type { FitTraceClient, PlanAdoption } from "@agent-fit-trace/api-contracts";
import {
  ArtifactSnapshotMeta,
  ArtifactSourceSelector,
} from "../components/ArtifactSourceSelector.tsx";
import { useArtifactSource } from "../state/useArtifactSource.ts";
import { useWorkouts } from "../state/useWorkouts.ts";
import { displayStoredExerciseName } from "../i18n/exercises.ts";
import { useI18n } from "../i18n/useI18n.ts";
import type { AppLanguage } from "../i18n/i18n.ts";
import {
  displayCarePrompt,
  displayRecommendation,
  displaySafetyNote,
} from "../i18n/domain.ts";

/**
 * Render one evidence chip value. Evidence is machine metadata and normally
 * stays canonical, but a catalog-backed exercise name is user-facing copy: it is
 * displayed in the UI language while the plan payload keeps the canonical
 * English name.
 */
function formatEvidenceValue(
  key: string,
  value: unknown,
  language: AppLanguage,
): string {
  if (key === "exercise") {
    if (typeof value === "string") {
      return displayStoredExerciseName(language, value);
    }
    if (Array.isArray(value)) {
      return value
        .map((entry) => displayStoredExerciseName(language, String(entry)))
        .join(", ");
    }
  }
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function PlanView({ plan }: { plan: PlanDraft }) {
  const { language, t } = useI18n();
  const { based_on: basedOn } = plan;

  return (
    <>
      {plan.goal !== null && <p className="plan-goal">{t("Goal: {goal}", { goal: plan.goal })}</p>}

      <p className="plan-based-on">
        {t("Based on: {from} – {to}, {sessions} session(s), {records} source record(s)", {
          from: basedOn.period.from ?? t("n/a"),
          to: basedOn.period.to ?? t("n/a"),
          sessions: basedOn.sessions,
          records: basedOn.source_records.length,
        })}
      </p>

      <section>
        <h2>{t("Recommendations")}</h2>
        {plan.recommendations.length === 0 ? (
          <p>{t("No recommendations.")}</p>
        ) : (
          <ul className="plan-recommendations">
            {plan.recommendations.map((recommendation, index) => {
              const displayed = displayRecommendation(language, recommendation);
              return (
              <li
                key={`${recommendation.action}-${index}`}
                className="plan-recommendation"
                data-recommendation-action={recommendation.action}
              >
                <p className="plan-action">{displayed.action}</p>
                <p className="plan-detail">{displayed.detail}</p>
                <p className="plan-reason">
                  {t("Reason: {reason}", { reason: displayed.reason })}
                </p>
                <ul className="plan-evidence">
                  {Object.entries(recommendation.evidence).map(([key, value]) => (
                    <li key={key}>{`${key}: ${formatEvidenceValue(key, value, language)}`}</li>
                  ))}
                </ul>
              </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>{t("Safety notes")}</h2>
        {plan.safety_notes.length === 0 ? (
          <p>{t("No additional safety notes.")}</p>
        ) : (
          <ul className="plan-safety-notes">
            {plan.safety_notes.map((note) => (
              <li key={note}>{displaySafetyNote(language, note)}</li>
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
  const { language, t } = useI18n();
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
        t("Could not adopt this plan snapshot: {error}", {
          error: caught instanceof Error ? caught.message : String(caught),
        }),
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
        t("Could not revoke the adopted plan: {error}", {
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      );
    } finally {
      if (adoptionWriteRef.current === generation) {
        adoptionSavingRef.current = false;
        if (mountedRef.current && clientRef.current === captured) setAdoptionSaving(false);
      }
    }
  }

  return (
    <section data-screen="plan">
      <div className="screen-head">
        <div className="screen-head-main">
          <h1>{t("Training Plan")}</h1>
        </div>
      </div>

      {historyStatus === "error" ? (
        <div role="alert" data-testid="history-error" className="validation-summary">
          <p>
            {t("Could not load workout history: {message}", {
              message: loadError?.message ?? t("Unknown error."),
            })}
          </p>
          <button type="button" onClick={reload}>
            {t("Retry")}
          </button>
        </div>
      ) : (
        <>
          <ArtifactSourceSelector source={source} />

          <section className="plan-adoption" aria-labelledby="plan-adoption-heading">
            <h2 id="plan-adoption-heading">{t("Saved plan adoption")}</h2>
            {currentAdoption.status === "loading" && (
              <p role="status">{t("Loading saved adoption…")}</p>
            )}
            {currentAdoption.status === "error" && (
              <div role="alert" className="validation-summary" data-testid="plan-adoption-error">
                <p>
                  {t(
                    "Could not load the saved plan adoption: {error}. No adoption is claimed while this fails.",
                    { error: currentAdoption.error ?? "" },
                  )}
                </p>
                <button type="button" onClick={() => setAdoptionToken((token) => token + 1)}>
                  {t("Retry adoption")}
                </button>
              </div>
            )}
            {currentAdoption.status === "ready" && (
              <p data-testid="current-adoption">
                {currentAdoption.adoption === null
                  ? t("No plan adopted.")
                  : t("A saved plan is adopted.")}
              </p>
            )}
            {currentAdoption.status === "ready" && currentAdoption.adoption !== null && (
              <div className="plan-actions">
                <button
                  type="button"
                  onClick={() => void revokeImportedPlan()}
                  disabled={adoptionSaving}
                >
                  {t("Revoke adoption")}
                </button>
              </div>
            )}
            {snapshot !== null && (
              <p data-testid="selected-snapshot-adoption">
                {currentAdoption.status !== "ready"
                  ? t(
                      "Adoption status: {status}.",
                      { status: currentAdoption.status },
                    )
                  : adoptedSnapshot
                    ? t("This saved plan is adopted.")
                    : t("This saved plan is not adopted.")}
              </p>
            )}
            {snapshot !== null && !adoptedSnapshot && (
              <div className="plan-actions">
                <button
                  type="button"
                  onClick={() => void confirmImportedPlan()}
                  disabled={adoptionSaving || currentAdoption.status !== "ready"}
                >
                  {t("Adopt this plan")}
                </button>
              </div>
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
                {adoptedSnapshot ? t("This plan is adopted.") : t("This plan is a draft.")}
              </p>
              {snapshot.payload.professional_care_prompt !== null && (
                <div role="alert" data-testid="care-prompt" className="care-prompt">
                  <h2>{t("Professional care")}</h2>
                  <p>{displayCarePrompt(language, snapshot.payload.professional_care_prompt)}</p>
                </div>
              )}
              <PlanView plan={snapshot.payload} />
            </>
          ) : sourceBlocked ? null : historyStatus === "loading" ||
            (historyStatus === "ready" && planCallStatus === "loading") ? (
            <p role="status">{t("Loading plan…")}</p>
          ) : planCallStatus === "error" ? (
            <div role="alert" data-testid="plan-error" className="validation-summary">
              <p>
                {t("Could not load plan: {message}", {
                  message: planCallError?.message ?? t("Unknown error."),
                })}
              </p>
              <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
                {t("Retry")}
              </button>
            </div>
          ) : showEmpty || plan === null ? (
            <div className="empty-state">
              <p>{t("No workout history to draft a plan from yet.")}</p>
              <Link to="/workout/new">{t("Log your first workout")}</Link>
            </div>
          ) : (
            <>
              {plan.professional_care_prompt !== null && (
                <div role="alert" data-testid="care-prompt" className="care-prompt">
                  <h2>{t("Professional care")}</h2>
                  <p>{displayCarePrompt(language, plan.professional_care_prompt)}</p>
                </div>
              )}

              <p data-testid="plan-status" className="plan-status">
                {generatedConfirmed
                  ? t("Plan status: confirmed only in this view (not saved or adopted)")
                  : t("Plan status: draft (generated current plan, not saved or adopted)")}
              </p>

              <div className="plan-actions">
                {generatedConfirmed ? (
                  <button type="button" onClick={() => setConfirmedFingerprint(null)}>
                    {t("Discard this-view confirmation")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => planFingerprint !== null && setConfirmedFingerprint(planFingerprint)}
                  >
                    {t("Confirm plan for this view only")}
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
