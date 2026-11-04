import { useI18n } from "../i18n";
import type { LaunchOptions } from "../types";

export default function LaunchOptionsEditor({ value = {}, onChange, disabled = false, showMemory = true }: {
  value?: LaunchOptions; onChange: (value: LaunchOptions) => void; disabled?: boolean; showMemory?: boolean;
}) {
  const { t } = useI18n();
  const numberField = (key: "maxMemoryMb" | "windowWidth" | "windowHeight", label: string, min: number, max: number) => (
    <label className="grid gap-2 text-sm">
      <span>{label}</span>
      <input className="ui-input" type="number" min={min} max={max} disabled={disabled}
        placeholder={t("launchOptions.inherit")} value={value[key] ?? ""}
        onChange={(e) => onChange({ ...value, [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />
    </label>
  );
  return <div className="grid gap-4">
    <p className="text-sm text-[var(--text-secondary)]">{t("launchOptions.hint")}</p>
    <div className="grid gap-4 sm:grid-cols-3">
      {showMemory && numberField("maxMemoryMb", t("launchOptions.memory"), 1024, 65536)}
      {numberField("windowWidth", t("launchOptions.width"), 320, 16384)}
      {numberField("windowHeight", t("launchOptions.height"), 240, 16384)}
    </div>
    <label className="grid gap-2 text-sm">
      <span>{t("launchOptions.java")}</span>
      <input className="ui-input" disabled={disabled} placeholder={t("launchOptions.inherit")} value={value.javaPath ?? ""}
        onChange={(e) => onChange({ ...value, javaPath: e.target.value || undefined })} />
    </label>
    <label className="grid gap-2 text-sm">
      <span>{t("launchOptions.jvm")}</span>
      <textarea className="ui-input min-h-24" disabled={disabled} placeholder={t("launchOptions.inherit")}
        value={value.jvmArgs?.join("\n") ?? ""}
        onChange={(e) => onChange({ ...value, jvmArgs: e.target.value ? e.target.value.split("\n") : undefined })} />
    </label>
  </div>;
}
