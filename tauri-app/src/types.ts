export type Page = "home" | "instances" | "install" | "content" | "settings" | "instance-settings";
export type Loader = "vanilla" | "forge" | "fabric";
export type PhaseStatus = "pending" | "running" | "done" | "error";
export type Locale = "en-US" | "zh-CN";
export type ThemeMode = "dark" | "light";
export type ThemeAccent =
  | "emerald"
  | "cyan"
  | "violet"
  | "sunset"
  | "rose"
  | "amber"
  | "sky"
  | "lime"
  | "custom";
export type BackgroundSource = "local" | "web-random";
export type LauncherVersionType = "EDGE" | "NOVA";
export type ContentSource = "modrinth" | "curseforge" | "local";
export type OnlineContentSource = Exclude<ContentSource, "local">;
export type ContentProjectType = "mod" | "resourcepack" | "shader" | "world";
export type InstalledContentUpdateStatus =
  | "up-to-date"
  | "update-available"
  | "unavailable"
  | "error";

export type Instance = {
  id: string;
  name: string;
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string;
  launcherVersionType?: LauncherVersionType;
  iconPath?: string;
  preset: boolean;
};

export type Settings = {
  gameDir: string;
  playerName: string;
  maxMemoryMb: number;
  hideMainOnLaunch: boolean;
  minimizeToTray: boolean;
  launchOnStartup: boolean;
  language: Locale;
  themeMode: ThemeMode;
  themeAccent: ThemeAccent;
  customAccentHex: string;
  backgroundSource: BackgroundSource;
  backgroundImage: string;
  backgroundWebUrl: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  curseforgeApiKey: string;
};

export type NewsItem = {
  id?: string;
  title: string;
  summary: string;
  pinned?: boolean;
  publishedAt?: string | null;
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

export type ModrinthSearchResult = {
  source: OnlineContentSource;
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string | null;
  downloads: number;
  categories: string[];
  displayCategories: string[];
  projectType: ContentProjectType;
  latestGameVersion?: string | null;
  gameVersions: string[];
  clientSide?: string | null;
  serverSide?: string | null;
};

export type ModrinthInstallResult = {
  source: OnlineContentSource;
  projectId: string;
  projectTitle: string;
  contentType: ContentProjectType;
  versionId: string;
  versionNumber: string;
  fileName: string;
  targetDir: string;
  installedPath: string;
  changelog?: string | null;
};

export type WorldInstallResult = {
  source: ContentSource;
  projectId: string;
  projectTitle: string;
  contentType: ContentProjectType;
  fileName: string;
  installedPath: string;
  installedAtEpochSec: number;
};

export type InstanceExportResult = {
  archivePath: string;
};

export type InstanceImportResult = {
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string;
};

export type InstanceRepairResult = {
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string;
  reinstalledFromVersionId: string;
};

export type InstalledContentItem = {
  source: ContentSource;
  projectId: string;
  projectTitle: string;
  contentType: ContentProjectType;
  versionId: string;
  versionNumber: string;
  fileName: string;
  installedPath: string;
  installedAtEpochSec: number;
};

export type InstalledContentUpdate = {
  source: ContentSource;
  projectId: string;
  contentType: ContentProjectType;
  status: InstalledContentUpdateStatus;
  updateAvailable: boolean;
  installedVersionId: string;
  installedVersionNumber: string;
  latestVersionId?: string | null;
  latestVersionNumber?: string | null;
  changelog?: string | null;
  error?: string | null;
  checkedAtEpochSec: number;
};

export type LauncherUser = {
  id?: string;
  username?: string;
  email?: string;
  role?: string;
  level?: number | string;
  userLevel?: number | string;
  membershipLevel?: number | string;
  experience?: number;
  nextLevelNeed?: number;
  emailVerified?: boolean;
  banned?: boolean;
  walletBalance?: string;
  customTitle?: string;
  avatarUrl?: string;
  membershipExpiresAt?: string | null;
};

export type LauncherLoginResult = {
  token: string;
  user: LauncherUser;
};

export type LauncherVersion = {
  id?: unknown;
  channel: string;
  versionType: LauncherVersionType;
  versionName: string;
  artifactSourceType?: string | null;
  downloadUrl: string;
  fileBucket?: string | null;
  fileKey?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  manifestUrl?: string | null;
  minLauncherVersion?: string | null;
  enabled?: boolean;
  recommended?: boolean;
  changelog?: string | null;
  commitHash?: string | null;
  createdAt?: string | null;
};

export type LauncherModsInstallResult = {
  targetDir: string;
  installedFiles: number;
  skipped: boolean;
  versionTag: string;
  manifestUrl?: string | null;
};

export type LauncherPackageState = {
  installed: boolean;
  upToDate: boolean;
  versionTag: string | null;
  checksum?: string | null;
  manifestUrl?: string | null;
};

export type PresetPackageStatus = {
  state: "checking" | "missing" | "ready" | "update-available" | "syncing" | "error";
  versionTag: string | null;
  installedVersionTag?: string | null;
  targetVersionTag?: string | null;
  changelog?: string | null;
  lastError?: string | null;
};

export type DailyPlaytimePoint = {
  date: string;
  playSeconds: number;
  playMinutes: number;
  playHours: number;
};

export type WeeklyPlaytime = {
  points: DailyPlaytimePoint[];
  totalSeconds: number;
  totalMinutes: number;
  totalHours: number;
};

export type LauncherUserStats = {
  totalActivities: number;
  playSessionCount: number;
  totalPlaySeconds: number;
  totalPlayHours: number;
  latestActivityAt?: string | null;
};

export type LauncherDashboard = {
  user: LauncherUser;
  stats: LauncherUserStats;
  weeklyPlaytime: WeeklyPlaytime;
};

export type TelemetryOnlineSummary = {
  online: number;
  total: number;
  launcher: number;
  edge: number;
  nova: number;
  generic: number;
};

export type LauncherHomePayload = {
  news: NewsItem[];
  online: TelemetryOnlineSummary;
  dashboard?: LauncherDashboard | null;
};
