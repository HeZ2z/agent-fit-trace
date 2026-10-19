import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

export type BannerTone = "info" | "warn" | "danger";

interface BannerProps {
  tone?: BannerTone;
  title?: string;
  message: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** Inline status callout. Text is wrapped explicitly to keep contrast on tone fills. */
export function Banner({ tone = "info", title, message, testID, style }: BannerProps) {
  const { tokens } = useSkin();
  const { palette } = tokens;

  const toneStyles =
    tone === "warn"
      ? {
          backgroundColor: palette.warnSoft,
          borderColor: palette.warn,
          textColor: palette.warnDeep,
        }
      : tone === "danger"
        ? {
            backgroundColor: palette.dangerSoft,
            borderColor: palette.accent,
            textColor: palette.accentDeep,
          }
        : {
            backgroundColor: palette.infoSoft,
            borderColor: palette.border,
            textColor: palette.fg,
          };

  return (
    <View
      accessibilityLiveRegion="polite"
      testID={testID}
      style={[
        styles.banner,
        {
          backgroundColor: toneStyles.backgroundColor,
          borderColor: toneStyles.borderColor,
          borderWidth: tokens.borderWidthThin,
          borderRadius: tokens.radiusCard,
        },
        style,
      ]}>
      {title ? (
        <Text style={[styles.title, { color: toneStyles.textColor }]}>{title}</Text>
      ) : null}
      <Text style={[styles.message, { color: toneStyles.textColor }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: SPACING[4],
    paddingVertical: SPACING[3],
    gap: SPACING[1],
  },
  title: { ...TYPOGRAPHY.bodyText, fontWeight: "800" },
  message: { ...TYPOGRAPHY.bodyText },
});
