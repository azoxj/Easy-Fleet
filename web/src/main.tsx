import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyDocumentLocale, useLocale } from "./i18n";
import "./index.css";

applyDocumentLocale();

/** Re-mounts the app when the language changes so every t() call and lazy label is evaluated again. */
function LocaleRoot() {
  const locale = useLocale();
  return <App key={locale} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleRoot />
  </StrictMode>,
);

// PWA: register the service worker in production builds only (never caches /api).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
