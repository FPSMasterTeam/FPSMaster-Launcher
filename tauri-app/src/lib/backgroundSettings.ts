import type { BackgroundSource } from "../types";

/** Ignore removed web-background settings instead of reviving a network image. */
export function normalizeBackgroundSettings(value: unknown): {
  backgroundSource: BackgroundSource; backgroundImage: string; backgroundVideo: string;
} {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const source = raw.backgroundSource;
  if (source !== "local" && source !== "video" && source !== "system") {
    return { backgroundSource: "local", backgroundImage: "", backgroundVideo: "" };
  }
  const localAsset = (value: unknown) =>
    typeof value === "string" && !/^(https?:)?\/\//i.test(value.trim()) ? value : "";
  return {
    backgroundSource: source,
    backgroundImage: localAsset(raw.backgroundImage),
    backgroundVideo: localAsset(raw.backgroundVideo)
  };
}
