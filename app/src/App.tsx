import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { WorkoutStoreProvider } from "./state/WorkoutStoreContext.tsx";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import { HistoryScreen } from "./screens/HistoryScreen.tsx";
import { WorkoutEditorScreen } from "./screens/WorkoutEditorScreen.tsx";
import { WorkoutSummaryScreen } from "./screens/WorkoutSummaryScreen.tsx";
import { AnalysisScreen } from "./screens/AnalysisScreen.tsx";
import { PlanScreen } from "./screens/PlanScreen.tsx";

export interface AppProps {
  /** Optional client for tests; defaults to the local client. */
  client?: FitTraceClient;
}

export default function App({ client }: AppProps = {}) {
  return (
    <WorkoutStoreProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HistoryScreen />} />
            <Route path="/workout/new" element={<WorkoutEditorScreen />} />
            <Route path="/workout/:id" element={<WorkoutSummaryScreen />} />
            <Route path="/analysis" element={<AnalysisScreen />} />
            <Route path="/plan" element={<PlanScreen />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WorkoutStoreProvider>
  );
}
