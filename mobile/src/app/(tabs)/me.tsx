import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";
import {
  Body,
  Button,
  Card,
  Chip,
  Display,
  Kicker,
  Screen,
  Title,
} from "@/ui";

const copy = {
  kicker: "ME",
  title: "Me",
  lede: "Your profile, appearance, and language preferences.",
  profileKicker: "PROFILE",
  profileName: "Guest lifter",
  profileBody: "Sign in to sync sessions and unlock the cloud coach.",
  appearanceTitle: "Appearance",
  appearanceBody: "Choose the visual shell for this device.",
  skinPixel: "Pixel",
  skinGlass: "Glass",
  skinPixelLabel: "Use Pixel skin",
  skinGlassLabel: "Use Glass skin",
  languageTitle: "Language",
  languageBody: "English is active for now.",
  languageEnglish: "English",
  languageChinese: "Chinese",
  languageEnglishLabel: "English language",
  languageChineseLabel: "Chinese language, coming next commit",
  languageChineseNote: "Chinese support is coming next commit.",
  signInNote: "Sign-in and cloud sync are placeholders in this commit.",
  signIn: "Sign in",
};

export default function MeScreen() {
  const router = useRouter();
  const { skin, tokens, setSkin } = useSkin();
  const { palette } = tokens;
  const isPixel = skin === "pixel";

  return (
    <Screen testID="screen-me">
      <Kicker>{copy.kicker}</Kicker>
      <Display>{copy.title}</Display>
      <Body>{copy.lede}</Body>

      <Card testID="profile-card">
        <View style={styles.profileRow}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[
              styles.avatar,
              {
                backgroundColor: palette.soft,
                borderColor: isPixel ? palette.fg : palette.glassEdge,
                borderWidth: tokens.borderWidthThin,
                borderRadius: isPixel ? 0 : 999,
              },
            ]}>
            <Text style={[styles.avatarLabel, { color: palette.fg }]}>FT</Text>
          </View>
          <View style={styles.profileCopy}>
            <Kicker>{copy.profileKicker}</Kicker>
            <Title>{copy.profileName}</Title>
            <Body>{copy.profileBody}</Body>
          </View>
        </View>
      </Card>

      <View style={styles.section}>
        <Title>{copy.appearanceTitle}</Title>
        <Body>{copy.appearanceBody}</Body>
        <View style={styles.choiceRow}>
          <Chip
            accessibilityLabel={copy.skinPixelLabel}
            label={copy.skinPixel}
            onPress={() => setSkin("pixel")}
            selected={skin === "pixel"}
            testID="skin-pixel"
          />
          <Chip
            accessibilityLabel={copy.skinGlassLabel}
            label={copy.skinGlass}
            onPress={() => setSkin("glass")}
            selected={skin === "glass"}
            testID="skin-glass"
          />
        </View>
      </View>

      <View style={styles.section}>
        <Title>{copy.languageTitle}</Title>
        <Body>{copy.languageBody}</Body>
        <View style={styles.choiceRow}>
          <Chip
            accessibilityLabel={copy.languageEnglishLabel}
            label={copy.languageEnglish}
            onPress={() => undefined}
            selected
            testID="language-english"
          />
          <Chip
            accessibilityLabel={copy.languageChineseLabel}
            disabled
            label={copy.languageChinese}
            testID="language-chinese"
          />
        </View>
        <Body>{copy.languageChineseNote}</Body>
      </View>

      <View style={styles.section}>
        <Body>{copy.signInNote}</Body>
        <Button
          accessibilityLabel="Sign in"
          fullWidth
          label={copy.signIn}
          onPress={() => router.push("/auth/sign-in")}
          testID="sign-in-button"
          variant="secondary"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING[3],
  },
  avatar: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLabel: {
    ...TYPOGRAPHY.h2,
    fontWeight: "800",
  },
  profileCopy: { flex: 1, gap: SPACING[1] },
  section: { gap: SPACING[2] },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] },
});
