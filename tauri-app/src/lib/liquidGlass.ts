// Liquid Glass displacement-map generation + engine capability detection.
//
// The refraction technique is ported from rdev/liquid-glass-react (MIT,
// https://github.com/rdev/liquid-glass-react), whose shader-utils are in turn
// adapted from shuding/liquid-glass: a canvas-generated displacement map is
// fed into an SVG filter that displaces the R/G/B channels of the backdrop
// separately (chromatic aberration), masks that refraction to the element's
// rim, and composites the undisplaced image back into the center so the
// interior stays optically flat. Unlike the reference (which ships fixed
// square maps), every map here is generated at the host element's actual
// aspect ratio and corner radius so wide chrome (titlebar, sidebar) bends
// correctly instead of stretching a square lens.

export type LiquidGlassMode = "standard" | "polar" | "prominent" | "shader";

// Resolution cap keeps map generation to a few milliseconds and the data URL
// small; the displacement field is smooth, so upscaling in feImage is fine.
const MAP_MAX_LONG_SIDE = 512;
const MAP_MIN_SIDE = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothStep(a: number, b: number, t: number): number {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

// Signed distance to a rounded rectangle centered at the origin (negative
// inside). `halfW`/`halfH` are half-extents, `r` the corner radius.
function roundedRectSdf(x: number, y: number, halfW: number, halfH: number, r: number): number {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
  );
}

type FieldSample = { dx: number; dy: number; mask: number };

// Bezel refraction: interior neutral, displacement along the inward SDF
// normal in a ring hugging the perimeter — how a flat glass slab with a
// curved edge actually bends light.
function sampleBezel(
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  r: number,
  bezel: number,
  out: FieldSample
): void {
  const d = roundedRectSdf(x, y, halfW, halfH, r);
  const t = clamp(1 + d / bezel, 0, 1);
  if (t <= 0) {
    out.dx = 0;
    out.dy = 0;
    out.mask = 0;
    return;
  }
  // Quadratic ease: zero at the inner ring boundary, strongest at the edge.
  const magnitude = t * t;
  const eps = 1;
  const gx =
    roundedRectSdf(x + eps, y, halfW, halfH, r) - roundedRectSdf(x - eps, y, halfW, halfH, r);
  const gy =
    roundedRectSdf(x, y + eps, halfW, halfH, r) - roundedRectSdf(x, y - eps, halfW, halfH, r);
  const len = Math.hypot(gx, gy) || 1;
  // Sample toward the interior => the backdrop appears magnified at the rim.
  out.dx = (-gx / len) * magnitude;
  out.dy = (-gy / len) * magnitude;
  out.mask = smoothStep(0, 1, t);
}

// Port of the `liquidGlass` fragment from rdev/liquid-glass-react
// shader-utils (itself adapted from shuding/liquid-glass): a normalized
// rounded-rect SDF drives a radial squeeze toward the center.
function sampleShader(u: number, v: number, w: number, h: number, out: FieldSample): void {
  const ix = u - 0.5;
  const iy = v - 0.5;
  const d = roundedRectSdf(ix, iy, 0.3, 0.2, 0.6);
  const displacement = smoothStep(0.8, 0, d - 0.15);
  const scaled = smoothStep(0, 1, displacement);
  out.dx = (ix * scaled + 0.5 - u) * w;
  out.dy = (iy * scaled + 0.5 - v) * h;
  // The real mask is derived from the displacement magnitude after
  // normalization; carry a unit value so the boundary feather still applies.
  out.mask = 1;
}

// Builds the per-element displacement map. Channel layout (consumed by
// GlassFilter in LiquidGlass.tsx):
//   R = x displacement (128 neutral)   B = y displacement (128 neutral)
//   G = rim intensity (0 = optically flat interior, 255 = edge) — a purpose
//       built mask channel instead of the reference's luminance heuristic,
//       so the "clean center" composite never leaks refraction inward.
export function buildLiquidGlassMap(
  cssWidth: number,
  cssHeight: number,
  cornerRadius: number,
  mode: LiquidGlassMode
): string | null {
  try {
    if (typeof document === "undefined") {
      return null;
    }
    const long = Math.max(cssWidth, cssHeight);
    if (!Number.isFinite(long) || long <= 0) {
      return null;
    }
    const scale = Math.min(1, MAP_MAX_LONG_SIDE / long);
    const w = Math.max(MAP_MIN_SIDE, Math.round(cssWidth * scale));
    const h = Math.max(MAP_MIN_SIDE, Math.round(cssHeight * scale));
    const halfW = w / 2;
    const halfH = h / 2;
    const r = clamp(cornerRadius * scale, 0, Math.min(halfW, halfH));
    // Narrow rims read as a crisp beveled slab (the Apple look); wide soft
    // rims read as smeared frost. Prominent mode keeps a broader ring.
    const minSide = Math.min(w, h);
    const bezel =
      mode === "prominent"
        ? clamp(minSide * 0.42, 8, 110)
        : clamp(minSide * 0.18, 6, 42);

    const count = w * h;
    const dxArr = new Float32Array(count);
    const dyArr = new Float32Array(count);
    const maskArr = new Float32Array(count);
    const sample: FieldSample = { dx: 0, dy: 0, mask: 0 };
    let maxMag = 0;

    for (let py = 0; py < h; py += 1) {
      for (let px = 0; px < w; px += 1) {
        const x = px + 0.5 - halfW;
        const y = py + 0.5 - halfH;
        if (mode === "shader") {
          sampleShader((px + 0.5) / w, (py + 0.5) / h, w, h, sample);
        } else if (mode === "polar") {
          const nx = x / halfW;
          const ny = y / halfH;
          const rho = Math.hypot(nx, ny);
          const t = clamp((rho - 0.45) / 0.55, 0, 1);
          const magnitude = t * t;
          const len = Math.hypot(x, y) || 1;
          sample.dx = (-x / len) * magnitude;
          sample.dy = (-y / len) * magnitude;
          sample.mask = smoothStep(0, 1, t);
        } else {
          sampleBezel(x, y, halfW, halfH, r, bezel, sample);
        }
        // Feather the outermost pixels so the filter never samples outside
        // its region (which would smear the boundary) — same trick as the
        // reference generator.
        const edgeDistance = Math.min(px, py, w - 1 - px, h - 1 - py);
        const edgeFactor = Math.min(1, edgeDistance / 2);
        const i = py * w + px;
        dxArr[i] = sample.dx * edgeFactor;
        dyArr[i] = sample.dy * edgeFactor;
        maskArr[i] = sample.mask * edgeFactor;
        maxMag = Math.max(maxMag, Math.abs(dxArr[i]), Math.abs(dyArr[i]));
      }
    }
    if (maxMag <= 0) {
      maxMag = 1;
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    const image = ctx.createImageData(w, h);
    const data = image.data;
    for (let i = 0; i < count; i += 1) {
      const dxNorm = dxArr[i] / maxMag;
      const dyNorm = dyArr[i] / maxMag;
      const mask =
        mode === "shader"
          ? clamp(Math.hypot(dxNorm, dyNorm) * 1.4, 0, 1) * maskArr[i]
          : maskArr[i];
      const o = i * 4;
      data[o] = Math.round(clamp(0.5 + 0.5 * dxNorm, 0, 1) * 255);
      data[o + 1] = Math.round(clamp(mask, 0, 1) * 255);
      data[o + 2] = Math.round(clamp(0.5 + 0.5 * dyNorm, 0, 1) * 255);
      data[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

// --- Engine capability detection -------------------------------------------
//
// WebKit (WKWebView on macOS, WebKitGTK on Linux) claims support for
// `backdrop-filter: url(#…)` via CSS.supports but silently renders nothing,
// so CSS.supports alone cannot be trusted; require a Chromium engine (which
// includes Win7-era WebView2 109). Detection runs once and never throws.
let cachedLensSupport: boolean | undefined;

export function supportsLiquidLens(): boolean {
  if (cachedLensSupport === undefined) {
    cachedLensSupport = detectLensSupport();
  }
  return cachedLensSupport;
}

function detectLensSupport(): boolean {
  try {
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
      return false;
    }
    const value = "url(#lg-probe) blur(4px)";
    if (
      !CSS.supports("backdrop-filter", value) &&
      !CSS.supports("-webkit-backdrop-filter", value)
    ) {
      return false;
    }
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    return /Chrome\/\d+/.test(userAgent);
  } catch {
    return false;
  }
}
