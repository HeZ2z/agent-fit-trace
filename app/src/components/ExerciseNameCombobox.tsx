/**
 * Accessible exercise-name autocomplete for the workout editor.
 *
 * The catalog is a suggestion layer, never a gate: typing stays fully valid,
 * Escape/blur only close the suggestion list, and ignoring every suggestion
 * saves the free-text name exactly as typed. Selecting a suggestion writes the
 * canonical English catalog name into the field (the stored spelling), while
 * the option copy follows the UI language: Chinese shows the display name plus
 * that canonical name, English shows the canonical name alone.
 *
 * Implemented with the WAI-ARIA combobox/listbox pattern on a single text
 * input: `role="combobox"`, `aria-expanded`, `aria-controls`,
 * `aria-activedescendant`, and `role="option"` children. No new dependency.
 */

import { useMemo, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  searchExerciseSuggestions,
} from "../i18n/exercises.ts";
import type { ExerciseSuggestion } from "../i18n/exercises.ts";
import { useI18n } from "../i18n/useI18n.ts";

export interface ExerciseNameComboboxProps {
  /** Input id owned by the caller; `label` is associated through it. */
  id: string;
  /** Visible label text, which is also the input's accessible name. */
  label: string;
  /** Current field value: free text or a canonical English name. */
  value: string;
  /** Called on typing and after a suggestion is selected. */
  onChange: (value: string) => void;
}

export function ExerciseNameCombobox({
  id,
  label,
  value,
  onChange,
}: ExerciseNameComboboxProps) {
  const { language, t } = useI18n();
  const listboxId = `${id}-suggestions`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const suggestions = useMemo(
    () => searchExerciseSuggestions(value, language),
    [value, language],
  );
  const expanded = open && suggestions.length > 0;
  const activeSuggestion =
    expanded && activeIndex >= 0 && activeIndex < suggestions.length
      ? suggestions[activeIndex]
      : null;
  const activeOptionId =
    activeSuggestion === null ? undefined : `${listboxId}-option-${activeIndex}`;

  function close(): void {
    setOpen(false);
    setActiveIndex(-1);
  }

  function select(suggestion: ExerciseSuggestion): void {
    onChange(suggestion.canonicalName);
    close();
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange(event.target.value);
    setOpen(true);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case "ArrowDown": {
        if (suggestions.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActiveIndex((previous) =>
          previous < 0 || previous >= suggestions.length - 1 ? 0 : previous + 1,
        );
        return;
      }
      case "ArrowUp": {
        if (suggestions.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActiveIndex((previous) =>
          previous <= 0 ? suggestions.length - 1 : previous - 1,
        );
        return;
      }
      case "Enter": {
        // A highlighted suggestion is chosen; otherwise Enter keeps its normal
        // meaning (the surrounding form handles submission of the free text).
        if (activeSuggestion === null) return;
        event.preventDefault();
        select(activeSuggestion);
        return;
      }
      case "Escape": {
        // Close-only: never clear the typed name, so a custom exercise remains
        // saveable after dismissing the suggestions.
        if (!expanded) return;
        event.preventDefault();
        close();
        return;
      }
      default:
        return;
    }
  }

  return (
    <div className="field exercise-name-field">
      <label htmlFor={id}>{label}</label>
      <div className="exercise-combobox">
        <input
          id={id}
          type="text"
          role="combobox"
          value={value}
          autoComplete="off"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={expanded ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          onBlur={close}
        />
        {expanded && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={t("Exercises")}
            className="exercise-suggestions"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion.canonicalName}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-exercise-name={suggestion.canonicalName}
                className={
                  index === activeIndex
                    ? "exercise-suggestion exercise-suggestion-active"
                    : "exercise-suggestion"
                }
                // Keep focus on the input so selecting never fires a blur that
                // closes the list before the click is handled.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(suggestion)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {suggestion.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
