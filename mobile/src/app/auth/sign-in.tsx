import { useRouter } from "expo-router";

import { useI18n } from "@/i18n";
import { Body, Button, Card, Display, Kicker, Screen, Title } from "@/ui";

const copy = {
  kicker: "ACCOUNT",
  title: "Sign in",
  lede: "A secure session will unlock sync and the cloud coach.",
  cardTitle: "Auth placeholder",
  cardMessage:
    "No credentials are collected and no network calls are made in this commit. The secure sign-in flow lands next.",
  back: "Back",
  backLabel: "Go back",
};

export default function SignInScreen() {
  const router = useRouter();
  const { t } = useI18n();

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/me");
  };

  return (
    <Screen bottomInset testID="screen-auth-sign-in">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      <Card testID="auth-placeholder-card">
        <Title>{t(copy.cardTitle)}</Title>
        <Body>{t(copy.cardMessage)}</Body>
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
