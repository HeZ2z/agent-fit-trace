import { BlurView } from "expo-blur";
import { Tabs, type BottomTabBarProps } from "expo-router/js-tabs";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useI18n } from "@/i18n";
import { SPACING, TYPOGRAPHY } from "@/theme";
import { TabIcon } from "@/ui/TabIcon";
import { useSkin } from "@/theme/skin";

const TAB_ITEMS = [
  { name: "history", label: "History" },
  { name: "log", label: "Log" },
  { name: "analysis", label: "Analysis" },
  { name: "plan", label: "Plan" },
  { name: "coach", label: "Coach" },
  { name: "health", label: "Health" },
  { name: "me", label: "Me" },
] as const;

export default function TabsLayout() {
  const { tokens } = useSkin();
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: tokens.palette.shell },
      }}
      tabBar={(props) => <AppTabBar {...props} />}>
      {TAB_ITEMS.map((item) => (
        <Tabs.Screen key={item.name} name={item.name} options={{ title: t(item.label) }} />
      ))}
    </Tabs>
  );
}

/**
 * Token-driven dock. Pixel gets a 3dp ink rule and a hard offset shadow;
 * Glass gets a translucent tinted bar, rounded top corners and soft elevation.
 */
function AppTabBar({ state, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const { skin, tokens } = useSkin();
  const { t } = useI18n();
  const { palette } = tokens;
  const isPixel = skin === "pixel";
  const glassRadius = tokens.radiusCard * 2;

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: isPixel ? palette.surface : palette.glassTintHi,
          borderColor: isPixel ? palette.fg : palette.glassEdge,
          borderTopWidth: isPixel ? tokens.borderWidth : tokens.borderWidthThin,
          borderTopLeftRadius: isPixel ? 0 : glassRadius,
          borderTopRightRadius: isPixel ? 0 : glassRadius,
          paddingTop: SPACING[2],
          paddingBottom: Math.max(insets.bottom, SPACING[2]),
          paddingHorizontal: SPACING[1],
          shadowColor: tokens.shadow.color,
          shadowOffset: {
            width: tokens.shadow.offsetX,
            height: -tokens.shadow.offsetY,
          },
          shadowOpacity: 1,
          shadowRadius: tokens.shadow.blurRadius,
          elevation: isPixel ? 6 : 12,
        },
      ]}>
      {!isPixel ? (
        <BlurView
          blurMethod="dimezisBlurViewSdk31Plus"
          intensity={65}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { borderTopLeftRadius: glassRadius, borderTopRightRadius: glassRadius },
          ]}
          tint="light"
        />
      ) : null}

      <View role="tablist" style={styles.row}>
        {state.routes.map((route, index) => {
          const item = TAB_ITEMS.find((tab) => tab.name === route.name);
          if (!item) {
            return null;
          }

          const focused = state.index === index;
          const onPress = () => {
            const event = emitter.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigateToTab(route.key);
            }
          };
          const onLongPress = () => {
            emitter.emit({ type: "tabLongPress", target: route.key });
          };

          return (
            <Pressable
              key={route.key}
              accessibilityLabel={t("{label} tab", { label: t(item.label) })}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              onLongPress={onLongPress}
              onPress={onPress}
              style={({ pressed }) => [
                styles.tab,
                isPixel
                  ? {
                      borderWidth: tokens.borderWidthThin,
                      borderColor: focused ? palette.border : "transparent",
                      borderRadius: 0,
                      backgroundColor: focused ? palette.soft : "transparent",
                    }
                  : {
                      borderWidth: 0,
                      borderRadius: tokens.radiusControl,
                      backgroundColor: focused ? palette.soft : "transparent",
                    },
                pressed ? styles.pressed : null,
              ]}
              testID={`tab-${route.name}`}>
              <TabIcon focused={focused} name={item.name} tokens={tokens} />
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  {
                    color: focused ? palette.fg : palette.muted,
                    fontWeight: focused ? "800" : "600",
                  },
                ]}>
                {t(item.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { width: "100%" },
  row: { flexDirection: "row", alignItems: "stretch" },
  tab: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING[1],
    paddingHorizontal: 2,
    paddingVertical: SPACING[1],
  },
  label: { ...TYPOGRAPHY.micro, fontSize: 11, letterSpacing: 0.2 },
  pressed: { opacity: 0.7 },
});
