import type { ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SPACING } from "@/theme";
import { useSkin } from "@/theme/skin";

interface ScreenProps {
  children: ReactNode;
  /** Stable test handle for the whole screen, e.g. `screen-history`. */
  testID?: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /**
   * Stack screens (auth) own the bottom edge; tab screens do not, because the
   * custom dock already consumes the bottom safe area.
   */
  bottomInset?: boolean;
}

const TAB_SCREEN_EDGES = ["top", "left", "right"] as const;
const STACK_SCREEN_EDGES = ["top", "left", "right", "bottom"] as const;

/**
 * Page shell: top safe area, page padding, and a scrolling content column.
 * The bottom safe area is owned by the tab bar unless `bottomInset` is set.
 */
export function Screen({
  children,
  testID,
  contentContainerStyle,
  bottomInset = false,
}: ScreenProps) {
  const { tokens } = useSkin();

  return (
    <SafeAreaView
      testID={testID}
      edges={bottomInset ? STACK_SCREEN_EDGES : TAB_SCREEN_EDGES}
      style={[styles.safe, { backgroundColor: tokens.palette.shell }]}>
      <ScrollView
        contentContainerStyle={[styles.content, contentContainerStyle]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    paddingHorizontal: SPACING[5],
    paddingTop: SPACING[5],
    paddingBottom: SPACING[6],
    gap: SPACING[4],
  },
});
