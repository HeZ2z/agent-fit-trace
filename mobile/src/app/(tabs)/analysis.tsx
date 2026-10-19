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
  return (
    <Screen testID="screen-analysis">
      <Kicker>{copy.kicker}</Kicker>
      <Display>{copy.title}</Display>
      <Body>{copy.lede}</Body>
      <EmptyState
        message={copy.emptyMessage}
        testID="empty-analysis"
        title={copy.emptyTitle}
      />
    </Screen>
  );
}
