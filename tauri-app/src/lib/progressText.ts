// Install / launch progress texts are emitted by the Rust side in English.
// These helpers map the known ones onto locale keys so non-English UIs do not
// show raw English; unknown text is returned unchanged.
import type { TranslationKey } from "../i18n";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

const STAGE_KEYS: Record<string, TranslationKey> = {
  prepare: "dialog.stage.prepare",
  complete: "dialog.stage.complete",
  failed: "dialog.stage.failed",
  client: "dialog.stage.client",
  libraries: "dialog.stage.libraries",
  logging: "dialog.stage.logging",
  assets: "dialog.stage.assets",
  download: "dialog.stage.download",
  "fetch-manifest": "dialog.stage.fetchManifest",
  "resolve-version": "dialog.stage.resolveVersion",
  "resolve-loader": "dialog.stage.resolveLoader",
  "resolve-installer": "dialog.stage.resolveInstaller",
  "download-installer": "dialog.stage.downloadInstaller",
  installer: "dialog.stage.installer",
  "run-installer": "dialog.stage.installer",
  "fallback-installer": "dialog.stage.installer",
  "legacy-profile": "dialog.stage.installer",
  patch: "dialog.stage.patch"
};

export function translateStageName(stage: string, t: Translator): string {
  const key = STAGE_KEYS[stage];
  return key ? t(key) : stage || t("dialog.stage.default");
}

const EXACT_KEYS: Record<string, TranslationKey> = {
  Downloading: "progress.msg.downloading",
  Queued: "progress.msg.queued",
  queued: "progress.msg.queued",
  "Fetching version manifest": "progress.msg.fetchManifest",
  "Version manifest resolved": "progress.msg.manifestResolved",
  "Version metadata ready": "progress.msg.metadataReady",
  "Download client jar": "progress.msg.downloadClient",
  "Client jar downloaded": "progress.msg.clientDownloaded",
  "Client jar already cached": "progress.msg.clientCached",
  "Client jar repaired": "progress.msg.clientRepaired",
  "Client jar verified": "progress.msg.clientVerified",
  "Verify client jar": "progress.msg.verifyClient",
  "Download libraries": "progress.msg.downloadLibraries",
  "Start downloading libraries": "progress.msg.downloadLibraries",
  "Verify libraries": "progress.msg.verifyLibraries",
  "Download logging configuration": "progress.msg.downloadLogging",
  "Verify logging configuration": "progress.msg.verifyLogging",
  "Download assets": "progress.msg.downloadAssets",
  "Start downloading assets": "progress.msg.downloadAssets",
  "Verify assets": "progress.msg.verifyAssets",
  "Fabric loader metadata ready": "progress.msg.fabricMetadataReady",
  "Download fabric libraries": "progress.msg.downloadFabricLibraries",
  "Forge installer URL ready": "progress.msg.forgeUrlReady",
  "Downloading forge installer": "progress.msg.downloadForgeInstaller",
  "Forge installer ready": "progress.msg.forgeInstallerReady",
  "Detected legacy forge installer profile": "progress.msg.forgeLegacy",
  "Running forge installer (first attempt)": "progress.msg.forgeRun",
  "Retry forge installer with fallback args": "progress.msg.forgeRetry",
  "Patching vanilla client for standalone OptiFine": "progress.msg.optifinePatch",
  "OptiFine standalone runtime is already installed": "progress.msg.optifineInstalled"
};

const PATTERN_KEYS: ReadonlyArray<[RegExp, TranslationKey]> = [
  [/^Prepare install for version=(.+)$/, "progress.msg.prepareInstall"],
  [/^Resolving version metadata for (.+)$/, "progress.msg.resolveVersion"],
  [/^Fetching version manifest for (.+)$/, "progress.msg.fetchManifestFor"],
  [/^Verifying installed files for (.+)$/, "progress.msg.verifyInstalled"],
  [/^Install completed version=(\S+) libraries=(\d+) assets=(\d+)$/, "progress.msg.installCompleted"],
  [/^Verify completed version=(\S+) repaired=(\d+)$/, "progress.msg.verifyCompleted"],
  [/^Prepare fabric install gameVersion=(.+)$/, "progress.msg.prepareFabric"],
  [/^Resolving fabric loader metadata for (.+)$/, "progress.msg.resolveFabric"],
  [/^Fabric install completed profile=(.+?)(?: libraries=\d+)?$/, "progress.msg.fabricCompleted"],
  [/^Prepare forge install gameVersion=(.+)$/, "progress.msg.prepareForge"],
  [/^Resolving forge installer for (.+)$/, "progress.msg.resolveForge"],
  [/^Run forge installer (.+)$/, "progress.msg.runForge"],
  [/^Forge install completed profile=(.+)$/, "progress.msg.forgeCompleted"],
  [/^Prepare OptiFine install version=(.+)$/, "progress.msg.prepareOptifine"],
  [/^OptiFine (?:standalone )?install completed file=(.+)$/, "progress.msg.optifineCompleted"],
  [/^OptiFine already installed: (.+)$/, "progress.msg.optifineAlready"],
  [/^Downloaded (\S+) (\d+)\/(\d+)$/, "progress.msg.downloadedCount"]
];

const GROUP_NAMES = ["a", "b", "c"] as const;

export function localizeProgressMessage(message: string, t: Translator): string {
  const text = message.trim();
  const exact = EXACT_KEYS[text];
  if (exact) return t(exact);
  for (const [pattern, key] of PATTERN_KEYS) {
    const match = text.match(pattern);
    if (!match) continue;
    const values: Record<string, string> = {};
    GROUP_NAMES.forEach((name, index) => {
      if (match[index + 1] !== undefined) values[name] = match[index + 1];
    });
    // "Downloaded <stage> n/m": translate the stage word as well.
    if (key === "progress.msg.downloadedCount") values.a = translateStageName(values.a, t);
    return t(key, values);
  }
  return message;
}
