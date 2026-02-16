export type Page = "home" | "instances" | "install" | "settings" | "instance-settings";
export type Loader = "vanilla" | "forge" | "fabric";
export type PhaseStatus = "pending" | "running" | "done" | "error";
export type Locale = "en-US" | "zh-CN";
export type ThemeMode = "dark" | "light";
export type ThemeAccent = "emerald" | "cyan" | "violet" | "sunset";
export type BackgroundSource = "local" | "web-random";

export type Instance = {
  id: string;
  name: string;
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string;
  iconPath?: string;
  preset: boolean;
};

export type Settings = {
  gameDir: string;
  playerName: string;
  maxMemoryMb: number;
  hideMainOnLaunch: boolean;
  language: Locale;
  themeMode: ThemeMode;
  themeAccent: ThemeAccent;
  backgroundSource: BackgroundSource;
  backgroundImage: string;
  backgroundWebUrl: string;
  backgroundOpacity: number;
  backgroundBlur: number;
};

export type NewsItem = {
  title: string;
  summary: string;
};

export type ServerItem = {
  name: string;
  address: string;
  mode: string;
  iconPath?: string;
};

export type LaunchExecutionResult = {
  versionId: string;
  pid: number;
  command: string[];
  mainClass: string;
  shell: string;
};

export type InstallResult = { versionId: string };
export type FabricInstallResult = { profileId: string };
export type ForgeInstallResult = { profileId: string; forgeVersion: string };
export type JdkEnsureResult = { javaPath: string };

export type UiLogEntry = {
  seq: number;
  source: string;
  level: string;
  message: string;
};

export type UiLogPollResult = {
  entries: UiLogEntry[];
  nextSeq: number;
};

export type GameRuntimeStats = {
  pid: number;
  running: boolean;
  memoryMb: number | null;
  elapsedMs: number | null;
};

export type InstallIpcEvent = {
  channel: string;
  event: string;
  phase?: string;
  stage?: string;
  session?: string;
  current?: number;
  total?: number;
  downloaded?: number;
  cached?: number;
  message?: string;
  error?: string;
};

export type InstallPhaseState = {
  title: string;
  sourcePhase: "vanilla" | "forge" | "fabric";
  status: PhaseStatus;
  stage: string;
  message: string;
  current: number;
  total: number;
  downloaded: number;
  cached: number;
};

export type InstallDialogState = {
  open: boolean;
  sessionId: string;
  versionId: string;
  loader: Loader;
  canClose: boolean;
  errorText: string;
  vanilla: InstallPhaseState;
  loaderPhase: InstallPhaseState | null;
};

export type InstanceSectionEntry = {
  name: string;
  isDir: boolean;
};
