import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const rootElement = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

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
