import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors } from "@/theme/colors";

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.kicker}>FIT TRACE · ANDROID</Text>
        <Text style={styles.title}>训练记录与证据复盘</Text>
        <Text style={styles.body}>
          React Native foundation is in place. The Pixel and Glass design system, SQLite record
          store and cloud coach land in the next commits.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, justifyContent: "center", paddingHorizontal: 24, gap: 12 },
  kicker: { color: colors.muted, fontSize: 12, letterSpacing: 1.6, fontWeight: "600" },
  title: { color: colors.ink, fontSize: 30, fontWeight: "700" },
  body: { color: colors.muted, fontSize: 15, lineHeight: 24 },
});
