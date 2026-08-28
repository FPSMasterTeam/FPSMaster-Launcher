import { memo, useEffect, useRef } from "react";

type AppBackgroundProps = {
  url: string | null;
  videoUrl: string | null;
  opacity: number;
  blur: number;
  // True while the window is hidden (tray) — the video must not keep decoding
  // frames nobody can see.
  paused: boolean;
};

// Full-window decorative background layer (behind the launcher shell).
// Renders either a static image or a muted looped video. The video never gets
// a CSS blur filter: live-blurring a decoding video is the single most
// expensive compositor combination on low-end machines, so softness for video
// comes from the dim overlay (and capped frost blur, see styles.css).
function AppBackground({ url, videoUrl, opacity, blur, paused }: AppBackgroundProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hasVideo = Boolean(videoUrl);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = true;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      const shouldPause = paused || document.hidden || reduceMotion.matches;
      if (shouldPause) {
        video.pause();
      } else {
        void video.play().catch(() => {
          // Autoplay can be rejected before the source is ready; the next
          // sync (visibility/pause change) retries.
        });
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    reduceMotion.addEventListener("change", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      reduceMotion.removeEventListener("change", sync);
    };
  }, [paused, videoUrl]);

  if (!url && !hasVideo) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {hasVideo ? (
        <video
          ref={videoRef}
          className="app-background-video"
          src={videoUrl ?? undefined}
          style={{ opacity: opacity / 100 }}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          disablePictureInPicture
          tabIndex={-1}
        />
      ) : (
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-[var(--duration-normal)]"
          style={{
            backgroundImage: `url("${url}")`,
            opacity: opacity / 100,
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            transform: blur > 0 ? "scale(1.04)" : "scale(1)"
          }}
        />
      )}
      <div className="absolute inset-0 bg-[var(--bg-primary)]/16" />
    </div>
  );
}

export default memo(AppBackground);
