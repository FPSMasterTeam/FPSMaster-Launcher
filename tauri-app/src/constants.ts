import type { Instance, NewsItem, Settings } from "./types";

export const STORAGE_KEYS = {
  instances: "fpsmaster.instances",
  settings: "fpsmaster.settings",
  selected: "fpsmaster.selected",
  launcherAuth: "fpsmaster.launcherAuth",
  launcherLoginPrefs: "fpsmaster.launcherLoginPrefs",
  launcherSessionId: "fpsmaster.launcherSessionId",
  minecraftAccounts: "fpsmaster.minecraftAccounts",
  selectedMinecraftAccount: "fpsmaster.selectedMinecraftAccount"
} as const;

// Rust backend needs the full API URL for invoke() calls
// Vite proxy only works for direct fetch() calls from frontend
export const LAUNCHER_API_BASE_URL = "https://api.fpsmaster.top";

export const NEWS_ITEMS: readonly NewsItem[] = [
  {
    title: "欢迎使用 FPSMaster",
    summary: "登录后即可同步客户端包、查看最新公告，并快速启动常用实例。"
  }
];

export const DEFAULT_SETTINGS: Settings = {
  gameDir: "",
  playerName: "",
  downloadSource: "official",
  downloadThreads: 8,
  launcherUpdateChannel: "beta",
  maxMemoryMb: 4096,
  hideMainOnLaunch: true,
  minimizeToTray: true,
  launchOnStartup: true,
  language: "en-US",
  themeMode: "dark",
  themeAccent: "emerald",
  customAccentHex: "#25b87a",
  backgroundSource: "local",
  backgroundImage: "",
  backgroundWebUrl: "",
  backgroundOpacity: 32,
  backgroundBlur: 0,
  curseforgeApiKey: ""
};

export const PRESET_INSTANCES: readonly Instance[] = [
  {
    id: "preset-1.8.9-forge",
    name: "FPSMaster Edge (1.8.9)",
    versionId: "FPSMaster-Edge",
    baseVersion: "1.8.9",
    loader: "forge",
    launcherVersionType: "EDGE",
    iconPath: "/instance-icons/edge.png",
    preset: true
  },
  {
    id: "preset-1.20.1-fabric",
    name: "FPSMaster Nova (1.20.1)",
    versionId: "FPSMaster-Nova",
    baseVersion: "1.20.1",
    loader: "fabric",
    launcherVersionType: "NOVA",
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
