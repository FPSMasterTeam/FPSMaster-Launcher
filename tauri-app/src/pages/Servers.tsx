import { memo, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Search, Server as ServerIcon } from "lucide-react";
import { useI18n } from "../i18n";
import Button from "../components/Button";
import Card from "../components/Card";
import ServerDialog from "../components/ServerDialog";
import type { Instance, ServerItem } from "../types";

const SERVERS_PER_PAGE = 12;

type ServersPageProps = {
  servers: ServerItem[];
  currentInstance: Instance | null;
  busy: boolean;
  launching: boolean;
  launchProgressPercent: number | null;
  launchProgressText: string;
  onLaunch: (serverAddress: string) => void;
  onRefreshServers: () => void;
};

// Partner servers come with an optional curated ordering; entries that carry a
// displayOrder rank first, everything else falls back to name order.
function sortServers(items: ServerItem[]): ServerItem[] {
  return [...items].sort((a, b) => {
    const aOrder = typeof a.displayOrder === "number" ? a.displayOrder : Number.POSITIVE_INFINITY;
    const bOrder = typeof b.displayOrder === "number" ? b.displayOrder : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });
}

function ServersPage({
  servers,
  currentInstance,
  busy,
  launching,
  launchProgressPercent,
  launchProgressText,
  onLaunch,
  onRefreshServers
}: ServersPageProps) {
  const { t } = useI18n();
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerItem | null>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const names = new Set<string>();
    for (const server of servers) {
      names.add(server.serverGroup || t("servers.uncategorized"));
    }
    return Array.from(names).sort();
  }, [servers, t]);

  const filteredServers = useMemo(() => {
    let list = servers;
    if (selectedGroup !== null) {
      list = list.filter((server) => (server.serverGroup || t("servers.uncategorized")) === selectedGroup);
    }
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      list = list.filter((server) =>
        [server.name, server.address, server.description ?? "", server.serverGroup ?? "", server.mode]
          .join("\n")
          .toLowerCase()
          .includes(keyword)
      );
    }
    return sortServers(list);
  }, [servers, selectedGroup, query, t]);

  const totalPages = Math.max(1, Math.ceil(filteredServers.length / SERVERS_PER_PAGE));
  // A refresh (or a narrower filter) can shrink the page count while the user
  // sits on a late page; clamp instead of showing an empty page.
  const safePage = Math.min(currentPage, totalPages);
  const paginatedServers = useMemo(() => {
    const start = (safePage - 1) * SERVERS_PER_PAGE;
    return filteredServers.slice(start, start + SERVERS_PER_PAGE);
  }, [filteredServers, safePage]);

  const handleGroupChange = (group: string | null) => {
    setSelectedGroup(group);
    setCurrentPage(1);
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setCurrentPage(1);
  };

  const closeDialog = () => {
    setDialogClosing(true);
    setTimeout(() => {
      setSelectedServer(null);
      setDialogClosing(false);
    }, 150);
  };

  const handleLaunch = () => {
    if (!selectedServer || busy) return;
    closeDialog();
    onLaunch(selectedServer.address);
  };

  const hasAnyServers = servers.length > 0;
  const hasMatches = filteredServers.length > 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="page-shell flex-1">
        <header className="page-header mb-6">
          <div className="page-header-main">
            <p className="page-eyebrow">{t("servers.count", { count: servers.length })}</p>
            <h1 className="page-title">{t("servers.title")}</h1>
            <p className="page-subtitle">{t("servers.subtitle")}</p>
          </div>
          <div className="page-header-actions">
            <Button
              variant="secondary"
              size="md"
              className="gap-2"
              disabled={busy}
              onClick={onRefreshServers}
            >
              <RefreshCw size={15} />
              {t("servers.refresh")}
            </Button>
          </div>
        </header>

        <div className="mb-4">
          <label className="search-field w-full max-w-md">
            <Search className="search-field-icon" size={16} />
            <input
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              type="text"
              placeholder={t("servers.searchPlaceholder")}
              aria-label={t("servers.searchPlaceholder")}
              className="ui-input"
            />
          </label>
        </div>

        {groups.length > 1 && (
          <div className="mb-5 flex flex-wrap gap-2">
            <button
              className={`segment-chip !min-h-9 ${selectedGroup === null ? "is-active" : ""}`}
              type="button"
              onClick={() => handleGroupChange(null)}
            >
              {t("servers.allGroups")}
            </button>
            {groups.map((group) => (
              <button
                key={group}
                className={`segment-chip !min-h-9 ${selectedGroup === group ? "is-active" : ""}`}
                type="button"
                onClick={() => handleGroupChange(group)}
              >
                {group}
              </button>
            ))}
          </div>
        )}

        {launching && (
          <div className="notice notice-accent mb-5">
            <RefreshCw size={16} className="mt-0.5 shrink-0 animate-spin text-[var(--accent)]" />
            <div className="min-w-0">
              <p className="notice-text !mt-0">
                {t("servers.launchingStatus")}
                {launchProgressPercent != null && (
                  <span className="text-data"> · {launchProgressPercent}%</span>
                )}
              </p>
              {launchProgressText && (
                <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{launchProgressText}</p>
              )}
            </div>
          </div>
        )}

        {hasMatches ? (
          <>
            <Card variant="soft" className="page-card rounded-[10px]" interactive={false}>
              <div className="surface-list">
                {paginatedServers.map((server) => {
                  const groupLabel = server.serverGroup || t("servers.uncategorized");
                  return (
                    <button
                      key={server.id ?? server.address}
                      className="surface-list-item w-full text-left"
                      type="button"
                      onClick={() => setSelectedServer(server)}
                    >
                      <div className="icon-tile h-12 w-12 rounded-[8px]">
                        {server.iconUrl ? (
                          <img src={server.iconUrl} alt={server.name} className="h-full w-full object-cover" />
                        ) : server.iconPath ? (
                          <img src={server.iconPath} alt={server.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-base font-semibold text-[var(--text-secondary)]">
                            {server.name.slice(0, 1)}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-base font-semibold text-[var(--text-primary)]">{server.name}</p>
                          {server.mode && (
                            <span className="badge badge-accent normal-case tracking-normal">{server.mode}</span>
                          )}
                          {selectedGroup === null && server.serverGroup && (
                            <span className="badge badge-muted normal-case tracking-normal">{groupLabel}</span>
                          )}
                        </div>
                        <p className="text-data truncate text-sm text-[var(--text-muted)]">{server.address}</p>
                        {server.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{server.description}</p>
                        )}
                      </div>
                      <ArrowRight size={18} className="shrink-0 text-[var(--text-muted)]" />
                    </button>
                  );
                })}
              </div>
            </Card>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={safePage === 1}
                  onClick={() => setCurrentPage(Math.max(1, safePage - 1))}
                >
                  <ArrowLeft size={16} />
                </Button>
                <span className="text-data text-sm text-[var(--text-secondary)]">
                  {safePage} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={safePage === totalPages}
                  onClick={() => setCurrentPage(Math.min(totalPages, safePage + 1))}
                >
                  <ArrowRight size={16} />
                </Button>
              </div>
            )}
          </>
        ) : hasAnyServers ? (
          <div className="empty-state min-h-[300px]">
            <Search size={42} className="empty-state-icon" />
            <p className="empty-state-title">{t("servers.noMatches")}</p>
            <p className="empty-state-text">{t("servers.noMatchesText")}</p>
          </div>
        ) : (
          <div className="empty-state min-h-[300px]">
            <ServerIcon size={42} className="empty-state-icon" />
            <p className="empty-state-title">{t("servers.noServers")}</p>
            <p className="empty-state-text">{t("servers.noServersText")}</p>
          </div>
        )}
      </div>

      <ServerDialog
        server={selectedServer}
        closing={dialogClosing}
        onClose={closeDialog}
        onLaunch={handleLaunch}
        currentInstance={currentInstance}
        busy={busy}
        launching={launching}
        launchProgressPercent={launchProgressPercent}
      />
    </div>
  );
}

export default memo(ServersPage);
