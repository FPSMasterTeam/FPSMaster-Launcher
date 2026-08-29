export type Page = "home" | "instances" | "install" | "servers" | "content" | "settings" | "instance-settings" | "mandatory-update" | "account-center";
export type Loader = "vanilla" | "forge" | "fabric";
export type OptiFineCompatibilityState = "compatible" | "incompatible" | "unknown";
export type PhaseStatus = "pending" | "running" | "done" | "error";
export type Locale = "en-US" | "zh-CN";
export type ThemeMode = "dark" | "light";
export type DownloadSource =
  | "official-only"
  | "mirror-only"
  | "mirror-first"
  | "official-first";
export type ThemeAccent =
  | "emerald"
  | "cyan"
  | "violet"
  | "sunset"
  | "rose"
  | "amber"
  | "sky"
  | "lime"
  | "background"
  | "custom";
export type BackgroundSource = "local" | "video" | "web-random" | "system";
// How blur is spent: none at all, on the background layer only, or on frosted
// UI surfaces (translucent panels with backdrop blur).
export type BlurMode = "off" | "background" | "frost";
// Named visual presets. "custom" means the user moved a knob away from a preset.
// "liquid" is the Apple-style lensed-glass look, reserved for navigation chrome.
export type VisualProfile = "standard" | "glass" | "liquid" | "custom";
export type LauncherVersionType = "EDGE" | "NOVA" | "EXTREME";
export type MinecraftAccountType = "offline" | "microsoft";
export type ContentSource = "modrinth" | "curseforge" | "local";
export type OnlineContentSource = Exclude<ContentSource, "local">;
export type ContentProjectType = "mod" | "resourcepack" | "shader" | "world" | "modpack";
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
  optiFineVersion?: string;
  launcherVersionType?: LauncherVersionType;
  iconPath?: string;
  preset: boolean;
  // Edge-only Forge/OptiFine toggles. Both default to true (existing Edge behavior).
  // `loader` is derived from `useForge` for Edge ("forge" when true, "vanilla" when
  // false) rather than being an independent choice; see ensureInstanceReadyForLaunch.
  useForge?: boolean;
  useOptiFine?: boolean;
};

export type MinecraftAccount = {
  id: string;
  type: MinecraftAccountType;
  username: string;
  uuid: string;
  accessToken: string;
  refreshToken?: string | null;
  xuid?: string | null;
  skinUrl?: string | null;
  expiresAt?: number | null;
  addedAt: number;
  // Microsoft accounts only: the last token refresh failed, so the stored session
  // is dead until the user signs in interactively again. The account stays in the
  // list; launching or auto-refresh clears the flag once a refresh succeeds.
  needsRelogin?: boolean;
};

export type MinecraftAuthConfig = {
  configured: boolean;
  clientIdSource?: string | null;
  configurationHint?: string | null;
};

export type MinecraftDeviceLoginStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  expiresIn: number;
  expiresAt: number;
  interval: number;
  message?: string | null;
};

export type MinecraftDeviceLoginPollStatus =
  | "pending"
  | "slow_down"
  | "completed"
  | "expired"
  | "denied";

export type MinecraftDeviceLoginPollResult = {
  status: MinecraftDeviceLoginPollStatus;
  interval?: number | null;
  account?: MinecraftAccount | null;
  error?: string | null;
};

export type Settings = {
  gameDir: string;
  playerName: string;
  downloadSource: DownloadSource;
  downloadThreads: number;
  launcherUpdateChannel: string;
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
  // Absolute path to a local mp4/webm played muted on loop (source "video").
  backgroundVideo: string;
  backgroundWebUrl: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  blurMode: BlurMode;
  // Percent scale applied to the shared radius tokens (75–150, 100 = default).
  cornerRadiusScale: number;
  // Accent glow strength 0–100. Kept low by default; 0 disables glow entirely.
  glowAmount: number;
  visualProfile: VisualProfile;
  curseforgeApiKey: string;
};

export type NewsItem = {
  id?: string;
  title: string;
  summary: string;
  content?: string | null;
  author?: string | null;
  category?: string | null;
  pinned?: boolean;
  targetClients?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  severity?: "info" | "success" | "warning" | "critical";
  publishedAt?: string | null;
};

export type ServerItem = {
  id?: string;
  name: string;
  address: string;
  mode: string;
  iconPath?: string;
  iconUrl?: string;
  description?: string;
  detailedDescription?: string;
  serverGroup?: string;
  displayOrder?: number;
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

export type LauncherLoginPrefs = {
  usernameOrEmail: string;
  password: string;
  rememberPassword: boolean;
  autoLogin: boolean;
};

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
  bytesDone?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  message?: string;
  error?: string;
  itemId?: string;
  itemName?: string;
  itemKind?: string;
  itemCurrentBytes?: number;
  itemTotalBytes?: number;
  itemCached?: boolean;
};

export type ContentInstallProgressEvent = {
  projectKey: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

export type ModpackInstallStage =
  | "catalog"
  | "download-pack"
  | "parse"
  | "loader"
  | "files"
  | "overrides"
  | "finalize";

export type ModpackInstallProgressEvent = {
  projectKey: string;
  stage: ModpackInstallStage;
  message: string;
  current: number;
  total: number;
  percent: number | null;
};

export type ModpackInstallResult = {
  source: OnlineContentSource;
  projectId: string;
  projectTitle: string;
  name: string;
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string | null;
  packVersion: string;
  fileCount: number;
  overrideCount: number;
};

export type InstallPhaseState = {
  title: string;
  sourcePhase: "vanilla" | "forge" | "fabric" | "optifine";
  status: PhaseStatus;
  stage: string;
  message: string;
  current: number;
  total: number;
  downloaded: number;
  cached: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  items: LaunchPrepareItem[];
};

export type InstallDialogState = {
  open: boolean;
  sessionId: string;
  versionId: string;
  loader: Loader;
  canClose: boolean;
  cancelling: boolean;
  errorText: string;
  vanilla: InstallPhaseState;
  loaderPhase: InstallPhaseState | null;
  optiFinePhase: InstallPhaseState | null;
};

export type LaunchPrepareItemStatus = "pending" | "running" | "done" | "cached" | "error";

export type LaunchPreparePhaseKey =
  | "login"
  | "check-instance"
  | "verify"
  | "vanilla"
  | "fabric"
  | "forge"
  | "optifine"
  | "mods"
  | "runtime"
  | "launch";

export type LaunchPrepareItem = {
  id: string;
  name: string;
  kind: string;
  status: LaunchPrepareItemStatus;
  currentBytes: number;
  totalBytes: number | null;
  message: string;
  updatedAt: number;
};

export type LaunchPreparePhaseState = {
  key: LaunchPreparePhaseKey;
  title: string;
  status: PhaseStatus;
  stage: string;
  message: string;
  current: number;
  total: number;
  downloaded: number;
  cached: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  items: LaunchPrepareItem[];
};

export type LaunchPrepareDialogState = {
  open: boolean;
  sessionId: string;
  instanceName: string;
  versionId: string;
  canClose: boolean;
  errorText: string;
  phases: LaunchPreparePhaseState[];
};

export type InstanceSectionEntry = {
  name: string;
  isDir: boolean;
  disabled?: boolean;
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
  source: ContentSource;
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
  optiFineVersion?: string;
};

export type InstanceRepairResult = {
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string;
  optiFineVersion?: string;
  reinstalledFromVersionId: string;
};

export type OptiFineVersion = {
  id: string;
  gameVersion: string;
  version: string;
  fileName: string;
  type: string;
  patch: string;
  isPreview: boolean;
  forgeRequirement?: string | null;
  compatibility: OptiFineCompatibilityState;
  incompatibilityReason?: string | null;
};

export type OptiFineInstallResult = {
  versionId: string;
  optiFineVersion: string;
  fileName: string;
  installedPath: string;
  skipped: boolean;
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
  novaBetaEligible?: boolean;
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
  // Minecraft game version (e.g. "1.21.11") for multi-version products like Nova; null otherwise.
  gameVersion?: string | null;
  artifactSourceType?: string | null;
  downloadUrl: string;
  // Optional dedicated download for Edge's Forge-free AOT package (see
  // `install_edge_aot_package`). Falls back to `downloadUrl` when absent so a single
  // catalog entry keeps working until the backend publishes a separate AOT artifact.
  aotDownloadUrl?: string | null;
  aotChecksum?: string | null;
  aotFileSize?: number | null;
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

export type LauncherAuthState = {
  token: string;
  user: LauncherUser;
};

export type LauncherVersionMap = Record<LauncherVersionType, LauncherVersion | null>;

export type LauncherModsInstallResult = {
  targetDir: string;
  installedFiles: number;
  skipped: boolean;
  versionTag: string;
  manifestUrl?: string | null;
};

export type EdgeAotInstallResult = {
  targetDir: string;
  installed: boolean;
  skipped: boolean;
  versionTag: string;
  checksum?: string | null;
};

export type LauncherPackageState = {
  installed: boolean;
  upToDate: boolean;
  // Installed and on the latest version, but the mods dir has an unsupported/
  // tampered mod and needs a repair reinstall. Orthogonal to upToDate.
  needsRepair?: boolean;
  versionTag: string | null;
  checksum?: string | null;
  manifestUrl?: string | null;
};

export type PresetPackageStatus = {
  state: "checking" | "missing" | "ready" | "update-available" | "needs-repair" | "syncing" | "error" | "beta" | "pending-release";
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

export type LauncherAppUpdateInfo = {
  version: string;
  downloadUrl: string;
  notes?: string | null;
  publishedAt?: string | null;
  mandatory: boolean;
  checksum?: string | null;
  fileSize?: number | null;
  target: string;
};

export type LauncherAppUpdateChannel = {
  code: string;
  name: string;
};

export type DownloadedLauncherUpdate = {
  version: string;
  fileName: string;
  filePath: string;
};

export type LauncherHomePayload = {
  news: NewsItem[];
  servers: ServerItem[];
  online: TelemetryOnlineSummary;
  dashboard?: LauncherDashboard | null;
};
