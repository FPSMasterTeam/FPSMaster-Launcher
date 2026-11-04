// Preset-package status helpers. Pure functions extracted from App.tsx.
import type { Instance, LauncherVersion, LauncherVersionMap, PresetPackageStatus } from "../types";

export function createPresetPackageStatus(
  state: PresetPackageStatus["state"],
  overrides: Partial<Omit<PresetPackageStatus, "state">> = {}
): PresetPackageStatus {
  return {
    state,
    versionTag: null,
    installedVersionTag: null,
    targetVersionTag: null,
    changelog: null,
    lastError: null,
    ...overrides
  };
}

export function resolvePresetAccessState(
  instance: Instance,
  versionMap: LauncherVersionMap,
  // For NOVA, the entry for the picked game version (Nova has several); ignored for other products.
  novaVersion?: LauncherVersion | null
): { state: "ok" | "pending-release"; versionTag?: string | null; changelog?: string | null } {
  if (!instance.preset || !instance.launcherVersionType) {
    return { state: "ok" };
  }
  if (instance.launcherVersionType === "EDGE") {
    return { state: "ok" };
  }
  // NOVA is gated: it resolves against the picked game version's catalog entry, which is
  // only present once released. The caller words the message (it knows whether the
  // catalog actually loaded).
  const version = novaVersion ?? null;
  if (!version) {
    return { state: "pending-release" };
  }
  return {
    state: "ok",
    versionTag: version.versionName,
    changelog: version.changelog ?? null
  };
}
