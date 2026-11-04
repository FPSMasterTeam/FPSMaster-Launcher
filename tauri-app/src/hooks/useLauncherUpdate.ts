import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TranslationKey } from "../i18n";
import { describeApiError, isCancelledError } from "../lib/launcherError";
import { notifyError, notifyInfo } from "../lib/toast";
import type { DownloadedLauncherUpdate, LauncherAppUpdateInfo } from "../types";
import { compareMajor, createSessionId } from "../utils/launcher";
import { IS_WINDOWS } from "../utils/platform";

type LauncherAppUpdateProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

type UseLauncherUpdateDeps = {
  currentLauncherVersion: string;
  t: Translator;
  setStatus: (status: string) => void;
};

export type LauncherUpdateController = {
  appUpdate: LauncherAppUpdateInfo | null;
  checking: boolean;
  downloading: boolean;
  progressPercent: number | null;
  download: DownloadedLauncherUpdate | null;
  available: boolean;
  refresh: (silent?: boolean) => Promise<void>;
  install: () => Promise<void>;
  /** Stops a running installer download. */
  cancel: () => Promise<void>;
};

// Owns the launcher self-update domain: checking the static release catalog
// (see src-tauri/src/catalog.rs) for a newer build, and downloading/launching
// the installer. Updates are never mandatory any more.
export function useLauncherUpdate(deps: UseLauncherUpdateDeps): LauncherUpdateController {
  const { currentLauncherVersion, t, setStatus } = deps;

  const [appUpdate, setAppUpdate] = useState<LauncherAppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [download, setDownload] = useState<DownloadedLauncherUpdate | null>(null);
  const downloadSessionRef = useRef<string | null>(null);

  const available = useMemo(
    () => appUpdate !== null && compareMajor(appUpdate.version, currentLauncherVersion) > 0,
    [appUpdate, currentLauncherVersion]
  );

  const refresh = useCallback(
    async (silent = false) => {
      setChecking(true);
      try {
        const info = await invoke<LauncherAppUpdateInfo | null>("catalog_get_app_update");
        if (!info) {
          // The catalog lists no build for this platform: nothing to offer.
          setAppUpdate(null);
          setDownload(null);
          if (!silent) {
            setStatus(t("settings.launcherUpToDate"));
          }
          return;
        }
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
        const errorText = describeApiError(error, t);
        setStatus(t("app.status.failed", { error: errorText }));
        if (!silent) {
          notifyError(errorText, t("toast.title.updateFailed"));
        }
      } finally {
        setChecking(false);
      }
    },
    [currentLauncherVersion, setStatus, t]
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
      const sessionId = createSessionId();
      downloadSessionRef.current = sessionId;
      const downloaded = await invoke<DownloadedLauncherUpdate>("download_launcher_app_update", {
        downloadUrl: appUpdate.downloadUrl,
        version: appUpdate.version,
        checksum: appUpdate.checksum,
        ipcSession: sessionId
      });
      setDownload(downloaded);
      completed = true;
      await invoke("open_downloaded_file", { filePath: downloaded.filePath });
      setStatus(t("settings.launcherUpdateInstallerOpened", { file: downloaded.fileName }));
      if (IS_WINDOWS) {
        await invoke("quit_launcher_app");
      }
    } catch (error) {
      if (isCancelledError(error)) {
        setStatus(t("settings.launcherUpdateCancelled"));
        notifyInfo(t("settings.launcherUpdateCancelled"));
      } else {
        const errorText = describeApiError(error, t);
        setStatus(t("app.status.failed", { error: errorText }));
        notifyError(errorText, t("toast.title.updateFailed"));
      }
    } finally {
      downloadSessionRef.current = null;
      stopProgressListener?.();
      if (!completed) setProgressPercent(null);
      setDownloading(false);
    }
  }, [appUpdate, available, setStatus, t]);

  const cancel = useCallback(async () => {
    const sessionId = downloadSessionRef.current;
    if (!sessionId) return;
    try {
      await invoke("cancel_install", { sessionId });
    } catch (error) {
      notifyError(describeApiError(error, t), t("toast.title.updateFailed"));
    }
  }, [t]);

  // Check once on startup; the user can re-check from settings.
  useEffect(() => {
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    appUpdate,
    checking,
    downloading,
    progressPercent,
    download,
    available,
    refresh,
    install,
    cancel
  };
}
