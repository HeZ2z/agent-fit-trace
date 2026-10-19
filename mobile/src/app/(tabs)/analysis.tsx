import { useI18n } from "@/i18n";
import { Body, Display, EmptyState, Kicker, Screen } from "@/ui";

const copy = {
  kicker: "ANALYSIS",
  title: "Evidence analysis",
  lede: "Turn logged sessions into trends, stalls, and the evidence behind the next step.",
  emptyTitle: "No evidence to analyse",
  emptyMessage:
    "Analysis runs on your local history. Log a few sessions first, then come back once the store is connected.",
};

export default function AnalysisScreen() {
  const { t } = useI18n();

  return (
    <Screen testID="screen-analysis">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      <EmptyState
        message={t(copy.emptyMessage)}
        testID="empty-analysis"
        title={t(copy.emptyTitle)}
      />
    </Screen>
  );
}
