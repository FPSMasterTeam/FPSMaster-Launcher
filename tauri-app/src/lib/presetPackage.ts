// Preset-package status helpers. Pure functions extracted from App.tsx.
import type { Instance, LauncherVersionMap, PresetPackageStatus } from "../types";

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
  versionMap: LauncherVersionMap
): { state: "ok" | "pending-release"; versionTag?: string | null; changelog?: string | null; lastError?: string | null } {
  if (!instance.preset || !instance.launcherVersionType) {
    return { state: "ok" };
  }
  if (instance.launcherVersionType === "EDGE") {
    return { state: "ok" };
  }
  const version = versionMap.NOVA;
  if (!version) {
    return {
      state: "pending-release",
      lastError: "Nova has not been released yet."
    };
  }
  return {
    state: "ok",
    versionTag: version.versionName,
    changelog: version.changelog ?? null
  };
}
