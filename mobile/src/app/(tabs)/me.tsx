import { useRouter } from "expo-router";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { authErrorMessage, useAuth } from "@/auth";
import { useI18n } from "@/i18n";
import { usePreferences } from "@/preferences";
import { readSyncConfig } from "@/sync/syncClient";
import { SPACING, TYPOGRAPHY } from "@/theme";
import { useSkin } from "@/theme/skin";
import {
  Banner,
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
  profileKicker: "PROFILE",
  profileName: "Guest lifter",
  profileBody: "Sign in to sync sessions and unlock the cloud coach.",
  accountKicker: "ACCOUNT",
  signedIn: "Signed in",
  accountFallback: "Account",
  signedInBody:
    "Cloud sync is optional and manual. The cloud coach is available while signed in. You can sign out at any time.",
  prefsSyncing: "Saving preferences to your account…",
  prefsSynced: "Preferences are saved to your account.",
  prefsSyncError:
    "Preferences could not be saved to your account. Your choices still apply on this device.",
  guestNote: "Local-only on this device. Sign in to sync and use the cloud coach.",
  syncKicker: "SYNC",
  syncTitle: "Cloud sync",
  syncReady: "Manual sync available. Nothing uploads until you start it.",
  syncUnconfigured:
    "Cloud sync is not configured in this build. Your workouts stay on this device.",
  syncOpen: "Open sync",
  restoring: "Restoring your account…",
  unconfigured:
    "Account sign-in is not configured in this build. Your workouts stay on this device.",
  signIn: "Sign in",
  signOut: "Sign out",
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
};

export default function MeScreen() {
  const router = useRouter();
  const { language, setLanguage, t } = useI18n();
  const { skin, tokens, setSkin } = useSkin();
  const { status, user, error, signOut } = useAuth();
  const { status: preferencesStatus } = usePreferences();
  const { palette } = tokens;
  const isPixel = skin === "pixel";
  const signedIn = status === "signed-in";
  // The build-level API configuration is static; a signed-in user still sees
  // whether this build can reach the cloud before opening the manual screen.
  const syncConfigured = useMemo(() => readSyncConfig().status === "configured", []);
  const languageBody =
    language === "zh" ? copy.languageChineseBody : copy.languageEnglishBody;
  const preferencesSyncMessage =
    preferencesStatus === "error"
      ? copy.prefsSyncError
      : preferencesStatus === "synced"
        ? copy.prefsSynced
        : copy.prefsSyncing;

  return (
    <Screen testID="screen-me">
      <Display>{t(copy.title)}</Display>

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
            {signedIn ? (
              <>
                <Kicker>{t(copy.accountKicker)}</Kicker>
                <Title>{t(copy.signedIn)}</Title>
                <Body testID="me-account-email" tone="default" style={styles.email}>
                  {user?.email ?? t(copy.accountFallback)}
                </Body>
                <Body>{t(copy.signedInBody)}</Body>
                <Body
                  testID="prefs-sync-status"
                  tone={preferencesStatus === "error" ? "warn" : "muted"}>
                  {t(preferencesSyncMessage)}
                </Body>
                <Button
                  accessibilityLabel={t(copy.signOut)}
                  fullWidth
                  label={t(copy.signOut)}
                  onPress={() => {
                    void signOut();
                  }}
                  testID="auth-sign-out"
                  variant="secondary"
                />
              </>
            ) : (
              <>
                <Kicker>{t(copy.profileKicker)}</Kicker>
                <Title>{t(copy.profileName)}</Title>
                <Body>{t(copy.profileBody)}</Body>
                {status === "loading" ? <Body>{t(copy.restoring)}</Body> : null}
                {status === "unconfigured" ? (
                  <Banner
                    message={t(copy.unconfigured)}
                    testID="me-auth-unconfigured"
                    tone="info"
                  />
                ) : null}
                {error !== null ? (
                  <Banner
                    message={t(authErrorMessage(error.code))}
                    testID="me-auth-error"
                    tone="warn"
                  />
                ) : null}
                <Body>{t(copy.guestNote)}</Body>
                <Button
                  accessibilityLabel={t(copy.signIn)}
                  disabled={status === "loading"}
                  fullWidth
                  label={t(copy.signIn)}
                  onPress={() => router.push("/auth/sign-in")}
                  testID="me-sign-in"
                  variant="secondary"
                />
              </>
            )}
          </View>
        </View>
      </Card>

      {signedIn ? (
        <Card testID="me-sync-section">
          <Kicker>{t(copy.syncKicker)}</Kicker>
          <Title>{t(copy.syncTitle)}</Title>
          <Body testID="me-sync-status" tone={syncConfigured ? "muted" : "warn"}>
            {t(syncConfigured ? copy.syncReady : copy.syncUnconfigured)}
          </Body>
          <Button
            accessibilityLabel={t(copy.syncOpen)}
            fullWidth
            label={t(copy.syncOpen)}
            onPress={() => router.push("/sync")}
            testID="me-sync-open"
            variant="secondary"
          />
        </Card>
      ) : null}

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
  email: { fontWeight: "700" },
  section: { gap: SPACING[2] },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] },
});
