import { useMemo, useState } from "react";
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
 * The catalog is a suggestion layer, never a gate: typing stays fully valid and
 * ignoring every suggestion saves the free-text name exactly as authored. The
 * input is a display surface only — its visible text follows the UI language
 * through the shared `displayStoredExerciseName` helper (Chinese shows
 * `杠铃卧推`, English shows the canonical English name) while the parent value
 * stays the stored spelling. Every keystroke still passes the raw typed text to
 * `onChangeText`, and a selection writes the suggestion's canonical English name
 * into the form. Option labels are UI-language copy only: the Chinese display
 * name in Chinese, the canonical English name in English.
 *
 * The panel is an absolute overlay anchored just above the field, so the soft
 * keyboard cannot cover it while the input keeps focus. It is not a modal: the
 * options scroll inside it and tapping one is handled by the panel rather than
 * dismissing the keyboard first. It closes after a selection, on submit, and
 * whenever the query matches nothing (including the empty query), and the
 * shared helper caps how many options it can contain.
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
  const [open, setOpen] = useState(false);
  const [fieldHeight, setFieldHeight] = useState(0);

  const suggestions = useMemo(
    // Search ranks the parent value — canonical English or the raw typed text —
    // never the localized display text, so the stored spelling drives matching.
    () => searchExerciseSuggestions(value, language),
    [value, language],
  );
  // The parent value stays canonical; only the rendered text is localized, so a
  // selected catalog name shows as its Chinese display name in Chinese UI.
  const visibleValue = displayStoredExerciseName(language, value);
  const visible = open && suggestions.length > 0;
  const isPixel = skin === "pixel";
  const listTestID = `${testID}-suggestions`;

  function close(): void {
    setOpen(false);
  }

  function measureField(event: LayoutChangeEvent): void {
    // The panel is positioned in this component's own coordinate space, so the
    // measured field height is what puts its bottom edge just above the field.
    setFieldHeight(event.nativeEvent.layout.height);
  }

  function select(suggestion: ExerciseSuggestion): void {
    // Free text never triggers this path; selecting is the only way the field
    // replaces what the user typed with a catalog name.
    setOpen(false);
    onChangeText(suggestion.canonicalName);
  }

  return (
    <View style={[styles.container, containerStyle]}>
      <View onLayout={measureField}>
        <Field
          autoCorrect={false}
          label={label}
          onChangeText={(next) => {
            // Typing re-opens the list and passes exactly the text the user
            // typed to the parent, never the localized display text; an empty
            // or unmatched query renders no list because the shared helper
            // returns no suggestions.
            setOpen(true);
            onChangeText(next);
          }}
          onFocus={() => setOpen(true)}
          onSubmitEditing={close}
          returnKeyType="done"
          testID={testID}
          value={visibleValue}
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
