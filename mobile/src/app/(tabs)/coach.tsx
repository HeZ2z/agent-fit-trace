import { useI18n } from "@/i18n";
import { Banner, Body, Card, Display, Kicker, Screen, Title } from "@/ui";

const copy = {
  kicker: "COACH",
  title: "Coach",
  lede: "Ask about training, review the evidence, and shape the next block with a coach.",
  bannerTitle: "Cloud coach requires sign-in",
  bannerMessage:
    "Hosted coaching is a signed-in feature. Accounts and networking arrive in a later commit, so this screen makes no network calls.",
  localTitle: "Local coach placeholder",
  localMessage:
    "The conversation surface will connect to the local coach through the desktop app. Until then, this card reserves the space.",
};

export default function CoachScreen() {
  const { t } = useI18n();

  return (
    <Screen testID="screen-coach">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      <Banner
        message={t(copy.bannerMessage)}
        testID="coach-cloud-banner"
        title={t(copy.bannerTitle)}
        tone="info"
      />
      <Card testID="coach-placeholder-card">
        <Title>{t(copy.localTitle)}</Title>
        <Body>{t(copy.localMessage)}</Body>
      </Card>
    </Screen>
  );
}
