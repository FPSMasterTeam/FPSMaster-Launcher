import { Calendar, Check, ChevronRight, Play, Search, Users, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useMemo, useState } from "react";
import Button from "../components/Button";
import Card from "../components/Card";
import { NEWS_ITEMS, RECOMMENDED_SERVERS } from "../constants";
import { useI18n, type TranslationKey } from "../i18n";
import type { Instance } from "../types";
import { resolveInstanceIconPath } from "../utils/launcher";

const NEWS_TITLE_KEYS: TranslationKey[] = [
  "home.news.0.title",
  "home.news.1.title",
  "home.news.2.title"
];

const NEWS_SUMMARY_KEYS: TranslationKey[] = [
  "home.news.0.summary",
  "home.news.1.summary",
  "home.news.2.summary"
];

type HomePageProps = {
  availableInstances: Instance[];
  current: Instance | null;
  busy: boolean;
  launching: boolean;
  launchProgressPercent: number | null;
  launchProgressText: string;
  onSelect: (id: string) => void;
  onLaunch: () => void;
};

export default function HomePage({
  availableInstances,
  current,
  busy,
  launching,
  launchProgressPercent,
  launchProgressText,
  onSelect,
  onLaunch
}: HomePageProps) {
  const { t } = useI18n();
  const selectedInstance = current ?? availableInstances[0] ?? null;
  const selectedInstanceIcon = selectedInstance ? resolveInstanceIconPath(selectedInstance) : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const filteredInstances = useMemo(() => {
    const keyword = pickerQuery.trim().toLowerCase();
    if (keyword === "") return availableInstances;
    return availableInstances.filter((instance) => {
      return (
        instance.name.toLowerCase().includes(keyword) ||
        instance.versionId.toLowerCase().includes(keyword) ||
        instance.baseVersion.toLowerCase().includes(keyword) ||
        instance.loader.toLowerCase().includes(keyword)
      );
    });
  }, [availableInstances, pickerQuery]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 md:p-5 xl:p-6">
        <section className="mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">FPSMaster Launcher</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)] md:text-3xl">{t("home.welcomeBack")}</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)] md:text-[15px]">{t("home.dashboardReady")}</p>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.92fr)]">
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
                <Calendar size={16} className="text-[var(--mc-grass)]" />
                {t("home.latestNews")}
              </h2>
              <button className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" type="button">
                {t("home.viewAll")}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {NEWS_ITEMS.map((news, index) => (
                <Card as="article" key={news.title} variant="soft" className="group rounded-xl p-4">
                  <div className="mb-2 inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {t("home.news.tag")}
                  </div>
                  <h3 className="text-base font-semibold leading-tight text-[var(--text-primary)] transition-colors group-hover:text-[var(--mc-grass)]">
                    {t(NEWS_TITLE_KEYS[index] ?? "home.news.0.title") || news.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-6 text-[var(--text-secondary)]">
                    {t(NEWS_SUMMARY_KEYS[index] ?? "home.news.0.summary") || news.summary}
                  </p>
                </Card>
              ))}
            </div>
          </div>

          <Card variant="frost" className="rounded-xl p-3.5 md:p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              <Users size={16} className="text-[var(--mc-grass)]" />
              {t("home.topServers")}
            </h2>
            <div className="space-y-1.5">
              {RECOMMENDED_SERVERS.map((server) => (
                <button
                  key={server.address}
                  className="linear-float flex min-h-11 w-full cursor-pointer items-center rounded-lg border border-transparent px-2.5 py-2 text-left transition-all duration-[var(--duration-normal)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-soft)]"
                  type="button"
                >
                  <div className="h-8 w-8 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                    {server.iconPath ? <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" /> : null}
                  </div>
                  <div className="ml-2.5 min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{server.name}</p>
                    <p className="truncate text-[11px] text-[var(--text-muted)]">{server.address}</p>
                  </div>
                  <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                    {server.mode}
                  </span>
                </button>
              ))}
            </div>
            <button className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" type="button">
              {t("home.moreServers")} <ChevronRight size={12} />
            </button>
          </Card>
        </section>
      </div>

      <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/78 px-4 py-2.5 backdrop-blur-xl md:px-5 xl:px-6">
        <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] md:items-center md:gap-4">
          <button
            className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-3 py-2 text-left transition-colors hover:border-[var(--border-medium)]"
            onClick={() => setPickerOpen(true)}
            type="button"
          >
            <div className="h-9 w-9 overflow-hidden rounded-lg border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
              {selectedInstanceIcon ? <img src={selectedInstanceIcon} alt={selectedInstance?.name ?? "instance"} className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-[var(--text-muted)]">{t("home.selectedInstance")}</p>
              <div className="flex items-center gap-1">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{selectedInstance ? selectedInstance.name : t("home.noInstance")}</p>
                <ChevronRight size={14} className="text-[var(--text-muted)]" />
              </div>
            </div>
          </button>

          <div className="relative flex items-center">
            <Button
              variant="primary"
              size="lg"
              className="w-full justify-center"
              disabled={busy || !selectedInstance}
              launchProgress={launching}
              launchProgressPercent={launchProgressPercent}
              onClick={onLaunch}
            >
              <span className="flex w-full flex-col items-center justify-center text-center leading-tight">
                <span className="flex items-center justify-center gap-2.5">
                  <Play fill="currentColor" size={16} />
                  {launching
                    ? `${t("home.launching")}${typeof launchProgressPercent === "number" ? ` ${launchProgressPercent}%` : ""}`
                    : t("home.launch")}
                </span>
                {launching && (
                  <span className="mt-1 text-[11px] font-medium text-white/85">
                    {launchProgressText || t("launch.progress.preparing")}
                  </span>
                )}
              </span>
            </Button>
          </div>
        </div>
      </footer>

      {pickerOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--bg-primary)]/66 p-4 backdrop-blur-xl">
            <Card variant="strong" className="flex h-[78vh] w-full max-w-4xl min-h-[420px] max-h-[720px] flex-col rounded-2xl p-4 md:p-5" interactive={false}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--text-primary)]">{t("home.instancePickerTitle")}</h3>
                  <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{t("home.instancePickerSubtitle")}</p>
                </div>
                <button
                  className="min-h-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-2 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  onClick={() => setPickerOpen(false)}
                  type="button"
                  aria-label={t("home.instancePickerClose")}
                >
                  <X size={16} />
                </button>
              </div>

              <label className="relative mb-3 block">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={15} />
                <input
                  value={pickerQuery}
                  onChange={(event) => setPickerQuery(event.target.value)}
                  type="text"
                  className="min-h-10 w-full rounded-lg border border-[var(--border-medium)] bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] focus:border-[var(--mc-grass)]/45 focus:outline-none"
                  placeholder={t("instances.searchPlaceholder")}
                />
              </label>

              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="space-y-2">
                  {filteredInstances.map((instance) => {
                    const active = selectedInstance?.id === instance.id;
                    const icon = resolveInstanceIconPath(instance);
                    return (
                      <button
                        key={instance.id}
                        onClick={() => {
                          onSelect(instance.id);
                          setPickerOpen(false);
                        }}
                        type="button"
                        className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                          active
                            ? "border-[rgba(var(--accent-rgb),0.36)] bg-[rgba(var(--accent-rgb),0.14)]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-soft)] hover:border-[var(--border-medium)]"
                        }`}
                      >
                        <div className="h-9 w-9 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                          {icon ? <img src={icon} alt={instance.name} className="h-full w-full object-cover" /> : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{instance.name}</p>
                          <p className="truncate font-mono text-[11px] text-[var(--text-muted)]">{instance.versionId}</p>
                        </div>
                        <div className="hidden text-right sm:block">
                          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t("instances.base")}</p>
                          <p className="text-xs text-[var(--text-secondary)]">{instance.baseVersion}</p>
                        </div>
                        <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                          {instance.loader}
                        </span>
                        {active && <Check size={14} className="text-[var(--mc-grass)]" />}
                      </button>
                    );
                  })}
                </div>
                {filteredInstances.length === 0 && (
                  <p className="pt-3 text-sm text-[var(--text-muted)]">{t("home.noInstance")}</p>
                )}
              </div>

              <div className="mt-3 flex items-center justify-end gap-3">
                <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
                  {t("home.instancePickerClose")}
                </Button>
              </div>
            </Card>
          </div>,
          document.body
        )}
    </div>
  );
}
