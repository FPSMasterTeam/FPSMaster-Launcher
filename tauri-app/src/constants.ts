import type {
  BlurMode,
  Instance,
  LauncherLoginPrefs,
  NewsItem,
  Settings,
  VisualProfile
} from "./types";

export const DEFAULT_LOGIN_PREFS: LauncherLoginPrefs = {
  usernameOrEmail: "",
  password: "",
  rememberPassword: false,
  autoLogin: false
};

export const STORAGE_KEYS = {
  instances: "fpsmaster.instances",
  settings: "fpsmaster.settings",
  selected: "fpsmaster.selected",
  launcherAuth: "fpsmaster.launcherAuth",
  launcherLoginPrefs: "fpsmaster.launcherLoginPrefs",
  launcherSessionId: "fpsmaster.launcherSessionId",
  minecraftAccounts: "fpsmaster.minecraftAccounts",
  selectedMinecraftAccount: "fpsmaster.selectedMinecraftAccount",
  // Which Minecraft game version the user picked inside the Nova region (Nova stays one preset,
  // this sub-selection drives the launched MC version + matching mod jar).
  selectedNovaGameVersion: "fpsmaster.selectedNovaGameVersion"
} as const;

// Default/fallback Nova game version highlighted in the picker when the catalog hasn't loaded yet.
export const NOVA_DEFAULT_GAME_VERSION = "1.21.11";

// Rust backend needs the full API URL for invoke() calls
// Vite proxy only works for direct fetch() calls from frontend
export const LAUNCHER_API_BASE_URL = "https://api.fpsmaster.top";

// Account registration happens on the website, not in the launcher.
export const REGISTER_URL = "https://fpsmaster.top/register";

export const NEWS_ITEMS: readonly NewsItem[] = [
  {
    title: "欢迎使用 FPSMaster",
    summary: "登录后即可同步客户端包、查看最新公告，并快速启动常用实例。"
  }
];

export const DEFAULT_SETTINGS: Settings = {
  gameDir: "",
  playerName: "",
  downloadSource: "mirror-first",
  downloadThreads: 16,
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
  backgroundVideo: "",
  backgroundWebUrl: "",
  backgroundOpacity: 32,
  backgroundBlur: 0,
  blurMode: "background",
  cornerRadiusScale: 100,
  glowAmount: 20,
  visualProfile: "standard",
  curseforgeApiKey: ""
};

// Named visual presets. Picking one sets these three knobs; moving a knob off
// a preset flips the stored profile to "custom" (see resolveVisualProfile).
export type VisualProfilePreset = {
  blurMode: BlurMode;
  cornerRadiusScale: number;
  glowAmount: number;
};

export const VISUAL_PROFILE_PRESETS: Record<Exclude<VisualProfile, "custom">, VisualProfilePreset> = {
  // Refined dark default: flat matte surfaces, blur reserved for the wallpaper.
  standard: { blurMode: "background", cornerRadiusScale: 100, glowAmount: 20 },
  // Restrained liquid glass: frosted panels, slightly softer corners.
  glass: { blurMode: "frost", cornerRadiusScale: 115, glowAmount: 35 }
};

export function resolveVisualProfile(settings: Pick<Settings, "blurMode" | "cornerRadiusScale" | "glowAmount">): VisualProfile {
  for (const [name, preset] of Object.entries(VISUAL_PROFILE_PRESETS) as Array<[Exclude<VisualProfile, "custom">, VisualProfilePreset]>) {
    if (
      preset.blurMode === settings.blurMode &&
      preset.cornerRadiusScale === settings.cornerRadiusScale &&
      preset.glowAmount === settings.glowAmount
    ) {
      return name;
    }
  }
  return "custom";
}

export const PRESET_INSTANCES: readonly Instance[] = [
  {
    id: "preset-1.8.9-forge",
    name: "FPSMaster Edge (1.8.9)",
    versionId: "FPSMaster-Edge",
    baseVersion: "1.8.9",
    loader: "forge",
    launcherVersionType: "EDGE",
    iconPath: "/instance-icons/edge.png",
    preset: true,
    useForge: true,
    useOptiFine: true
  },
  {
    // Nova is a single "region" preset; the actual Minecraft version is chosen inside the Nova
    // picker (see selectedNovaGameVersion) and applied at launch time, so the name/baseVersion here
    // are only defaults/fallbacks. baseVersion stays 1.21.11 for offline/catalog-less fallback.
    id: "preset-1.20.1-fabric",
    name: "FPSMaster Nova",
    versionId: "FPSMaster-Nova",
    baseVersion: NOVA_DEFAULT_GAME_VERSION,
    loader: "fabric",
    launcherVersionType: "NOVA",
    iconPath: "/instance-icons/nova.png",
    preset: true
  },
  {
    // Native Rust client (fpsmaster_app), not a Java instance — installed and
    // launched via the launcher's native-app path, not the vanilla/loader
    // pipeline. `baseVersion`/`loader` are informational only; the
    // `launcherVersionType: "EXTREME"` discriminator drives the native path.
    id: "preset-extreme",
    name: "FPSMaster Extreme (1.8.9)",
    versionId: "FPSMaster-Extreme",
    baseVersion: "1.8.9",
    loader: "vanilla",
    launcherVersionType: "EXTREME",
    iconPath: "/instance-icons/extreme.png",
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
  if (instanceId === "preset-extreme") {
    return "FPSMaster-Extreme";
  }
  return null;
}
