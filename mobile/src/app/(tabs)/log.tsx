import { Body, Display, EmptyState, Kicker, Screen } from "@/ui";

const copy = {
  kicker: "LOG",
  title: "Log a session",
  lede: "Capture sets, reps, load, and how the session felt while it is still fresh.",
  emptyTitle: "Session logging is next",
  emptyMessage:
    "The logging form is not wired yet. It will write to the local SQLite store in a later commit, so nothing is saved here.",
};

export default function LogScreen() {
  return (
    <Screen testID="screen-log">
      <Kicker>{copy.kicker}</Kicker>
      <Display>{copy.title}</Display>
      <Body>{copy.lede}</Body>
      <EmptyState message={copy.emptyMessage} testID="empty-log" title={copy.emptyTitle} />
    </Screen>
  );
}
