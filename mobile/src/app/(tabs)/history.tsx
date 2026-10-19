import { useI18n } from "@/i18n";
import { Body, Display, EmptyState, Kicker, Screen } from "@/ui";

const copy = {
  kicker: "HISTORY",
  title: "Training history",
  lede: "Every logged session becomes evidence. Review what you lifted, how it felt, and what changed over time.",
  emptyTitle: "No sessions yet",
  emptyMessage:
    "Your workout history will appear here once local logging is connected. This shell only reserves the route.",
};

export default function HistoryScreen() {
  const { t } = useI18n();

  return (
    <Screen testID="screen-history">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      <EmptyState
        message={t(copy.emptyMessage)}
        testID="empty-history"
        title={t(copy.emptyTitle)}
      />
    </Screen>
  );
}
