import { StyleSheet, Text, type TextProps } from "react-native";

import { TYPOGRAPHY, type SkinTokens } from "@/theme";
import { useSkin } from "@/theme/skin";

export type TextTone = "default" | "muted" | "accent" | "warn" | "danger";

function toneColor(tokens: SkinTokens, tone: TextTone): string {
  switch (tone) {
    case "muted":
      return tokens.palette.muted;
    case "accent":
      return tokens.palette.accent;
    case "warn":
      return tokens.palette.warnDeep;
    case "danger":
      return tokens.palette.accentDeep;
    default:
      return tokens.palette.fg;
  }
}

export interface TextPrimitiveProps extends TextProps {
  tone?: TextTone;
}

/** Hero heading used once per screen. */
export function Display({ tone = "default", style, ...rest }: TextPrimitiveProps) {
  const { tokens } = useSkin();
  return (
    <Text
      accessibilityRole="header"
      {...rest}
      style={[styles.display, { color: toneColor(tokens, tone) }, style]}
    />
  );
}

/** Section or card heading. */
export function Title({ tone = "default", style, ...rest }: TextPrimitiveProps) {
  const { tokens } = useSkin();
  return (
    <Text
      accessibilityRole="header"
      {...rest}
      style={[styles.title, { color: toneColor(tokens, tone) }, style]}
    />
  );
}

/** Supporting paragraph copy. Muted by default for hierarchy. */
export function Body({ tone = "muted", style, ...rest }: TextPrimitiveProps) {
  const { tokens } = useSkin();
  return (
    <Text
      {...rest}
      style={[styles.body, { color: toneColor(tokens, tone) }, style]}
    />
  );
}

/** Small uppercase label that anchors a screen or card. */
export function Kicker({ tone = "muted", style, ...rest }: TextPrimitiveProps) {
  const { tokens } = useSkin();
  return (
    <Text
      {...rest}
      style={[styles.kicker, { color: toneColor(tokens, tone) }, style]}
    />
  );
}

const styles = StyleSheet.create({
  display: { ...TYPOGRAPHY.h1, letterSpacing: -0.4 },
  title: { ...TYPOGRAPHY.h2 },
  body: { ...TYPOGRAPHY.bodyText, maxWidth: 560 },
  kicker: {
    ...TYPOGRAPHY.micro,
    fontWeight: "700",
    textTransform: "uppercase",
  },
});
