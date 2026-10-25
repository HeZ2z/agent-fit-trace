import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { authErrorMessage, useAuth } from "@/auth";
import { getHealthConnectProvider } from "@/health/healthConnect";
import {
  healthConnectStatusKey,
  SLEEP_READ_SCOPE,
  type HealthAvailability,
  type HealthConnectStatusKey,
  type PermissionRequestResult,
} from "@/health/healthModel";
import { useI18n } from "@/i18n";
import {
  readHealthConnectEnabled,
  writeHealthConnectEnabled,
} from "@/preferences/deviceHealth";
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
  lede: "Your profile, appearance, and language preferences.",
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
  healthKicker: "HEALTH",
  healthTitle: "Health Connect",
  healthLede:
    "Optional, device-local and read-only. Used to import sleep into the Log form; nothing is uploaded.",
  healthScopes: "Read-only scopes: sleep sessions and resting heart rate.",
  healthStatusOff: "Off. Enable it to import sleep into the Log form.",
  healthStatusSupported: "Connected. The Log form can import sleep for the night before a session.",
  healthStatusNoPermission:
    "Sleep access has been revoked. Go to the system Health Connect settings and re-grant the read permission.",
  healthStatusNeedsInstall:
    "Health Connect is not installed. Install it from the Google Play Store, then turn on “Sync with Health Connect” in Samsung Health settings.",
  healthStatusNeedsUpdate:
    "Health Connect needs an update from the Google Play Store before sleep import can be used.",
  healthStatusPlatform: "Health Connect is only available on Android devices.",
  healthStatusNotFound: "Health Connect is not available on this device.",
  healthStatusPartial:
    "Partially granted. Some Health Connect read permissions are missing; disable and enable again to grant them.",
  healthEnable: "Enable Health Connect",
  healthDisable: "Disable Health Connect",
  healthPermissionDenied:
    "Sleep import stays off. Grant Fit Trace read access to sleep and resting heart rate, and make sure Samsung Health has “Sync with Health Connect” turned on in its settings.",
  healthOffNote:
    "Off on this device. To revoke access entirely, remove Fit Trace from the Health Connect system settings.",
  healthError: "Health Connect error: {message}",
};

/** Status-line copy per resolved key; keys come from the pure status model. */
const HEALTH_STATUS_COPY: Record<HealthConnectStatusKey, string> = {
  off: copy.healthStatusOff,
  supported: copy.healthStatusSupported,
  "no-permission": copy.healthStatusNoPermission,
  "needs-install": copy.healthStatusNeedsInstall,
  "needs-update": copy.healthStatusNeedsUpdate,
  platform: copy.healthStatusPlatform,
  "not-found": copy.healthStatusNotFound,
  partial: copy.healthStatusPartial,
};

/** Message for a Health Connect failure notice; never empty. */
function healthErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "Unknown error.";
}

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

  // Device-local Health Connect state. `null` means "still hydrating"; the
  // toggle and the status line render the off state until hydration lands.
  const healthProvider = useMemo(() => getHealthConnectProvider(), []);
  const [healthEnabled, setHealthEnabled] = useState<boolean | null>(null);
  const [healthAvailability, setHealthAvailability] = useState<HealthAvailability | null>(null);
  const [healthGrant, setHealthGrant] = useState<PermissionRequestResult | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthNotice, setHealthNotice] = useState<string | null>(null);
  // True when hydration itself failed: the state falls back to safe defaults
  // and the status line shows the degraded "platform" copy instead of a
  // misleading "off" (the toggle value was never actually read). The flag is
  // sticky only until a later manual refresh succeeds — clearing it there lets
  // the status line derive from the freshly read availability/grants again,
  // so a successful enable is never permanently masked by an earlier
  // hydration failure.
  const [healthHydrationFailed, setHealthHydrationFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [enabled, availability, grant] = await Promise.all([
          readHealthConnectEnabled(),
          healthProvider.availability(),
          healthProvider.currentPermissions(),
        ]);
        if (cancelled) return;
        setHealthHydrationFailed(false);
        setHealthEnabled(enabled);
        setHealthAvailability(availability);
        setHealthGrant(grant);
      } catch {
        // Hydration must never reject into the effect: land on safe defaults
        // (off, unavailable, nothing granted) so the toggle stays usable and
        // can never wedge behind a permanent `null` (the on-device QA deadlock).
        if (cancelled) return;
        setHealthHydrationFailed(true);
        setHealthEnabled(false);
        setHealthAvailability({ kind: "unavailable", reason: "platform" });
        setHealthGrant({ granted: [], missing: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [healthProvider]);

  const healthStatus = healthHydrationFailed
    ? "platform"
    : healthConnectStatusKey(healthEnabled, healthAvailability, healthGrant);

  /**
   * Toggle the device-local opt-in. Enabling first checks availability, then
   * requests the read permissions; a denied sleep grant keeps the toggle off
   * and shows guidance. The write is awaited: a failed persistence rethrows
   * after rolling the toggle back, so the in-app state stays off and the
   * catch reports the failure instead of the UI showing a state storage never
   * received. Disabling is in-app only (Health Connect grants are revoked
   * from the system settings, which the notice says).
   */
  async function handleToggleHealthConnect(): Promise<void> {
    if (healthBusy || healthEnabled === null) return;
    setHealthBusy(true);
    setHealthNotice(null);
    try {
      if (healthEnabled) {
        await writeHealthConnectEnabled(false);
        setHealthEnabled(false);
        setHealthNotice(t(copy.healthOffNote));
        return;
      }
      const availability = await healthProvider.availability();
      setHealthAvailability(availability);
      // This availability read succeeded, so the degraded hydration-failure
      // state is over: clear the flag so the status line derives from the
      // fresh state instead of being stuck on the "platform" copy.
      setHealthHydrationFailed(false);
      if (availability.kind !== "supported") {
        // Stay off; the status line and notice carry the install/update hint.
        const key =
          availability.kind === "unavailable"
            ? availability.reason === "platform"
              ? "platform"
              : "not-found"
            : availability.kind;
        setHealthNotice(t(HEALTH_STATUS_COPY[key]));
        return;
      }
      const grant = await healthProvider.requestReadPermissions();
      setHealthGrant(grant);
      setHealthHydrationFailed(false);
      if (!grant.granted.includes(SLEEP_READ_SCOPE)) {
        setHealthNotice(t(copy.healthPermissionDenied));
        return;
      }
      await writeHealthConnectEnabled(true);
      setHealthEnabled(true);
    } catch (cause) {
      setHealthNotice(t(copy.healthError, { message: healthErrorMessage(cause) }));
    } finally {
      setHealthBusy(false);
    }
  }

  return (
    <Screen testID="screen-me">
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

      <Card testID="me-health-section">
        <Kicker>{t(copy.healthKicker)}</Kicker>
        <Title>{t(copy.healthTitle)}</Title>
        <Body>{t(copy.healthLede)}</Body>
        <Body
          testID="me-health-status"
          tone={
            healthStatus === "supported" || healthStatus === "off" ? "muted" : "warn"
          }>
          {t(HEALTH_STATUS_COPY[healthStatus])}
        </Body>
        <Body>{t(copy.healthScopes)}</Body>
        {healthNotice !== null ? (
          <Banner message={healthNotice} testID="me-health-notice" tone="info" />
        ) : null}
        <Button
          accessibilityLabel={t(healthEnabled ? copy.healthDisable : copy.healthEnable)}
          disabled={healthBusy || healthEnabled === null}
          fullWidth
          label={healthEnabled ? t(copy.healthDisable) : t(copy.healthEnable)}
          onPress={() => {
            void handleToggleHealthConnect();
          }}
          testID="me-health-toggle"
          variant="secondary"
        />
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
