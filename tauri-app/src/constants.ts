import type { Instance, NewsItem, ServerItem, Settings } from "./types";

export const STORAGE_KEYS = {
  instances: "fpsmaster.instances",
  settings: "fpsmaster.settings",
  selected: "fpsmaster.selected"
} as const;

export const NEWS_ITEMS: readonly NewsItem[] = [
  {
    title: "全新启动器发布",
    summary: "基于现代技术栈开发的FPSMaster启动器已发布，提供便捷快速的启动体验。"
  }
];

export const RECOMMENDED_SERVERS: readonly ServerItem[] = [
  {
    name: "Hypixel",
    address: "mc.hypixel.net",
    mode: "PvP",
    iconPath: "/server-icons/hypixel.png"
  },
  {
    name: "CloverPixel",
    address: "cloverpixel.com",
    mode: "Network",
    iconPath: "/server-icons/cloverpixel.png"
  }
];

export const DEFAULT_SETTINGS: Settings = {
  gameDir: "./.minecraft",
  playerName: "Player",
  maxMemoryMb: 4096,
  hideMainOnLaunch: true,
  language: "en-US",
  themeMode: "dark",
  themeAccent: "emerald",
  backgroundSource: "local",
  backgroundImage: "",
  backgroundWebUrl: "",
  backgroundOpacity: 32,
  backgroundBlur: 0
};

export const PRESET_INSTANCES: readonly Instance[] = [
  {
    id: "preset-1.8.9-forge",
    name: "FPSMaster Edge (1.8.9)",
    versionId: "FPSMaster-Edge",
    baseVersion: "1.8.9",
    loader: "forge",
    iconPath: "/instance-icons/edge.png",
    preset: true
  },
  {
    id: "preset-1.20.1-fabric",
    name: "FPSMaster Nova (1.20.1)",
    versionId: "FPSMaster-Nova",
    baseVersion: "1.20.1",
    loader: "fabric",
    iconPath: "/instance-icons/nova.png",
    preset: true
  }
];

export function resolvePresetVersionId(instanceId: string): string | null {
  if (instanceId === "preset-1.8.9-forge") {
    return "FPSMaster-Edge";
  }
  if (instanceId === "preset-1.20.1-fabric") {
    return "FPSMaster-Nova";
  }
  return null;
}
