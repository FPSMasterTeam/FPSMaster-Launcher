import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../i18n";
import { loaderLabelKey } from "../lib/instance";
import type { Loader, OptiFineVersion, Page, Settings } from "../types";
import { compareMajor, groupByMajor, isSnapshot, resolveInstallVersion } from "../utils/launcher";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

type UseInstallControllerDeps = {
  page: Page;
  busy: boolean;
  settings: Settings;
  t: Translator;
  setStatus: (status: string) => void;
};

export type InstallController = {
  catalog: string[];
  catalogLoading: boolean;
  loaderLoading: boolean;
  major: string;
  setMajor: (major: string) => void;
  showSnapshots: boolean;
  setShowSnapshots: React.Dispatch<React.SetStateAction<boolean>>;
  installVersion: string;
  setInstallVersion: (version: string) => void;
  loader: Loader;
  setLoader: (loader: Loader) => void;
  loaderOptions: string[];
  loaderVersion: string;
  setLoaderVersion: (version: string) => void;
  optiFineEnabled: boolean;
  setOptiFineEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  optiFineLoading: boolean;
  optiFineOptions: OptiFineVersion[];
  optiFineVersion: string;
  setOptiFineVersion: (version: string) => void;
  installedVersions: string[];
  setInstalledVersions: React.Dispatch<React.SetStateAction<string[]>>;
  grouped: Record<string, string[]>;
  majors: string[];
  majorVersions: string[];
  snapshots: string[];
  installDisabled: boolean;
  installButtonText: string;
  optiFineDisabledReason: string;
};

// Owns the install-wizard domain: version catalog, loader/OptiFine selection,
// and the async lookups that feed the Install page. The install *action* itself
// stays in App since it writes instances/dialogs across domains.
export function useInstallController(deps: UseInstallControllerDeps): InstallController {
  const { page, busy, settings, t, setStatus } = deps;

  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [major, setMajor] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [installVersion, setInstallVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderOptions, setLoaderOptions] = useState<string[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [optiFineEnabled, setOptiFineEnabled] = useState(false);
  const [optiFineLoading, setOptiFineLoading] = useState(false);
  const [optiFineOptions, setOptiFineOptions] = useState<OptiFineVersion[]>([]);
  const [optiFineVersion, setOptiFineVersion] = useState("");
  const [installedVersions, setInstalledVersions] = useState<string[]>([]);

  const loaderRequestRef = useRef(0);
  const optiFineRequestRef = useRef(0);
  const lastInstallPageRef = useRef(false);

  const loaderDisplayName = (value: Loader) => t(loaderLabelKey(value));

  const grouped = useMemo(() => groupByMajor(catalog), [catalog]);
  const majors = useMemo(() => Object.keys(grouped).sort((a, b) => compareMajor(b, a)), [grouped]);
  const majorVersions = major ? grouped[major] ?? [] : [];
  const snapshots = useMemo(() => catalog.filter(isSnapshot), [catalog]);
  const installDisabled =
    busy ||
    catalogLoading ||
    !installVersion ||
    (loader !== "vanilla" && (loaderLoading || !loaderVersion)) ||
    (optiFineEnabled && (optiFineLoading || !optiFineVersion || loader === "fabric"));
  const optiFineDisabledReason = loader === "fabric" ? t("install.optifineFabricConflict") : "";
  const installButtonText = busy
    ? t("install.button.installing")
    : catalogLoading
      ? t("install.button.syncing")
      : loader !== "vanilla" && loaderLoading
        ? t("install.button.loadingLoader", { loader: loaderDisplayName(loader) })
        : t("install.button.installSelected");

  async function refreshCatalog() {
    if (catalogLoading) return;
    setCatalogLoading(true);
    setStatus(t("app.status.loadingVersions"));
    try {
      const [versions, installed] = await Promise.all([
        invoke<string[]>("list_vanilla_versions", { downloadSource: settings.downloadSource }),
        invoke<string[]>("list_installed_versions", { gameDir: settings.gameDir }).catch(() => [])
      ]);
      const groupedVersions = groupByMajor(versions);
      const majorKeys = Object.keys(groupedVersions).sort((a, b) => compareMajor(b, a));
      const nextMajor = majorKeys.includes(major) ? major : majorKeys[0] ?? "";
      const nextVersion = resolveInstallVersion(versions, groupedVersions, nextMajor, showSnapshots, installVersion);
      setCatalog(versions);
      setInstalledVersions(installed);
      setMajor(nextMajor);
      setInstallVersion(nextVersion);
      setStatus(t("app.status.loadedVersions", { count: versions.length }));
    } catch (error) {
      setStatus(t("app.status.failed", { error: String(error) }));
    } finally {
      setCatalogLoading(false);
    }
  }

  async function refreshLoader() {
    if (!installVersion || loader === "vanilla") return;
    const requestId = loaderRequestRef.current + 1;
    loaderRequestRef.current = requestId;
    setLoaderLoading(true);
    try {
      const versions =
        loader === "fabric"
          ? await invoke<string[]>("list_fabric_loaders", {
              gameVersion: installVersion,
              downloadSource: settings.downloadSource
            })
          : await invoke<string[]>("list_forge_versions", {
              gameVersion: installVersion,
              downloadSource: settings.downloadSource
            });
      if (requestId !== loaderRequestRef.current) return;
      const options = versions;
      setLoaderOptions(options);
      setLoaderVersion(options[0] ?? "");
      setStatus(
        options.length > 0
          ? t("app.status.loadedLoaderVersions", { count: options.length, loader: loaderDisplayName(loader) })
          : t("app.status.noLoaderVersions", { loader: loaderDisplayName(loader), version: installVersion })
      );
    } catch (error) {
      if (requestId !== loaderRequestRef.current) return;
      setLoaderOptions([]);
      setLoaderVersion("");
      setStatus(t("app.status.failed", { error: String(error) }));
    } finally {
      if (requestId === loaderRequestRef.current) {
        setLoaderLoading(false);
      }
    }
  }

  async function refreshOptiFine() {
    if (!installVersion || loader === "fabric") return;
    const requestId = optiFineRequestRef.current + 1;
    optiFineRequestRef.current = requestId;
    setOptiFineLoading(true);
    try {
      const versions = await invoke<OptiFineVersion[]>("list_optifine_versions", {
        gameVersion: installVersion,
        loader,
        loaderVersion: loader === "vanilla" ? null : loaderVersion,
        downloadSource: settings.downloadSource
      });
      if (requestId !== optiFineRequestRef.current) return;
      const options = versions.slice(0, 80);
      const firstCompatible = options.find((item) => item.compatibility === "compatible") ?? null;
      setOptiFineOptions(options);
      setOptiFineVersion(firstCompatible?.version ?? "");
      setStatus(
        options.length > 0
          ? t("app.status.loadedLoaderVersions", { count: options.length, loader: t("loader.optifine") })
          : t("app.status.noLoaderVersions", { loader: t("loader.optifine"), version: installVersion })
      );
    } catch (error) {
      if (requestId !== optiFineRequestRef.current) return;
      setOptiFineOptions([]);
      setOptiFineVersion("");
      setStatus(t("app.status.failed", { error: String(error) }));
    } finally {
      if (requestId === optiFineRequestRef.current) {
        setOptiFineLoading(false);
      }
    }
  }

  // Refresh the catalog when first entering the install page.
  useEffect(() => {
    const inInstall = page === "install";
    if (inInstall && !lastInstallPageRef.current) {
      void refreshCatalog();
    }
    lastInstallPageRef.current = inInstall;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    if (catalog.length === 0) return;
    const nextVersion = resolveInstallVersion(catalog, grouped, major, showSnapshots, installVersion);
    if (nextVersion !== installVersion) {
      setInstallVersion(nextVersion);
    }
  }, [catalog, grouped, major, showSnapshots, installVersion]);

  useEffect(() => {
    loaderRequestRef.current += 1;
    setLoaderOptions([]);
    setLoaderVersion("");
    if (page !== "install" || loader === "vanilla" || !installVersion) {
      setLoaderLoading(false);
      return;
    }
    void refreshLoader();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, loader, installVersion]);

  useEffect(() => {
    if (loader === "fabric" && optiFineEnabled) {
      setOptiFineEnabled(false);
    }
  }, [loader, optiFineEnabled]);

  useEffect(() => {
    optiFineRequestRef.current += 1;
    setOptiFineOptions([]);
    setOptiFineVersion("");
    if (page !== "install" || !optiFineEnabled || !installVersion || loader === "fabric") {
      setOptiFineLoading(false);
      return;
    }
    if (loader !== "vanilla" && !loaderVersion) {
      setOptiFineLoading(false);
      return;
    }
    void refreshOptiFine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, optiFineEnabled, installVersion, loader, loaderVersion]);

  return {
    catalog,
    catalogLoading,
    loaderLoading,
    major,
    setMajor,
    showSnapshots,
    setShowSnapshots,
    installVersion,
    setInstallVersion,
    loader,
    setLoader,
    loaderOptions,
    loaderVersion,
    setLoaderVersion,
    optiFineEnabled,
    setOptiFineEnabled,
    optiFineLoading,
    optiFineOptions,
    optiFineVersion,
    setOptiFineVersion,
    installedVersions,
    setInstalledVersions,
    grouped,
    majors,
    majorVersions,
    snapshots,
    installDisabled,
    installButtonText,
    optiFineDisabledReason
  };
}
