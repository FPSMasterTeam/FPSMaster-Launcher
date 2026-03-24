import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementType,
  type MouseEvent
} from "react";

type CardVariant = "soft" | "strong" | "frost";

type CardProps<T extends ElementType = "div"> = {
  as?: T;
  variant?: CardVariant;
  interactive?: boolean;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className">;

export default function Card<T extends ElementType = "div">({
  as,
  variant = "soft",
  interactive = true,
  className = "",
  style,
  onMouseMove,
  onMouseLeave,
  ...rest
}: CardProps<T>) {
  const Component = (as ?? "div") as ElementType;

  const baseClass = `ui-card ui-card-${variant} ${interactive ? "ui-card-interactive" : ""} ${className}`.trim();
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
    />
  );
}
