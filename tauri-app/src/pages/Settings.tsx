import {
  Cpu,
  Download,
  Folder,
  Globe,
  HardDrive,
  ImagePlus,
  Monitor,
  Palette,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Button from "../components/Button";
import Card from "../components/Card";
import { LOCALE_OPTIONS, useI18n } from "../i18n";
import type {
  BackgroundSource,
  DownloadSource,
  DownloadedLauncherUpdate,
  LauncherAppUpdateInfo,
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
  onRefreshLauncherUpdate,
  onInstallLauncherUpdate,
  onChange,
  onClampMemory,
  onReset
}: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const [hardwareAcceleration, setHardwareAcceleration] = useState(true);
  const [showGameOutput, setShowGameOutput] = useState(false);
  const [backgroundError, setBackgroundError] = useState("");
  const [customAccentDraft, setCustomAccentDraft] = useState(settings.customAccentHex);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

  const chartData = useMemo(
    () =>
      [
        { name: "0s", uv: Math.max(1024, settings.maxMemoryMb * 0.5) },
        { name: "10s", uv: Math.max(1024, settings.maxMemoryMb * 0.72) },
        { name: "20s", uv: Math.max(1024, settings.maxMemoryMb * 0.61) },
        { name: "30s", uv: Math.max(1024, settings.maxMemoryMb * 0.9) },
        { name: "40s", uv: Math.max(1024, settings.maxMemoryMb * 0.8) },
        { name: "50s", uv: Math.max(1024, settings.maxMemoryMb * 0.95) },
        { name: "60s", uv: Math.max(1024, settings.maxMemoryMb * 0.83) }
      ].map((item) => ({ ...item, uv: Math.round(item.uv) })),
    [settings.maxMemoryMb]
  );

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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card as="section" variant="frost" className="rounded-xl p-4 md:p-5">
          <SectionTitle icon={<Cpu size={18} className="text-[var(--mc-grass)]" />} title={t("settings.javaMemory")} subtitle={t("settings.runtimeConfig")} />

          <div className="space-y-5">
            <div>
              <FieldLabel>{t("settings.gameDirectory")}</FieldLabel>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={settings.gameDir}
                  onChange={(event) => onChange({ ...settings, gameDir: event.target.value })}
                  className="flex-1 rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                />
                <Button variant="secondary" size="md" className="!px-3" aria-label={t("settings.open")}>
                  <Folder size={18} />
                </Button>
              </div>
            </div>

            <div>
              <FieldLabel>{t("settings.playerName")}</FieldLabel>
              <input
                type="text"
                value={settings.playerName}
                onChange={(event) => onChange({ ...settings, playerName: event.target.value })}
                className="w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
              />
            </div>

            <div>
              <FieldLabel>{t("settings.downloadSource")}</FieldLabel>
              <select
                value={settings.downloadSource}
                onChange={(event) =>
                  onChange({ ...settings, downloadSource: event.target.value as DownloadSource })
                }
                className="w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
              >
                {downloadSources.map((source) => (
                  <option key={source} value={source}>
                    {t(`settings.downloadSource.${source}` as const)}
                  </option>
                ))}
              </select>
            </div>

            <div>
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

            <Card variant="soft" className="h-44 rounded-2xl p-2" interactive={false}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="settingsMemoryGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--mc-grass)" stopOpacity={0.22} />
                      <stop offset="95%" stopColor="var(--mc-grass)" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                  <XAxis dataKey="name" hide />
                  <YAxis hide domain={[0, 16384]} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--bg-tertiary)",
                      borderColor: "var(--border-medium)",
                      borderRadius: "12px"
                    }}
                    itemStyle={{ color: "var(--text-primary)", fontSize: "12px", fontFamily: "Manrope, sans-serif" }}
                  />
                  <Area type="monotone" dataKey="uv" stroke="var(--mc-grass)" strokeWidth={1.8} fillOpacity={1} fill="url(#settingsMemoryGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <div>
              <FieldLabel>{t("settings.language")}</FieldLabel>
              <select
                value={locale}
                onChange={(event) => setLocale(event.target.value as "en-US" | "zh-CN")}
                className="w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
              >
                {LOCALE_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {t(`language.${item}` as const)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <FieldLabel>{t("settings.themeMode")}</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                {themeModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onChange({ ...settings, themeMode: mode })}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                      settings.themeMode === mode
                        ? "border-[var(--mc-grass)]/55 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                        : "border-[var(--border-medium)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {t(`settings.theme.${mode}` as const)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                <Palette size={14} />
                {t("settings.themeAccent")}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {accentOptions.map((accent) => (
                  <button
                    key={accent.id}
                    type="button"
                    onClick={() => onChange({ ...settings, themeAccent: accent.id })}
                    className={`rounded-xl border p-2 text-left transition-colors ${
                      settings.themeAccent === accent.id
                        ? "border-[var(--mc-grass)]/55 bg-[var(--surface-soft)]"
                        : "border-[var(--border-medium)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <div className="h-5 w-full rounded-md" style={{ backgroundColor: accent.id === "custom" ? settings.customAccentHex : accent.swatch }} />
                    <p className="mt-1 text-xs font-medium text-[var(--text-secondary)]">{t(`settings.accent.${accent.id}` as const)}</p>
                  </button>
                ))}
              </div>
              {settings.themeAccent === "custom" && (
                <div className="mt-3 grid grid-cols-[64px_minmax(0,1fr)] gap-2">
                  <input
                    type="color"
                    value={settings.customAccentHex}
                    onChange={(event) => applyCustomAccent(event.target.value)}
                    className="h-11 w-full cursor-pointer rounded-lg border border-[var(--border-medium)] bg-[var(--bg-secondary)] p-1"
                    aria-label={t("settings.customAccent")}
                  />
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      {t("settings.customAccentHex")}
                    </label>
                    <input
                      type="text"
                      value={customAccentDraft}
                      onChange={(event) => setCustomAccentDraft(event.target.value)}
                      onBlur={commitCustomAccentDraft}
                      onKeyDown={onCustomAccentKeyDown}
                      className="h-11 w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                    />
                  </div>
                </div>
              )}
              {settings.themeAccent === "custom" && (
                <p className="mt-2 text-xs text-[var(--text-muted)]">{t("settings.customAccentHint")}</p>
              )}
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card as="section" variant="soft" className="rounded-xl p-4 md:p-5">
            <SectionTitle icon={<Monitor size={18} className="text-[var(--mc-grass)]" />} title={t("settings.general")} subtitle={t("settings.behaviorAppearance")} />
            <div className="space-y-3">
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
              <ToggleRow
                title={t("settings.hardwareAcceleration")}
                subtitle={t("settings.hardwareAccelerationDesc")}
                enabled={hardwareAcceleration}
                onToggle={() => setHardwareAcceleration((value) => !value)}
              />
              <ToggleRow
                title={t("settings.gameOutput")}
                subtitle={t("settings.gameOutputDesc")}
                enabled={showGameOutput}
                onToggle={() => setShowGameOutput((value) => !value)}
              />
            </div>
          </Card>

          <Card as="section" variant="strong" className="rounded-xl p-4 md:p-5">
            <SectionTitle icon={<HardDrive size={18} className="text-[var(--text-secondary)]" />} title={t("settings.storage")} subtitle={t("settings.dataAssets")} />
            <div className="flex gap-2">
              <input
                type="text"
                value={settings.gameDir}
                onChange={(event) => onChange({ ...settings, gameDir: event.target.value })}
                className="flex-1 rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-primary)]"
              />
              <Button variant="secondary" size="md">
                {t("settings.open")}
              </Button>
            </div>
          </Card>

          <Card as="section" variant="strong" className="rounded-xl p-4 md:p-5">
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
                      <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-1">
                        {t("settings.launcherUpdateSize", { size: formatFileSize(launcherUpdate.fileSize) })}
                      </span>
                    ) : null}
                    {launcherUpdate.checksum ? (
                      <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-1">
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

          <Card as="section" variant="strong" className="rounded-xl p-4 md:p-5">
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
                className="w-full rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)]"
              />
              <p className="text-xs leading-5 text-[var(--text-muted)]">{t("settings.curseforgeApiKeyHint")}</p>
            </div>
          </Card>

          <Card as="section" variant="frost" className="rounded-xl p-4 md:p-5">
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
                        ? "border-[var(--mc-grass)]/55 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                        : "border-[var(--border-medium)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {t("settings.backgroundMode.local")}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchBackgroundSource("web-random")}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                      settings.backgroundSource === "web-random"
                        ? "border-[var(--mc-grass)]/55 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                        : "border-[var(--border-medium)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
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

      <footer className="mt-8 flex flex-wrap justify-end gap-3 border-t border-[var(--border-subtle)] pt-6">
        <Button variant="ghost" className="gap-2" onClick={onReset}>
          <RefreshCw size={16} /> {t("settings.resetDefaults")}
        </Button>
        <Button variant="primary" className="gap-2 px-8">
          <Save size={16} /> {t("settings.savedAuto")}
        </Button>
      </footer>
    </div>
  );
}

function SectionTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">{icon}</div>
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
    <div className={`rounded-xl border px-3 py-2 ${tone === "highlight" ? "border-[var(--mc-grass)]/35 bg-[var(--mc-grass)]/10" : "border-[var(--border-subtle)] bg-[var(--surface-soft)]"}`}>
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
      className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--border-medium)]"
      onClick={onToggle}
      type="button"
    >
      <div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
        <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
      </div>
      <div className={`relative h-6 w-11 rounded-full border transition-colors ${enabled ? "border-[var(--mc-grass)]/60 bg-[var(--mc-grass)]/20" : "border-[var(--border-medium)] bg-[var(--bg-elevated)]"}`}>
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
