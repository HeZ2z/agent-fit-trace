import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthProvider } from "@/auth";
import { WorkoutDataProvider } from "@/data/provider";
import { I18nProvider } from "@/i18n";
import { PreferencesProvider } from "@/preferences";
import { SkinProvider, useSkin } from "@/theme/skin";
import { SyncLifecycle } from "@/sync/syncLifecycle";

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
      {/* Language outside skin: a language change re-renders every screen and the dock. */}
      <I18nProvider>
        <SkinProvider>
          <WorkoutDataProvider>
            {/* Auth sits inside the existing providers so account changes never remount local data, language, or skin. */}
            <AuthProvider>
              {/* Preferences sit inside auth + skin + language: one place reconciles account metadata with the local stores. */}
              <PreferencesProvider>
                <SyncLifecycle />
                <RootShell />
              </PreferencesProvider>
            </AuthProvider>
          </WorkoutDataProvider>
        </SkinProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
