import {
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  fullWidth?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Pixel: square, 3dp ink border, hard offset shadow.
 * Glass: rounded hairline border, soft elevation, translucent secondary fill.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  fullWidth = false,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps) {
  const { skin, tokens } = useSkin();
  const { palette } = tokens;
  const isPixel = skin === "pixel";
  const isPrimary = variant === "primary";

  const backgroundColor = isPrimary
    ? palette.accent
    : isPixel
      ? palette.surface
      : palette.glassTintHi;
  const borderColor = isPrimary
    ? isPixel
      ? palette.fg
      : palette.accentDeep
    : isPixel
      ? palette.fg
      : palette.glassEdge;
  const foregroundColor = isPrimary ? palette.background : palette.fg;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        fullWidth ? styles.fullWidth : styles.selfStart,
        {
          backgroundColor,
          borderColor,
          borderWidth: isPixel ? tokens.borderWidth : tokens.borderWidthThin,
          borderRadius: tokens.radiusControl,
          shadowColor: tokens.shadow.color,
          shadowOffset: {
            width: tokens.shadow.offsetX,
            height: tokens.shadow.offsetY,
          },
          shadowOpacity: 1,
          shadowRadius: tokens.shadow.blurRadius,
          elevation: isPixel ? 2 : 5,
        },
        pressed && !disabled
          ? isPixel
            ? {
                opacity: 0.9,
                transform: [
                  { translateX: tokens.shadow.offsetX / 2 },
                  { translateY: tokens.shadow.offsetY / 2 },
                ],
              }
            : { opacity: 0.86 }
          : null,
        disabled ? styles.disabled : null,
        style,
      ]}>
      <Text style={[styles.label, { color: foregroundColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING[4],
    paddingVertical: SPACING[3],
  },
  selfStart: { alignSelf: "flex-start" },
  fullWidth: { alignSelf: "stretch" },
  label: { ...TYPOGRAPHY.bodyText, fontWeight: "700" },
  disabled: { opacity: 0.45 },
});
