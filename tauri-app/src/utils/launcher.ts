import { DEFAULT_SETTINGS, PRESET_INSTANCES, STORAGE_KEYS } from "../constants";
import fabricIcon from "../assets/icons/fabric.png";
import forgeIcon from "../assets/icons/forge.png";
import grassIcon from "../assets/icons/grass.png";
import { detectLocaleFromEnvironment } from "../i18n";
import type {
  BackgroundSource,
  InstallIpcEvent,
  InstallPhaseState,
  Instance,
  Locale,
  Settings,
  ThemeAccent,
  ThemeMode,
  UiLogEntry
} from "../types";

export function createPhaseState(
  title: string,
  sourcePhase: "vanilla" | "forge" | "fabric"
): InstallPhaseState {
  return {
    title,
    sourcePhase,
    status: "pending",
    stage: "",
    message: "Waiting...",
    current: 0,
    total: 0,
    downloaded: 0,
    cached: 0
  };
}

export function parseInstallIpc(message: string): InstallIpcEvent | null {
  if (!message.startsWith("[ipc]")) {
    return null;
  }
  const jsonText = message.slice("[ipc]".length).trim();
  if (jsonText === "") {
    return null;
  }
  try {
    return JSON.parse(jsonText) as InstallIpcEvent;
  } catch {
    return null;
  }
}

export function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export function loadInstances(): Instance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.instances);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Instance[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaults();
    return withPresetInstances(parsed);
  } catch {
    return defaults();
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) {
      return {
        ...DEFAULT_SETTINGS,
        language: detectLocaleFromEnvironment()
      };
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const language = parseLocale(parsed.language);
    const themeMode = parseThemeMode(parsed.themeMode);
    const themeAccent = parseThemeAccent(parsed.themeAccent);
    const backgroundSource = parseBackgroundSource(parsed.backgroundSource);
    return {
      gameDir:
        typeof parsed.gameDir === "string" && parsed.gameDir
          ? parsed.gameDir
          : DEFAULT_SETTINGS.gameDir,
      playerName:
        typeof parsed.playerName === "string" && parsed.playerName
          ? parsed.playerName
          : DEFAULT_SETTINGS.playerName,
      maxMemoryMb:
        typeof parsed.maxMemoryMb === "number"
          ? clamp(parsed.maxMemoryMb, 1024, 16384)
          : DEFAULT_SETTINGS.maxMemoryMb,
      hideMainOnLaunch:
        typeof parsed.hideMainOnLaunch === "boolean"
          ? parsed.hideMainOnLaunch
          : DEFAULT_SETTINGS.hideMainOnLaunch,
      language,
      themeMode,
      themeAccent,
      backgroundSource,
      backgroundImage:
        typeof parsed.backgroundImage === "string" ? parsed.backgroundImage : DEFAULT_SETTINGS.backgroundImage,
      backgroundWebUrl:
        typeof parsed.backgroundWebUrl === "string"
          ? parsed.backgroundWebUrl
          : DEFAULT_SETTINGS.backgroundWebUrl,
      backgroundOpacity:
        typeof parsed.backgroundOpacity === "number"
          ? clamp(parsed.backgroundOpacity, 0, 100)
          : DEFAULT_SETTINGS.backgroundOpacity,
      backgroundBlur:
        typeof parsed.backgroundBlur === "number"
          ? clamp(parsed.backgroundBlur, 0, 32)
          : DEFAULT_SETTINGS.backgroundBlur
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      language: detectLocaleFromEnvironment()
    };
  }
}

function parseLocale(input: unknown): Locale {
  if (input === "zh-CN" || input === "en-US") {
    return input;
  }
  return detectLocaleFromEnvironment();
}

function parseThemeMode(input: unknown): ThemeMode {
  if (input === "dark" || input === "light") {
    return input;
  }
  return DEFAULT_SETTINGS.themeMode;
}

function parseThemeAccent(input: unknown): ThemeAccent {
  if (input === "emerald" || input === "cyan" || input === "violet" || input === "sunset") {
    return input;
  }
  return DEFAULT_SETTINGS.themeAccent;
}

function parseBackgroundSource(input: unknown): BackgroundSource {
  if (input === "local" || input === "web-random") {
    return input;
  }
  return DEFAULT_SETTINGS.backgroundSource;
}

export function applyTheme(mode: ThemeMode, accent: ThemeAccent) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.setAttribute("data-accent", accent);
}

function defaults(): Instance[] {
  return PRESET_INSTANCES.map((item) => ({ ...item }));
}

function withPresetInstances(instances: Instance[]): Instance[] {
  const byId = new Map(instances.map((item) => [item.id, item]));
  const presets = PRESET_INSTANCES.map((preset) => {
    const saved = byId.get(preset.id);
    if (!saved) {
      return { ...preset };
    }
    return {
      ...preset,
      versionId: saved.versionId || preset.versionId,
      loaderVersion: saved.loaderVersion
    };
  });
  const custom = instances
    .filter((item) => !item.id.startsWith("preset-"))
    .map(normalizeLegacyCustomInstanceName);
  return [...presets, ...custom];
}

function normalizeLegacyCustomInstanceName(instance: Instance): Instance {
  const vanillaLegacyName = `FPSMaster ${instance.baseVersion}`;
  const loaderLegacyName = `FPSMaster ${instance.baseVersion} (${instance.loader})`;
  if (instance.name !== vanillaLegacyName && instance.name !== loaderLegacyName) {
    return instance;
  }
  return {
    ...instance,
    name: instance.loader === "vanilla" ? instance.baseVersion : `${instance.baseVersion} (${instance.loader})`
  };
}

export function resolveInstallVersion(
  catalog: string[],
  grouped: Record<string, string[]>,
  major: string,
  showSnapshots: boolean,
  current: string
): string {
  const snapshotVersions = catalog.filter(isSnapshot);
  if (showSnapshots) {
    return snapshotVersions.includes(current) ? current : (snapshotVersions[0] ?? "");
  }

  const currentMajorVersions = major ? grouped[major] ?? [] : [];
  if (currentMajorVersions.length > 0) {
    return currentMajorVersions.includes(current) ? current : currentMajorVersions[0];
  }

  const firstMajor = Object.keys(grouped).sort((a, b) => compareMajor(b, a))[0];
  const fallbackVersions = firstMajor ? grouped[firstMajor] ?? [] : [];
  return fallbackVersions.includes(current) ? current : (fallbackVersions[0] ?? "");
}

export function groupByMajor(versions: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const version of versions) {
    if (isSnapshot(version)) continue;
    const major = majorOf(version);
    if (!major) continue;
    out[major] = out[major] ?? [];
    out[major].push(version);
  }
  for (const major of Object.keys(out)) out[major].sort((a, b) => compareRelease(b, a));
  return out;
}

function majorOf(version: string): string {
  const match = version.match(/^(\d+\.\d+)/);
  return match ? match[1] : "";
}

export function isSnapshot(version: string): boolean {
  return !/^\d+\.\d+(?:\.\d+)?$/.test(version);
}

function compareRelease(a: string, b: string): number {
  const left = a.split(".").map((item) => Number.parseInt(item, 10));
  const right = b.split(".").map((item) => Number.parseInt(item, 10));
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    if (l !== r) return l - r;
  }
  return 0;
}

export function compareMajor(a: string, b: string): number {
  return compareRelease(a, b);
}

export function prefix(entry: UiLogEntry): string {
  if (entry.source === "game") return entry.level === "stderr" ? "[game-err]" : "[game]";
  return entry.level === "stderr" ? "[core-err]" : "[core]";
}

export function parseIntSafe(input: string | null, fallback: number): number {
  if (input === null) return fallback;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`
    : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function resolveInstanceIconPath(instance: Pick<Instance, "iconPath" | "loader">): string {
  if (instance.iconPath && instance.iconPath.trim() !== "") {
    return instance.iconPath;
  }
  if (instance.loader === "forge") {
    return forgeIcon;
  }
  if (instance.loader === "fabric") {
    return fabricIcon;
  }
  return grassIcon;
}
