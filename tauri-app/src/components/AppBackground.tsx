import { memo } from "react";

type AppBackgroundProps = {
  url: string | null;
  opacity: number;
  blur: number;
};

// Full-window decorative background image layer (behind the launcher shell).
function AppBackground({ url, opacity, blur }: AppBackgroundProps) {
  if (!url) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-[var(--duration-normal)]"
        style={{
          backgroundImage: `url("${url}")`,
          opacity: opacity / 100,
          filter: `blur(${blur}px)`,
          transform: blur > 0 ? "scale(1.04)" : "scale(1)"
        }}
      />
      <div className="absolute inset-0 bg-[var(--bg-primary)]/16" />
    </div>
  );
}

export default memo(AppBackground);
