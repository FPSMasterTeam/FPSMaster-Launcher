import { useEffect, useState } from "react";

const COMPACT_BREAKPOINT = 1120;

// Tracks whether the window is narrow enough to force the compact layout
// (collapsed sidebar). Self-contained: owns its own listener + state.
export function useResponsiveLayout(): { compactLayout: boolean } {
  const [compactLayout, setCompactLayout] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < COMPACT_BREAKPOINT : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setCompactLayout(window.innerWidth < COMPACT_BREAKPOINT);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { compactLayout };
}
