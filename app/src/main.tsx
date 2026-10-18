import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { applyLanguage, getLanguage } from "./i18n/i18n.ts";
import { applyTheme, getTheme } from "./theme/theme.ts";

applyTheme(getTheme());
applyLanguage(getLanguage());

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
