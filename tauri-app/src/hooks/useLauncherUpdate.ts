import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LAUNCHER_API_BASE_URL } from "../constants";
import type { TranslationKey } from "../i18n";
import { formatLaunchError, isLauncherAppUpdateMissing } from "../lib/launcherError";
import type { DownloadedLauncherUpdate, LauncherAppUpdateChannel, LauncherAppUpdateInfo } from "../types";
import { compareMajor } from "../utils/launcher";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

type UseLauncherUpdateDeps = {
  token: string | null;
  channel: string;
  currentLauncherVersion: string;
  t: Translator;
  setStatus: (status: string) => void;
  flushTelemetry: () => Promise<void>;
};

export type LauncherUpdateController = {
  appUpdate: LauncherAppUpdateInfo | null;
  channels: LauncherAppUpdateChannel[];
  checking: boolean;
  downloading: boolean;
  download: DownloadedLauncherUpdate | null;
  available: boolean;
  mandatoryRequired: boolean;
  refresh: (silent?: boolean) => Promise<void>;
  refreshChannels: () => Promise<void>;
  install: () => Promise<void>;
};

// Owns the launcher self-update domain: checking for new versions, listing
// channels, and downloading/launching the installer.
export function useLauncherUpdate(deps: UseLauncherUpdateDeps): LauncherUpdateController {
  const { token, channel, currentLauncherVersion, t, setStatus, flushTelemetry } = deps;

  const [appUpdate, setAppUpdate] = useState<LauncherAppUpdateInfo | null>(null);
  const [channels, setChannels] = useState<LauncherAppUpdateChannel[]>([]);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [download, setDownload] = useState<DownloadedLauncherUpdate | null>(null);

  const available = useMemo(
    () => appUpdate !== null && compareMajor(appUpdate.version, currentLauncherVersion) > 0,
    [appUpdate, currentLauncherVersion]
  );
  const mandatoryRequired = available && Boolean(appUpdate?.mandatory);

  const refreshChannels = useCallback(async () => {
    try {
      const items = await invoke<LauncherAppUpdateChannel[]>("launcher_list_app_update_channels", {
        baseUrl: LAUNCHER_API_BASE_URL,
        token: token ?? null
      });
      setChannels(items);
    } catch {
      setChannels([]);
    }
  }, [token]);

  const refresh = useCallback(
    async (silent = false) => {
      setChecking(true);
      try {
        const info = await invoke<LauncherAppUpdateInfo>("launcher_get_app_update", {
          baseUrl: LAUNCHER_API_BASE_URL,
          channel
        });
        setAppUpdate(info);
        setDownload((prev) => (prev?.version === info.version ? prev : null));
        if (!silent) {
          setStatus(
            compareMajor(info.version, currentLauncherVersion) > 0
              ? t("settings.launcherUpdateAvailable", { version: info.version })
              : t("settings.launcherUpToDate")
          );
        }
      } catch (error) {
        const errorText = formatLaunchError(error);
        if (isLauncherAppUpdateMissing(errorText)) {
          setAppUpdate(null);
          setDownload(null);
        } else if (!silent) {
          setStatus(t("app.status.failed", { error: errorText }));
        }
      } finally {
        setChecking(false);
      }
    },
    [channel, currentLauncherVersion, setStatus, t]
  );

  const install = useCallback(async () => {
    if (!appUpdate || !available) {
      return;
    }
    setDownloading(true);
    try {
      setStatus(t("settings.launcherUpdateDownloading", { version: appUpdate.version }));
      const downloaded = await invoke<DownloadedLauncherUpdate>("download_launcher_app_update", {
        downloadUrl: appUpdate.downloadUrl,
        version: appUpdate.version,
        checksum: appUpdate.checksum
      });
      setDownload(downloaded);
      await invoke("open_downloaded_file", { filePath: downloaded.filePath });
      setStatus(t("settings.launcherUpdateInstallerOpened", { file: downloaded.fileName }));
      await flushTelemetry();
      await invoke("quit_launcher_app");
    } catch (error) {
      setStatus(t("app.status.failed", { error: formatLaunchError(error) }));
    } finally {
      setDownloading(false);
    }
  }, [appUpdate, available, flushTelemetry, setStatus, t]);

  // Load channels once, and re-check for updates whenever the channel changes.
  useEffect(() => {
    void refreshChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  return {
    appUpdate,
    channels,
    checking,
    downloading,
    download,
    available,
    mandatoryRequired,
    refresh,
    refreshChannels,
    install
  };
}
