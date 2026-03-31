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
  Trash2
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { type ChangeEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import Select from "../components/Select";
import { LOCALE_OPTIONS, useI18n } from "../i18n";
import type {
  BackgroundSource,
  DownloadSource,
  DownloadedLauncherUpdate,
  LauncherAppUpdateInfo,
  LauncherUser,
  Settings,
  ThemeAccent,
  ThemeMode
} from "../types";

type SettingsPageProps = {
  settings: Settings;
  launcherCurrentVersion: string;
  launcherUpdate: LauncherAppUpdateInfo | null;
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

export default function SettingsPage({
  settings,
  launcherCurrentVersion,
  launcherUpdate,
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
  const [gameDirError, setGameDirError] = useState("");
  const [customAccentDraft, setCustomAccentDraft] = useState(settings.customAccentHex);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

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
      return { valid: false, error: t("settings.gameDirEmpty") || "Game directory cannot be empty" };
    }
    if (!isAbsolutePath(trimmed)) {
      return { valid: false, error: t("settings.gameDirMustBeAbsolute") || "Game directory must be an absolute path" };
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
    } catch {
      // User cancelled the dialog
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
  const downloadSources: DownloadSource[] = ["official", "bmclapi"];
  const accentOptions: Array<{ id: ThemeAccent; swatch: string }> = [
    { id: "emerald", swatch: "#25b87a" },
    { id: "cyan", swatch: "#2b7fff" },
    { id: "violet", swatch: "#7b61ff" },
    { id: "sunset", swatch: "#e06c51" },
    { id: "rose", swatch: "#e4578f" },
    { id: "amber", swatch: "#e2a62a" },
    { id: "sky", swatch: "#23a3d8" },
    { id: "lime", swatch: "#77c043" },
    { id: "custom", swatch: settings.customAccentHex }
  ];
  const presetAccentOptions = accentOptions.filter((accent) => accent.id !== "custom");
  const activeAccentColor = accentOptions.find((accent) => accent.id === settings.themeAccent)?.swatch ?? "#25b87a";
  const activeThemeLabel = t(`settings.theme.${settings.themeMode}` as const);
  const activeAccentLabel = t(`settings.accent.${settings.themeAccent}` as const);

  const activeBackgroundUrl = settings.backgroundSource === "web-random" ? settings.backgroundWebUrl : settings.backgroundImage;
  const hasBackground = activeBackgroundUrl.trim() !== "";

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
      onChange({ ...settings, backgroundSource: "local", backgroundImage: dataUrl });
      setBackgroundError("");
    } catch {
      setBackgroundError(t("settings.backgroundReadError"));
    }
  }

  function switchBackgroundSource(source: BackgroundSource) {
    if (source === "web-random") {
      onChange({
        ...settings,
        backgroundSource: "web-random",
        backgroundWebUrl: settings.backgroundWebUrl || buildRandomBackgroundUrl()
      });
      return;
    }
    onChange({ ...settings, backgroundSource: "local" });
  }

  function refreshRandomWebBackground() {
    onChange({ ...settings, backgroundSource: "web-random", backgroundWebUrl: buildRandomBackgroundUrl() });
  }

  useEffect(() => {
    setCustomAccentDraft(settings.customAccentHex);
  }, [settings.customAccentHex]);

  function applyCustomAccent(hex: string) {
    const normalized = normalizeHexColor(hex);
    if (!normalized) return;
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

  return (
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("nav.settings")}</p>
          <h1 className="page-title">{t("settings.title")}</h1>
          <p className="page-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      {launcherUser ? (
        <Card as="section" variant="strong" className="page-card mb-6 rounded-[22px]" interactive={false}>
          <SectionTitle icon={<Palette size={18} className="text-[var(--mc-grass)]" />} title={t("settings.launcherAuth.title")} subtitle={t("settings.launcherAuth.subtitle")} />
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="field-label !mb-1">{t("settings.launcherAuth.loggedInAs")}</p>
              <p className="mt-1 text-base font-semibold text-[var(--text-primary)]">{launcherUser.username || launcherUser.email || launcherUser.id || "-"}</p>
            </div>
            <Button variant="ghost" size="sm" className="gap-2 self-start" onClick={onLogoutLauncherAccount}>
              <LogOut size={14} />
              {t("settings.launcherAuth.logout")}
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="page-grid page-grid-two">
        <div className="space-y-6">
          <Card as="section" variant="strong" className="page-card page-card-roomy rounded-[22px]" interactive={false}>
            <SectionTitle icon={<Cpu size={18} className="text-[var(--mc-grass)]" />} title={t("settings.runtimeConfig")} subtitle={t("settings.runtimeConfigDesc")} />
            <div className="field-grid field-grid-two">
              <div className="md:col-span-2">
                <FieldLabel>{t("settings.playerName")}</FieldLabel>
                <input
                  type="text"
                  value={settings.playerName}
                  onChange={(event) => onChange({ ...settings, playerName: event.target.value })}
                  className="ui-input"
                />
              </div>

              <div className="md:col-span-2">
                <FieldLabel>{t("settings.gameDirectory")}</FieldLabel>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.gameDir}
                    onChange={(event) => handleGameDirChange(event.target.value)}
                    className={`ui-input ${gameDirError ? "border-[var(--accent-danger)]" : ""}`}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="gap-2 shrink-0"
                    onClick={handleSelectGameDir}
                  >
                    <FolderOpen size={14} />
                    {t("settings.browse") || "Browse"}
                  </Button>
                </div>
                {gameDirError && (
                  <p className="mt-1 text-xs text-[var(--accent-danger)]">{gameDirError}</p>
                )}
              </div>
            </div>

            <div className="surface-panel surface-panel-soft mt-6 rounded-[20px] p-4">
              <div className="mb-2 flex items-center justify-between">
                <FieldLabel>{t("settings.heapAllocation")}</FieldLabel>
                <span className="font-mono text-sm font-semibold text-[var(--mc-grass)]">{settings.maxMemoryMb} MB</span>
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
              <div className="mt-1 flex justify-between text-[10px] font-semibold uppercase text-[var(--text-muted)]">
                <span>1 GB</span>
                <span>16 GB</span>
              </div>
            </div>
          </Card>

          <Card as="section" variant="frost" className="page-card page-card-roomy rounded-[22px]" interactive={false}>
            <SectionTitle icon={<Monitor size={18} className="text-[var(--mc-grass)]" />} title={t("settings.general")} subtitle={t("settings.behaviorAppearance")} />
            <div className="field-grid field-grid-two mb-5">
              <div>
                <FieldLabel>{t("settings.language")}</FieldLabel>
                <Select value={locale} onValueChange={(value) => setLocale(value as "en-US" | "zh-CN")}>
                  <Select.Trigger className="ui-select-trigger">
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

              <div>
                <FieldLabel>{t("settings.downloadSource")}</FieldLabel>
                <Select value={settings.downloadSource} onValueChange={(value) => onChange({ ...settings, downloadSource: value as DownloadSource })}>
                  <Select.Trigger className="ui-select-trigger">
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

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <ToggleRow
                title={t("settings.keepOpen")}
                subtitle={t("settings.keepOpenDesc")}
                enabled={!settings.hideMainOnLaunch}
                onToggle={() => onChange({ ...settings, hideMainOnLaunch: !settings.hideMainOnLaunch })}
              />
              <ToggleRow
                title={t("settings.minimizeToTray")}
                subtitle={t("settings.minimizeToTrayDesc")}
                enabled={settings.minimizeToTray}
                onToggle={() => onChange({ ...settings, minimizeToTray: !settings.minimizeToTray })}
              />
              <ToggleRow
                title={t("settings.launchOnStartup")}
                subtitle={t("settings.launchOnStartupDesc")}
                enabled={settings.launchOnStartup}
                onToggle={() => onChange({ ...settings, launchOnStartup: !settings.launchOnStartup })}
              />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card as="section" variant="frost" className="page-card page-card-roomy rounded-[22px]" interactive={false}>
            <SectionTitle icon={<Palette size={18} className="text-[var(--mc-grass)]" />} title={t("settings.themeMode")} subtitle={t("settings.behaviorAppearance")} />
            <div className="space-y-5">
              <div className="surface-panel surface-panel-soft rounded-[20px] p-4 md:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge badge-muted normal-case tracking-normal">
                    {activeThemeLabel}
                  </span>
                  <span className="badge badge-muted normal-case tracking-normal inline-flex gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: activeAccentColor }} />
                    {activeAccentLabel}
                  </span>
                </div>

                <div className="mt-4">
                  <FieldLabel>{t("settings.themeMode")}</FieldLabel>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {themeModes.map((mode) => {
                      const selected = settings.themeMode === mode;
                      const isDark = mode === "dark";
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => onChange({ ...settings, themeMode: mode })}
                          className={`theme-option-card ${selected ? "is-active" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <span className={`icon-tile h-9 w-9 rounded-[14px] ${selected ? "border-[rgba(var(--accent-rgb),0.24)] bg-[rgba(var(--accent-rgb),0.12)]" : ""}`}>
                                {isDark ? <MoonStar size={16} className="text-[var(--text-primary)]" /> : <SunMedium size={16} className="text-[var(--text-primary)]" />}
                              </span>
                              <div>
                                <p className="text-sm font-semibold text-[var(--text-primary)]">{t(`settings.theme.${mode}` as const)}</p>
                                <p className="text-xs text-[var(--text-muted)]">{isDark ? t("settings.theme.dark") : t("settings.theme.light")}</p>
                              </div>
                            </div>
                            <span className={`selection-indicator ${selected ? "is-active" : ""}`} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-5">
                  <label className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    <Palette size={14} />
                    {t("settings.themeAccent")}
                  </label>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    {presetAccentOptions.map((accent) => {
                      const selected = settings.themeAccent === accent.id;
                      return (
                        <button
                          key={accent.id}
                          type="button"
                          onClick={() => onChange({ ...settings, themeAccent: accent.id })}
                          className={`theme-option-card ${selected ? "is-active" : ""}`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="h-8 w-8 rounded-full border border-[rgba(255,255,255,0.1)]" style={{ backgroundColor: accent.swatch }} />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{t(`settings.accent.${accent.id}` as const)}</p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="surface-panel mt-5 rounded-[18px] p-4">
                  <button type="button" onClick={() => onChange({ ...settings, themeAccent: "custom" })} className="flex w-full items-center justify-between gap-3 text-left">
                    <div>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{t("settings.customAccent")}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{t("settings.customAccentHint")}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="h-8 w-8 rounded-full border border-[rgba(255,255,255,0.1)]" style={{ backgroundColor: settings.customAccentHex }} />
                      <span className={`selection-indicator ${settings.themeAccent === "custom" ? "is-active" : ""}`} />
                    </div>
                  </button>

                  {settings.themeAccent === "custom" ? (
                    <div className="mt-4 grid grid-cols-1 gap-3 border-t border-[rgba(255,255,255,0.1)] pt-4 md:grid-cols-[88px_minmax(0,1fr)]">
                      <div>
                        <label className="field-label">{t("settings.customAccent")}</label>
                        <input
                          type="color"
                          value={settings.customAccentHex}
                          onChange={(event) => applyCustomAccent(event.target.value)}
                          className="h-11 w-full cursor-pointer rounded-xl border border-[rgba(255,255,255,0.1)] bg-[var(--bg-elevated)] p-1"
                          aria-label={t("settings.customAccent")}
                        />
                      </div>
                      <div>
                        <label className="field-label">{t("settings.customAccentHex")}</label>
                        <input
                          type="text"
                          value={customAccentDraft}
                          onChange={(event) => setCustomAccentDraft(event.target.value)}
                          onBlur={commitCustomAccentDraft}
                          onKeyDown={onCustomAccentKeyDown}
                          className="ui-input"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          <Card as="section" variant="frost" className="page-card page-card-roomy rounded-[22px]" interactive={false}>
            <SectionTitle icon={<ImagePlus size={18} className="text-[var(--mc-grass)]" />} title={t("settings.background")} subtitle={t("settings.backgroundDesc")} />

            <div className="space-y-4">
              <div>
                <FieldLabel>{t("settings.backgroundMode")}</FieldLabel>
                <div className="segment-control w-fit">
                  <button
                    type="button"
                    onClick={() => switchBackgroundSource("local")}
                    className={`segment-chip ${settings.backgroundSource === "local" ? "is-active" : ""}`}
                  >
                    {t("settings.backgroundMode.local")}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchBackgroundSource("web-random")}
                    className={`segment-chip ${settings.backgroundSource === "web-random" ? "is-active" : ""}`}
                  >
                    {t("settings.backgroundMode.web")}
                  </button>
                </div>
              </div>

              <Card variant="soft" className="overflow-hidden rounded-2xl" interactive={false}>
                {hasBackground ? (
                  <div className="h-28 w-full bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url("${activeBackgroundUrl}")` }} />
                ) : (
                  <div className="flex h-28 items-center justify-center text-sm text-[var(--text-muted)]">{t("settings.backgroundNoImage")}</div>
                )}
              </Card>

              <input ref={backgroundInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleBackgroundFile(event)} />
              <div className="flex gap-2">
                {settings.backgroundSource === "local" ? (
                  <Button variant="secondary" size="sm" className="flex-1 gap-2" onClick={() => backgroundInputRef.current?.click()}>
                    <ImagePlus size={14} />
                    {t("settings.backgroundUpload")}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" className="flex-1 gap-2" onClick={refreshRandomWebBackground}>
                    <Globe size={14} />
                    {t("settings.backgroundRefreshWeb")}
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

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <FieldLabel>{t("settings.backgroundOpacity")}</FieldLabel>
                  <span className="text-xs font-semibold text-[var(--text-secondary)]">{settings.backgroundOpacity}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={settings.backgroundOpacity}
                  disabled={!hasBackground}
                  onChange={(event) => onChange({ ...settings, backgroundOpacity: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-secondary)] accent-[var(--mc-grass)] disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <FieldLabel>{t("settings.backgroundBlur")}</FieldLabel>
                  <span className="text-xs font-semibold text-[var(--text-secondary)]">{settings.backgroundBlur}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="32"
                  step="1"
                  value={settings.backgroundBlur}
                  disabled={!hasBackground}
                  onChange={(event) => onChange({ ...settings, backgroundBlur: Math.max(0, Math.min(32, Number(event.target.value) || 0)) })}
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-secondary)] accent-[var(--mc-grass)] disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <p className="text-xs leading-5 text-[var(--text-muted)]">
                {settings.backgroundSource === "web-random" ? t("settings.backgroundWebHint") : t("settings.backgroundHint")}
              </p>
              {backgroundError && <p className="text-xs text-[var(--accent-danger)]">{backgroundError}</p>}
            </div>
          </Card>

          <Card as="section" variant="strong" className="page-card rounded-[22px]" interactive={false}>
            <SectionTitle
              icon={<Download size={18} className="text-[var(--mc-grass)]" />}
              title={t("settings.launcherUpdates")}
              subtitle={t("settings.launcherUpdatesDesc")}
            />
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <InfoTile label={t("settings.launcherCurrentVersion")} value={launcherCurrentVersion} />
                <InfoTile
                  label={t("settings.launcherLatestVersion")}
                  value={launcherUpdate?.version ?? "--"}
                  tone={launcherUpdateAvailable ? "highlight" : "default"}
                />
              </div>

              {launcherUpdate ? (
                <div className="surface-panel rounded-[20px] p-4">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {launcherUpdateAvailable ? t("settings.launcherUpdateAvailable", { version: launcherUpdate.version }) : t("settings.launcherUpToDate")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    {launcherUpdateAvailable
                      ? launcherUpdate.mandatory
                        ? t("settings.launcherUpdateMandatory")
                        : t("settings.launcherUpdateOptional")
                      : t("settings.launcherUpdateCurrentHint")}
                  </p>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <InfoTile label={t("settings.launcherUpdateTarget")} value={launcherUpdate.target} />
                    <InfoTile
                      label={t("settings.launcherUpdatePublishedAt")}
                      value={formatPublishedAt(launcherUpdate.publishedAt, t("settings.launcherUpdateUnknownDate"))}
                    />
                  </div>

                  {launcherUpdate.notes && (
                    <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-[var(--text-secondary)]">
                      {launcherUpdate.notes.trim()}
                    </p>
                  )}
                  {(launcherUpdate.fileSize || launcherUpdate.checksum) && (
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--text-muted)]">
                      {launcherUpdate.fileSize ? (
                        <span className="badge badge-muted normal-case tracking-normal">
                          {t("settings.launcherUpdateSize", { size: formatFileSize(launcherUpdate.fileSize) })}
                        </span>
                      ) : null}
                      {launcherUpdate.checksum ? (
                        <span className="badge badge-muted normal-case tracking-normal">
                          SHA-256: {launcherUpdate.checksum}
                        </span>
                      ) : null}
                    </div>
                  )}
                  {launcherUpdateDownload && (
                    <p className="mt-3 text-xs text-[var(--text-secondary)]">
                      {t("settings.launcherUpdateDownloaded", { file: launcherUpdateDownload.fileName })}
                    </p>
                  )}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-2"
                  disabled={launcherUpdateChecking || launcherUpdateDownloading}
                  onClick={onRefreshLauncherUpdate}
                >
                  <RefreshCw size={14} />
                  {launcherUpdateChecking ? t("settings.launcherUpdateChecking") : t("settings.launcherUpdateCheck")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="gap-2"
                  disabled={!launcherUpdateAvailable || launcherUpdateDownloading}
                  onClick={onInstallLauncherUpdate}
                >
                  <Download size={14} />
                  {launcherUpdateDownloading ? t("settings.launcherUpdatePreparing") : t("settings.launcherUpdateInstall")}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <footer className="mt-8 flex flex-wrap justify-end gap-3 border-t border-white/5 pt-6">
        <Button variant="ghost" className="gap-2" onClick={onReset}>
          <RefreshCw size={16} /> {t("settings.resetDefaults")}
        </Button>
      </footer>
    </div>
  );
}

function SectionTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="icon-tile h-10 w-10 rounded-[14px] shrink-0">{icon}</div>
      <div className="min-w-0">
        <h2 className="section-title text-base">{title}</h2>
        <p className="section-subtitle !mt-1">{subtitle}</p>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <label className="field-label">{children}</label>;
}

function InfoTile({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "highlight";
}) {
  return (
    <div className={`metric-tile ${tone === "highlight" ? "!border-[rgba(var(--accent-rgb),0.24)] !bg-[rgba(var(--accent-rgb),0.1)]" : ""}`}>
      <p className="metric-label">{label}</p>
      <p className="metric-value truncate">{value}</p>
    </div>
  );
}

function ToggleRow({
  title,
  subtitle,
  enabled,
  onToggle
}: {
  title: string;
  subtitle: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="toggle-card"
      onClick={onToggle}
      type="button"
    >
      <div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
        <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
      </div>
      <div className={`toggle-switch ${enabled ? "is-on" : ""}`} />
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
