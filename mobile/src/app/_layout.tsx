import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SkinProvider, useSkin } from "@/theme/skin";

function RootShell() {
  const { tokens } = useSkin();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.palette.shell }}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: tokens.palette.shell },
        }}
      />
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SkinProvider>
        <RootShell />
      </SkinProvider>
    </SafeAreaProvider>
  );
}
