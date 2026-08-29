import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";
import { useLiquidGlass } from "../hooks/useLiquidGlass";
import { buildLiquidGlassMap, type LiquidGlassMode } from "../lib/liquidGlass";

// Liquid Glass chrome material. Architecture ported from
// rdev/liquid-glass-react (MIT, https://github.com/rdev/liquid-glass-react):
//   - per-instance SVG filter (useId) fed by a displacement map generated at
//     the host element's real size / corner radius (ResizeObserver),
//   - three displacement passes with slightly offset scales, isolated to the
//     R / G / B channels and screen-blended => chromatic aberration,
//   - the aberrated refraction is masked to the rim and the undisplaced
//     backdrop is composited back into the center (edge-only lensing),
//   - dual gradient border layers (screen + overlay) + inset specular that
//     pick up the light of whatever sits behind the glass,
//   - hover / press inner illumination that follows the pointer (Apple:
//     light starts under the cursor), optional elastic stretch on small
//     controls only (large surfaces never warp).
// Unlike the reference, layout is fill-parent (no centered translate) and the
// material renders as plain children of the host element, so existing chrome
// keeps its flex/grid layout: the layers live in absolutely positioned,
// aria-hidden spans behind the host's content, which therefore stays sharp
// (only the backdrop layer is filtered).
//
// DOM shape is load-bearing. The filtered .lg-backdrop span MUST be a direct
// child of the host, and the mix-blend-mode layers (shine / glint) MUST sit
// in their own stacking-context wrapper (.lg-layers): a blend-mode child
// forces Chromium to isolate its parent group into a render surface, which
// becomes the backdrop root for every descendant — a backdrop-filter sibling
// inside the same wrapper then samples an empty group and renders nothing.
// Keeping the blends bounded by .lg-layers and the backdrop span outside it
// lets the filter sample the real page. (Verified empirically; the same flat
// structure works in the reference only because its wrapper is not a
// stacking context.)
//
// Degradation ladder (never throws), resolved by useLiquidGlass:
//   - Chromium / WebView2 (incl. Win7-era 109): full lens + aberration.
//   - WebKit / Firefox / old engines: same layered material with a plain
//     blur+saturate backdrop, no SVG url() (detected once, UA-gated because
//     CSS.supports lies on WebKit).
//   - video wallpaper: cheap frost only, no displacement.
//   - prefers-reduced-transparency / prefers-contrast / forced-colors: the
//     component renders nothing and the CSS-only fallback rules own the look.
//   - prefers-reduced-motion: no elasticity, no pointer-tracking illumination
//     (the hover fade stays at the static top-center rest pose).

// Refractive surfaces are deliberately scarce (Apple reserves the material
// for floating chrome, and each lens costs three displacement passes on the
// GPU). Instances beyond the budget silently keep the blur-only material
// until a slot frees up on unmount.
const LENS_BUDGET = 8;
let lensSlotsUsed = 0;

// --- per-instance SVG filter -------------------------------------------------

type GlassFilterProps = {
  id: string;
  mapUrl: string;
  /** Host CSS size; feImage needs absolute px (percentages resolve against
      the nearest SVG viewport, and the defs svg is 0x0 => an empty map). */
  width: number;
  height: number;
  displacementScale: number;
  aberrationIntensity: number;
};

// Filter graph ported from the reference GlassFilter: R/G/B displaced with
// slightly different scales, screen-combined, softened, clipped to the rim
// mask, and laid over the untouched center. The rim mask comes straight from
// the map's G channel (see buildLiquidGlassMap) instead of a luminance
// heuristic, which keeps the center provably clean.
function GlassFilter({
  id,
  mapUrl,
  width,
  height,
  displacementScale,
  aberrationIntensity,
}: GlassFilterProps) {
  const redScale = displacementScale;
  const greenScale = displacementScale * Math.max(0.35, 1 - aberrationIntensity * 0.05);
  const blueScale = displacementScale * Math.max(0.3, 1 - aberrationIntensity * 0.1);
  const soften = Math.max(0.08, 0.5 - aberrationIntensity * 0.1);
  return (
    <svg className="lg-svg" aria-hidden="true" focusable="false">
      <defs>
        <filter
          id={id}
          x="-35%"
          y="-35%"
          width="170%"
          height="170%"
          colorInterpolationFilters="sRGB"
        >
          <feImage
            href={mapUrl}
            x="0"
            y="0"
            width={width}
            height={height}
            preserveAspectRatio="none"
            result="LG_MAP"
          />
          <feColorMatrix
            in="LG_MAP"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 1 0 0 0"
            result="LG_EDGE"
          />
          <feComponentTransfer in="LG_EDGE" result="LG_EDGE_MASK">
            <feFuncA type="gamma" amplitude="1" exponent="0.8" offset="0" />
          </feComponentTransfer>
          <feDisplacementMap
            in="SourceGraphic"
            in2="LG_MAP"
            scale={redScale}
            xChannelSelector="R"
            yChannelSelector="B"
            result="LG_RED_DISP"
          />
          <feColorMatrix
            in="LG_RED_DISP"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="LG_RED"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="LG_MAP"
            scale={greenScale}
            xChannelSelector="R"
            yChannelSelector="B"
            result="LG_GREEN_DISP"
          />
          <feColorMatrix
            in="LG_GREEN_DISP"
            type="matrix"
            values="0 0 0 0 0
                    0 1 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="LG_GREEN"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="LG_MAP"
            scale={blueScale}
            xChannelSelector="R"
            yChannelSelector="B"
            result="LG_BLUE_DISP"
          />
          <feColorMatrix
            in="LG_BLUE_DISP"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 1 0 0
                    0 0 0 1 0"
            result="LG_BLUE"
          />
          <feBlend in="LG_GREEN" in2="LG_BLUE" mode="screen" result="LG_GB" />
          <feBlend in="LG_RED" in2="LG_GB" mode="screen" result="LG_RGB" />
          <feGaussianBlur in="LG_RGB" stdDeviation={soften} result="LG_RGB_SOFT" />
          <feComposite in="LG_RGB_SOFT" in2="LG_EDGE_MASK" operator="in" result="LG_RIM" />
          <feComponentTransfer in="LG_EDGE_MASK" result="LG_CENTER_MASK">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feComposite in="SourceGraphic" in2="LG_CENTER_MASK" operator="in" result="LG_CENTER" />
          <feComposite in="LG_RIM" in2="LG_CENTER" operator="over" />
        </filter>
      </defs>
    </svg>
  );
}

// --- material layers ----------------------------------------------------------

export type LiquidGlassLayersProps = {
  mode?: LiquidGlassMode;
  /** SVG displacement scale; max pixel bend at the rim is roughly scale / 2. */
  displacementScale?: number;
  aberrationIntensity?: number;
  /** Backdrop blur in px; defaults to the profile's --lg-blur token. */
  blur?: number;
  /** "chrome" = neutral material, "accent" = colored glass for primary CTAs. */
  tint?: "chrome" | "accent";
  /** Hover / press inner illumination that follows the pointer. */
  interactive?: boolean;
  /**
   * Mouse-following stretch. Small controls only (buttons, chips, tiles) —
   * large surfaces (dialog cards, the launch pad) must never warp.
   */
  elastic?: boolean;
  overLight?: boolean;
};

// The material layers, rendered as the first child of a positioned host
// element that carries the `lg-on` class (see useLiquidGlass). Kept separate
// from the wrapper so existing components (Button, Card) can embed it without
// changing their own root element.
export function LiquidGlassLayers({
  mode = "standard",
  displacementScale = 48,
  aberrationIntensity = 2,
  blur,
  tint = "chrome",
  interactive = false,
  elastic = false,
  overLight,
}: LiquidGlassLayersProps) {
  const glass = useLiquidGlass({ overLight });
  const rawId = useId();
  const filterId = useMemo(() => `lg-lens-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [rawId]);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [map, setMap] = useState<{ url: string; width: number; height: number } | null>(null);

  // The z:-1 material layers must stay inside the host: make the host a
  // positioned stacking context, but only where it is not one already (a CSS
  // rule would fight Tailwind's cascade layers and could break e.g. the
  // sidebar panel's `absolute`). Never isolation:isolate — that would create
  // a backdrop root and blind the backdrop-filter.
  useEffect(() => {
    if (!glass.active) {
      return;
    }
    const host = anchorRef.current?.parentElement as HTMLElement | null;
    if (!host) {
      return;
    }
    const computed = getComputedStyle(host);
    const prevPosition = host.style.position;
    const prevZIndex = host.style.zIndex;
    let touchedPosition = false;
    let touchedZIndex = false;
    if (computed.position === "static") {
      host.style.position = "relative";
      touchedPosition = true;
    }
    if (getComputedStyle(host).zIndex === "auto") {
      host.style.zIndex = "0";
      touchedZIndex = true;
    }
    return () => {
      if (touchedPosition) {
        host.style.position = prevPosition;
      }
      if (touchedZIndex) {
        host.style.zIndex = prevZIndex;
      }
    };
  }, [glass.active]);

  // Size-aware map: take a slot from the scarce refraction budget, observe
  // the host and (re)build the displacement map at the element's actual
  // width x height (debounced; resolution capped in the generator). One
  // square map stretched over a wide bar is exactly the artifact this kills.
  useEffect(() => {
    if (!glass.lensed || lensSlotsUsed >= LENS_BUDGET) {
      return;
    }
    const host = anchorRef.current?.parentElement;
    if (!host) {
      return;
    }
    lensSlotsUsed += 1;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = "";
    const rebuild = () => {
      if (disposed) {
        return;
      }
      const rect = host.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 24 || height < 24) {
        lastKey = "";
        setMap(null);
        return;
      }
      const radius = readCornerRadius(host, width, height);
      const key = `${width}x${height}r${radius}m${mode}`;
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      const url = buildLiquidGlassMap(width, height, radius, mode);
      setMap(url === null ? null : { url, width, height });
    };
    // First build lands a frame later so mount stays cheap and the effect
    // body itself never sets state synchronously.
    timer = setTimeout(rebuild, 0);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(rebuild, 140);
      });
      observer.observe(host);
    }
    return () => {
      disposed = true;
      lensSlotsUsed -= 1;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      observer?.disconnect();
    };
  }, [glass.lensed, mode]);

  // Pointer tracking: hover illumination follows the cursor (Apple: light
  // starts under the pointer), plus optional elastic stretch on small
  // controls. Direct style writes on the host (rAF-throttled) so React never
  // re-renders on mousemove. Coarse pointers and prefers-reduced-motion keep
  // the static top-center fade from CSS.
  useEffect(() => {
    if (!glass.active || glass.reducedMotion || (!interactive && !elastic)) {
      return;
    }
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(pointer: fine)").matches
    ) {
      return;
    }
    const host = anchorRef.current?.parentElement as HTMLElement | null;
    if (!host) {
      return;
    }
    if (elastic) {
      host.classList.add("lg-elastic");
    }
    let raf = 0;
    let hovered = false;
    let pressed = false;
    let tx = 0;
    let ty = 0;
    let sx = 1;
    let sy = 1;
    let glintX = 50;
    let glintY = 0;
    const resetGlint = () => {
      host.style.removeProperty("--lg-glint-x");
      host.style.removeProperty("--lg-glint-y");
    };
    const apply = () => {
      raf = 0;
      if (interactive) {
        if (!hovered && !pressed) {
          resetGlint();
        } else {
          host.style.setProperty("--lg-glint-x", `${glintX.toFixed(1)}%`);
          host.style.setProperty("--lg-glint-y", `${glintY.toFixed(1)}%`);
        }
      }
      if (!elastic) {
        return;
      }
      if (!hovered && !pressed) {
        host.style.transform = "";
        return;
      }
      const press = pressed ? " scale(0.97)" : "";
      host.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scaleX(${sx.toFixed(3)}) scaleY(${sy.toFixed(3)})${press}`;
    };
    const schedule = () => {
      if (raf === 0) {
        raf = requestAnimationFrame(apply);
      }
    };
    const onMove = (event: MouseEvent) => {
      if (host instanceof HTMLButtonElement && host.disabled) {
        return;
      }
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      if (elastic) {
        // Normalized offset from center, [-0.5, 0.5] while inside the control.
        const nx = (event.clientX - (rect.left + rect.width / 2)) / rect.width;
        const ny = (event.clientY - (rect.top + rect.height / 2)) / rect.height;
        tx = Math.max(-4, Math.min(4, nx * 7));
        ty = Math.max(-3, Math.min(3, ny * 7));
        sx = 1 + Math.min(0.03, Math.abs(nx) * 0.05);
        sy = 1 + Math.min(0.04, Math.abs(ny) * 0.08);
      }
      if (interactive) {
        glintX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
        glintY = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
      }
      hovered = true;
      schedule();
    };
    const onLeave = () => {
      hovered = false;
      pressed = false;
      schedule();
    };
    const onDown = () => {
      pressed = true;
      schedule();
    };
    const onUp = () => {
      pressed = false;
      schedule();
    };
    host.addEventListener("mousemove", onMove);
    host.addEventListener("mouseleave", onLeave);
    host.addEventListener("mousedown", onDown);
    host.addEventListener("mouseup", onUp);
    return () => {
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseleave", onLeave);
      host.removeEventListener("mousedown", onDown);
      host.removeEventListener("mouseup", onUp);
      if (raf !== 0) {
        cancelAnimationFrame(raf);
      }
      host.style.transform = "";
      resetGlint();
      host.classList.remove("lg-elastic");
    };
  }, [glass.active, glass.reducedMotion, elastic, interactive]);

  if (!glass.active) {
    return null;
  }

  const lensReady = glass.lensed && map !== null;
  // Shine budget by physical size: at panel scale even a soft border light
  // reads as a drawn outline on dark wallpapers, so plates run the rim
  // layers near-off while small controls keep the livelier glint.
  const plateScale = map !== null && (map.width > 420 || map.height > 240);
  // Split exactly like the reference: backdrop-filter carries only the plain
  // blur/saturate chain, while the displacement graph goes into the regular
  // `filter` property of the same span. Chromium folds the backdrop-filter
  // output into the span's own surface, so the SVG filter (running on the
  // fully supported non-compositor path) warps the blurred backdrop; a
  // `url()` inside backdrop-filter itself hits Chromium's compositor filter
  // path, which mishandles feImage-based graphs and silently no-ops.
  const plainChain =
    "blur(calc(var(--lg-blur, 10px) + var(--lg-blur-boost, 0px))) saturate(var(--lg-saturate, 1.4)) brightness(var(--lg-brightness, 1.06))";
  const layerStyle: Record<string, string> = {};
  if (blur !== undefined) {
    layerStyle["--lg-blur"] = `${blur}px`;
  }
  if (glass.overLight) {
    layerStyle["--lg-blur-boost"] = "4px";
  }

  return (
    <>
      {/* Backdrop layer: the only filtered layer — bends and frosts what is
          behind the glass while the host's content above stays sharp. Direct
          host child on purpose: inside .lg-layers the blend-mode siblings
          would isolate the wrapper and blind the backdrop-filter (see the
          header comment). The outer span clips (regular `filter` output is
          not clipped by the element's own border-radius); the inner warp
          span carries backdrop-filter + the SVG displacement filter. */}
      <span className="lg-backdrop" aria-hidden="true">
        {lensReady && map !== null && (
          <GlassFilter
            id={filterId}
            mapUrl={map.url}
            width={map.width}
            height={map.height}
            displacementScale={displacementScale}
            aberrationIntensity={aberrationIntensity}
          />
        )}
        <span
          className="lg-warp"
          style={
            {
              ...layerStyle,
              WebkitBackdropFilter: plainChain,
              backdropFilter: plainChain,
              filter: lensReady ? `url(#${filterId})` : undefined,
            } as CSSProperties
          }
        />
      </span>
      <span
        ref={anchorRef}
        className="lg-layers"
        aria-hidden="true"
        data-lg-lens={lensReady ? "on" : "off"}
        data-lg-scale={plateScale ? "plate" : "control"}
        data-lg-tint={tint}
        data-lg-overlight={glass.overLight ? "true" : "false"}
      >
        <span className="lg-tint" />
        <span className="lg-shine" />
        <span className="lg-shine lg-shine-overlay" />
        {interactive && <span className="lg-glint" />}
      </span>
    </>
  );
}

// Corner radius of the host in px, for the map's rounded-rect SDF. Handles
// the common cases (px values, pill radii larger than the box).
function readCornerRadius(host: Element, width: number, height: number): number {
  try {
    const raw = getComputedStyle(host).borderTopLeftRadius;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }
    const px = raw.trim().endsWith("%")
      ? (value / 100) * Math.min(width, height)
      : value;
    return Math.min(px, Math.min(width, height) / 2);
  } catch {
    return 0;
  }
}

// --- host wrapper -------------------------------------------------------------

export type LiquidGlassProps = LiquidGlassLayersProps & {
  /** Host tag; the element keeps its own classes, layout and handlers. */
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  // Host element props (event handlers, aria, data-*, style, …).
  [key: string]: unknown;
};

// Fill-parent host wrapper: renders the interactive element itself (launch
// pad, chip, picker tile, dialog card, …) and slips the material layers
// behind its children. In Standard / Glass profiles it renders the exact
// same element with no extra DOM. Structural chrome (sidebar, titlebar)
// must NOT use this — quiet CSS frost only (see styles.css).
export default function LiquidGlass({
  as,
  mode,
  displacementScale,
  aberrationIntensity,
  blur,
  tint,
  interactive,
  elastic,
  overLight,
  className = "",
  children,
  ...rest
}: LiquidGlassProps) {
  const glass = useLiquidGlass({ overLight });
  const Tag = (as ?? "div") as ElementType;
  const hostClassName = glass.active ? `${className} ${glass.hostClassName}`.trim() : className;
  return (
    <Tag className={hostClassName} {...rest}>
      <LiquidGlassLayers
        mode={mode}
        displacementScale={displacementScale}
        aberrationIntensity={aberrationIntensity}
        blur={blur}
        tint={tint}
        interactive={interactive}
        elastic={elastic}
        overLight={overLight}
      />
      {children}
    </Tag>
  );
}
