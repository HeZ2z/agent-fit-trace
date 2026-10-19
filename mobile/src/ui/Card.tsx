import type { ReactNode } from "react";
import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";

import { SPACING } from "@/theme";
import { useSkin } from "@/theme/skin";

interface CardProps extends ViewProps {
  children: ReactNode;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Opaque content surface. Glass deliberately keeps the same solid surface so
 * long-form text never sits directly on the blurred app background.
 */
export function Card({ children, padded = true, style, ...rest }: CardProps) {
  const { skin, tokens } = useSkin();
  const { palette } = tokens;

  return (
    <View
      {...rest}
      style={[
        styles.card,
        padded ? styles.padded : null,
        {
          backgroundColor: palette.surface,
          borderColor: skin === "pixel" ? palette.border : palette.glassEdge,
          borderWidth: skin === "pixel" ? tokens.borderWidth : tokens.borderWidthThin,
          borderRadius: tokens.radiusCard,
        },
        skin === "glass"
          ? {
              shadowColor: tokens.shadow.color,
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: 1,
              shadowRadius: 18,
              elevation: 3,
            }
          : null,
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: SPACING[2] },
  padded: { padding: SPACING[4] },
});
