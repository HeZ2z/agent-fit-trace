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
  return (
    <Screen testID="screen-history">
      <Kicker>{copy.kicker}</Kicker>
      <Display>{copy.title}</Display>
      <Body>{copy.lede}</Body>
      <EmptyState
        message={copy.emptyMessage}
        testID="empty-history"
        title={copy.emptyTitle}
      />
    </Screen>
  );
}
