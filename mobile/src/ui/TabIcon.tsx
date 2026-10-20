import { StyleSheet, View } from "react-native";

import type { SkinName, SkinTokens } from "@/theme";

export type TabIconName = "history" | "log" | "analysis" | "plan" | "coach" | "me";

interface TabIconProps {
  name: TabIconName;
  focused: boolean;
  skin: SkinName;
  tokens: SkinTokens;
  size?: number;
}

const BASE = 22;

/**
 * Token-drawn dock icons.
 *
 * The app ships no icon font or image set, so each icon is composed from a few
 * views. Pixel keeps square corners and 2dp ink rules; Glass uses rounded
 * corners and hairlines. The active icon switches to the accent colour, which
 * keeps the dock readable without a separate marker glyph.
 */
export function TabIcon({ name, focused, skin, tokens, size = BASE }: TabIconProps) {
  const isPixel = skin === "pixel";
  const color = focused ? tokens.palette.accent : tokens.palette.muted;
  const stroke = isPixel ? tokens.borderWidthThin : tokens.borderWidthThin;
  const radius = isPixel ? 0 : 3;
  const scale = size / BASE;

  const frame = {
    width: size,
    height: size,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  switch (name) {
    case "history":
      return (
        <View style={frame}>
          <View
            style={{
              width: size * 0.64,
              height: size * 0.64,
              borderRadius: isPixel ? 0 : size,
              borderWidth: stroke,
              borderColor: color,
              alignItems: "center",
              justifyContent: "center",
            }}>
            <View
              style={{
                position: "absolute",
                width: stroke,
                height: size * 0.22,
                backgroundColor: color,
                top: size * 0.08,
              }}
            />
            <View
              style={{
                position: "absolute",
                width: size * 0.18,
                height: stroke,
                backgroundColor: color,
                left: size * 0.26,
                top: size * 0.29,
              }}
            />
          </View>
        </View>
      );
    case "log":
      return (
        <View style={frame}>
          <View
            style={{
              width: size * 0.62,
              height: size * 0.62,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: radius,
              alignItems: "center",
              justifyContent: "center",
            }}>
            <View style={{ position: "absolute", width: size * 0.34, height: stroke, backgroundColor: color }} />
            <View style={{ position: "absolute", width: stroke, height: size * 0.34, backgroundColor: color }} />
          </View>
        </View>
      );
    case "analysis":
      return (
        <View style={[frame, { flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 2 * scale }]}>
          {[0.34, 0.56, 0.76].map((height) => (
            <View
              key={height}
              style={{
                width: size * 0.16,
                height: size * height,
                backgroundColor: color,
                borderRadius: isPixel ? 0 : 1,
              }}
            />
          ))}
        </View>
      );
    case "plan":
      return (
        <View style={frame}>
          <View
            style={{
              width: size * 0.66,
              height: size * 0.66,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: radius,
              padding: 2.5 * scale,
              justifyContent: "space-between",
            }}>
            {[0.9, 0.65, 0.8].map((width) => (
              <View
                key={width}
                style={{ flexDirection: "row", alignItems: "center", gap: 2 * scale }}
              >
                <View style={{ width: 3 * scale, height: 3 * scale, backgroundColor: color }} />
                <View style={{ width: size * 0.32 * width, height: stroke, backgroundColor: color }} />
              </View>
            ))}
          </View>
        </View>
      );
    case "coach":
      return (
        <View style={frame}>
          <View
            style={{
              width: size * 0.72,
              height: size * 0.52,
              borderWidth: stroke,
              borderColor: color,
              borderRadius: isPixel ? 0 : 6,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 3 * scale,
            }}>
            {[0, 1, 2].map((dot) => (
              <View
                key={dot}
                style={{ width: 2.5 * scale, height: 2.5 * scale, borderRadius: isPixel ? 0 : 999, backgroundColor: color }}
              />
            ))}
          </View>
          <View
            style={{
              width: size * 0.18,
              height: size * 0.18,
              backgroundColor: color,
              marginTop: -1,
              transform: [{ rotate: "45deg" }],
            }}
          />
        </View>
      );
    case "me":
      return (
        <View style={[frame, { justifyContent: "flex-start", paddingTop: size * 0.12 }]}>
          <View
            style={{
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: isPixel ? 0 : 999,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View
            style={{
              width: size * 0.56,
              height: size * 0.24,
              marginTop: 2 * scale,
              borderWidth: stroke,
              borderColor: color,
              borderBottomWidth: 0,
              borderTopLeftRadius: isPixel ? 0 : size,
              borderTopRightRadius: isPixel ? 0 : size,
            }}
          />
        </View>
      );
  }
}
