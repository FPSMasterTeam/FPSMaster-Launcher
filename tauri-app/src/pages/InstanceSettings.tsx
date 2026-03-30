import { invoke } from "@tauri-apps/api/core";
import { Archive, ArrowLeft, Copy, File, Folder, FolderOpen, MoreHorizontal, RefreshCw, Trash2, Ban, Check } from "lucide-react";
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
  busy: boolean;
  onBack: () => void;
  onRepair: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onExport: () => void;
};

const SECTIONS: readonly { id: InstanceSection; icon: ReactNode }[] = [
  { id: "saves", icon: <Folder size={18} /> },
  { id: "mods", icon: <Folder size={18} /> },
  { id: "resourcepacks", icon: <Folder size={18} /> },
  { id: "shaderpacks", icon: <Folder size={18} /> },
  { id: "logs", icon: <File size={18} /> },
  { id: "crash-reports", icon: <File size={18} /> }
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

export default function InstanceSettingsPage({
  instance,
  gameDir,
  busy,
  onBack,
  onRepair,
  onDelete,
  onDuplicate,
  onExport
}: InstanceSettingsPageProps) {
  const { t } = useI18n();
  const [sections, setSections] = useState<Record<InstanceSection, SectionState>>(emptySectionState);
  const [activeTab, setActiveTab] = useState<InstanceSection>("saves");

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

  async function deleteEntry(section: InstanceSection, entryName: string) {
    if (!instance) return;
    try {
      await invoke("delete_instance_section_entry", {
        gameDir,
        versionId: instance.versionId,
        section,
        entryName
      });
      // Refresh the section after deletion
      await refreshSection(section, instance.versionId);
    } catch (error) {
      setSections((prev) => ({
        ...prev,
        [section]: {
          ...prev[section],
          error: t("instanceFiles.deleteFailed", { error: String(error) })
        }
      }));
    }
  }

  async function toggleModDisabled(entryName: string, currentlyDisabled: boolean) {
    if (!instance) return;
    try {
      await invoke("toggle_mod_disabled", {
        gameDir,
        versionId: instance.versionId,
        modName: entryName,
        disable: !currentlyDisabled
      });
      // Refresh the mods section after toggling
      await refreshSection("mods", instance.versionId);
    } catch (error) {
      setSections((prev) => ({
        ...prev,
        mods: {
          ...prev.mods,
          error: t("instanceFiles.toggleFailed", { error: String(error) })
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
        await refreshSection(section.id, currentVersionId);
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [instance, gameDir, t]);

  if (!instance) {
    return (
      <div className="h-full overflow-y-auto p-4 md:p-5 xl:p-6">
        <Card variant="frost" className="max-w-xl rounded-xl p-5" interactive={false}>
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2" disabled={busy} onClick={onRepair}>
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            {t("instanceFiles.repair")}
          </Button>
          <Button variant="outline" size="sm" className="gap-2" disabled={busy} onClick={onDuplicate}>
            <Copy size={14} />
            {t("instances.copy")}
          </Button>
          <Button variant="outline" size="sm" className="gap-2" disabled={busy} onClick={onExport}>
            <Archive size={14} />
            {t("instances.export")}
          </Button>
          <Button variant="danger" size="sm" className="gap-2" disabled={busy || instance?.preset} onClick={onDelete}>
            <Trash2 size={14} />
            {t("instances.delete")}
          </Button>
          <Button variant="secondary" size="sm" className="gap-2" onClick={onBack}>
            <ArrowLeft size={14} />
            {t("instanceFiles.back")}
          </Button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="mb-6 flex items-center gap-2 overflow-x-auto pb-1">
        {SECTIONS.map((section) => {
          const isActive = activeTab === section.id;
          const state = sections[section.id];
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveTab(section.id)}
              className={`relative flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "border-[rgba(var(--accent-rgb),0.36)] bg-[rgba(var(--accent-rgb),0.14)] text-[var(--text-primary)]"
                  : "border-white/5 bg-[var(--surface-soft)] text-[var(--text-secondary)] hover:border-white/10 hover:text-[var(--text-primary)]"
              }`}
            >
              {section.icon}
              <span>{sectionLabel(section.id)}</span>
              {isActive && state.loading && (
                <RefreshCw size={12} className="animate-spin" />
              )}
            </button>
          );
        })}
      </div>

      {/* Active Section Content */}
      {(() => {
        const state = sections[activeTab];
        return (
          <Card variant="frost" className="rounded-xl p-4 md:p-5" interactive={false}>
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">{sectionLabel(activeTab)}</h2>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={state.loading}
                  onClick={() => void refreshSection(activeTab, instance.versionId)}
                >
                  <RefreshCw size={14} className={state.loading ? "animate-spin" : ""} />
                  {t("instanceFiles.refresh")}
                </Button>
                <Button variant="secondary" size="sm" className="gap-1" onClick={() => void openSection(activeTab)}>
                  <FolderOpen size={14} />
                  {t("instanceFiles.openFolder")}
                </Button>
              </div>
            </div>

            {state.loading ? (
              <p className="text-sm text-[var(--text-secondary)]">{t("instanceFiles.loading")}</p>
            ) : state.error ? (
              <p className="break-all text-sm text-[var(--accent-danger)]">{state.error}</p>
            ) : state.entries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/5 bg-[var(--surface-soft)] p-8 text-center">
                <FolderOpen size={32} className="mx-auto mb-3 text-[var(--text-muted)]" />
                <p className="text-sm text-[var(--text-muted)]">{t("instanceFiles.empty")}</p>
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto">
                <ul className="grid grid-cols-1 gap-2">
                  {state.entries.map((entry) => {
                    const isMods = activeTab === "mods";
                    return (
                      <li
                        key={entry.name}
                        className={`group relative flex items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors ${
                          entry.disabled
                            ? "border-white/5 bg-[var(--surface-soft)]/50 opacity-60"
                            : "border-white/5 bg-[var(--surface-soft)] hover:border-white/10"
                        }`}
                      >
                        {entry.isDir ? (
                          <Folder size={16} className={`shrink-0 ${entry.disabled ? "text-[var(--text-muted)]" : "text-[var(--mc-grass)]"}`} />
                        ) : (
                          <File size={16} className={`shrink-0 ${entry.disabled ? "text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}`} />
                        )}
                        <span className={`min-w-0 flex-1 truncate text-sm ${entry.disabled ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                          {entry.name}
                          {entry.disabled && (
                            <span className="ml-2 text-[11px] text-[var(--text-muted)]">(已禁用)</span>
                          )}
                        </span>

                        {/* Actions */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {isMods && (
                            <button
                              type="button"
                              onClick={() => toggleModDisabled(entry.name, entry.disabled ?? false)}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                              title={entry.disabled ? "启用模组" : "禁用模组"}
                            >
                              {entry.disabled ? <Check size={12} /> : <Ban size={12} />}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => deleteEntry(activeTab, entry.name)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--accent-danger)]/10 hover:text-[var(--accent-danger)]"
                            title="删除"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>
        );
      })()}
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
    <span className="rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
      {children}
    </span>
  );
}
