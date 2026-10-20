import { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  searchExerciseSuggestions,
  type ExerciseSuggestion,
} from "@pi-fit-trace/i18n";

import { useI18n } from "@/i18n";
import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

import { Field } from "./Field";

interface ExerciseNameFieldProps {
  /** Visible label; it is also the input's accessible name. */
  label: string;
  /** Current field value: free text or a canonical English name. */
  value: string;
  /** Called on typing and after a suggestion is selected. */
  onChangeText: (value: string) => void;
  /** Stable test handle for the input; the list and options derive from it. */
  testID: string;
  /** Accessible name for the suggestion list, e.g. the localized "Exercises". */
  suggestionsLabel: string;
  containerStyle?: StyleProp<ViewStyle>;
}

/**
 * Labelled exercise-name input with inline catalog suggestions.
 *
 * The catalog is a suggestion layer, never a gate: typing stays fully valid and
 * ignoring every suggestion saves the free-text name exactly as authored. A
 * selection writes the suggestion's canonical English name — the stored
 * spelling — while option copy follows the UI language through the shared
 * helper (Chinese shows the display name plus the canonical name, English shows
 * the canonical name alone).
 *
 * Suggestions render inline under the input rather than in an overlay, so they
 * cannot cover another field and the surrounding screen keeps scrolling. They
 * close after a selection, on submit, and whenever the query matches nothing
 * (including the empty query), and they are capped by the shared helper.
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

  const suggestions = useMemo(
    () => searchExerciseSuggestions(value, language),
    [value, language],
  );
  const visible = open && suggestions.length > 0;
  const isPixel = skin === "pixel";
  const listTestID = `${testID}-suggestions`;

  function close(): void {
    setOpen(false);
  }

  function select(suggestion: ExerciseSuggestion): void {
    // Free text never triggers this path; selecting is the only way the field
    // replaces what the user typed with a catalog name.
    setOpen(false);
    onChangeText(suggestion.canonicalName);
  }

  return (
    <View style={[styles.container, containerStyle]}>
      <Field
        autoCorrect={false}
        label={label}
        onChangeText={(next) => {
          // Typing re-opens the list; an empty or unmatched query renders no
          // list because the shared helper returns no suggestions.
          setOpen(true);
          onChangeText(next);
        }}
        onFocus={() => setOpen(true)}
        onSubmitEditing={close}
        returnKeyType="done"
        testID={testID}
        value={value}
      />
      {visible ? (
        <View
          accessibilityLabel={suggestionsLabel}
          accessibilityRole="list"
          style={[
            styles.list,
            {
              backgroundColor: palette.surface,
              borderColor: isPixel ? palette.fg : palette.glassEdge,
              borderWidth: tokens.borderWidthThin,
              borderRadius: tokens.radiusControl,
            },
          ]}
          testID={listTestID}>
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
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING[2] },
  list: { overflow: "hidden" },
  option: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: SPACING[3],
    paddingVertical: SPACING[2],
  },
  optionLabel: { ...TYPOGRAPHY.bodyText },
});
