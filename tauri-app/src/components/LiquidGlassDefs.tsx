import { memo, useEffect, useState } from "react";

// Optional enhancement for the "liquid" visual profile: a hidden SVG filter
// that bends the backdrop of a handful of chrome surfaces (edge refraction /
// "lensing") via `backdrop-filter: url(#liquid-lens)`. The CSS-only liquid
// material must already read as its own look without this — the filter only
// runs where the engine actually composites SVG references inside
// backdrop-filter (Chromium / WebView2). WebKit (WKWebView, WebKitGTK) parses
// the value but renders nothing, so it is excluded and silently keeps the
// CSS-only material. Detection runs once and never throws.
//
// Lensing is shape-aware, not noise: the displacement map is a generated
// rounded-rect "bezel" — neutral (128,128) across the interior so the center
// stays optically flat, with displacement along the outward edge normal
// concentrated in a ring around the perimeter. That matches how a physical
// glass slab refracts: straight through the middle, bending only where the
// surface curves at the edge. The map is built once on a canvas and stretched
// over each lensed element (`preserveAspectRatio="none"`), which is the same
// pre-generated-map approach used by liquid-glass-react / the LogRocket
// CSS+SVG technique — no WebGL, no per-frame JS.

const MAP_SIZE = 384;
// Corner radius of the map's rounded rect, tuned to read as a squircle once
// stretched over typical chrome proportions.
const MAP_CORNER_RADIUS = 56;
// Width of the refractive bezel ring, in map pixels (relative: /MAP_SIZE).
const MAP_BEZEL_WIDTH = 52;

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

// Signed distance to a rounded rectangle centered at the origin with
// half-extent `half` and corner radius `r` (negative inside).
function roundedRectSdf(x: number, y: number, half: number, r: number): number {
  const qx = Math.abs(x) - (half - r);
  const qy = Math.abs(y) - (half - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
}

// Builds the displacement map once: R encodes x-offset, G encodes y-offset
// (128 = no displacement, feDisplacementMap semantics). Runs in a few
// milliseconds at 384px and is never rebuilt.
function buildLensDisplacementMap(): string | null {
  try {
    const size = MAP_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(size, size);
    const data = image.data;
    const half = size / 2;
    const r = MAP_CORNER_RADIUS;
    const bezel = MAP_BEZEL_WIDTH;
    const eps = 1;
    for (let py = 0; py < size; py += 1) {
      for (let px = 0; px < size; px += 1) {
        const x = px + 0.5 - half;
        const y = py + 0.5 - half;
        const d = roundedRectSdf(x, y, half, r);
        let offsetX = 0;
        let offsetY = 0;
        if (d <= 0 && d >= -bezel) {
          // Quadratic ease: zero at the inner ring boundary, strongest at the
          // perimeter, so refraction hugs the edge instead of warping the body.
          const t = 1 + d / bezel;
          const magnitude = t * t;
          // Outward normal from the SDF gradient (central differences).
          const gx =
            roundedRectSdf(x + eps, y, half, r) - roundedRectSdf(x - eps, y, half, r);
          const gy =
            roundedRectSdf(x, y + eps, half, r) - roundedRectSdf(x, y - eps, half, r);
          const len = Math.hypot(gx, gy) || 1;
          offsetX = (gx / len) * magnitude;
          offsetY = (gy / len) * magnitude;
        }
        const i = (py * size + px) * 4;
        data[i] = Math.round(127.5 + 127.5 * offsetX);
        data[i + 1] = Math.round(127.5 + 127.5 * offsetY);
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

// Detection + map generation are deterministic for the lifetime of the page,
// so the result is computed once and cached at module level.
let cachedMapHref: string | null | undefined;

function resolveLensMap(): string | null {
  if (cachedMapHref === undefined) {
    cachedMapHref = detectBackdropLensSupport() ? buildLensDisplacementMap() : null;
  }
  return cachedMapHref;
}

function LiquidGlassDefs() {
  const [mapHref] = useState<string | null>(resolveLensMap);

  useEffect(() => {
    // Runs after commit, so when this flips to "on" the feImage below is
    // already in the DOM — the filter is never applied with an empty map
    // (which would shift the whole backdrop by -scale/2).
    document.documentElement.setAttribute("data-liquid-lens", mapHref ? "on" : "off");
  }, [mapHref]);

  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" className="liquid-glass-defs">
      <filter
        id="liquid-lens"
        x="0%"
        y="0%"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
      >
        {mapHref && (
          <>
            <feImage
              href={mapHref}
              x="0%"
              y="0%"
              width="100%"
              height="100%"
              preserveAspectRatio="none"
              result="liquid-map"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="liquid-map"
              scale="48"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </>
        )}
      </filter>
    </svg>
  );
}

export default memo(LiquidGlassDefs);
