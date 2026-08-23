import { invoke } from "@tauri-apps/api/core";
import { Archive, ArrowLeft, Copy, Eye, File, Folder, FolderOpen, Layers, MoreHorizontal, RefreshCw, Trash2, Ban, Check } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { resolvePresetVersionId } from "../constants";
import { useI18n } from "../i18n";
import { novaVersionIdFor } from "../lib/novaTargets";
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
  onUpdateInstance: (next: Instance) => void;
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

function InstanceSettingsPage({
  instance,
  gameDir,
  busy,
  onBack,
  onRepair,
  onDelete,
  onDuplicate,
  onExport,
  onUpdateInstance
}: InstanceSettingsPageProps) {
  const { t } = useI18n();
  const [sections, setSections] = useState<Record<InstanceSection, SectionState>>(emptySectionState);
  const [activeTab, setActiveTab] = useState<InstanceSection>("saves");
  // Nova uses per-game-version profiles (FPSMaster-Nova-<gv>); other presets keep their static ids.
  const effectiveVersionId = !instance
    ? ""
    : instance.preset && instance.launcherVersionType === "NOVA"
      ? novaVersionIdFor(instance.baseVersion)
      : instance.preset
        ? (resolvePresetVersionId(instance.id) ?? instance.versionId)
        : instance.versionId;
  const useForgeEnabled = instance?.useForge !== false;
  const useOptiFineEnabled = instance?.useOptiFine !== false;

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
        versionId: effectiveVersionId,
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
    if (!window.confirm(t("instanceFiles.deleteConfirm", { name: entryName }))) return;
    try {
      await invoke("delete_instance_section_entry", {
        gameDir,
        versionId: effectiveVersionId,
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
        versionId: effectiveVersionId,
        modName: entryName,
        disable: !currentlyDisabled
      });
      // Refresh the mods section after toggling
      await refreshSection("mods", effectiveVersionId);
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

  function toggleUseForge() {
    if (!instance) return;
    const nextUseForge = instance.useForge === false;
    onUpdateInstance({ ...instance, useForge: nextUseForge });
  }

  function toggleUseOptiFine() {
    if (!instance) return;
    const nextUseOptiFine = instance.useOptiFine === false;
    onUpdateInstance({ ...instance, useOptiFine: nextUseOptiFine });
  }

  useEffect(() => {
    if (!instance) {
      setSections(emptySectionState());
      return;
    }

    let cancelled = false;
    const currentVersionId = effectiveVersionId;
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
  }, [effectiveVersionId, instance, gameDir, t]);

  if (!instance) {
    return (
      <div className="page-shell">
        <Card variant="frost" className="page-card max-w-xl rounded-[10px]" interactive={false}>
          <h1 className="page-title !mt-0 !text-[28px]">{t("instanceFiles.title")}</h1>
          <p className="page-subtitle">{t("instanceFiles.noInstance")}</p>
          <div className="mt-5">
            <Button variant="secondary" size="sm" className="gap-2 !rounded-[10px]" onClick={onBack}>
              <ArrowLeft size={14} />
              {t("instanceFiles.back")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <header className="page-header mb-6">
        <div className="page-header-main">
          <p className="page-eyebrow">{t("instanceFiles.title")}</p>
          <h1 className="page-title">
            {instance.launcherVersionType === "NOVA"
              ? `Nova ${instance.baseVersion}`
              : instance.name}
          </h1>
          <p className="page-subtitle">
            {t("instanceFiles.subtitle", {
              name:
                instance.launcherVersionType === "NOVA"
                  ? `Nova ${instance.baseVersion}`
                  : instance.name
            })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <MetaBadge>{instance.baseVersion}</MetaBadge>
            <MetaBadge>{loaderLabel(instance.loader, t)}</MetaBadge>
            {instance.launcherVersionType && <MetaBadge>{instance.launcherVersionType}</MetaBadge>}
          </div>
        </div>
        <div className="page-header-actions">
          <Button variant="outline" size="sm" className="gap-2 !rounded-[10px]" disabled={busy} onClick={onRepair}>
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            {t("instanceFiles.repair")}
          </Button>
          <Button variant="outline" size="sm" className="gap-2 !rounded-[10px]" disabled={busy} onClick={onDuplicate}>
            <Copy size={14} />
            {t("instances.copy")}
          </Button>
          <Button variant="outline" size="sm" className="gap-2 !rounded-[10px]" disabled={busy} onClick={onExport}>
            <Archive size={14} />
            {t("instances.export")}
          </Button>
          <Button variant="danger" size="sm" className="gap-2 !rounded-[10px]" disabled={busy || instance?.preset} onClick={onDelete}>
            <Trash2 size={14} />
            {t("instances.delete")}
          </Button>
          <Button variant="secondary" size="sm" className="gap-2 !rounded-[10px]" onClick={onBack}>
            <ArrowLeft size={14} />
            {t("instanceFiles.back")}
          </Button>
        </div>
      </header>

      {instance.launcherVersionType === "EDGE" && (
        <Card variant="frost" className="page-card mb-6 rounded-[10px]" interactive={false}>
          <div className="section-header !mb-3">
            <div className="section-header-main">
              <h2 className="section-title">{t("instanceFiles.edgeOptions")}</h2>
              <p className="section-subtitle">{t("instanceFiles.edgeOptionsSubtitle")}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={toggleUseForge}
              disabled={busy}
              className={`surface-panel flex w-full items-center justify-between gap-3 rounded-[10px] px-4 py-4 text-left transition-all duration-[var(--duration-normal)] ${
                useForgeEnabled
                  ? "border-[rgba(var(--accent-rgb),0.3)] bg-[rgba(var(--accent-rgb),0.1)]"
                  : "hover:border-[var(--border-medium)] hover:bg-[rgba(255,255,255,0.05)]"
              }`}
            >
              <span className="flex items-center gap-3">
                <Layers size={22} className="text-amber-400" />
                <span>
                  <span className="block text-sm font-semibold text-[var(--text-primary)]">{t("loader.forge")}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{t("instanceFiles.useForgeHint")}</span>
                </span>
              </span>
              <span className={`badge rounded-[5px] px-3 py-1 text-xs ${useForgeEnabled ? "badge-accent" : "badge-muted"}`}>
                {useForgeEnabled ? t("install.enabled") : t("install.disabled")}
              </span>
            </button>
            <button
              type="button"
              onClick={toggleUseOptiFine}
              disabled={busy}
              className={`surface-panel flex w-full items-center justify-between gap-3 rounded-[10px] px-4 py-4 text-left transition-all duration-[var(--duration-normal)] ${
                useOptiFineEnabled
                  ? "border-[rgba(var(--accent-rgb),0.3)] bg-[rgba(var(--accent-rgb),0.1)]"
                  : "hover:border-[var(--border-medium)] hover:bg-[rgba(255,255,255,0.05)]"
              }`}
            >
              <span className="flex items-center gap-3">
                <Eye size={22} className="text-lime-300" />
                <span>
                  <span className="block text-sm font-semibold text-[var(--text-primary)]">{t("loader.optifine")}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{t("instanceFiles.useOptiFineHint")}</span>
                </span>
              </span>
              <span className={`badge rounded-[5px] px-3 py-1 text-xs ${useOptiFineEnabled ? "badge-accent" : "badge-muted"}`}>
                {useOptiFineEnabled ? t("install.enabled") : t("install.disabled")}
              </span>
            </button>
          </div>
          <p className="mt-3 text-xs text-[var(--text-muted)]">{t("instanceFiles.edgeOptionsNote")}</p>
        </Card>
      )}

      {/* Tab Navigation */}
      <div className="segment-control mb-6 flex items-center gap-2 overflow-x-auto rounded-[10px] pb-1">
        {SECTIONS.map((section) => {
          const isActive = activeTab === section.id;
          const state = sections[section.id];
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveTab(section.id)}
              className={`segment-chip relative shrink-0 ${isActive ? "is-active" : ""}`}
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
          <Card variant="frost" className="page-card rounded-[10px]" interactive={false}>
            <div className="section-header">
              <div className="section-header-main">
                <h2 className="section-title">{sectionLabel(activeTab)}</h2>
                <p className="section-subtitle">{effectiveVersionId}</p>
              </div>
              <div className="section-toolbar">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 !rounded-[10px]"
                  disabled={state.loading}
                  onClick={() => void refreshSection(activeTab, effectiveVersionId)}
                >
                  <RefreshCw size={14} className={state.loading ? "animate-spin" : ""} />
                  {t("instanceFiles.refresh")}
                </Button>
                <Button variant="secondary" size="sm" className="gap-1 !rounded-[10px]" onClick={() => void openSection(activeTab)}>
                  <FolderOpen size={14} />
                  {t("instanceFiles.openFolder")}
                </Button>
              </div>
            </div>

            {state.loading ? (
              <p className="text-sm text-[var(--text-secondary)]">{t("instanceFiles.loading")}</p>
            ) : state.error ? (
              <div className="notice notice-danger">
                <div>
                  <p className="notice-text !mt-0 break-all">{state.error}</p>
                </div>
              </div>
            ) : state.entries.length === 0 ? (
              <div className="empty-state min-h-[220px]">
                <FolderOpen size={32} className="empty-state-icon" />
                <p className="empty-state-text !mt-0">{t("instanceFiles.empty")}</p>
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto">
                <ul className="grid grid-cols-1 gap-2">
                  {state.entries.map((entry) => {
                    const isMods = activeTab === "mods";
                    return (
                      <li
                        key={entry.name}
                        className={`surface-panel group relative flex items-center gap-2 rounded-[8px] px-3 py-2.5 transition-colors ${
                          entry.disabled
                            ? "opacity-60"
                            : "hover:border-[var(--border-medium)]"
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
    <span className="badge badge-muted rounded-[5px] px-2 py-1 text-[10px]">
      {children}
    </span>
  );
}

export default memo(InstanceSettingsPage);
