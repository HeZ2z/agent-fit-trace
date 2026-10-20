import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  displayStoredExerciseName,
  searchExerciseSuggestions,
  type ExerciseSuggestion,
} from "@pi-fit-trace/i18n";

import { useI18n } from "@/i18n";
import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

import { Field } from "./Field";

/** Space between the measured field and the floating suggestion panel. */
const PANEL_GAP = SPACING[2];
/**
 * Visible panel height cap in dp. The shared helper returns up to eight
 * options, which is taller than the space above the keyboard, so the panel
 * scrolls instead of growing off-screen.
 */
const PANEL_MAX_HEIGHT = 240;
/**
 * Blur-to-close delay in ms. A blur can be the first half of an option tap, so
 * the panel closes on a short timer that a refocus or an option press cancels.
 */
const BLUR_CLOSE_DELAY_MS = 150;

interface ExerciseNameFieldProps {
  /** Visible label; it is also the input's accessible name. */
  label: string;
  /** Current field value: free text or a canonical English name. */
  value: string;
  /** Called on typing (raw text) and after a suggestion is selected (canonical). */
  onChangeText: (value: string) => void;
  /** Stable test handle for the input; the list and options derive from it. */
  testID: string;
  /** Accessible name for the suggestion list, e.g. the localized "Exercises". */
  suggestionsLabel: string;
  containerStyle?: StyleProp<ViewStyle>;
}

/**
 * Labelled exercise-name input with a floating catalog suggestion panel.
 *
 * The catalog is a suggestion layer, never a gate: an ignored or custom name is
 * stored exactly as typed. The TextInput renders a local `draft` instead of the
 * parent value directly: a selected catalog name is shown through the shared
 * `displayStoredExerciseName` helper (Chinese shows `杠铃卧推`, English shows the
 * canonical English name), but free typing is never re-localized between
 * keystrokes. Every keystroke passes the raw typed text to `onChangeText`, and a
 * selection writes the suggestion's canonical English name — the only spelling a
 * record stores. The draft is re-synced only when the parent value changes
 * externally (form reset or load) or when the UI language changes. Option labels
 * are UI-language copy only: the Chinese display name in Chinese, the canonical
 * English name in English.
 *
 * The panel is an absolute overlay anchored just above the field, so the soft
 * keyboard cannot cover it while the input keeps focus. It is not a modal: the
 * options scroll inside it and tapping one is handled by the panel rather than
 * dismissing the keyboard first. It closes after a selection, on submit, and
 * whenever the query matches nothing (including the empty query); it also closes
 * shortly after the field loses focus, so moving to another field does not leave
 * panels open. The shared helper caps how many options it can contain.
 */
export function ExerciseNameField({
  label,
  value,
  onChangeText,
  testID,
  suggestionsLabel,
  containerStyle,
}: ExerciseNameFieldProps) {
  const { language } = useI18n();
  const { skin, tokens } = useSkin();
  const { palette } = tokens;

  // `draft` is the editable text; the parent `value` stays the stored spelling.
  const [draft, setDraft] = useState(() =>
    displayStoredExerciseName(language, value),
  );
  const [open, setOpen] = useState(false);
  const [fieldHeight, setFieldHeight] = useState(0);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last parent value this field emitted or adopted on an external sync. An
  // incoming value equal to it is our own echo (keep the raw draft); anything
  // else is an external form reset/load (re-localize the draft from it).
  const lastEmittedRef = useRef<string | null>(null);
  const lastLanguageRef = useRef(language);

  const suggestions = useMemo(
    () => searchExerciseSuggestions(draft, language),
    [draft, language],
  );
  const visible = open && suggestions.length > 0;
  const isPixel = skin === "pixel";
  const listTestID = `${testID}-suggestions`;

  useEffect(() => {
    const languageChanged = lastLanguageRef.current !== language;
    lastLanguageRef.current = language;
    if (!languageChanged && value === lastEmittedRef.current) {
      // The form is echoing an edit this field made; the raw draft wins.
      return;
    }
    setDraft(displayStoredExerciseName(language, value));
    // Adopt the external value as the new baseline, so a later external change
    // back to a previously emitted value is still detected as external.
    lastEmittedRef.current = value;
  }, [language, value]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
    };
  }, []);

  function clearBlurTimer(): void {
    if (blurTimerRef.current !== null) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }

  function emit(next: string): void {
    // Record the emitted value before the parent re-renders, so the sync effect
    // can tell its echo apart from an external update.
    lastEmittedRef.current = next;
    onChangeText(next);
  }

  function handleChangeText(next: string): void {
    // Raw text always goes to the parent; only a selection stores a canonical
    // name, so free text is never rewritten or translated.
    setDraft(next);
    emit(next);
    setOpen(true);
  }

  function handleFocus(): void {
    clearBlurTimer();
    setOpen(true);
  }

  function handleBlur(): void {
    // Tapping an option blurs the input before the press fires, so closing
    // immediately would swallow the selection. A short timer also catches
    // "moved to another field" and is cancelled by focus/press/submit.
    clearBlurTimer();
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null;
      setOpen(false);
    }, BLUR_CLOSE_DELAY_MS);
  }

  function close(): void {
    clearBlurTimer();
    setOpen(false);
  }

  function measureField(event: LayoutChangeEvent): void {
    // The panel is positioned in this component's own coordinate space, so the
    // measured field height is what puts its bottom edge just above the field.
    setFieldHeight(event.nativeEvent.layout.height);
  }

  function select(suggestion: ExerciseSuggestion): void {
    // Selecting is the only path that replaces what the user typed: the draft
    // shows the localized name, while the form keeps the canonical English one.
    clearBlurTimer();
    setOpen(false);
    setDraft(displayStoredExerciseName(language, suggestion.canonicalName));
    emit(suggestion.canonicalName);
  }

  return (
    <View style={[styles.container, containerStyle]}>
      <View onLayout={measureField}>
        <Field
          autoCorrect={false}
          label={label}
          onBlur={handleBlur}
          onChangeText={handleChangeText}
          onFocus={handleFocus}
          onSubmitEditing={close}
          returnKeyType="done"
          testID={testID}
          value={draft}
        />
      </View>
      {visible ? (
        <View
          accessibilityLabel={suggestionsLabel}
          accessibilityRole="list"
          style={[
            styles.panel,
            {
              bottom: fieldHeight + PANEL_GAP,
              backgroundColor: palette.surface,
              borderColor: isPixel ? palette.fg : palette.glassEdge,
              borderWidth: tokens.borderWidthThin,
              borderRadius: tokens.radiusControl,
              shadowColor: tokens.shadow.color,
              shadowOffset: {
                width: tokens.shadow.offsetX,
                height: tokens.shadow.offsetY,
              },
              shadowOpacity: 1,
              shadowRadius: tokens.shadow.blurRadius,
            },
          ]}
          testID={listTestID}>
          <ScrollView
            keyboardDismissMode="none"
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            style={styles.scroll}>
            {suggestions.map((suggestion, index) => (
              <Pressable
                key={suggestion.canonicalName}
                accessibilityLabel={suggestion.label}
                accessibilityRole="button"
                onPress={() => select(suggestion)}
                style={({ pressed }) => [
                  styles.option,
                  index > 0
                    ? {
                        borderTopColor: palette.hair,
                        borderTopWidth: tokens.borderWidthThin,
                      }
                    : null,
                  pressed ? { backgroundColor: palette.soft } : null,
                ]}
                testID={`${listTestID}-${index}`}>
                <Text style={[styles.optionLabel, { color: palette.fg }]}>
                  {suggestion.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING[2] },
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
    // Android draws elevated siblings above the cards, so the panel stays on
    // top of the content it overlaps; other platforms ignore elevation.
    elevation: 10,
    overflow: "hidden",
  },
  scroll: { maxHeight: PANEL_MAX_HEIGHT },
  option: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: SPACING[3],
    paddingVertical: SPACING[2],
  },
  optionLabel: { ...TYPOGRAPHY.bodyText },
});
