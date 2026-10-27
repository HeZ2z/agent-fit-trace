import { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
} from "@react-native-community/datetimepicker";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

/**
 * Labelled date field backed by the native picker (`@react-native-community/
 * datetimepicker`). The value is always a "YYYY-MM-DD" string; there is no
 * manual typing. Android opens the platform dialog imperatively through
 * `DateTimePickerAndroid.open`; iOS toggles an inline picker below the row
 * (closed again by the done affordance). On platforms without a native picker
 * the row renders read-only — no value can be entered by hand.
 *
 * The package ships a no-op cross-platform fallback module, so the static
 * import is safe to bundle everywhere; the fallback only warns when used.
 */

/** Local "YYYY-MM-DD" for a `Date`'s calendar day (never UTC-shifted). */
export function isoFromLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parse "YYYY-MM-DD" into a local-midnight `Date`, or null when malformed. */
function parseIsoDateToLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface DateFieldProps {
  label: string;
  /** The shown date, "YYYY-MM-DD" (already validated by the caller's model). */
  value: string;
  /** Called with the picked day as "YYYY-MM-DD"; never called on dismiss. */
  onConfirm: (isoDate: string) => void;
  hint?: string;
  /** Copy for the iOS inline picker's close affordance. */
  doneLabel?: string;
  accessibilityLabel?: string;
  testID?: string;
}

export function DateField({
  label,
  value,
  onConfirm,
  hint,
  doneLabel = "Done",
  accessibilityLabel,
  testID,
}: DateFieldProps) {
  const { skin, tokens } = useSkin();
  const { palette } = tokens;
  const [iosOpen, setIosOpen] = useState(false);

  const borderColor = iosOpen
    ? palette.accent
    : skin === "pixel"
      ? palette.fg
      : palette.glassEdge;

  function openPicker(): void {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: parseIsoDateToLocal(value) ?? new Date(),
        mode: "date",
        onChange: (event, date) => {
          if (event.type === "set" && date !== undefined) {
            onConfirm(isoFromLocalDate(date));
          }
        },
      });
      return;
    }
    if (Platform.OS === "ios") {
      setIosOpen((open) => !open);
    }
  }

  return (
    <View style={styles.container} testID={testID}>
      <Text style={[styles.label, { color: palette.fg }]}>{label}</Text>
      <Pressable
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityRole="button"
        disabled={Platform.OS !== "android" && Platform.OS !== "ios"}
        onPress={openPicker}
        style={[
          styles.valueWrap,
          {
            backgroundColor: palette.surface,
            borderColor,
            borderWidth: tokens.borderWidthThin,
            borderRadius: tokens.radiusControl,
          },
        ]}>
        <Text style={[styles.value, { color: palette.fg }]}>{value}</Text>
      </Pressable>
      {Platform.OS === "ios" && iosOpen ? (
        <>
          <DateTimePicker
            mode="date"
            onChange={(event, date) => {
              if (event.type === "set" && date !== undefined) {
                onConfirm(isoFromLocalDate(date));
              }
            }}
            value={parseIsoDateToLocal(value) ?? new Date()}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => setIosOpen(false)}
            style={styles.done}>
            <Text style={[styles.doneLabel, { color: palette.accent }]}>
              {doneLabel}
            </Text>
          </Pressable>
        </>
      ) : null}
      {hint ? <Text style={[styles.hint, { color: palette.muted }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING[2] },
  label: {
    ...TYPOGRAPHY.micro,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  valueWrap: { minHeight: 48, justifyContent: "center" },
  value: {
    ...TYPOGRAPHY.bodyText,
    minHeight: 46,
    paddingHorizontal: SPACING[3],
    paddingVertical: SPACING[2],
  },
  done: { alignItems: "flex-end" },
  doneLabel: { ...TYPOGRAPHY.bodyText, fontWeight: "700" },
  hint: { ...TYPOGRAPHY.micro },
});
