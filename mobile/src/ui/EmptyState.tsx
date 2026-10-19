import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

import { Card } from "./Card";

interface EmptyStateProps {
  title: string;
  message: string;
  action?: ReactNode;
  testID?: string;
}

/** Quiet placeholder for surfaces that will be populated in a later commit. */
export function EmptyState({ title, message, action, testID }: EmptyStateProps) {
  const { skin, tokens } = useSkin();
  const { palette } = tokens;

  return (
    <Card padded={false} testID={testID} style={styles.card}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.marker,
          {
            backgroundColor: palette.soft,
            borderColor: skin === "pixel" ? palette.border : palette.glassEdge,
            borderWidth: tokens.borderWidthThin,
            borderRadius: skin === "pixel" ? tokens.radiusControl : 999,
          },
        ]}
      />
      <Text style={[styles.title, { color: palette.fg }]}>{title}</Text>
      <Text style={[styles.message, { color: palette.muted }]}>{message}</Text>
      {action ? <View style={styles.action}>{action}</View> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: SPACING[6], paddingHorizontal: SPACING[5] },
  marker: { width: 12, height: 12, marginBottom: SPACING[1] },
  title: { ...TYPOGRAPHY.h2 },
  message: { ...TYPOGRAPHY.bodyText, maxWidth: 520 },
  action: { marginTop: SPACING[2] },
});
