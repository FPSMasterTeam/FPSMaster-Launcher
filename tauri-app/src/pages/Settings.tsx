import {
  Cpu,
  Download,
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
  const [customAccentDraft, setCustomAccentDraft] = useState(settings.customAccentHex);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

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
    <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{t("nav.settings")}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">{t("settings.title")}</h1>
        <p className="mt-1 text-[var(--text-secondary)]">{t("settings.subtitle")}</p>
      </header>

      {launcherUser ? (
        <Card as="section" variant="strong" className="mb-6 rounded-xl p-4 md:p-5" interactive={false}>
          <SectionTitle icon={<Globe size={18} className="text-[var(--mc-grass)]" />} title={t("settings.launcherAuth.title")} subtitle={t("settings.launcherAuth.subtitle")} />
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{t("settings.launcherAuth.loggedInAs")}</p>
              <p className="mt-1 text-base font-semibold text-[var(--text-primary)]">{launcherUser.username || launcherUser.email || launcherUser.id || "-"}</p>
            </div>
            <Button variant="ghost" size="sm" className="gap-2 self-start" onClick={onLogoutLauncherAccount}>
              <LogOut size={14} />
              {t("settings.launcherAuth.logout")}
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="space-y-6">
          <Card as="section" variant="strong" className="rounded-2xl p-5 md:p-6" interactive={false}>
            <SectionTitle icon={<Cpu size={18} className="text-[var(--mc-grass)]" />} title={t("settings.javaMemory")} subtitle={t("settings.runtimeConfig")} />
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <FieldLabel>{t("settings.playerName")}</FieldLabel>
                <input
                  type="text"
                  value={settings.playerName}
                  onChange={(event) => onChange({ ...settings, playerName: event.target.value })}
                  className="w-full rounded-2xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                />
              </div>

              <div className="md:col-span-2">
                <FieldLabel>{t("settings.gameDirectory")}</FieldLabel>
                <input
                  type="text"
                  value={settings.gameDir}
                  onChange={(event) => onChange({ ...settings, gameDir: event.target.value })}
                  className="w-full rounded-2xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                />
              </div>

              <div>
                <FieldLabel>{t("settings.downloadSource")}</FieldLabel>
                <Select value={settings.downloadSource} onValueChange={(value) => onChange({ ...settings, downloadSource: value as DownloadSource })}>
                  <Select.Trigger>
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

              <div>
                <FieldLabel>{t("settings.language")}</FieldLabel>
                <Select value={locale} onValueChange={(value) => setLocale(value as "en-US" | "zh-CN")}>
                  <Select.Trigger>
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

            <div className="mt-6 rounded-2xl border border-white/5 bg-[var(--surface-soft)]/85 p-4">
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

          <Card as="section" variant="frost" className="rounded-2xl p-5 md:p-6" interactive={false}>
            <SectionTitle icon={<Monitor size={18} className="text-[var(--mc-grass)]" />} title={t("settings.general")} subtitle={t("settings.behaviorAppearance")} />
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
          <Card as="section" variant="frost" className="rounded-2xl p-5 md:p-6" interactive={false}>
            <SectionTitle icon={<Palette size={18} className="text-[var(--mc-grass)]" />} title={t("settings.themeMode")} subtitle={t("settings.behaviorAppearance")} />
            <div className="space-y-5">
              <div className="rounded-2xl border border-white/8 bg-[var(--surface-soft)] p-4 md:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-white/10 bg-[var(--bg-secondary)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)]">
                    {activeThemeLabel}
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[var(--bg-secondary)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)]">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: activeAccentColor }} />
                    {activeAccentLabel}
                  </span>
                </div>

                <div className="mt-4">
                  <FieldLabel>{t("settings.themeMode")}</FieldLabel>
                  <div className="grid grid-cols-2 gap-3">
                    {themeModes.map((mode) => {
                      const selected = settings.themeMode === mode;
                      const isDark = mode === "dark";
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => onChange({ ...settings, themeMode: mode })}
                          className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                            selected
                              ? "border-[var(--mc-grass)]/35 bg-[var(--bg-secondary)]"
                              : "border-white/10 bg-[var(--bg-secondary)] hover:border-white/20"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <span
                                className={`flex h-9 w-9 items-center justify-center rounded-xl border ${
                                  selected ? "border-[var(--mc-grass)]/30 bg-[var(--mc-grass)]/10" : "border-white/10 bg-[var(--bg-elevated)]"
                                }`}
                              >
                                {isDark ? <MoonStar size={16} className="text-[var(--text-primary)]" /> : <SunMedium size={16} className="text-[var(--text-primary)]" />}
                              </span>
                              <div>
                                <p className="text-sm font-semibold text-[var(--text-primary)]">{t(`settings.theme.${mode}` as const)}</p>
                                <p className="text-xs text-[var(--text-muted)]">{isDark ? "Higher contrast" : "Brighter surface"}</p>
                              </div>
                            </div>
                            <span
                              className={`h-3 w-3 rounded-full border ${
                                selected ? "border-[var(--mc-grass)] bg-[var(--mc-grass)]" : "border-white/15 bg-transparent"
                              }`}
                            />
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
                          className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                            selected
                              ? "border-[var(--mc-grass)]/35 bg-[var(--bg-secondary)]"
                              : "border-white/10 bg-[var(--bg-secondary)] hover:border-white/20"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="h-8 w-8 rounded-full border border-white/10" style={{ backgroundColor: accent.swatch }} />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{t(`settings.accent.${accent.id}` as const)}</p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-5 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
                  <button type="button" onClick={() => onChange({ ...settings, themeAccent: "custom" })} className="flex w-full items-center justify-between gap-3 text-left">
                    <div>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{t("settings.customAccent")}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{t("settings.customAccentHint")}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="h-8 w-8 rounded-full border border-white/10" style={{ backgroundColor: settings.customAccentHex }} />
                      <span
                        className={`h-3 w-3 rounded-full border ${
                          settings.themeAccent === "custom" ? "border-[var(--mc-grass)] bg-[var(--mc-grass)]" : "border-white/15 bg-transparent"
                        }`}
                      />
                    </div>
                  </button>

                  {settings.themeAccent === "custom" ? (
                    <div className="mt-4 grid grid-cols-1 gap-3 border-t border-white/10 pt-4 md:grid-cols-[88px_minmax(0,1fr)]">
                      <div>
                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                          {t("settings.customAccent")}
                        </label>
                        <input
                          type="color"
                          value={settings.customAccentHex}
                          onChange={(event) => applyCustomAccent(event.target.value)}
                          className="h-11 w-full cursor-pointer rounded-xl border border-white/10 bg-[var(--bg-elevated)] p-1"
                          aria-label={t("settings.customAccent")}
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                          {t("settings.customAccentHex")}
                        </label>
                        <input
                          type="text"
                          value={customAccentDraft}
                          onChange={(event) => setCustomAccentDraft(event.target.value)}
                          onBlur={commitCustomAccentDraft}
                          onKeyDown={onCustomAccentKeyDown}
                          className="h-11 w-full rounded-xl border border-white/10 bg-[var(--bg-elevated)] px-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          <Card as="section" variant="strong" className="rounded-xl p-4 md:p-5" interactive={false}>
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

              {launcherUpdate && (
                <div className="grid grid-cols-2 gap-2">
                  <InfoTile label={t("settings.launcherUpdateTarget")} value={launcherUpdate.target} />
                  <InfoTile
                    label={t("settings.launcherUpdatePublishedAt")}
                    value={formatPublishedAt(launcherUpdate.publishedAt, t("settings.launcherUpdateUnknownDate"))}
                  />
                </div>
              )}

              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {launcherUpdate
                    ? launcherUpdateAvailable
                      ? t("settings.launcherUpdateAvailable", { version: launcherUpdate.version })
                      : t("settings.launcherUpToDate")
                    : t("settings.launcherUpdateNotConfigured")}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                  {launcherUpdate
                    ? launcherUpdateAvailable
                      ? launcherUpdate.mandatory
                        ? t("settings.launcherUpdateMandatory")
                        : t("settings.launcherUpdateOptional")
                      : t("settings.launcherUpdateCurrentHint")
                    : t("settings.launcherUpdateConfigHint")}
                </p>
                {launcherUpdate?.notes && (
                  <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-[var(--text-secondary)]">
                    {launcherUpdate.notes.trim()}
                  </p>
                )}
                {launcherUpdate && (launcherUpdate.fileSize || launcherUpdate.checksum) && (
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[var(--text-muted)]">
                    {launcherUpdate.fileSize ? (
                      <span className="rounded-md border border-white/5 bg-[var(--surface-soft)] px-2 py-1">
                        {t("settings.launcherUpdateSize", { size: formatFileSize(launcherUpdate.fileSize) })}
                      </span>
                    ) : null}
                    {launcherUpdate.checksum ? (
                      <span className="rounded-md border border-white/5 bg-[var(--surface-soft)] px-2 py-1">
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

          <Card as="section" variant="strong" className="rounded-2xl p-5 md:p-6" interactive={false}>
            <SectionTitle
              icon={<Globe size={18} className="text-[var(--mc-grass)]" />}
              title={t("settings.contentSources")}
              subtitle={t("settings.contentSourcesDesc")}
            />
            <div className="space-y-2">
              <FieldLabel>{t("settings.curseforgeApiKey")}</FieldLabel>
              <input
                type="password"
                value={settings.curseforgeApiKey}
                onChange={(event) => onChange({ ...settings, curseforgeApiKey: event.target.value })}
                placeholder="cf-api-***"
                className="w-full rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)]"
              />
              <p className="text-xs leading-5 text-[var(--text-muted)]">{t("settings.curseforgeApiKeyHint")}</p>
            </div>
          </Card>

          <Card as="section" variant="frost" className="rounded-2xl p-5 md:p-6" interactive={false}>
            <SectionTitle icon={<ImagePlus size={18} className="text-[var(--mc-grass)]" />} title={t("settings.background")} subtitle={t("settings.backgroundDesc")} />

            <div className="space-y-4">
              <div>
                <FieldLabel>{t("settings.backgroundMode")}</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => switchBackgroundSource("local")}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                      settings.backgroundSource === "local"
                        ? "border-[#25b87a]/40 bg-[#25b87a]/12 text-[var(--text-primary)]"
                        : "border-white/10 bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {t("settings.backgroundMode.local")}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchBackgroundSource("web-random")}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                      settings.backgroundSource === "web-random"
                        ? "border-[#25b87a]/40 bg-[#25b87a]/12 text-[var(--text-primary)]"
                        : "border-white/10 bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
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
    <div className="mb-5 flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-[var(--bg-elevated)]">{icon}</div>
      <div>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{children}</label>;
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
    <div className={`rounded-xl border px-3 py-2 ${tone === "highlight" ? "border-[#25b87a]/25 bg-[#25b87a]/10" : "border-white/5 bg-[var(--surface-soft)]"}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[var(--text-primary)]">{value}</p>
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
      className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-white/5 bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-white/10"
      onClick={onToggle}
      type="button"
    >
      <div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
        <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
      </div>
      <div className={`relative h-6 w-11 rounded-full border transition-colors ${enabled ? "border-[#25b87a]/50 bg-[#25b87a]/20" : "border-white/10 bg-[var(--bg-elevated)]"}`}>
        <div className={`absolute bottom-1 top-1 w-4 rounded-full transition-all ${enabled ? "right-1 bg-[var(--mc-grass)]" : "left-1 bg-[var(--text-muted)]"}`} />
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

function toAlpha(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex);
  if (!normalized) {
    return `rgba(37, 184, 122, ${clampUnit(alpha)})`;
  }
  const value = normalized.slice(1);
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clampUnit(alpha)})`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
