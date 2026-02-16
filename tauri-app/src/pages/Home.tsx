import { Calendar, Check, ChevronRight, Play, Users, X, Zap } from "lucide-react";
import { createPortal } from "react-dom";
import { useState } from "react";
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-[var(--text-primary)]">
              {t("home.welcomeBack")}
            </h1>
            <p className="mt-2 text-[var(--text-secondary)]">{t("home.dashboardReady")}</p>
          </div>
          <Card
            variant="frost"
            className="hidden items-center gap-2 rounded-full px-4 py-2 text-xs text-[var(--text-secondary)] xl:flex"
          >
            <Zap size={14} className="text-[var(--mc-grass)]" />
            FPSMaster Launcher
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <section className="xl:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
                <Calendar size={18} className="text-[var(--mc-grass)]" />
                {t("home.latestNews")}
              </h2>
              <button className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
                {t("home.viewAll")}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {NEWS_ITEMS.map((news, index) => (
                <Card
                  as="article"
                  key={news.title}
                  variant="soft"
                  className="group rounded-2xl p-5"
                >
                  <div className="mb-3 inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {t("home.news.tag")}
                  </div>
                  <h3 className="text-lg font-semibold leading-tight text-[var(--text-primary)] transition-colors group-hover:text-[var(--mc-grass)]">
                    {t(NEWS_TITLE_KEYS[index] ?? "home.news.0.title") || news.title}
                  </h3>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    {t(NEWS_SUMMARY_KEYS[index] ?? "home.news.0.summary") || news.summary}
                  </p>
                </Card>
              ))}
            </div>
          </section>

          <section className="space-y-6">
            <Card variant="frost" className="rounded-2xl p-2">
              <div className="mb-1 px-2 py-2">
                <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
                  <Users size={18} className="text-[var(--mc-grass)]" />
                  {t("home.topServers")}
                </h2>
              </div>
              {RECOMMENDED_SERVERS.map((server) => (
                <button
                  key={server.address}
                  className="linear-float mb-1 flex w-full items-center rounded-xl border border-transparent px-3 py-3 text-left transition-all duration-[var(--duration-normal)] hover:border-[var(--border-subtle)] hover:bg-[var(--surface-soft)]"
                  type="button"
                >
                  <div className="h-9 w-9 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                    {server.iconPath ? (
                      <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="ml-3 min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                      {server.name}
                    </p>
                    <p className="truncate text-xs text-[var(--text-muted)]">{server.address}</p>
                  </div>
                  <span className="rounded-md border border-[var(--border-medium)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                    {server.mode}
                  </span>
                </button>
              ))}
              <button className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
                {t("home.moreServers")} <ChevronRight size={12} />
              </button>
            </Card>
          </section>
        </div>
      </div>

      <div className="h-24 shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/62 px-8 backdrop-blur-xl">
        <div className="flex h-full items-center justify-between gap-6">
          <div className="relative group">
            <Card
              as="button"
              variant="soft"
              className="linear-float flex min-w-[250px] items-center gap-3 rounded-xl px-3 py-2 text-left"
              onClick={() => setPickerOpen(true)}
              type="button"
            >
              <div className="h-10 w-10 overflow-hidden rounded-xl border border-[var(--border-medium)] bg-[var(--bg-elevated)]">
                {selectedInstanceIcon ? (
                  <img
                    src={selectedInstanceIcon}
                    alt={selectedInstance?.name ?? "instance"}
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-[var(--text-muted)]">{t("home.selectedInstance")}</p>
                <div className="flex items-center gap-1">
                  <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                    {selectedInstance ? selectedInstance.name : t("home.noInstance")}
                  </p>
                  <ChevronRight size={14} className="text-[var(--text-muted)]" />
                </div>
              </div>
            </Card>

          </div>

          <div className="min-w-[220px]">
            <Button
              variant="primary"
              size="xl"
              className="w-full"
              disabled={busy || !selectedInstance}
              launchProgress={launching}
              launchProgressPercent={launchProgressPercent}
              onClick={onLaunch}
            >
              <span className="flex items-center gap-3">
                <Play fill="currentColor" size={18} />
                {launching
                  ? `${t("home.launching")}${typeof launchProgressPercent === "number" ? ` ${launchProgressPercent}%` : ""}`
                  : t("home.launch")}
              </span>
            </Button>
            <p className="mt-1.5 min-h-[16px] text-[11px] text-[var(--text-muted)] truncate">
              {launching ? (launchProgressText || t("launch.progress.preparing")) : ""}
            </p>
          </div>
        </div>
      </div>

      {pickerOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--bg-primary)]/62 p-6 backdrop-blur-xl">
            <Card
              variant="frost"
              className="flex h-[78vh] w-full max-w-5xl min-h-[480px] max-h-[760px] flex-col rounded-2xl p-6"
            >
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-semibold text-[var(--text-primary)]">
                    {t("home.instancePickerTitle")}
                  </h3>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t("home.instancePickerSubtitle")}
                  </p>
                </div>
                <button
                  className="linear-float rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  onClick={() => setPickerOpen(false)}
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
                {availableInstances.map((instance) => {
                  const active = selectedInstance?.id === instance.id;
                  const icon = resolveInstanceIconPath(instance);
                  return (
                    <Card
                      as="button"
                      key={instance.id}
                      onClick={() => {
                        onSelect(instance.id);
                        setPickerOpen(false);
                      }}
                      variant={active ? "strong" : "soft"}
                      className={`h-[172px] rounded-2xl p-4 text-left transition-all ${
                        active
                          ? "border-[rgba(var(--accent-rgb),0.28)] shadow-[0_0_0_1px_rgba(var(--accent-rgb),var(--linear-hover-ring)),0_0_18px_rgba(var(--accent-rgb),var(--linear-hover-halo))]"
                          : ""
                      }`}
                      type="button"
                    >
                      <div className="mb-3 flex items-center justify-between">
                        <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
                          {instance.loader}
                        </span>
                        {active && <Check size={14} className="text-[var(--mc-grass)]" />}
                      </div>
                      <div className="mb-3 h-11 w-11 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                        {icon ? (
                          <img src={icon} alt={instance.name} className="h-full w-full object-cover" />
                        ) : null}
                      </div>
                      <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{instance.name}</p>
                      <p className="mt-1 font-mono text-xs text-[var(--text-muted)]">{instance.versionId}</p>
                      <div className="mt-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-soft)] px-2.5 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                          {t("instances.base")}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{instance.baseVersion}</p>
                      </div>
                    </Card>
                  );
                })}
              </div>

              <div className="mt-5 flex justify-end">
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
