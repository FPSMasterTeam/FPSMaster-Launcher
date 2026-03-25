import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, File, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { useI18n } from "../i18n";
import type { Instance, InstanceSectionEntry } from "../types";

type InstanceSection =
  | "saves"
  | "mods"
  | "resourcepacks"
  | "shaderpacks"
  | "logs"
  | "crash-reports";

type SectionState = {
  entries: InstanceSectionEntry[];
  loading: boolean;
  error: string | null;
};

type InstanceSettingsPageProps = {
  instance: Instance | null;
  gameDir: string;
  onBack: () => void;
};

const SECTIONS: readonly InstanceSection[] = [
  "saves",
  "mods",
  "resourcepacks",
  "shaderpacks",
  "logs",
  "crash-reports"
];

function emptySectionState(): Record<InstanceSection, SectionState> {
  return {
    saves: { entries: [], loading: false, error: null },
    mods: { entries: [], loading: false, error: null },
    resourcepacks: { entries: [], loading: false, error: null },
    shaderpacks: { entries: [], loading: false, error: null },
    logs: { entries: [], loading: false, error: null },
    "crash-reports": { entries: [], loading: false, error: null }
  };
}

export default function InstanceSettingsPage({ instance, gameDir, onBack }: InstanceSettingsPageProps) {
  const { t } = useI18n();
  const [sections, setSections] = useState<Record<InstanceSection, SectionState>>(emptySectionState);

  function sectionLabel(section: InstanceSection): string {
    if (section === "saves") return t("instanceFiles.saves");
    if (section === "mods") return t("instanceFiles.mods");
    if (section === "shaderpacks") return t("instanceFiles.shaderpacks");
    if (section === "logs") return t("instanceFiles.logs");
    if (section === "crash-reports") return t("instanceFiles.crashReports");
    return t("instanceFiles.resourcepacks");
  }

  async function refreshSection(section: InstanceSection, versionId: string) {
    setSections((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        loading: true,
        error: null
      }
    }));

    try {
      const entries = await invoke<InstanceSectionEntry[]>("list_instance_section_entries", {
        gameDir,
        versionId,
        section
      });
      setSections((prev) => ({
        ...prev,
        [section]: {
          entries,
          loading: false,
          error: null
        }
      }));
    } catch (error) {
      setSections((prev) => ({
        ...prev,
        [section]: {
          ...prev[section],
          loading: false,
          error: t("instanceFiles.loadFailed", { error: String(error) })
        }
      }));
    }
  }

  async function openSection(section: InstanceSection) {
    if (!instance) return;
    try {
      await invoke("open_instance_section", {
        gameDir,
        versionId: instance.versionId,
        section
      });
    } catch (error) {
      setSections((prev) => ({
        ...prev,
        [section]: {
          ...prev[section],
          error: t("instanceFiles.openFailed", { error: String(error) })
        }
      }));
    }
  }

  useEffect(() => {
    if (!instance) {
      setSections(emptySectionState());
      return;
    }

    let cancelled = false;
    const currentVersionId = instance.versionId;
    setSections(emptySectionState());

    for (const section of SECTIONS) {
      void (async () => {
        if (cancelled) return;
        await refreshSection(section, currentVersionId);
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [instance, gameDir, t]);

  if (!instance) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
        <Card variant="frost" className="max-w-xl rounded-xl p-5">
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">{t("instanceFiles.title")}</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">{t("instanceFiles.noInstance")}</p>
          <div className="mt-5">
            <Button variant="secondary" size="sm" className="gap-2" onClick={onBack}>
              <ArrowLeft size={14} />
              {t("instanceFiles.back")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
      <header className="mb-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{t("instanceFiles.title")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">{instance.name}</h1>
          <p className="mt-1 text-[var(--text-secondary)]">{t("instanceFiles.subtitle", { name: instance.name })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <MetaBadge>{instance.baseVersion}</MetaBadge>
            <MetaBadge>{loaderLabel(instance.loader, t)}</MetaBadge>
            {instance.launcherVersionType && <MetaBadge>{instance.launcherVersionType}</MetaBadge>}
          </div>
        </div>
        <Button variant="secondary" size="sm" className="gap-2" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("instanceFiles.back")}
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 pb-20 xl:grid-cols-3">
        {SECTIONS.map((section) => {
          const state = sections[section];
          return (
            <Card key={section} as="section" variant="frost" className="flex min-h-[320px] flex-col rounded-xl p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{sectionLabel(section)}</h2>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={state.loading}
                    onClick={() => void refreshSection(section, instance.versionId)}
                  >
                    <RefreshCw size={12} className={state.loading ? "animate-spin" : ""} />
                    {t("instanceFiles.refresh")}
                  </Button>
                  <Button variant="secondary" size="sm" className="gap-1" onClick={() => void openSection(section)}>
                    <FolderOpen size={12} />
                    {t("instanceFiles.openFolder")}
                  </Button>
                </div>
              </div>

              {state.loading ? (
                <p className="text-sm text-[var(--text-secondary)]">{t("instanceFiles.loading")}</p>
              ) : state.error ? (
                <p className="break-all text-sm text-[var(--accent-danger)]">{state.error}</p>
              ) : state.entries.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">{t("instanceFiles.empty")}</p>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <ul className="space-y-2">
                    {state.entries.map((entry) => (
                      <li key={entry.name} className="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2.5 py-2">
                        {entry.isDir ? <Folder size={14} className="shrink-0 text-[var(--mc-grass)]" /> : <File size={14} className="shrink-0 text-[var(--text-muted)]" />}
                        <span className="truncate text-xs text-[var(--text-secondary)]">{entry.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function loaderLabel(
  loader: Instance["loader"],
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (loader === "forge") return t("loader.forge");
  if (loader === "fabric") return t("loader.fabric");
  return t("loader.vanilla");
}

function MetaBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
      {children}
    </span>
  );
}
