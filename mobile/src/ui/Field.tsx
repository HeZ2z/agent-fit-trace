import { useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  hint?: string;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
}

/** Labelled text input with a token-styled wrapper and visible focus state. */
export function Field({
  label,
  hint,
  containerStyle,
  inputStyle,
  editable = true,
  onFocus,
  onBlur,
  accessibilityLabel,
  placeholderTextColor,
  ...inputProps
}: FieldProps) {
  const { skin, tokens } = useSkin();
  const { palette } = tokens;
  const [focused, setFocused] = useState(false);

  const borderColor = focused
    ? palette.accent
    : skin === "pixel"
      ? palette.fg
      : palette.glassEdge;

  return (
    <View style={[styles.container, containerStyle]}>
      <Text style={[styles.label, { color: palette.fg }]}>{label}</Text>
      <View
        style={[
          styles.inputWrap,
          {
            backgroundColor: palette.surface,
            borderColor,
            borderWidth: tokens.borderWidthThin,
            borderRadius: tokens.radiusControl,
          },
        ]}>
        <TextInput
          {...inputProps}
          accessibilityLabel={accessibilityLabel ?? label}
          editable={editable}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          placeholderTextColor={placeholderTextColor ?? palette.muted}
          style={[styles.input, { color: palette.fg }, inputStyle]}
        />
      </View>
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
  inputWrap: { minHeight: 48, justifyContent: "center" },
  input: {
    ...TYPOGRAPHY.bodyText,
    minHeight: 46,
    paddingHorizontal: SPACING[3],
    paddingVertical: SPACING[2],
  },
  hint: { ...TYPOGRAPHY.micro },
});
