import { memo, type CSSProperties, useEffect, useRef } from "react";

type AppBackgroundProps = {
  url: string | null;
  videoUrl: string | null;
  opacity: number;
  blur: number;
  paused: boolean;
  hidden: boolean;
};

type BackgroundVideoProps = {
  src: string;
  className?: string;
  style?: CSSProperties;
  paused?: boolean;
  onPlaybackError?: () => void;
};

export function BackgroundVideo({
  src,
  className,
  style,
  paused = false,
  onPlaybackError
}: BackgroundVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = true;
    video.defaultMuted = true;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      const shouldPause = paused || document.hidden || reduceMotion.matches;
      if (shouldPause) {
        video.pause();
      } else {
        void video.play().catch(() => {
          // Muted autoplay can still be rejected while the source is loading.
          // The media readiness events below retry without user interaction.
        });
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    reduceMotion.addEventListener("change", sync);
    video.addEventListener("loadeddata", sync);
    video.addEventListener("canplay", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      reduceMotion.removeEventListener("change", sync);
      video.removeEventListener("loadeddata", sync);
      video.removeEventListener("canplay", sync);
      video.pause();
    };
  }, [paused, src]);

  return (
    <video
      ref={videoRef}
      className={className}
      src={src}
      style={style}
      muted
      loop
      playsInline
      preload="metadata"
      disablePictureInPicture
      tabIndex={-1}
      onError={onPlaybackError}
    />
  );
}

// Full-window decorative background layer (behind the launcher shell).
// Renders either a static image or a muted looped video. The video never gets
// a CSS blur filter: live-blurring a decoding video is the single most
// expensive compositor combination on low-end machines, so softness for video
// comes from the dim overlay (and capped frost blur, see styles.css).
function AppBackground({ url, videoUrl, opacity, blur, paused, hidden }: AppBackgroundProps) {
  const hasVideo = Boolean(videoUrl);

  if (!url && !hasVideo) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      hidden={hidden}
      aria-hidden="true"
    >
      {hasVideo ? (
        <BackgroundVideo
          className="app-background-video"
          src={videoUrl as string}
          style={{ opacity: opacity / 100 }}
          paused={paused || hidden}
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
