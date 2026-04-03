import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Play, Server as ServerIcon, Users, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import Button from "../components/Button";
import Card from "../components/Card";
import type {
  Instance,
  LauncherUser,
  ServerItem,
  TelemetryOnlineSummary
} from "../types";

const SERVERS_PER_PAGE = 12;

type ServersPageProps = {
  servers: ServerItem[];
  currentInstance: Instance | null;
  busy: boolean;
  launching: boolean;
  launchProgressPercent: number | null;
  launchProgressText: string;
  user: LauncherUser | null;
  onLaunch: (serverAddress: string) => void;
  onRefreshServers: () => void;
};

export default function ServersPage({
  servers,
  currentInstance,
  busy,
  launching,
  launchProgressPercent,
  launchProgressText,
  user,
  onLaunch,
  onRefreshServers
}: ServersPageProps) {
  const { t } = useI18n();
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerItem | null>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  // Group servers by serverGroup
  const groupedServers = useMemo(() => {
    const groups = new Map<string, ServerItem[]>();
    for (const server of servers) {
      const group = server.serverGroup || t("servers.uncategorized");
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(server);
    }
    return groups;
  }, [servers, t]);

  // Get list of groups
  const groups = useMemo(() => {
    return Array.from(groupedServers.keys()).sort();
  }, [groupedServers]);

  // Get servers for selected group
  const groupServers = useMemo(() => {
    if (selectedGroup === null) {
      return servers;
    }
    return servers.filter(s => (s.serverGroup || t("servers.uncategorized")) === selectedGroup);
  }, [servers, selectedGroup, t]);

  // Pagination
  const totalPages = Math.ceil(groupServers.length / SERVERS_PER_PAGE);
  const paginatedServers = useMemo(() => {
    const start = (currentPage - 1) * SERVERS_PER_PAGE;
    const end = start + SERVERS_PER_PAGE;
    return groupServers.slice(start, end);
  }, [groupServers, currentPage]);

  // Reset to page 1 when group changes
  const handleGroupChange = (group: string | null) => {
    setSelectedGroup(group);
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="page-shell flex-1">
        <header className="page-header mb-6">
          <div className="page-header-main">
            <p className="page-eyebrow">FPSMaster Launcher</p>
            <h1 className="page-title">{t("servers.title")}</h1>
            <p className="page-subtitle">{t("servers.subtitle")}</p>
          </div>
        </header>

        {/* Group Filter */}
        <div className="mb-5 flex gap-2 flex-wrap">
          <button
            className={`segment-chip !min-h-9 ${selectedGroup === null ? "is-active" : ""}`}
            type="button"
            onClick={() => handleGroupChange(null)}
          >
            {t("servers.allGroups")}
          </button>
          {groups.map(group => (
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

        {/* Server List */}
        <Card variant="soft" className="page-card rounded-[20px]" interactive={false}>
          <div className="surface-list">
            {paginatedServers.map((server) => (
              <button
                key={server.id ?? server.address}
                className="surface-list-item w-full text-left"
                type="button"
                onClick={() => setSelectedServer(server)}
              >
                <div className="icon-tile h-12 w-12 rounded-[16px]">
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
                  <p className="truncate text-base font-semibold text-[var(--text-primary)]">{server.name}</p>
                  <p className="truncate text-sm text-[var(--text-muted)]">{server.address}</p>
                  {server.description && (
                    <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{server.description}</p>
                  )}
                </div>
                <ArrowRight size={18} className="shrink-0 text-[var(--text-muted)]" />
              </button>
            ))}
          </div>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >
              <ArrowLeft size={16} />
            </Button>
            <span className="text-sm text-[var(--text-secondary)]">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            >
              <ArrowRight size={16} />
            </Button>
          </div>
        )}

        {groupServers.length === 0 && (
          <div className="empty-state min-h-[300px]">
            <ServerIcon size={42} className="empty-state-icon" />
            <p className="empty-state-title">{t("servers.noServers")}</p>
            <p className="empty-state-text">{t("servers.noServersText")}</p>
          </div>
        )}
      </div>

      {/* Server Detail Dialog */}
      {(selectedServer || dialogClosing) &&
        typeof document !== "undefined" &&
        createPortal(
          <div className={`modal-shell ${dialogClosing ? "modal-backdrop-animate-out" : "modal-backdrop-animate"}`} onClick={closeDialog}>
            <Card
              variant="strong"
              className={`${dialogClosing ? "modal-animate-out" : "modal-animate"} modal-card page-card w-full max-w-2xl`}
              interactive={false}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="icon-tile h-16 w-16 rounded-[20px] shrink-0">
                    {selectedServer?.iconUrl ? (
                      <img src={selectedServer.iconUrl} alt={selectedServer.name} className="h-full w-full object-cover" />
                    ) : selectedServer?.iconPath ? (
                      <img src={selectedServer.iconPath} alt={selectedServer.name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-xl font-bold text-[var(--text-secondary)]">
                        {selectedServer?.name.slice(0, 1)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="page-eyebrow">{t("servers.serverDetail")}</p>
                    <h3 className="page-title !mt-1 !text-[28px] truncate">{selectedServer?.name}</h3>
                    <p className="mt-1 text-sm text-[var(--text-muted)] truncate">{selectedServer?.address}</p>
                  </div>
                </div>
                <button
                  className="modal-close"
                  onClick={closeDialog}
                  type="button"
                  aria-label={t("servers.close")}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="modal-body">
                {selectedServer?.description && (
                  <div className="mb-4">
                    <p className="text-sm leading-6 text-[var(--text-secondary)]">{selectedServer.description}</p>
                  </div>
                )}

                {selectedServer?.detailedDescription && (
                  <div className="surface-panel surface-panel-soft rounded-[20px] p-4 mb-4">
                    <p className="text-sm leading-6 text-[var(--text-secondary)] whitespace-pre-wrap">{selectedServer.detailedDescription}</p>
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="primary"
                    size="lg"
                    className="flex-1 min-h-[48px] justify-center"
                    disabled={busy || launching}
                    launchProgress={launching}
                    launchProgressPercent={launchProgressPercent}
                    onClick={handleLaunch}
                  >
                    <span className="flex flex-col items-center justify-center gap-1 text-center leading-tight">
                      <span className="flex items-center justify-center gap-2">
                        <Play fill="currentColor" size={16} />
                        {launching
                          ? `${t("home.launching")}${typeof launchProgressPercent === "number" ? ` ${launchProgressPercent}%` : ""}`
                          : t("servers.quickLaunch")
                        }
                      </span>
                      {currentInstance && !launching && (
                        <span className="text-xs text-white/80">
                          {currentInstance.name}
                        </span>
                      )}
                    </span>
                  </Button>

                  <Button
                    variant="secondary"
                    size="lg"
                    className="min-h-[48px] px-5"
                    title={t("servers.addToServerList")}
                  >
                    <ExternalLink size={16} />
                  </Button>
                </div>
              </div>
            </Card>
          </div>,
          document.body
        )}
    </div>
  );
}
