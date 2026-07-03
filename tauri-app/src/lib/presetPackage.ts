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
  // NOVA and EXTREME are gated: each resolves against its own catalog entry, which is only
  // present once released (and, for premium channels, once the account is entitled).
  const version = versionMap[instance.launcherVersionType];
  if (!version) {
    const label = instance.launcherVersionType === "EXTREME" ? "Extreme" : "Nova";
    return {
      state: "pending-release",
      lastError: `${label} has not been released yet.`
    };
  }
  return {
    state: "ok",
    versionTag: version.versionName,
    changelog: version.changelog ?? null
  };
}
