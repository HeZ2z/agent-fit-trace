import { StyleSheet, View } from "react-native";

import type { SkinTokens } from "@/theme";

export type TabIconName = "history" | "log" | "analysis" | "plan" | "coach" | "me";

type Rect = readonly [x: number, y: number, width: number, height: number];

/**
 * Dock pictograms copied from the web's `app/src/components/PixelIcon.tsx`.
 *
 * The rectangles live on a 24-unit grid, so a 24dp box renders them crisp and
 * both skins share the exact glyphs the desktop app uses. Only the colour
 * changes: muted for inactive tabs, accent for the active one.
 */
const GLYPHS: Record<TabIconName, readonly Rect[]> = {
  // Three list rows: a square bullet and a rule.
  history: [
    [3, 4, 3, 3],
    [9, 4, 12, 3],
    [3, 10, 3, 3],
    [9, 10, 12, 3],
    [3, 16, 3, 3],
    [9, 16, 12, 3],
  ],
  // A chunky plus.
  log: [
    [10, 3, 4, 18],
    [3, 10, 18, 4],
  ],
  // Three columns of increasing height.
  analysis: [
    [3, 14, 4, 7],
    [10, 9, 4, 12],
    [17, 4, 4, 17],
  ],
  // A training bag with a handle.
  plan: [
    [6, 4, 12, 3],
    [4, 8, 16, 13],
  ],
  // A speech bubble with a tail.
  coach: [
    [3, 4, 18, 13],
    [7, 17, 5, 4],
  ],
  // A square-headed figure.
  me: [
    [8, 3, 8, 8],
    [4, 13, 16, 8],
  ],
};

interface TabIconProps {
  name: TabIconName;
  focused: boolean;
  tokens: SkinTokens;
  size?: number;
}

const GRID = 24;

export function TabIcon({ name, focused, tokens, size = GRID }: TabIconProps) {
  const unit = size / GRID;
  const color = focused ? tokens.palette.accent : tokens.palette.muted;

  return (
    <View
      style={[styles.frame, { width: size, height: size }]}
      accessibilityElementsHidden
      importantForAccessibility="no">
      {GLYPHS[name].map(([x, y, width, height], index) => (
        <View
          key={`${name}-${index}`}
          style={{
            position: "absolute",
            left: x * unit,
            top: y * unit,
            width: width * unit,
            height: height * unit,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { alignItems: "center", justifyContent: "center" },
});
