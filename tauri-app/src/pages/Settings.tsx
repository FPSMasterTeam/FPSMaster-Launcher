import {
  Cpu,
  Download,
  FolderOpen,
  Globe,
  ImagePlus,
  LogOut,
  Monitor,
  MoonStar,
  Palette,
  RefreshCw,
  SunMedium,
  Trash2,
  User
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  memo,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import Button from "../components/Button";
import ChangelogNotes from "../components/ChangelogNotes";
import Select from "../components/Select";
import { LOCALE_OPTIONS, useI18n } from "../i18n";
import type {
  BackgroundSource,
  DownloadSource,
  DownloadedLauncherUpdate,
  LauncherAppUpdateChannel,
  LauncherAppUpdateInfo,
  LauncherUser,
  Settings,
  ThemeAccent,
  ThemeMode
} from "../types";
import { resolveBackgroundAssetUrl } from "../utils/launcher";

type SettingsTab =
  | "account"
  | "runtime"
  | "general"
  | "appearance"
  | "background"
  | "updates";

type SettingsPageProps = {
  settings: Settings;
  launcherCurrentVersion: string;
  launcherUpdate: LauncherAppUpdateInfo | null;
  launcherUpdateChannels: LauncherAppUpdateChannel[];
  launcherUpdateAvailable: boolean;
  launcherUpdateChecking: boolean;
  launcherUpdateDownloading: boolean;
  launcherUpdateDownload: DownloadedLauncherUpdate | null;
  launcherUser: LauncherUser | null;
  onLogoutLauncherAccount: () => void;
  onRefreshLauncherUpdate: () => void;
  onInstallLauncherUpdate: () => void;
  onChange: (next: Settings) => void;
  onClampMemory: (input: string) => void;
  onReset: () => void;
};

function SettingsPage({
  settings,
  launcherCurrentVersion,
  launcherUpdate,
  launcherUpdateChannels,
  launcherUpdateAvailable,
  launcherUpdateChecking,
  launcherUpdateDownloading,
  launcherUpdateDownload,
  launcherUser,
  onLogoutLauncherAccount,
  onRefreshLauncherUpdate,
  onInstallLauncherUpdate,
  onChange,
  onClampMemory,
  onReset
}: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const [backgroundError, setBackgroundError] = useState("");
  const [accentError, setAccentError] = useState("");
  const [gameDirError, setGameDirError] = useState("");
  const [backgroundAccentLoading, setBackgroundAccentLoading] = useState(false);
  const [customAccentDraft, setCustomAccentDraft] = useState(settings.customAccentHex);
  const [showLauncherUpdateNotes, setShowLauncherUpdateNotes] = useState(false);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const backgroundAccentRequestRef = useRef(0);

  function isAbsolutePath(path: string): boolean {
    const trimmed = path.trim();
    if (trimmed === "") return false;
    // Windows absolute path (e.g., C:\...)
    if (/^[A-Za-z]:\\/.test(trimmed)) return true;
    // Windows UNC path or root-relative
    if (/^\\\\/.test(trimmed)) return true;
    // Unix absolute path
    if (trimmed.startsWith("/")) return true;
    return false;
  }

  function validateGameDir(path: string): { valid: boolean; error: string } {
    const trimmed = path.trim();
    if (trimmed === "") {
      return {
        valid: false,
        error: t("settings.gameDirEmpty") || "Game directory cannot be empty"
      };
    }
    if (!isAbsolutePath(trimmed)) {
      return {
        valid: false,
        error: t("settings.gameDirMustBeAbsolute") || "Game directory must be an absolute path"
      };
    }
    return { valid: true, error: "" };
  }

  async function handleSelectGameDir() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("settings.selectGameDir") || "Select Game Directory"
      });
      if (selected && typeof selected === "string") {
        const validation = validateGameDir(selected);
        if (validation.valid) {
          onChange({ ...settings, gameDir: selected });
          setGameDirError("");
        } else {
          setGameDirError(validation.error);
        }
      }
    } catch (error) {
      setGameDirError(t("settings.gameDirPickerFailed", { error: String(error) }));
    }
  }

  function handleGameDirChange(value: string) {
    onChange({ ...settings, gameDir: value });
    const validation = validateGameDir(value);
    if (!validation.valid && value.trim() !== "") {
      setGameDirError(validation.error);
    } else {
      setGameDirError("");
    }
  }

  const themeModes: ThemeMode[] = ["dark", "light"];
  const downloadSources: DownloadSource[] = [
    "official-only",
    "mirror-only",
    "mirror-first",
    "official-first"
  ];
  const accentOptions: Array<{ id: ThemeAccent; swatch: string }> = useMemo(
    () => [
      { id: "emerald", swatch: "#25b87a" },
      { id: "cyan", swatch: "#2b7fff" },
      { id: "violet", swatch: "#7b61ff" },
      { id: "sunset", swatch: "#e06c51" },
      { id: "rose", swatch: "#e4578f" },
      { id: "amber", swatch: "#e2a62a" },
      { id: "sky", swatch: "#23a3d8" },
      { id: "lime", swatch: "#77c043" }
    ],
    []
  );

  const activeBackgroundUrl = resolveBackgroundAssetUrl(settings);
  const hasBackground = activeBackgroundUrl.trim() !== "";

  async function requestBackgroundAccent(
    targetSettings: Settings,
    activateBackgroundAccent: boolean
  ) {
    const requestId = backgroundAccentRequestRef.current + 1;
    backgroundAccentRequestRef.current = requestId;
    setAccentError("");
    setBackgroundAccentLoading(true);
    try {
      const nextAccent = await invoke<string>("extract_background_theme_accent", {
        backgroundSource: targetSettings.backgroundSource,
        backgroundImage: targetSettings.backgroundImage,
        backgroundWebUrl: targetSettings.backgroundWebUrl
      });
      if (backgroundAccentRequestRef.current !== requestId) {
        return;
      }
      onChange({
        ...targetSettings,
        themeAccent: activateBackgroundAccent ? "background" : targetSettings.themeAccent,
        customAccentHex: nextAccent
      });
      setCustomAccentDraft(nextAccent);
    } catch (error) {
      if (backgroundAccentRequestRef.current !== requestId) {
        return;
      }
      setAccentError(t("settings.backgroundAccentFailed", { error: String(error) }));
    } finally {
      if (backgroundAccentRequestRef.current === requestId) {
        setBackgroundAccentLoading(false);
      }
    }
  }

  function applyBackgroundSettings(nextSettings: Settings) {
    onChange(nextSettings);
    if (nextSettings.themeAccent === "background") {
      void requestBackgroundAccent(nextSettings, false);
    }
  }

  async function handleBackgroundFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setBackgroundError(t("settings.backgroundTypeError"));
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setBackgroundError(t("settings.backgroundSizeError"));
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      applyBackgroundSettings({ ...settings, backgroundSource: "local", backgroundImage: dataUrl });
      setBackgroundError("");
    } catch {
      setBackgroundError(t("settings.backgroundReadError"));
    }
  }

  async function switchBackgroundSource(source: BackgroundSource) {
    if (source === "web-random") {
      applyBackgroundSettings({
        ...settings,
        backgroundSource: "web-random",
        backgroundWebUrl: settings.backgroundWebUrl || buildRandomBackgroundUrl()
      });
      setBackgroundError("");
      return;
    }
    if (source === "system") {
      try {
        const wallpaperPath = await invoke<string | null>("get_system_wallpaper");
        applyBackgroundSettings({
          ...settings,
          backgroundSource: "system",
          backgroundImage: wallpaperPath ?? ""
        });
        setBackgroundError(wallpaperPath ? "" : t("settings.backgroundSystemUnavailable"));
      } catch (error) {
        onChange({
          ...settings,
          backgroundSource: "system",
          backgroundImage: ""
        });
        setBackgroundError(t("settings.backgroundSystemLoadFailed", { error: String(error) }));
      }
      return;
    }
    onChange({ ...settings, backgroundSource: "local" });
    setBackgroundError("");
  }

  function refreshRandomWebBackground() {
    applyBackgroundSettings({
      ...settings,
      backgroundSource: "web-random",
      backgroundWebUrl: buildRandomBackgroundUrl()
    });
  }

  function handleBackgroundWebUrlChange(value: string) {
    onChange({ ...settings, backgroundSource: "web-random", backgroundWebUrl: value });
  }

  function commitBackgroundWebUrl() {
    const trimmedUrl = settings.backgroundWebUrl.trim();
    if (trimmedUrl === "") {
      return;
    }
    const nextSettings = {
      ...settings,
      backgroundSource: "web-random",
      backgroundWebUrl: trimmedUrl
    } satisfies Settings;
    onChange(nextSettings);
    if (nextSettings.themeAccent === "background") {
      void requestBackgroundAccent(nextSettings, false);
    }
  }

  function onBackgroundWebUrlKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitBackgroundWebUrl();
  }

  useEffect(() => {
    setCustomAccentDraft(settings.customAccentHex);
  }, [settings.customAccentHex]);

  useEffect(() => {
    setShowLauncherUpdateNotes(false);
  }, [launcherUpdate?.version, launcherUpdate?.notes]);

  function applyCustomAccent(hex: string) {
    const normalized = normalizeHexColor(hex);
    if (!normalized) return;
    setAccentError("");
    onChange({
      ...settings,
      themeAccent: "custom",
      customAccentHex: normalized
    });
    setCustomAccentDraft(normalized);
  }

  function commitCustomAccentDraft() {
    applyCustomAccent(customAccentDraft);
  }

  function onCustomAccentKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitCustomAccentDraft();
  }

  function activateBackgroundAccent() {
    if (!hasBackground) {
      setAccentError(t("settings.backgroundNoImage"));
      return;
    }
    void requestBackgroundAccent(settings, true);
  }

  const launcherUpdatePublishedAt = launcherUpdate
    ? formatPublishedAt(launcherUpdate.publishedAt, t("settings.launcherUpdateUnknownDate"))
    : "--";
  const hasLauncherUpdateNotes = Boolean(launcherUpdate?.notes?.trim());
  const availableLauncherChannels = useMemo(() => {
    const normalizedCurrent = settings.launcherUpdateChannel.trim() || "beta";
    const items = launcherUpdateChannels
      .filter((item) => item.code.trim() !== "")
      .map((item) => ({
        code: item.code.trim(),
        name: item.name.trim() || item.code.trim()
      }));
    if (items.some((item) => item.code === normalizedCurrent)) {
      return items;
    }
    return [{ code: normalizedCurrent, name: normalizedCurrent }, ...items];
  }, [settings.launcherUpdateChannel, launcherUpdateChannels]);

  const navSections = useMemo(() => {
    const items: { id: SettingsTab; label: string; icon: ReactNode }[] = [];
    if (launcherUser) {
      items.push({
        id: "account",
        label: t("settings.launcherAuth.title"),
        icon: <User size={15} />
      });
    }
    items.push({ id: "runtime", label: t("settings.runtimeConfig"), icon: <Cpu size={15} /> });
    items.push({ id: "general", label: t("settings.general"), icon: <Monitor size={15} /> });
    items.push({ id: "appearance", label: t("settings.themeMode"), icon: <Palette size={15} /> });
    items.push({ id: "background", label: t("settings.background"), icon: <ImagePlus size={15} /> });
    items.push({ id: "updates", label: t("settings.launcherUpdates"), icon: <Download size={15} /> });
    return items;
  }, [launcherUser, t]);

  const [selectedTab, setSelectedTab] = useState<SettingsTab>("runtime");
  // If the account tab disappears (logout) while selected, fall back to the first tab
  // at render time — no effect needed.
  const activeTab: SettingsTab = navSections.some((section) => section.id === selectedTab)
    ? selectedTab
    : (navSections[0]?.id ?? "runtime");

  const activeLabel = navSections.find((section) => section.id === activeTab)?.label ?? "";

  return (
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("nav.settings")}</p>
          <h1 className="page-title">{t("settings.title")}</h1>
          <p className="page-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          {navSections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setSelectedTab(section.id)}
              className={`settings-nav-item ${activeTab === section.id ? "is-active" : ""}`}
            >
              {section.icon}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          <div>
            <h2 className="section-title">{activeLabel}</h2>
          </div>

          {activeTab === "account" && launcherUser && (
            <div className="settings-group">
              <div className="settings-row">
                <div className="settings-row-main">
                  <p className="settings-row-title">{t("settings.launcherAuth.loggedInAs")}</p>
                  <p className="settings-row-hint">
                    {t("settings.launcherAuth.subtitle")}
                  </p>
                  <p className="mt-2 text-base font-semibold text-[var(--text-primary)]">
                    {launcherUser.username || launcherUser.email || launcherUser.id || "-"}
                  </p>
                </div>
                <div className="settings-row-control">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2"
                    onClick={onLogoutLauncherAccount}
                  >
                    <LogOut size={14} />
                    {t("settings.launcherAuth.logout")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "runtime" && (
            <div className="settings-group">
              <div className="settings-row is-stacked">
                <div className="settings-row-main">
                  <p className="settings-row-title">{t("settings.gameDirectory")}</p>
                  <p className="settings-row-hint">{t("settings.runtimeConfigDesc")}</p>
                </div>
                <div className="settings-row-control">
                  <input
                    type="text"
                    value={settings.gameDir}
                    onChange={(event) => handleGameDirChange(event.target.value)}
                    className={`ui-input ${gameDirError ? "border-[var(--accent-danger)]" : ""}`}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 gap-2"
                    onClick={handleSelectGameDir}
                  >
                    <FolderOpen size={14} />
                    {t("settings.browse") || "Browse"}
                  </Button>
                </div>
                {gameDirError && <p className="settings-error">{gameDirError}</p>}
              </div>

              <div className="settings-row is-stacked">
                <div className="flex items-center justify-between gap-4">
                  <p className="settings-row-title">{t("settings.heapAllocation")}</p>
                  <span className="text-data text-sm font-semibold text-[var(--mc-grass)]">
                    {settings.maxMemoryMb} MB
                  </span>
                </div>
                <input
                  type="range"
                  min="1024"
                  max="16384"
                  step="256"
                  value={settings.maxMemoryMb}
                  onChange={(event) => onClampMemory(event.target.value)}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-secondary)] accent-[var(--mc-grass)]"
                />
                <div className="flex justify-between text-[10px] font-semibold uppercase text-[var(--text-muted)]">
                  <span>1 GB</span>
                  <span>16 GB</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "general" && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.language")}</p>
                  </div>
                  <div className="settings-row-control w-48">
                    <Select
                      value={locale}
                      onValueChange={(value) => setLocale(value as "en-US" | "zh-CN")}
                    >
                      <Select.Trigger className="ui-select-trigger w-full">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {LOCALE_OPTIONS.map((item) => (
                          <Select.Item key={item} value={item}>
                            {t(`language.${item}` as const)}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.downloadSource")}</p>
                  </div>
                  <div className="settings-row-control w-56">
                    <Select
                      value={settings.downloadSource}
                      onValueChange={(value) =>
                        onChange({ ...settings, downloadSource: value as DownloadSource })
                      }
                    >
                      <Select.Trigger className="ui-select-trigger w-full">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {downloadSources.map((source) => (
                          <Select.Item key={source} value={source}>
                            {t(`settings.downloadSource.${source}` as const)}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.downloadThreads")}</p>
                    <p className="settings-row-hint">{t("settings.downloadThreadsHint")}</p>
                  </div>
                  <div className="settings-row-control">
                    <input
                      className="ui-input w-24 text-center"
                      type="number"
                      min={1}
                      max={32}
                      step={1}
                      value={settings.downloadThreads}
                      onChange={(event) =>
                        onChange({
                          ...settings,
                          downloadThreads: Math.max(1, Math.min(32, Number(event.target.value) || 1))
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="settings-group">
                <SettingToggleRow
                  title={t("settings.keepOpen")}
                  hint={t("settings.keepOpenDesc")}
                  enabled={!settings.hideMainOnLaunch}
                  onToggle={() =>
                    onChange({ ...settings, hideMainOnLaunch: !settings.hideMainOnLaunch })
                  }
                />
                <SettingToggleRow
                  title={t("settings.minimizeToTray")}
                  hint={t("settings.minimizeToTrayDesc")}
                  enabled={settings.minimizeToTray}
                  onToggle={() =>
                    onChange({ ...settings, minimizeToTray: !settings.minimizeToTray })
                  }
                />
                <SettingToggleRow
                  title={t("settings.launchOnStartup")}
                  hint={t("settings.launchOnStartupDesc")}
                  enabled={settings.launchOnStartup}
                  onToggle={() =>
                    onChange({ ...settings, launchOnStartup: !settings.launchOnStartup })
                  }
                />
              </div>
            </>
          )}

          {activeTab === "appearance" && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.themeMode")}</p>
                  </div>
                  <div className="settings-row-control">
                    <div className="segment-control !p-1">
                      {themeModes.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => onChange({ ...settings, themeMode: mode })}
                          className={`segment-chip !min-h-8 gap-2 px-3 ${settings.themeMode === mode ? "is-active" : ""}`}
                        >
                          {mode === "dark" ? <MoonStar size={14} /> : <SunMedium size={14} />}
                          {t(`settings.theme.${mode}` as const)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-row is-stacked">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.themeAccent")}</p>
                    <p className="settings-row-hint">{t("settings.customAccentHint")}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {accentOptions.map((accent) => (
                      <button
                        key={accent.id}
                        type="button"
                        title={t(`settings.accent.${accent.id}` as const)}
                        aria-label={t(`settings.accent.${accent.id}` as const)}
                        onClick={() => {
                          setAccentError("");
                          onChange({ ...settings, themeAccent: accent.id });
                        }}
                        className={`accent-swatch ${settings.themeAccent === accent.id ? "is-active" : ""}`}
                        style={{ backgroundColor: accent.swatch }}
                      />
                    ))}
                    <button
                      type="button"
                      title={t("settings.customAccent")}
                      aria-label={t("settings.customAccent")}
                      onClick={() => {
                        setAccentError("");
                        onChange({ ...settings, themeAccent: "custom" });
                      }}
                      className={`accent-swatch ${settings.themeAccent === "custom" ? "is-active" : ""}`}
                      style={{
                        background: `conic-gradient(from 180deg, ${settings.customAccentHex}, #2b7fff, #e4578f, ${settings.customAccentHex})`
                      }}
                    />
                  </div>
                  {settings.themeAccent === "custom" && (
                    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                      <input
                        type="color"
                        value={settings.customAccentHex}
                        onChange={(event) => applyCustomAccent(event.target.value)}
                        className="h-11 w-full cursor-pointer rounded-[8px] border border-[var(--border-medium)] bg-[var(--bg-elevated)] p-1"
                        aria-label={t("settings.customAccent")}
                      />
                      <input
                        type="text"
                        value={customAccentDraft}
                        onChange={(event) => setCustomAccentDraft(event.target.value)}
                        onBlur={commitCustomAccentDraft}
                        onKeyDown={onCustomAccentKeyDown}
                        className="ui-input"
                        aria-label={t("settings.customAccentHex")}
                      />
                    </div>
                  )}
                </div>

                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.backgroundAccent")}</p>
                    <p className="settings-row-hint">{t("settings.backgroundAccentHint")}</p>
                  </div>
                  <div className="settings-row-control">
                    <span
                      className={`accent-swatch ${settings.themeAccent === "background" ? "is-active" : ""}`}
                      style={{ backgroundColor: settings.customAccentHex }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-2"
                      disabled={backgroundAccentLoading}
                      onClick={activateBackgroundAccent}
                    >
                      <Palette size={14} />
                      {backgroundAccentLoading
                        ? t("settings.backgroundAccentLoading")
                        : t("settings.backgroundAccentRefresh")}
                    </Button>
                  </div>
                </div>
              </div>
              {accentError && <p className="settings-error">{accentError}</p>}
            </>
          )}

          {activeTab === "background" && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.backgroundMode")}</p>
                    <p className="settings-row-hint">
                      {settings.backgroundSource === "web-random"
                        ? t("settings.backgroundWebHint")
                        : settings.backgroundSource === "system"
                          ? t("settings.backgroundSystemHint")
                          : t("settings.backgroundHint")}
                    </p>
                  </div>
                  <div className="settings-row-control">
                    <div className="segment-control !p-1">
                      <button
                        type="button"
                        onClick={() => void switchBackgroundSource("local")}
                        className={`segment-chip !min-h-8 px-3 ${settings.backgroundSource === "local" ? "is-active" : ""}`}
                      >
                        {t("settings.backgroundMode.local")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void switchBackgroundSource("web-random")}
                        className={`segment-chip !min-h-8 px-3 ${settings.backgroundSource === "web-random" ? "is-active" : ""}`}
                      >
                        {t("settings.backgroundMode.web")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void switchBackgroundSource("system")}
                        className={`segment-chip !min-h-8 px-3 ${settings.backgroundSource === "system" ? "is-active" : ""}`}
                      >
                        {t("settings.backgroundMode.system")}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-row is-stacked">
                  <div className="settings-preview">
                    {hasBackground ? (
                      <div
                        className="h-32 w-full bg-cover bg-center bg-no-repeat"
                        style={{ backgroundImage: `url("${activeBackgroundUrl}")` }}
                      />
                    ) : (
                      <div className="flex h-32 items-center justify-center text-sm text-[var(--text-muted)]">
                        {t("settings.backgroundNoImage")}
                      </div>
                    )}
                  </div>
                  <input
                    ref={backgroundInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => void handleBackgroundFile(event)}
                  />
                  <div className="flex gap-2">
                    {settings.backgroundSource === "local" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1 gap-2"
                        onClick={() => backgroundInputRef.current?.click()}
                      >
                        <ImagePlus size={14} />
                        {t("settings.backgroundUpload")}
                      </Button>
                    ) : settings.backgroundSource === "web-random" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1 gap-2"
                        onClick={refreshRandomWebBackground}
                      >
                        <Globe size={14} />
                        {t("settings.backgroundRefreshWeb")}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1 gap-2"
                        onClick={() => void switchBackgroundSource("system")}
                      >
                        <Monitor size={14} />
                        {t("settings.backgroundRefreshSystem")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2"
                      disabled={!hasBackground}
                      onClick={() =>
                        onChange(
                          settings.backgroundSource === "web-random"
                            ? { ...settings, backgroundWebUrl: "" }
                            : { ...settings, backgroundImage: "" }
                        )
                      }
                    >
                      <Trash2 size={14} />
                      {t("settings.backgroundClear")}
                    </Button>
                  </div>
                  {settings.backgroundSource === "web-random" && (
                    <div>
                      <p className="settings-row-title mb-2">{t("settings.backgroundUrl")}</p>
                      <input
                        type="url"
                        value={settings.backgroundWebUrl}
                        onChange={(event) => handleBackgroundWebUrlChange(event.target.value)}
                        onBlur={commitBackgroundWebUrl}
                        onKeyDown={onBackgroundWebUrlKeyDown}
                        className="ui-input"
                        placeholder="https://picsum.photos/1920/1080?random=..."
                      />
                      <p className="settings-row-hint mt-1">{t("settings.backgroundUrlHint")}</p>
                    </div>
                  )}
                </div>

                <div className="settings-row is-stacked">
                  <div className="flex items-center justify-between gap-4">
                    <p className="settings-row-title">{t("settings.backgroundOpacity")}</p>
                    <span className="text-data text-xs font-semibold text-[var(--text-secondary)]">
                      {settings.backgroundOpacity}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={settings.backgroundOpacity}
                    disabled={!hasBackground}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        backgroundOpacity: Math.max(
                          0,
                          Math.min(100, Number(event.target.value) || 0)
                        )
                      })
                    }
                    className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-secondary)] accent-[var(--mc-grass)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>

                <div className="settings-row is-stacked">
                  <div className="flex items-center justify-between gap-4">
                    <p className="settings-row-title">{t("settings.backgroundBlur")}</p>
                    <span className="text-data text-xs font-semibold text-[var(--text-secondary)]">
                      {settings.backgroundBlur}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="32"
                    step="1"
                    value={settings.backgroundBlur}
                    disabled={!hasBackground}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        backgroundBlur: Math.max(0, Math.min(32, Number(event.target.value) || 0))
                      })
                    }
                    className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-secondary)] accent-[var(--mc-grass)] disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              </div>
              {backgroundError && <p className="settings-error">{backgroundError}</p>}
            </>
          )}

          {activeTab === "updates" && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">{t("settings.launcherUpdateChannel")}</p>
                    <p className="settings-row-hint">{t("settings.launcherUpdatesDesc")}</p>
                  </div>
                  <div className="settings-row-control w-48">
                    <Select
                      value={settings.launcherUpdateChannel}
                      onValueChange={(value) =>
                        onChange({ ...settings, launcherUpdateChannel: value })
                      }
                    >
                      <Select.Trigger className="ui-select-trigger w-full">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {availableLauncherChannels.map((item) => (
                          <Select.Item key={item.code} value={item.code}>
                            {item.name}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </div>
                </div>

                <InfoRow
                  label={t("settings.launcherCurrentVersion")}
                  value={launcherCurrentVersion}
                />
                <InfoRow
                  label={t("settings.launcherUpdateStatus")}
                  value={
                    launcherUpdateAvailable
                      ? t("settings.launcherUpdateStatusAvailable")
                      : t("settings.launcherUpdateStatusUpToDate")
                  }
                  highlight={launcherUpdateAvailable}
                />
                <InfoRow
                  label={t("settings.launcherUpdatePublishedAt")}
                  value={launcherUpdatePublishedAt}
                />
              </div>

              {launcherUpdate && launcherUpdateAvailable && (
                <div className="settings-group">
                  <div className="settings-row is-stacked">
                    <div className="settings-row-main">
                      <p className="settings-row-title">
                        {t("settings.launcherUpdateAvailable", { version: launcherUpdate.version })}
                      </p>
                      <p className="settings-row-hint">
                        {launcherUpdate.mandatory
                          ? t("settings.launcherUpdateMandatory")
                          : t("settings.launcherUpdateOptional")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="badge badge-muted normal-case tracking-normal">
                        {t("settings.launcherUpdateTarget")}: {launcherUpdate.target}
                      </span>
                      {launcherUpdate.fileSize ? (
                        <span className="badge badge-muted normal-case tracking-normal">
                          {t("settings.launcherUpdateSize", {
                            size: formatFileSize(launcherUpdate.fileSize)
                          })}
                        </span>
                      ) : null}
                    </div>
                    <ChangelogNotes
                      notes={launcherUpdate.notes}
                      className="text-xs leading-6 text-[var(--text-secondary)]"
                    />
                    {launcherUpdate.checksum && (
                      <p className="text-data break-all text-[11px] text-[var(--text-muted)]">
                        SHA-256: {launcherUpdate.checksum}
                      </p>
                    )}
                    {launcherUpdateDownload && (
                      <p className="text-xs text-[var(--text-secondary)]">
                        {t("settings.launcherUpdateDownloaded", {
                          file: launcherUpdateDownload.fileName
                        })}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {!launcherUpdateAvailable && hasLauncherUpdateNotes && showLauncherUpdateNotes && (
                <div className="settings-group">
                  <div className="settings-row">
                    <ChangelogNotes
                      notes={launcherUpdate?.notes}
                      defaultExpanded
                      className="text-xs leading-6 text-[var(--text-secondary)]"
                    />
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-2"
                  disabled={launcherUpdateChecking || launcherUpdateDownloading}
                  onClick={onRefreshLauncherUpdate}
                >
                  <RefreshCw size={14} />
                  {launcherUpdateChecking
                    ? t("settings.launcherUpdateChecking")
                    : t("settings.launcherUpdateCheck")}
                </Button>
                {launcherUpdateAvailable && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="gap-2"
                    disabled={!launcherUpdateAvailable || launcherUpdateDownloading}
                    onClick={onInstallLauncherUpdate}
                  >
                    <Download size={14} />
                    {launcherUpdateDownloading
                      ? t("settings.launcherUpdatePreparing")
                      : t("settings.launcherUpdateInstall")}
                  </Button>
                )}
                {!launcherUpdateAvailable && hasLauncherUpdateNotes && (
                  <button
                    type="button"
                    className="text-sm text-[var(--mc-grass)] transition-opacity hover:opacity-80"
                    onClick={() => setShowLauncherUpdateNotes((prev) => !prev)}
                  >
                    {showLauncherUpdateNotes
                      ? t("settings.launcherUpdateHideNotes")
                      : t("settings.launcherUpdateViewNotes")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="mt-8 flex flex-wrap justify-end gap-3 border-t border-[var(--border-subtle)] pt-6">
        <Button variant="ghost" className="gap-2" onClick={onReset}>
          <RefreshCw size={16} /> {t("settings.resetDefaults")}
        </Button>
      </footer>
    </div>
  );
}

function InfoRow({
  label,
  value,
  highlight = false
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <p className="settings-row-title">{label}</p>
      </div>
      <div className="settings-row-control">
        <span
          className={`text-data text-sm font-semibold ${highlight ? "text-[var(--mc-grass)]" : "text-[var(--text-secondary)]"}`}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function SettingToggleRow({
  title,
  hint,
  enabled,
  onToggle
}: {
  title: string;
  hint: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button className="settings-row w-full text-left" onClick={onToggle} type="button">
      <div className="settings-row-main">
        <p className="settings-row-title">{title}</p>
        <p className="settings-row-hint">{hint}</p>
      </div>
      <div className="settings-row-control">
        <div className={`toggle-switch ${enabled ? "is-on" : ""}`} />
      </div>
    </button>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("invalid-data"));
    };
    reader.readAsDataURL(file);
  });
}

function buildRandomBackgroundUrl(): string {
  return `https://picsum.photos/1920/1080?random=${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "--";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatPublishedAt(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed.toLocaleDateString();
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

export default memo(SettingsPage);
