import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { useI18n } from "@/i18n";
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
  languageLede:
    "Choose the interface language. Workout records, saved snapshots and exported JSON keep their original English; only the interface is translated.",
  languageEnglish: "English",
  languageChinese: "简体中文",
  languageEnglishLabel: "English language",
  languageChineseLabel: "Chinese language",
  languageEnglishBody: "Source language. Data and exports stay in English.",
  languageChineseBody:
    "Display layer only: interface copy in Chinese; records and exports stay canonical English.",
  signInNote: "Sign-in and cloud sync are placeholders in this commit.",
  signIn: "Sign in",
};

export default function MeScreen() {
  const router = useRouter();
  const { language, setLanguage, t } = useI18n();
  const { skin, tokens, setSkin } = useSkin();
  const { palette } = tokens;
  const isPixel = skin === "pixel";
  const languageBody =
    language === "zh" ? copy.languageChineseBody : copy.languageEnglishBody;

  return (
    <Screen testID="screen-me">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>

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
            <Kicker>{t(copy.profileKicker)}</Kicker>
            <Title>{t(copy.profileName)}</Title>
            <Body>{t(copy.profileBody)}</Body>
          </View>
        </View>
      </Card>

      <View style={styles.section}>
        <Title>{t(copy.appearanceTitle)}</Title>
        <Body>{t(copy.appearanceBody)}</Body>
        <View style={styles.choiceRow}>
          <Chip
            accessibilityLabel={t(copy.skinPixelLabel)}
            label={t(copy.skinPixel)}
            onPress={() => setSkin("pixel")}
            selected={skin === "pixel"}
            testID="skin-pixel"
          />
          <Chip
            accessibilityLabel={t(copy.skinGlassLabel)}
            label={t(copy.skinGlass)}
            onPress={() => setSkin("glass")}
            selected={skin === "glass"}
            testID="skin-glass"
          />
        </View>
      </View>

      <View style={styles.section}>
        <Title>{t(copy.languageTitle)}</Title>
        <Body>{t(copy.languageLede)}</Body>
        <View style={styles.choiceRow}>
          <Chip
            accessibilityLabel={t(copy.languageEnglishLabel)}
            label={t(copy.languageEnglish)}
            onPress={() => setLanguage("en")}
            selected={language === "en"}
            testID="language-english"
          />
          <Chip
            accessibilityLabel={t(copy.languageChineseLabel)}
            label={t(copy.languageChinese)}
            onPress={() => setLanguage("zh")}
            selected={language === "zh"}
            testID="language-chinese"
          />
        </View>
        <Body>{t(languageBody)}</Body>
      </View>

      <View style={styles.section}>
        <Body>{t(copy.signInNote)}</Body>
        <Button
          accessibilityLabel={t(copy.signIn)}
          fullWidth
          label={t(copy.signIn)}
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
