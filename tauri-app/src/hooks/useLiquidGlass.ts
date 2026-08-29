import { useCallback, useSyncExternalStore } from "react";
import { supportsLiquidLens } from "../lib/liquidGlass";

// Shared state for the Liquid Glass material (components/LiquidGlass.tsx):
// resolves the current visual profile / theme / wallpaper flags from :root
// (where utils/launcher.ts publishes them) plus the accessibility media
// queries, into a single "how much glass may render right now" answer.

// --- :root attribute store (visual profile / theme / video wallpaper) ------

type RootUiState = { profile: string; theme: string; bgVideo: boolean };

const SERVER_ROOT_UI: RootUiState = { profile: "", theme: "dark", bgVideo: false };
let rootUiSnapshot: RootUiState | null = null;
const rootUiListeners = new Set<() => void>();
let rootUiObserver: MutationObserver | null = null;

function readRootUiState(): RootUiState {
  if (typeof document === "undefined") {
    return SERVER_ROOT_UI;
  }
  const root = document.documentElement;
  return {
    profile: root.getAttribute("data-visual-profile") ?? "",
    theme: root.getAttribute("data-theme") ?? "dark",
    bgVideo: root.getAttribute("data-bg-video") === "true",
  };
}

function getRootUiSnapshot(): RootUiState {
  if (rootUiSnapshot === null) {
    rootUiSnapshot = readRootUiState();
  }
  return rootUiSnapshot;
}

// One shared MutationObserver for every glass instance; it stays alive for
// the lifetime of the page (a handful of attribute reads per change).
function subscribeRootUi(listener: () => void): () => void {
  rootUiListeners.add(listener);
  if (rootUiObserver === null && typeof MutationObserver !== "undefined") {
    rootUiObserver = new MutationObserver(() => {
      const next = readRootUiState();
      const prev = rootUiSnapshot;
      if (
        !prev ||
        prev.profile !== next.profile ||
        prev.theme !== next.theme ||
        prev.bgVideo !== next.bgVideo
      ) {
        rootUiSnapshot = next;
        rootUiListeners.forEach((fn) => fn());
      }
    });
    rootUiObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-visual-profile", "data-theme", "data-bg-video"],
    });
  }
  return () => {
    rootUiListeners.delete(listener);
  };
}

function useRootUiState(): RootUiState {
  return useSyncExternalStore(subscribeRootUi, getRootUiSnapshot, () => SERVER_ROOT_UI);
}

// --- media query flag ---------------------------------------------------------

function useMediaFlag(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      try {
        const mql = window.matchMedia(query);
        if (typeof mql.addEventListener === "function") {
          mql.addEventListener("change", onChange);
          return () => mql.removeEventListener("change", onChange);
        }
        // Older engines only expose the deprecated listener API.
        if (typeof mql.addListener === "function") {
          mql.addListener(onChange);
          return () => mql.removeListener(onChange);
        }
      } catch {
        // Unsupported media-query implementations must degrade silently.
      }
      return () => {};
    },
    [query]
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  }, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// --- public hook ----------------------------------------------------------------

export type LiquidGlassState = {
  /** Layered material should render (profile is liquid, no a11y override). */
  active: boolean;
  /** Full SVG refraction is available (Chromium, no video wallpaper). */
  lensed: boolean;
  overLight: boolean;
  reducedMotion: boolean;
  /** Class the host element must carry while the material layers render. */
  hostClassName: string;
};

export function useLiquidGlass(options?: { overLight?: boolean }): LiquidGlassState {
  const { profile, theme, bgVideo } = useRootUiState();
  const reducedTransparency = useMediaFlag("(prefers-reduced-transparency: reduce)");
  const moreContrast = useMediaFlag("(prefers-contrast: more)");
  const forcedColors = useMediaFlag("(forced-colors: active)");
  const reducedMotion = useMediaFlag("(prefers-reduced-motion: reduce)");

  const active =
    profile === "liquid" && !reducedTransparency && !moreContrast && !forcedColors;
  const lensed = active && !bgVideo && supportsLiquidLens();
  return {
    active,
    lensed,
    overLight: options?.overLight ?? theme === "light",
    reducedMotion,
    hostClassName: active ? "lg-on" : "",
  };
}
