import { memo, useEffect } from "react";

// Optional enhancement for the "liquid" visual profile: a hidden SVG filter
// that bends the backdrop of a few chrome surfaces (edge refraction /
// "lensing") via `backdrop-filter: url(#liquid-lens)`. The CSS-only liquid
// material must already read as its own look without this — the filter only
// runs where the engine actually composites SVG references inside
// backdrop-filter (Chromium / WebView2). WebKit (WKWebView, WebKitGTK) parses
// the value but renders nothing, so it is excluded and silently keeps the
// CSS-only material. Detection runs once and never throws.
function detectBackdropLensSupport(): boolean {
  try {
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
      return false;
    }
    const value = "url(#liquid-lens)";
    if (
      !CSS.supports("backdrop-filter", value) &&
      !CSS.supports("-webkit-backdrop-filter", value)
    ) {
      return false;
    }
    // WebKit claims support via CSS.supports but does not apply SVG filter
    // references inside backdrop-filter; require a Chromium-based engine.
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    return /Chrome\/\d+/.test(userAgent);
  } catch {
    return false;
  }
}

function LiquidGlassDefs() {
  useEffect(() => {
    document.documentElement.setAttribute(
      "data-liquid-lens",
      detectBackdropLensSupport() ? "on" : "off"
    );
  }, []);

  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="liquid-glass-defs">
      <filter
        id="liquid-lens"
        x="-4%"
        y="-4%"
        width="108%"
        height="108%"
        colorInterpolationFilters="sRGB"
      >
        {/* Low-frequency noise, softened, drives a gentle negative displacement:
            the backdrop appears bent through the glass instead of only blurred. */}
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.004 0.009"
          numOctaves="2"
          seed="7"
          result="liquid-noise"
        />
        <feGaussianBlur in="liquid-noise" stdDeviation="2.5" result="liquid-soft" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="liquid-soft"
          scale="-42"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

export default memo(LiquidGlassDefs);
