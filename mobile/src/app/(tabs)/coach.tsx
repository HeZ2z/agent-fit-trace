import { useI18n } from "@/i18n";
import { Banner, Body, Card, Display, Kicker, Screen, Title } from "@/ui";

const copy = {
  kicker: "COACH",
  title: "Coach",
  lede: "Ask about training, review the evidence, and shape the next block with a coach.",
  bannerTitle: "Cloud coach requires sign-in",
  bannerMessage:
    "Hosted coaching is a signed-in feature. Accounts and networking arrive in a later commit, so this screen makes no network calls.",
  nextTitle: "Cloud coach is next",
  nextMessage:
    "This screen will start a hosted cloud pi session once accounts and networking land. The local CLI coach stays on desktop; mobile never runs a local agent.",
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
        <Title>{t(copy.nextTitle)}</Title>
        <Body>{t(copy.nextMessage)}</Body>
      </Card>
    </Screen>
  );
}
