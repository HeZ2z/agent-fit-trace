import { Redirect } from "expo-router";

/** The app opens on the history tab; the demo landing page is retired. */
export default function Index() {
  return <Redirect href="/history" />;
}
