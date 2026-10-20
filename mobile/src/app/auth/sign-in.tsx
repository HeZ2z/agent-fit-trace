import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  authErrorMessage,
  toAuthError,
  useAuth,
  type AuthError,
} from "@/auth";
import { useI18n } from "@/i18n";
import { SPACING } from "@/theme";
import { Banner, Body, Button, Card, Display, Field, Screen } from "@/ui";

/**
 * Invite-only email/password sign-in.
 *
 * There is intentionally no sign-up form: accounts are created by invitation,
 * exactly like the web client. The screen never receives tokens — `signIn`
 * resolves to provider state and the form is unmounted on success.
 */

const copy = {
  kicker: "ACCOUNT",
  title: "Sign in",
  lede: "Sign in to your account.",
  inviteNote:
    "Accounts are invite-only. Sign in with the email and password from your invitation; there is no sign-up in the app.",
  submitting: "Signing in…",
  back: "Back",
  backLabel: "Go back",
};

export default function SignInScreen() {
  const router = useRouter();
  const { status, error: providerError, signIn } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const unconfigured = status === "unconfigured";
  const loading = status === "loading";
  const formDisabled = submitting || unconfigured || loading;

  // A successful sign-in flips the provider to `signed-in`; leave the form
  // immediately. Deep-linking here while already signed in also goes back.
  useEffect(() => {
    if (status !== "signed-in") return;
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/me");
  }, [router, status]);

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/me");
  };

  async function handleSubmit(): Promise<void> {
    if (formDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (caught) {
      setError(toAuthError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const shownError = error ?? (status === "error" ? providerError : null);

  return (
    <Screen bottomInset testID="screen-auth-sign-in">
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      <Body>{t(copy.inviteNote)}</Body>

      {unconfigured ? (
        <Banner
          message={t(authErrorMessage("unconfigured"))}
          testID="auth-unconfigured"
          tone="warn"
        />
      ) : null}
      {loading ? <Body>{t("Restoring your account…")}</Body> : null}

      <Card>
        <View style={styles.form}>
          <Field
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            editable={!formDisabled}
            inputMode="email"
            keyboardType="email-address"
            label={t("Email")}
            onChangeText={setEmail}
            testID="auth-email"
            value={email}
          />
          <Field
            autoCapitalize="none"
            autoComplete="current-password"
            editable={!formDisabled}
            label={t("Password")}
            onChangeText={setPassword}
            onSubmitEditing={() => {
              void handleSubmit();
            }}
            returnKeyType="go"
            secureTextEntry
            testID="auth-password"
            value={password}
          />
        </View>

        {shownError !== null ? (
          <Banner
            message={t(authErrorMessage(shownError.code))}
            testID="auth-error"
            tone="danger"
          />
        ) : null}

        <Button
          accessibilityLabel={t(copy.title)}
          disabled={formDisabled}
          fullWidth
          label={submitting ? t(copy.submitting) : t(copy.title)}
          onPress={() => {
            void handleSubmit();
          }}
          testID="auth-submit"
        />
      </Card>

      <Button
        accessibilityLabel={t(copy.backLabel)}
        label={t(copy.back)}
        onPress={goBack}
        testID="auth-back-button"
        variant="secondary"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: SPACING[3] },
});
