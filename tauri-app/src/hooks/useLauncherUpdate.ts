import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LAUNCHER_API_BASE_URL } from "../constants";
import type { TranslationKey } from "../i18n";
import { describeApiError, formatLaunchError, isLauncherAppUpdateMissing } from "../lib/launcherError";
import { notifyError } from "../lib/toast";
import type { DownloadedLauncherUpdate, LauncherAppUpdateChannel, LauncherAppUpdateInfo } from "../types";
import { compareMajor } from "../utils/launcher";
import { IS_WINDOWS } from "../utils/platform";

type LauncherAppUpdateProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

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
  progressPercent: number | null;
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
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
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
    } catch (error) {
      // Channels drive the update-channel picker in settings. Failing silently
      // left the picker mysteriously empty with no way to tell why.
      setChannels([]);
      setStatus(t("app.status.failed", { error: describeApiError(error, t) }));
    }
  }, [token, setStatus, t]);

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
        const rawText = formatLaunchError(error);
        if (isLauncherAppUpdateMissing(rawText)) {
          setAppUpdate(null);
          setDownload(null);
        } else {
          const errorText = describeApiError(error, t);
          setStatus(t("app.status.failed", { error: errorText }));
          if (!silent) {
            notifyError(errorText, t("toast.title.updateFailed"));
          }
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
    setProgressPercent(null);
    let completed = false;
    let stopProgressListener: (() => void) | undefined;
    try {
      setStatus(t("settings.launcherUpdateDownloading", { version: appUpdate.version }));
      stopProgressListener = await listen<LauncherAppUpdateProgress>(
        "launcher-app-update-progress",
        ({ payload }) => {
          if (typeof payload.percent === "number") {
            setProgressPercent(payload.percent);
            setStatus(t("settings.launcherUpdateDownloadingProgress", { percent: payload.percent }));
          }
        }
      );
      const downloaded = await invoke<DownloadedLauncherUpdate>("download_launcher_app_update", {
        downloadUrl: appUpdate.downloadUrl,
        version: appUpdate.version,
        checksum: appUpdate.checksum
      });
      setDownload(downloaded);
      completed = true;
      await invoke("open_downloaded_file", { filePath: downloaded.filePath });
      setStatus(t("settings.launcherUpdateInstallerOpened", { file: downloaded.fileName }));
      if (IS_WINDOWS) {
        await flushTelemetry();
        await invoke("quit_launcher_app");
      }
    } catch (error) {
      const errorText = describeApiError(error, t);
      setStatus(t("app.status.failed", { error: errorText }));
      notifyError(errorText, t("toast.title.updateFailed"));
    } finally {
      stopProgressListener?.();
      if (!completed) setProgressPercent(null);
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
    progressPercent,
    download,
    available,
    mandatoryRequired,
    refresh,
    refreshChannels,
    install
  };
}
