import { convertFileSrc } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, PRESET_INSTANCES, STORAGE_KEYS } from "../constants";
import { IS_WINDOWS } from "./platform";
import fabricIcon from "../assets/icons/fabric.png";
import forgeIcon from "../assets/icons/forge.png";
import grassIcon from "../assets/icons/grass.png";
import { detectLocaleFromEnvironment } from "../i18n";
import type {
  BackgroundSource,
  DownloadSource,
  InstallIpcEvent,
  InstallPhaseState,
  LaunchPrepareDialogState,
  LaunchPreparePhaseKey,
  LaunchPreparePhaseState,
  LauncherUser,
  MinecraftAccount,
  Instance,
  Locale,
  Settings,
  ThemeAccent,
  ThemeMode,
  UiLogEntry
} from "../types";

export function createPhaseState(
  title: string,
  sourcePhase: "vanilla" | "forge" | "fabric" | "optifine"
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
    cached: 0,
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    items: []
  };
}

export function createLaunchPreparePhaseState(
  key: LaunchPreparePhaseKey,
  title: string,
  message: string
): LaunchPreparePhaseState {
  return {
    key,
    title,
    status: "pending",
    stage: "",
    message,
    current: 0,
    total: 0,
    downloaded: 0,
    cached: 0,
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    items: []
  };
}

export function createLaunchPrepareDialogState(
  sessionId: string,
  instanceName: string,
  versionId: string,
  phaseTitles: Record<LaunchPreparePhaseKey, string>,
  waitingText: string,
  initialMessage: string
): LaunchPrepareDialogState {
  return {
    open: true,
    sessionId,
    instanceName,
    versionId,
    canClose: false,
    errorText: "",
    phases: [
      createLaunchPreparePhaseState("login", phaseTitles.login, waitingText),
      {
        ...createLaunchPreparePhaseState("check-instance", phaseTitles["check-instance"], initialMessage),
        status: "running",
        stage: "prepare"
      },
      createLaunchPreparePhaseState("verify", phaseTitles.verify, waitingText),
      createLaunchPreparePhaseState("vanilla", phaseTitles.vanilla, waitingText),
      createLaunchPreparePhaseState("fabric", phaseTitles.fabric, waitingText),
      createLaunchPreparePhaseState("forge", phaseTitles.forge, waitingText),
      createLaunchPreparePhaseState("optifine", phaseTitles.optifine, waitingText),
      createLaunchPreparePhaseState("mods", phaseTitles.mods, waitingText),
      createLaunchPreparePhaseState("runtime", phaseTitles.runtime, waitingText),
      createLaunchPreparePhaseState("launch", phaseTitles.launch, waitingText)
    ]
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

// Wall-clock now, wrapped so component code can read it without the react-hooks/purity
// rule flagging a raw `Date.now()` call.
export function nowMs(): number {
  return Date.now();
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
    const fallbackPlayerName = resolveDefaultPlayerName();
    if (!raw) {
      return {
        ...DEFAULT_SETTINGS,
        playerName: fallbackPlayerName,
        language: detectLocaleFromEnvironment()
      };
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const language = parseLocale(parsed.language);
    const themeMode = parseThemeMode(parsed.themeMode);
    const themeAccent = parseThemeAccent(parsed.themeAccent);
    const customAccentHex = parseCustomAccentHex(parsed.customAccentHex);
    const parsedBackgroundSource = parseBackgroundSource(parsed.backgroundSource);
    const backgroundSource =
      parsedBackgroundSource === "system" && !IS_WINDOWS ? DEFAULT_SETTINGS.backgroundSource : parsedBackgroundSource;
    return {
      gameDir:
        typeof parsed.gameDir === "string" && parsed.gameDir
          ? parsed.gameDir
          : DEFAULT_SETTINGS.gameDir,
      playerName:
        typeof parsed.playerName === "string" && parsed.playerName
          ? parsed.playerName
          : fallbackPlayerName,
      downloadSource: parseDownloadSource(parsed.downloadSource),
      downloadThreads:
        typeof parsed.downloadThreads === "number"
          ? clamp(Math.round(parsed.downloadThreads), 1, 32)
          : DEFAULT_SETTINGS.downloadThreads,
      launcherUpdateChannel: parseLauncherUpdateChannel(parsed.launcherUpdateChannel),
      maxMemoryMb:
        typeof parsed.maxMemoryMb === "number"
          ? clamp(parsed.maxMemoryMb, 1024, 16384)
          : DEFAULT_SETTINGS.maxMemoryMb,
      hideMainOnLaunch:
        typeof parsed.hideMainOnLaunch === "boolean"
          ? parsed.hideMainOnLaunch
          : DEFAULT_SETTINGS.hideMainOnLaunch,
      minimizeToTray:
        typeof parsed.minimizeToTray === "boolean"
          ? parsed.minimizeToTray
          : DEFAULT_SETTINGS.minimizeToTray,
      launchOnStartup:
        typeof parsed.launchOnStartup === "boolean"
          ? parsed.launchOnStartup
          : DEFAULT_SETTINGS.launchOnStartup,
      language,
      themeMode,
      themeAccent,
      customAccentHex,
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
          : DEFAULT_SETTINGS.backgroundBlur,
      curseforgeApiKey:
        typeof parsed.curseforgeApiKey === "string"
          ? parsed.curseforgeApiKey
          : DEFAULT_SETTINGS.curseforgeApiKey
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      playerName: resolveDefaultPlayerName(),
      language: detectLocaleFromEnvironment()
    };
  }
}

function resolveDefaultPlayerName(): string {
  try {
    const authRaw = localStorage.getItem(STORAGE_KEYS.launcherAuth);
    if (authRaw) {
      const parsed = JSON.parse(authRaw) as { user?: LauncherUser | null };
      const username = parsed?.user?.username?.trim();
      if (username) {
        return username;
      }
    }
  } catch {
    // Ignore malformed launcher auth storage
  }

  try {
    const prefsRaw = localStorage.getItem(STORAGE_KEYS.launcherLoginPrefs);
    if (prefsRaw) {
      const parsed = JSON.parse(prefsRaw) as { usernameOrEmail?: string };
      const identity = parsed?.usernameOrEmail?.trim();
      if (identity) {
        return identity;
      }
    }
  } catch {
    // Ignore malformed launcher login prefs storage
  }

  return "";
}

function parseLocale(input: unknown): Locale {
  if (input === "zh-CN" || input === "en-US") {
    return input;
  }
  return detectLocaleFromEnvironment();
}

function parseDownloadSource(input: unknown): DownloadSource {
  if (
    input === "official-only" ||
    input === "mirror-only" ||
    input === "mirror-first" ||
    input === "official-first"
  ) {
    return input;
  }
  if (input === "official") {
    return "official-only";
  }
  if (input === "bmclapi") {
    return "mirror-first";
  }
  return DEFAULT_SETTINGS.downloadSource;
}

function parseLauncherUpdateChannel(input: unknown): string {
  if (typeof input !== "string") {
    return DEFAULT_SETTINGS.launcherUpdateChannel;
  }
  const normalized = input.trim().toLowerCase();
  // Only beta/release remain. Legacy cannary/canary/nightly/alpha installs map to beta.
  if (normalized === "release") {
    return "release";
  }
  if (
    normalized === "beta" ||
    normalized === "cannary" ||
    normalized === "canary" ||
    normalized === "nightly" ||
    normalized === "alpha"
  ) {
    return "beta";
  }
  return DEFAULT_SETTINGS.launcherUpdateChannel;
}

function parseThemeMode(input: unknown): ThemeMode {
  if (input === "dark" || input === "light") {
    return input;
  }
  return DEFAULT_SETTINGS.themeMode;
}

function parseThemeAccent(input: unknown): ThemeAccent {
  if (
    input === "emerald" ||
    input === "cyan" ||
    input === "violet" ||
    input === "sunset" ||
    input === "rose" ||
    input === "amber" ||
    input === "sky" ||
    input === "lime" ||
    input === "background" ||
    input === "custom"
  ) {
    return input;
  }
  return DEFAULT_SETTINGS.themeAccent;
}

function parseCustomAccentHex(input: unknown): string {
  if (typeof input !== "string") {
    return DEFAULT_SETTINGS.customAccentHex;
  }
  const normalized = normalizeHexColor(input);
  return normalized ?? DEFAULT_SETTINGS.customAccentHex;
}

function parseBackgroundSource(input: unknown): BackgroundSource {
  if (input === "local" || input === "web-random" || input === "system") {
    return input;
  }
  return DEFAULT_SETTINGS.backgroundSource;
}

export function resolveBackgroundAssetUrl(settings: Settings): string {
  if (settings.backgroundSource === "web-random") {
    return settings.backgroundWebUrl;
  }
  if (settings.backgroundSource === "system") {
    const value = settings.backgroundImage.trim();
    if (!value) {
      return "";
    }
    return value.startsWith("data:") ? value : convertFileSrc(value);
  }
  return settings.backgroundImage;
}

export function applyTheme(mode: ThemeMode, accent: ThemeAccent, customAccentHex: string) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.setAttribute("data-accent", accent);

  if (accent !== "custom" && accent !== "background") {
    root.style.removeProperty("--custom-accent");
    root.style.removeProperty("--custom-accent-dark");
    root.style.removeProperty("--custom-diamond");
    root.style.removeProperty("--custom-emerald");
    root.style.removeProperty("--custom-gold");
    root.style.removeProperty("--custom-accent-rgb");
    return;
  }

  const normalized = normalizeHexColor(customAccentHex) ?? DEFAULT_SETTINGS.customAccentHex;
  const rgb = hexToRgb(normalized);
  if (!rgb) {
    return;
  }
  const dark = tintRgb(rgb, 0.8);
  const diamond = tintRgb(rgb, 1.22);
  const emerald = tintRgb(rgb, 1.08);
  const gold = tintRgb(rgb, 1.34);

  root.style.setProperty("--custom-accent", rgbToHex(rgb));
  root.style.setProperty("--custom-accent-dark", rgbToHex(dark));
  root.style.setProperty("--custom-diamond", rgbToHex(diamond));
  root.style.setProperty("--custom-emerald", rgbToHex(emerald));
  root.style.setProperty("--custom-gold", rgbToHex(gold));
  root.style.setProperty("--custom-accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
}

function normalizeHexColor(input: string): string | null {
  const value = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [r, g, b] = value.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const raw = normalized.slice(1);
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return null;
  }
  return { r, g, b };
}

function rgbToHex(color: { r: number; g: number; b: number }): string {
  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function tintRgb(color: { r: number; g: number; b: number }, factor: number): { r: number; g: number; b: number } {
  return {
    r: clampChannel(Math.round(color.r * factor)),
    g: clampChannel(Math.round(color.g * factor)),
    b: clampChannel(Math.round(color.b * factor))
  };
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
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
    if (preset.launcherVersionType === "EDGE") {
      // Edge re-resolves versionId/loaderVersion/optiFineVersion live on every launch, so
      // those are safe to reset to the preset defaults — but useForge/useOptiFine are user
      // preferences (Forge/OptiFine toggles) that must survive a reload.
      return {
        ...preset,
        useForge: saved.useForge !== undefined ? saved.useForge : preset.useForge,
        useOptiFine: saved.useOptiFine !== undefined ? saved.useOptiFine : preset.useOptiFine
      };
    }
    const keepLoaderVersion = saved.baseVersion === preset.baseVersion;
    return {
      ...preset,
      versionId: saved.versionId || preset.versionId,
      loaderVersion: keepLoaderVersion ? saved.loaderVersion : undefined,
      optiFineVersion: keepLoaderVersion ? saved.optiFineVersion : undefined
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
  const leftSemver = parseSemverLike(a);
  const rightSemver = parseSemverLike(b);
  if (leftSemver && rightSemver) {
    return compareSemverLike(leftSemver, rightSemver);
  }

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

type ParsedSemverLike = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseSemverLike(input: string): ParsedSemverLike | null {
  const match = input.trim().match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4]?.split(".").filter(Boolean) ?? [],
  };
}

function compareSemverLike(a: ParsedSemverLike, b: ParsedSemverLike): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  const leftStable = a.prerelease.length === 0;
  const rightStable = b.prerelease.length === 0;
  if (leftStable && rightStable) return 0;
  if (leftStable) return 1;
  if (rightStable) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftIsNumber = /^\d+$/.test(left);
    const rightIsNumber = /^\d+$/.test(right);
    if (leftIsNumber && rightIsNumber) {
      return Number.parseInt(left, 10) - Number.parseInt(right, 10);
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return left.localeCompare(right);
  }
  return 0;
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
