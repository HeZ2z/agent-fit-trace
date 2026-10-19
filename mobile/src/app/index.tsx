import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";

export default function HomeScreen() {
  const { skin, tokens, toggleSkin } = useSkin();
  const { palette } = tokens;
  const swatches = [palette.fg, palette.accent, palette.border, palette.soft, palette.pale];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.shell }]}>
      <View style={styles.content}>
        <Text style={[styles.kicker, { color: palette.muted }]}>FIT TRACE · ANDROID</Text>
        <Text style={[styles.title, { color: palette.fg }]}>训练记录与证据复盘</Text>
        <Text style={[styles.body, { color: palette.muted }]}>
          React Native foundation is running on the shared Pixel/Glass token contract. SQLite
          records and the cloud coach land in the next commits.
        </Text>

        <View style={styles.swatches}>
          {swatches.map((color) => (
            <View
              key={color}
              style={{
                width: 40,
                height: 40,
                backgroundColor: color,
                borderWidth: tokens.borderWidth,
                borderColor: palette.fg,
                borderRadius: tokens.radiusControl,
              }}
            />
          ))}
        </View>

        <Pressable
          onPress={toggleSkin}
          accessibilityRole="button"
          style={[
            styles.button,
            {
              backgroundColor: palette.accent,
              borderColor: palette.fg,
              borderWidth: tokens.borderWidth,
              borderRadius: tokens.radiusControl,
              shadowColor: tokens.shadow.color,
              shadowOffset: { width: tokens.shadow.offsetX, height: tokens.shadow.offsetY },
              shadowOpacity: 1,
              shadowRadius: tokens.shadow.blurRadius,
              elevation: 2,
            },
          ]}>
          <Text style={styles.buttonLabel}>
            {skin === "pixel" ? "Switch to Glass" : "Switch to Pixel"}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 24, gap: SPACING[3] },
  kicker: { ...TYPOGRAPHY.micro, fontWeight: "600" },
  title: { ...TYPOGRAPHY.h1, letterSpacing: -0.4 },
  body: { ...TYPOGRAPHY.bodyText, maxWidth: 420 },
  swatches: { flexDirection: "row", gap: SPACING[2], marginVertical: SPACING[4] },
  button: { alignSelf: "flex-start", paddingHorizontal: 18, paddingVertical: 12 },
  buttonLabel: { color: "#ffffff", ...TYPOGRAPHY.bodyText, fontWeight: "700" },
});
