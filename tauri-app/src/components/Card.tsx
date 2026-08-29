import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementType,
  type MouseEvent,
  type ReactNode
} from "react";
import { LiquidGlassLayers } from "./LiquidGlass";
import { useLiquidGlass } from "../hooks/useLiquidGlass";

type CardVariant = "soft" | "strong" | "frost";

type CardProps<T extends ElementType = "div"> = {
  as?: T;
  variant?: CardVariant;
  interactive?: boolean;
  className?: string;
  /**
   * Dialog-card Liquid Glass: under the liquid visual profile the card gets
   * the layered lens material (LiquidGlass component). No-op otherwise.
   */
  liquidGlass?: boolean;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

export default function Card<T extends ElementType = "div">({
  as,
  variant = "soft",
  interactive = true,
  className = "",
  liquidGlass = false,
  children,
  style,
  onMouseMove,
  onMouseLeave,
  ...rest
}: CardProps<T>) {
  const Component = (as ?? "div") as ElementType;
  const glass = useLiquidGlass();
  const glassActive = liquidGlass && glass.active;

  const baseClass =
    `ui-card ui-card-${variant} ${interactive ? "ui-card-interactive" : ""} ${className} ${glassActive ? glass.hostClassName : ""}`.trim();
  const mergedStyle = style as CSSProperties | undefined;

  function handleMouseMove(event: MouseEvent<HTMLElement>) {
    if (interactive) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.min(Math.max(0, event.clientX - rect.left), Math.max(0, rect.width));
      const y = Math.min(Math.max(0, event.clientY - rect.top), Math.max(0, rect.height));
      event.currentTarget.style.setProperty("--card-halo-x", `${x}px`);
      event.currentTarget.style.setProperty("--card-halo-y", `${y}px`);
    }
    (onMouseMove as ((event: MouseEvent<HTMLElement>) => void) | undefined)?.(event);
  }

  function handleMouseLeave(event: MouseEvent<HTMLElement>) {
    if (interactive) {
      event.currentTarget.style.setProperty("--card-halo-x", "50%");
      event.currentTarget.style.setProperty("--card-halo-y", "50%");
    }
    (onMouseLeave as ((event: MouseEvent<HTMLElement>) => void) | undefined)?.(event);
  }

  return (
    <Component
      className={baseClass}
      style={mergedStyle}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      {...rest}
    >
      {glassActive && (
        <LiquidGlassLayers mode="standard" displacementScale={48} aberrationIntensity={2} />
      )}
      {children}
    </Component>
  );
}
