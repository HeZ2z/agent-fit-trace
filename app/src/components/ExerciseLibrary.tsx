/**
 * Searchable exercise-catalog browser shared by the library page (and, later,
 * any other selection surface).
 *
 * The catalog is a reference, not a coaching authority: the component always
 * shows the review notice, labels the catalog's own classification, and never
 * claims a technique or personal suitability. Selecting an exercise only calls
 * `onSelect`; persisting it into a workout draft is the parent's decision, so
 * this component stays reusable and free of storage access.
 *
 * Filter and search results are deterministic: an empty query lists the catalog
 * in canonical-name order, a query uses the shared bilingual ranking, and the
 * approved filters are applied after ranking. When a search or filter removes
 * the selected entry, the detail becomes a placeholder and its action
 * disappears — a stale selection is never actionable.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DIFFICULTIES,
  EQUIPMENT_CATEGORIES,
  MOVEMENT_PATTERNS,
  MUSCLE_IDS,
} from "@agent-fit-trace/core";
import type {
  Difficulty,
  EquipmentCategory,
  ExerciseCatalogEntry,
  ExerciseListFilter,
  MovementPattern,
  MuscleId,
} from "@agent-fit-trace/core";
import {
  displayDifficulty,
  displayEquipmentCategory,
  displayExerciseName,
  displayForce,
  displayMechanics,
  displayMovementPattern,
  displayMuscle,
  searchExerciseLibrary,
} from "../i18n/exercises.ts";
import { useI18n } from "../i18n/useI18n.ts";

type PatternFilter = MovementPattern | "";
type MuscleFilter = MuscleId | "";
type EquipmentFilter = EquipmentCategory | "";
type DifficultyFilter = Difficulty | "";

export interface ExerciseLibraryProps {
  /**
   * Called with the selected catalog entry. The parent owns what "select"
   * means (add to a draft, start a workout, ...); the library never writes.
   */
  onSelect: (entry: ExerciseCatalogEntry) => void;
}

/** Join catalog muscle ids into the UI language's labels. */
function muscleLabels(language: "en" | "zh", muscles: readonly MuscleId[]): string {
  return muscles.map((muscle) => displayMuscle(language, muscle)).join(", ");
}

export function ExerciseLibrary({ onSelect }: ExerciseLibraryProps) {
  const { language, t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState("");
  const [pattern, setPattern] = useState<PatternFilter>("");
  const [muscle, setMuscle] = useState<MuscleFilter>("");
  const [equipment, setEquipment] = useState<EquipmentFilter>("");
  const [difficulty, setDifficulty] = useState<DifficultyFilter>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The detail sits after the whole result list in DOM order, so a keyboard
  // user who selects a row would otherwise tab through every remaining result
  // before reaching the action. Move focus to the detail heading on selection;
  // the detail's Back and Add actions are then the next tab stops.
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectedId === null) return;
    detailHeadingRef.current?.focus();
  }, [selectedId]);

  function backToResults(): void {
    setSelectedId(null);
    // The detail is about to leave the layout; return keyboard focus to the
    // search field so the list can be used again without a tab hunt.
    searchInputRef.current?.focus();
  }

  const filter = useMemo<ExerciseListFilter>(
    () => ({
      ...(pattern === "" ? {} : { pattern }),
      ...(muscle === "" ? {} : { muscle }),
      ...(equipment === "" ? {} : { equipment }),
      ...(difficulty === "" ? {} : { difficulty }),
    }),
    [pattern, muscle, equipment, difficulty],
  );

  const results = useMemo(
    () => searchExerciseLibrary(query, language, filter),
    [query, language, filter],
  );

  // A selection that the current search/filter no longer contains resolves to
  // null, so the detail and its action cannot act on a hidden entry.
  const selected =
    selectedId === null ? null : (results.find((entry) => entry.id === selectedId) ?? null);

  function clearFilters(): void {
    setQuery("");
    setPattern("");
    setMuscle("");
    setEquipment("");
    setDifficulty("");
    setSelectedId(null);
  }

  const countLabel =
    results.length === 1
      ? t("{count} exercise", { count: results.length })
      : t("{count} exercises", { count: results.length });

  return (
    <div
      className="exercise-library"
      data-selected={selected === null ? "false" : "true"}
    >
      <div className="exercise-library-browse">
        <div className="exercise-library-controls">
          <div className="field exercise-library-search">
            <label htmlFor={`${id}-search`}>{t("Search exercises")}</label>
            <input
              id={`${id}-search`}
              ref={searchInputRef}
              type="search"
              value={query}
              placeholder={t("Search by name or alias")}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-pattern`}>{t("Movement pattern")}</label>
            <select
              id={`${id}-pattern`}
              value={pattern}
              onChange={(event) => setPattern(event.target.value as PatternFilter)}
            >
              <option value="">{t("All patterns")}</option>
              {MOVEMENT_PATTERNS.map((value) => (
                <option key={value} value={value}>
                  {displayMovementPattern(language, value)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${id}-muscle`}>{t("Muscle")}</label>
            <select
              id={`${id}-muscle`}
              value={muscle}
              onChange={(event) => setMuscle(event.target.value as MuscleFilter)}
            >
              <option value="">{t("All muscles")}</option>
              {MUSCLE_IDS.map((value) => (
                <option key={value} value={value}>
                  {displayMuscle(language, value)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${id}-equipment`}>{t("Equipment")}</label>
            <select
              id={`${id}-equipment`}
              value={equipment}
              onChange={(event) => setEquipment(event.target.value as EquipmentFilter)}
            >
              <option value="">{t("All equipment")}</option>
              {EQUIPMENT_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {displayEquipmentCategory(language, value)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${id}-difficulty`}>{t("Difficulty")}</label>
            <select
              id={`${id}-difficulty`}
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value as DifficultyFilter)}
            >
              <option value="">{t("All difficulties")}</option>
              {DIFFICULTIES.map((value) => (
                <option key={value} value={value}>
                  {displayDifficulty(language, value)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="exercise-library-reference" role="note">
          {t(
            "Catalog data is a reference. Movement descriptions and muscle/equipment mappings are still under review; this page gives no technique or suitability guidance.",
          )}
        </p>
        <ul className="exercise-library-notes">
          <li>{t("Muscle filters match primary and secondary muscles.")}</li>
          <li>
            {t(
              "Equipment is the resistance category; accessories such as a bench are not listed.",
            )}
          </li>
          <li>
            {t(
              "Difficulty is the catalog's classification, not a personal suitability rating.",
            )}
          </li>
        </ul>

        <p className="exercise-library-count" role="status">
          {countLabel}
        </p>

        {results.length === 0 ? (
          <div className="exercise-library-empty">
            <p>{t("No exercises match these filters.")}</p>
            <button type="button" onClick={clearFilters}>
              {t("Clear filters")}
            </button>
          </div>
        ) : (
          <ul
            className="exercise-library-list"
            aria-label={t("Exercises")}
            data-testid="exercise-library-list"
          >
            {results.map((entry) => {
              const displayName = displayExerciseName(language, entry.name);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-pressed={entry.id === selectedId}
                    data-exercise-id={entry.id}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span className="exercise-library-name">{displayName}</span>
                    <span className="exercise-library-meta">
                      {displayMovementPattern(language, entry.pattern)} ·{" "}
                      {displayDifficulty(language, entry.difficulty)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <aside className="exercise-library-detail" aria-label={t("Exercise details")}>
        {selected === null ? (
          <p className="exercise-library-placeholder">
            {t("Select an exercise to see its details.")}
          </p>
        ) : (
          <>
            <button
              type="button"
              className="exercise-library-back"
              onClick={backToResults}
            >
              {t("Back to results")}
            </button>
            <h2 ref={detailHeadingRef} tabIndex={-1}>
              {displayExerciseName(language, selected.name)}
            </h2>
            {language === "zh" && selected.name !== displayExerciseName(language, selected.name) ? (
              <p className="exercise-library-canonical">{selected.name}</p>
            ) : null}
            <dl className="exercise-library-facts">
              <div>
                <dt>{t("Movement pattern")}</dt>
                <dd>{displayMovementPattern(language, selected.pattern)}</dd>
              </div>
              <div>
                <dt>{t("Primary muscles")}</dt>
                <dd>
                  {selected.primary_muscles.length === 0
                    ? t("None listed")
                    : muscleLabels(language, selected.primary_muscles)}
                </dd>
              </div>
              <div>
                <dt>{t("Secondary muscles")}</dt>
                <dd>
                  {selected.secondary_muscles.length === 0
                    ? t("None listed")
                    : muscleLabels(language, selected.secondary_muscles)}
                </dd>
              </div>
              <div>
                <dt>{t("Equipment")}</dt>
                <dd>{displayEquipmentCategory(language, selected.equipment.category)}</dd>
              </div>
              <div>
                <dt>{t("Difficulty")}</dt>
                <dd>{displayDifficulty(language, selected.difficulty)}</dd>
              </div>
              <div>
                <dt>{t("Mechanics")}</dt>
                <dd>
                  {selected.mechanics === null
                    ? t("Not classified")
                    : displayMechanics(language, selected.mechanics)}
                </dd>
              </div>
              <div>
                <dt>{t("Force")}</dt>
                <dd>
                  {selected.force === null
                    ? t("Not classified")
                    : displayForce(language, selected.force)}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="exercise-library-add"
              onClick={() => onSelect(selected)}
            >
              {t("Add to workout")}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
