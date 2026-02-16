import {
  Cpu,
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
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Button from "../components/Button";
import Card from "../components/Card";
import { LOCALE_OPTIONS, useI18n } from "../i18n";
import type { BackgroundSource, Settings, ThemeAccent, ThemeMode } from "../types";

type SettingsPageProps = {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClampMemory: (input: string) => void;
  onReset: () => void;
};

export default function SettingsPage({
  settings,
  onChange,
  onClampMemory,
  onReset
}: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const [hardwareAcceleration, setHardwareAcceleration] = useState(true);
  const [showGameOutput, setShowGameOutput] = useState(false);
  const [backgroundError, setBackgroundError] = useState("");
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
  const accentOptions: Array<{ id: ThemeAccent; swatch: string }> = [
    { id: "emerald", swatch: "bg-[#5f6fff]" },
    { id: "cyan", swatch: "bg-[#2b7fff]" },
    { id: "violet", swatch: "bg-[#7b61ff]" },
    { id: "sunset", swatch: "bg-[#e06c51]" }
  ];
  const activeBackgroundUrl =
    settings.backgroundSource === "web-random" ? settings.backgroundWebUrl : settings.backgroundImage;
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
    onChange({
      ...settings,
      backgroundSource: "web-random",
      backgroundWebUrl: buildRandomBackgroundUrl()
    });
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)]">{t("settings.title")}</h1>
        <p className="mt-1 text-[var(--text-secondary)]">{t("settings.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card as="section" variant="frost" className="rounded-2xl p-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
              <Cpu size={18} className="text-[var(--mc-grass)]" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("settings.javaMemory")}</h2>
              <p className="text-xs text-[var(--text-muted)]">{t("settings.runtimeConfig")}</p>
            </div>
          </div>

          <div className="space-y-5">
            <FieldLabel>{t("settings.gameDirectory")}</FieldLabel>
            <div className="flex gap-2">
              <input
                type="text"
                value={settings.gameDir}
                onChange={(event) => onChange({ ...settings, gameDir: event.target.value })}
                className="flex-1 rounded-xl border border-[var(--border-medium)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
              />
              <Button variant="secondary" size="md" className="!px-3">
                <Folder size={18} />
              </Button>
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
              <div className="mb-2 flex items-center justify-between">
                <FieldLabel>{t("settings.heapAllocation")}</FieldLabel>
                <span className="font-mono text-sm font-semibold text-[var(--mc-grass)]">
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
              <div className="mt-1 flex justify-between text-[10px] font-semibold uppercase text-[var(--text-muted)]">
                <span>1 GB</span>
                <span>16 GB</span>
              </div>
            </div>

            <Card variant="soft" className="h-44 rounded-xl p-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--mc-grass)" stopOpacity={0.18} />
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
                  <Area
                    type="monotone"
                    dataKey="uv"
                    stroke="var(--mc-grass)"
                    strokeWidth={1.8}
                    fillOpacity={1}
                    fill="url(#colorUv)"
                  />
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
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
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
              <div className="grid grid-cols-2 gap-2">
                {accentOptions.map((accent) => (
                  <button
                    key={accent.id}
                    type="button"
                    onClick={() => onChange({ ...settings, themeAccent: accent.id })}
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      settings.themeAccent === accent.id
                        ? "border-[var(--mc-grass)]/55 bg-[var(--surface-soft)]"
                        : "border-[var(--border-medium)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <div className={`h-5 w-full rounded-md ${accent.swatch}`} />
                    <p className="mt-1 text-xs font-medium text-[var(--text-secondary)]">
                      {t(`settings.accent.${accent.id}` as const)}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card as="section" variant="soft" className="rounded-2xl p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
                <Monitor size={18} className="text-[var(--mc-grass)]" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("settings.general")}</h2>
                <p className="text-xs text-[var(--text-muted)]">{t("settings.behaviorAppearance")}</p>
              </div>
            </div>

            <div className="space-y-3">
              <ToggleRow
                title={t("settings.keepOpen")}
                subtitle={t("settings.keepOpenDesc")}
                enabled={!settings.hideMainOnLaunch}
                onToggle={() =>
                  onChange({
                    ...settings,
                    hideMainOnLaunch: !settings.hideMainOnLaunch
                  })
                }
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

          <Card as="section" variant="strong" className="rounded-2xl p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
                <HardDrive size={18} className="text-[var(--text-secondary)]" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{t("settings.storage")}</h2>
                <p className="text-xs text-[var(--text-muted)]">{t("settings.dataAssets")}</p>
              </div>
            </div>
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

          <Card as="section" variant="frost" className="rounded-2xl p-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
                <ImagePlus size={18} className="text-[var(--mc-grass)]" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  {t("settings.background")}
                </h2>
                <p className="text-xs text-[var(--text-muted)]">{t("settings.backgroundDesc")}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <FieldLabel>{t("settings.backgroundMode")}</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => switchBackgroundSource("local")}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
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
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      settings.backgroundSource === "web-random"
                        ? "border-[var(--mc-grass)]/55 bg-[var(--mc-grass)]/12 text-[var(--text-primary)]"
                        : "border-[var(--border-medium)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {t("settings.backgroundMode.web")}
                  </button>
                </div>
              </div>

              <Card variant="soft" className="overflow-hidden rounded-xl">
                {hasBackground ? (
                  <div
                    className="h-28 w-full bg-cover bg-center bg-no-repeat"
                    style={{ backgroundImage: `url("${activeBackgroundUrl}")` }}
                  />
                ) : (
                  <div className="flex h-28 items-center justify-center text-sm text-[var(--text-muted)]">
                    {t("settings.backgroundNoImage")}
                  </div>
                )}
              </Card>

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
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 gap-2"
                    onClick={refreshRandomWebBackground}
                  >
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
                  <span className="text-xs font-semibold text-[var(--text-secondary)]">
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
                      backgroundOpacity: Math.max(0, Math.min(100, Number(event.target.value) || 0))
                    })
                  }
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-secondary)] accent-[var(--mc-grass)] disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <FieldLabel>{t("settings.backgroundBlur")}</FieldLabel>
                  <span className="text-xs font-semibold text-[var(--text-secondary)]">
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

              <p className="text-xs text-[var(--text-muted)]">
                {settings.backgroundSource === "web-random"
                  ? t("settings.backgroundWebHint")
                  : t("settings.backgroundHint")}
              </p>
              {backgroundError && <p className="text-xs text-[var(--accent-danger)]">{backgroundError}</p>}
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-8 flex justify-end gap-4 border-t border-[var(--border-subtle)] pt-6">
        <Button variant="ghost" className="gap-2" onClick={onReset}>
          <RefreshCw size={16} /> {t("settings.resetDefaults")}
        </Button>
        <Button variant="primary" className="gap-2 px-8">
          <Save size={16} /> {t("settings.savedAuto")}
        </Button>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      {children}
    </label>
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
      className="flex w-full items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--border-medium)]"
      onClick={onToggle}
      type="button"
    >
      <div>
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
        <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
      </div>
      <div
        className={`relative h-6 w-11 rounded-full border transition-colors ${
          enabled
            ? "border-[var(--mc-grass)]/60 bg-[var(--mc-grass)]/20"
            : "border-[var(--border-medium)] bg-[var(--bg-elevated)]"
        }`}
      >
        <div
          className={`absolute bottom-1 top-1 w-4 rounded-full transition-all ${
            enabled ? "right-1 bg-[var(--mc-grass)]" : "left-1 bg-[var(--text-muted)]"
          }`}
        />
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
