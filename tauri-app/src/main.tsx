import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { loadLocale, resolveLocale } from "./i18n";
import { loadSettings } from "./utils/launcher";
import "./styles.css";

const rootElement = document.getElementById("root") as HTMLElement;

function renderApp() {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// Preload the active locale chunk before the first render so the synchronous
// translator already has its table (no English flash for non-default locales).
void (async () => {
  try {
    await loadLocale(resolveLocale(loadSettings().language));
  } catch {
    // fall back to the static en-US table
  }
  renderApp();
})();

let loadingScreenHidden = false;
const hideLoadingScreen = () => {
  if (loadingScreenHidden) return;
  loadingScreenHidden = true;
  const loadingScreen = document.getElementById("loading-screen");
  rootElement.classList.add("ready");
  if (loadingScreen) {
    loadingScreen.classList.add("hidden");
    window.setTimeout(() => loadingScreen.remove(), 300);
  }
};

window.addEventListener("fpsmaster:loaded", hideLoadingScreen, { once: true });
window.setTimeout(hideLoadingScreen, 5000);
