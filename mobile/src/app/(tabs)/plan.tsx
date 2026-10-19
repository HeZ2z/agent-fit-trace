import { useI18n } from "@/i18n";
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
  const { t } = useI18n();

  return (
    <Screen testID="screen-plan">
      <Kicker>{t(copy.kicker)}</Kicker>
      <Display>{t(copy.title)}</Display>
      <Body>{t(copy.lede)}</Body>
      <EmptyState message={t(copy.emptyMessage)} testID="empty-plan" title={t(copy.emptyTitle)} />
    </Screen>
  );
}
