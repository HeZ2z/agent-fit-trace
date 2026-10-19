import { Body, Display, EmptyState, Kicker, Screen } from "@/ui";

const copy = {
  kicker: "PLAN",
  title: "Draft plans",
  lede: "Plans are drafted from your evidence and need explicit confirmation before they take effect.",
  emptyTitle: "No plan in progress",
  emptyMessage:
    "Once there is enough history, a drafted plan will appear here for review. Nothing is applied automatically.",
};

export default function PlanScreen() {
  return (
    <Screen testID="screen-plan">
      <Kicker>{copy.kicker}</Kicker>
      <Display>{copy.title}</Display>
      <Body>{copy.lede}</Body>
      <EmptyState message={copy.emptyMessage} testID="empty-plan" title={copy.emptyTitle} />
    </Screen>
  );
}
