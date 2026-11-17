/**
 * Reusable exercise-library browser.
 *
 * Search/filter/list/detail only: selection is reported through `onAdd` and the
 * caller decides whether to append to the current draft (Log dialog) or navigate
 * to the editor with a one-shot request (library page). The catalog stays a
 * suggestion layer; this component never writes storage or a record.
 *
 * Shared helpers own the search ranking and metadata labels so the web library
 * and the editor autocomplete cannot drift, and the mobile follow-up can reuse
 * the same i18n/core seam.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  EQUIPMENT_CATEGORIES,
  MUSCLE_IDS,
  MOVEMENT_PATTERNS,
  listExercises,
} from "@agent-fit-trace/core";
import type {
  EquipmentCategory,
  ExerciseCatalogEntry,
  ExerciseListFilter,
  MovementPattern,
  MuscleId,
} from "@agent-fit-trace/core";
import {
  MAX_EXERCISE_LIBRARY_RESULTS,
  displayDifficulty,
  displayEquipmentCategory,
  displayEquipmentItem,
  displayExerciseName,
  displayForce,
  displayMechanics,
  displayMovementPattern,
  displayMuscle,
  searchCatalogExercises,
} from "@agent-fit-trace/i18n";
import { useI18n } from "../i18n/useI18n.ts";

export interface ExerciseLibraryProps {
  /** Append this catalog entry to the caller's current draft. */
  onAdd: (entry: ExerciseCatalogEntry) => void;
  /** Localized label for the detail action. */
  addLabel?: string;
  /** Focus the search field on mount (the Log dialog sets this). */
  autoFocusSearch?: boolean;
}

interface Filters {
  pattern: MovementPattern | "";
  muscle: MuscleId | "";
  equipment: EquipmentCategory | "";
}

const EMPTY_FILTERS: Filters = { pattern: "", muscle: "", equipment: "" };

function filterMatches(entry: ExerciseCatalogEntry, filters: Filters): boolean {
  if (filters.pattern !== "" && entry.pattern !== filters.pattern) return false;
  if (
    filters.muscle !== "" &&
    !entry.primary_muscles.includes(filters.muscle) &&
    !entry.secondary_muscles.includes(filters.muscle)
  ) {
    return false;
  }
  if (filters.equipment !== "" && entry.equipment.category !== filters.equipment) {
    return false;
  }
  return true;
}

function listFilter(filters: Filters): ExerciseListFilter {
  const filter: ExerciseListFilter = {};
  if (filters.pattern !== "") filter.pattern = filters.pattern;
  if (filters.muscle !== "") filter.muscle = filters.muscle;
  if (filters.equipment !== "") filter.equipment = filters.equipment;
  return filter;
}

export function ExerciseLibrary({
  onAdd,
  addLabel,
  autoFocusSearch = false,
}: ExerciseLibraryProps) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const baseId = useId();

  useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
  }, [autoFocusSearch]);

  const entries = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed === "") return listExercises(listFilter(filters));
    return searchCatalogExercises(trimmed, MAX_EXERCISE_LIBRARY_RESULTS).filter((entry) =>
      filterMatches(entry, filters),
    );
  }, [query, filters]);

  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  // A filter/search change can remove the selected row. Clear it rather than
  // showing details that are no longer part of the result set.
  useEffect(() => {
    if (selectedId !== null && !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null);
    }
  }, [entries, selectedId]);

  // On phones the list and detail stack; selecting a row must not leave the
  // detail/Add action many screens below an unbounded 194-row list.
  useEffect(() => {
    if (selectedId === null) return;
    if (typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    detailRef.current?.scrollIntoView?.({ block: "start" });
  }, [selectedId]);

  const hasQueryOrFilters =
    query.trim() !== "" ||
    filters.pattern !== "" ||
    filters.muscle !== "" ||
    filters.equipment !== "";

  function reset(): void {
    setQuery("");
    setFilters(EMPTY_FILTERS);
    setSelectedId(null);
    // The reset button remains mounted but becomes disabled; keep focus in the
    // library rather than letting a disabled/removed control drop it to body.
    searchRef.current?.focus();
  }

  function clearQuery(): void {
    setQuery("");
    // This button unmounts on the next render (empty query); move focus to the
    // field that remains so keyboard focus never escapes the dialog.
    searchRef.current?.focus();
  }

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  const equipmentItems = selected?.equipment.items ?? [];

  return (
    <div className="exercise-library">
      <div className="exercise-library-search">
        <label htmlFor={`${baseId}-search`}>{t("Search exercises")}</label>
        <div className="exercise-library-search-row">
          <input
            ref={searchRef}
            id={`${baseId}-search`}
            type="search"
            value={query}
            placeholder={t("Search by English or Chinese name or alias")}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query === "" ? null : (
            <button type="button" onClick={clearQuery}>
              {t("Clear search")}
            </button>
          )}
        </div>
      </div>

      <fieldset className="exercise-library-filters">
        <legend>{t("Filters")}</legend>
        <div className="exercise-library-filter-grid">
          <div className="field">
            <label htmlFor={`${baseId}-pattern`}>{t("Movement pattern")}</label>
            <select
              id={`${baseId}-pattern`}
              value={filters.pattern}
              onChange={(event) =>
                updateFilter("pattern", event.target.value as Filters["pattern"])
              }
            >
              <option value="">{t("All patterns")}</option>
              {MOVEMENT_PATTERNS.map((pattern) => (
                <option key={pattern} value={pattern}>
                  {displayMovementPattern(language, pattern)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${baseId}-muscle`}>{t("Muscle")}</label>
            <select
              id={`${baseId}-muscle`}
              value={filters.muscle}
              onChange={(event) =>
                updateFilter("muscle", event.target.value as Filters["muscle"])
              }
            >
              <option value="">{t("All muscles")}</option>
              {MUSCLE_IDS.map((muscle) => (
                <option key={muscle} value={muscle}>
                  {displayMuscle(language, muscle)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${baseId}-equipment`}>{t("Equipment")}</label>
            <select
              id={`${baseId}-equipment`}
              value={filters.equipment}
              onChange={(event) =>
                updateFilter("equipment", event.target.value as Filters["equipment"])
              }
            >
              <option value="">{t("All equipment")}</option>
              {EQUIPMENT_CATEGORIES.map((equipment) => (
                <option key={equipment} value={equipment}>
                  {displayEquipmentCategory(language, equipment)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" onClick={reset} disabled={!hasQueryOrFilters}>
          {t("Clear search and filters")}
        </button>
      </fieldset>

      <div className="exercise-library-body">
        <section className="exercise-library-results" aria-labelledby={`${baseId}-results`}>
          <div className="exercise-library-results-heading">
            <h2 id={`${baseId}-results`}>{t("Matching exercises")}</h2>
            <p className="exercise-library-count" role="status">
              {entries.length === 1
                ? t("1 exercise")
                : t("{count} exercises", { count: entries.length })}
            </p>
          </div>
          {entries.length === 0 ? (
            <div className="exercise-library-empty" role="status">
              {hasQueryOrFilters
                ? t("No exercises match the current search and filters.")
                : t("The exercise catalog is empty.")}
            </div>
          ) : (
            <ul className="exercise-library-list">
              {entries.map((entry) => {
                const isSelected = entry.id === selectedId;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={isSelected ? "exercise-library-row selected" : "exercise-library-row"}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => setSelectedId(entry.id)}
                    >
                      <span className="exercise-library-row-name">
                        {displayExerciseName(language, entry.name)}
                      </span>
                      {language === "zh" ? (
                        <span className="exercise-library-row-en">{entry.name}</span>
                      ) : null}
                      <span className="exercise-library-row-meta">
                        {displayMovementPattern(language, entry.pattern)} ·{" "}
                        {displayEquipmentCategory(language, entry.equipment.category)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section
          className="exercise-library-detail"
          aria-labelledby={`${baseId}-detail`}
          ref={detailRef}
        >
          <h2 id={`${baseId}-detail`}>{t("Exercise detail")}</h2>
          <p className="exercise-library-notice">
            {t(
              "Catalog metadata only. Content review is incomplete, so this is not technique, safety or suitability advice.",
            )}
          </p>
          {selected === null ? (
            <p className="exercise-library-detail-empty">
              {t("Select an exercise to see its details.")}
            </p>
          ) : (
            <div aria-live="polite">
              <h3>{displayExerciseName(language, selected.name)}</h3>
              {language === "zh" ? <p className="exercise-library-detail-en">{selected.name}</p> : null}
              <dl className="exercise-library-facts">
                <dt>{t("Movement pattern")}</dt>
                <dd>{displayMovementPattern(language, selected.pattern)}</dd>
                <dt>{t("Primary muscles")}</dt>
                <dd>
                  {selected.primary_muscles.length === 0
                    ? t("Not recorded")
                    : selected.primary_muscles
                        .map((muscle) => displayMuscle(language, muscle))
                        .join(", ")}
                </dd>
                <dt>{t("Secondary muscles")}</dt>
                <dd>
                  {selected.secondary_muscles.length === 0
                    ? t("Not recorded")
                    : selected.secondary_muscles
                        .map((muscle) => displayMuscle(language, muscle))
                        .join(", ")}
                </dd>
                <dt>{t("Equipment")}</dt>
                <dd>{displayEquipmentCategory(language, selected.equipment.category)}</dd>
                <dt>{t("Additional equipment")}</dt>
                <dd>
                  {equipmentItems.length === 0
                    ? t("None recorded")
                    : equipmentItems
                        .map((item) => displayEquipmentItem(language, item))
                        .join(", ")}
                </dd>
                <dt>{t("Difficulty")}</dt>
                <dd>{displayDifficulty(language, selected.difficulty)}</dd>
                <dt>{t("Mechanics")}</dt>
                <dd>
                  {selected.mechanics === null
                    ? t("Not classified")
                    : displayMechanics(language, selected.mechanics)}
                </dd>
                <dt>{t("Force")}</dt>
                <dd>
                  {selected.force === null
                    ? t("Not classified")
                    : displayForce(language, selected.force)}
                </dd>
              </dl>
              <button type="button" onClick={() => onAdd(selected)}>
                {addLabel ?? t("Add to workout")}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
