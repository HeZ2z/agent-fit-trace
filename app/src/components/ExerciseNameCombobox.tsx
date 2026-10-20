/**
 * Accessible exercise-name autocomplete for the workout editor.
 *
 * The catalog is a suggestion layer, never a gate: typing stays fully valid,
 * Escape/blur only close the suggestion list, and ignoring every suggestion
 * saves the free-text name exactly as typed. Selecting a suggestion writes the
 * canonical English catalog name into the parent state (the stored spelling),
 * while the field itself and the option copy follow the UI language: Chinese
 * shows `杠铃卧推`, English shows `Barbell Bench Press - Medium Grip`.
 *
 * The input keeps a raw editing draft separate from the localized display: the
 * draft is only re-localized when the parent value changes externally (form
 * reset, another record) or — for a pristine localized selection — when the UI
 * language changes. Typing therefore never translates under the cursor — in
 * Chinese UI, typing `Squat Jump` stays `Squat Jump` — and a raw draft stays raw
 * across a language switch instead of being re-interpreted and later stored as
 * localized text. Selecting a suggestion still writes the canonical English name
 * and shows its localized display, and every keystroke passes the raw text the
 * user typed to `onChange`.
 *
 * Implemented with the WAI-ARIA combobox/listbox pattern on a single text
 * input: `role="combobox"`, `aria-expanded`, `aria-controls`,
 * `aria-activedescendant`, and `role="option"` children. Keyboard-selected rows
 * are scrolled into view, and IME composition keys (Enter/arrows) are ignored so
 * they never select a suggestion. No new dependency.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  displayStoredExerciseName,
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
  /** Called on typing (raw text) and after a suggestion is selected (canonical). */
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
  // Raw editing draft: starts as the localized display of the current value and
  // is only rebuilt on external parent changes or a language switch.
  const [draft, setDraft] = useState(() => displayStoredExerciseName(language, value));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The last value this component emitted, so its own keystrokes/selection are
  // never mistaken for an external change.
  const lastEmittedValue = useRef(value);
  const lastLanguage = useRef(language);
  // True while the draft is a localized display this field owns (a selection or
  // an externally loaded value); false once the user types raw text. A dirty
  // draft must never be re-localized by a language switch.
  const pristineDraft = useRef(true);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  // Follow external parent changes in full; on a language switch, translate only
  // a pristine display and leave raw user text exactly as typed.
  useEffect(() => {
    const languageChanged = language !== lastLanguage.current;
    const valueChanged = value !== lastEmittedValue.current;
    if (!languageChanged && !valueChanged) return;
    lastLanguage.current = language;
    lastEmittedValue.current = value;
    if (valueChanged) {
      // A new value from the parent (form reset, loading another record) is
      // authoritative: show it localized and treat the draft as pristine again.
      pristineDraft.current = true;
      setDraft(displayStoredExerciseName(language, value));
      return;
    }
    if (!pristineDraft.current) return;
    setDraft(displayStoredExerciseName(language, value));
  }, [language, value]);

  const suggestions = useMemo(
    () => searchExerciseSuggestions(draft, language),
    [draft, language],
  );
  const expanded = open && suggestions.length > 0;
  const activeSuggestion =
    expanded && activeIndex >= 0 && activeIndex < suggestions.length
      ? suggestions[activeIndex]
      : null;
  const activeOptionId =
    activeSuggestion === null ? undefined : `${listboxId}-option-${activeIndex}`;

  // Keep the keyboard-selected row inside the scrollable suggestion list.
  // Optional call: jsdom and some environments do not implement scrollIntoView.
  useEffect(() => {
    if (!expanded || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, activeIndex]);

  function close(): void {
    setOpen(false);
    setActiveIndex(-1);
  }

  function select(suggestion: ExerciseSuggestion): void {
    // Selection is the only path that writes a canonical name; the field shows
    // the localized display of that canonical name.
    lastEmittedValue.current = suggestion.canonicalName;
    pristineDraft.current = true;
    setDraft(displayStoredExerciseName(language, suggestion.canonicalName));
    onChange(suggestion.canonicalName);
    close();
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    // The parent receives exactly the text the user typed, never a localized
    // mapping of it. A typed draft is dirty: language switches leave it alone.
    const next = event.target.value;
    lastEmittedValue.current = next;
    pristineDraft.current = false;
    setDraft(next);
    onChange(next);
    setOpen(true);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // While an IME is composing, Enter/arrows belong to the input method (e.g.
    // committing Chinese text), not to this list. `keyCode === 229` is the
    // browser fallback for engines that only report composition that way.
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (composing) return;
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
          // The draft is raw while editing and localized after a selection; the
          // parent value stays canonical English either way.
          value={draft}
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
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
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
