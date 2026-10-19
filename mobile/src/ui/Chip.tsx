import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Selectable pill. Selection is exposed as accessibilityState.selected so
 * assistive tech and tests can read it without relying on colour alone.
 */
export function Chip({
  label,
  selected = false,
  onPress,
  disabled = false,
  testID,
  accessibilityLabel,
  style,
}: ChipProps) {
  const { skin, tokens } = useSkin();
  const { palette } = tokens;
  const isPixel = skin === "pixel";

  const backgroundColor = selected ? palette.accent : palette.surface;
  const borderColor = selected
    ? isPixel
      ? palette.fg
      : palette.accentDeep
    : isPixel
      ? palette.fg
      : palette.glassEdge;
  const foregroundColor = selected ? palette.background : palette.fg;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={disabled ? { selected, disabled: true } : { selected }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor,
          borderColor,
          borderWidth: tokens.borderWidthThin,
          borderRadius: isPixel ? tokens.radiusControl : 999,
        },
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.marker,
          {
            backgroundColor: selected ? foregroundColor : "transparent",
            borderColor: selected ? foregroundColor : palette.muted,
            borderWidth: selected ? 0 : tokens.borderWidthThin,
            borderRadius: isPixel ? 0 : 999,
          },
        ]}
      />
      <Text style={[styles.label, { color: foregroundColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING[2],
    justifyContent: "center",
    paddingHorizontal: SPACING[4],
    paddingVertical: SPACING[2],
  },
  marker: { width: 7, height: 7 },
  label: { ...TYPOGRAPHY.bodyText, fontWeight: "700" },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
});
