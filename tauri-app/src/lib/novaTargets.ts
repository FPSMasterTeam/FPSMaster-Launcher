// Nova multi-version target helpers. Nova stays one persisted preset region; each Minecraft
// game version specialises into its own on-disk profile at launch/settings time.
import { NOVA_DEFAULT_GAME_VERSION } from "../constants";
import type { Instance, LauncherVersion } from "../types";

export const NOVA_VERSION_ID_PREFIX = "FPSMaster-Nova";

export type NovaVersionTarget = {
  gameVersion: string;
  catalogVersion: LauncherVersion | null;
};

/** On-disk versionId for a Nova Minecraft game version. */
export function novaVersionIdFor(gameVersion: string): string {
  return `${NOVA_VERSION_ID_PREFIX}-${gameVersion}`;
}

/**
 * Specialise the Nova preset to a concrete Minecraft game version.
 * Non-Nova instances are returned unchanged.
 */
export function buildNovaEffectiveInstance(instance: Instance, gameVersion: string): Instance {
  if (!instance.preset || instance.launcherVersionType !== "NOVA") {
    return instance;
  }
  const resolved = (gameVersion || instance.baseVersion || NOVA_DEFAULT_GAME_VERSION).trim();
  return {
    ...instance,
    baseVersion: resolved,
    versionId: novaVersionIdFor(resolved)
  };
}

/** Numeric dotted-version comparison; >0 when `a` is newer than `b`. */
export function compareGameVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * Expand the Nova catalog into selectable targets.
 * Recommended first, then descending game version. Falls back to `selectedFallback` when empty.
 */
export function listNovaVersionTargets(
  novaGameVersions: Record<string, LauncherVersion>,
  selectedFallback: string
): NovaVersionTarget[] {
  const entries = Object.entries(novaGameVersions)
    .map(([gameVersion, version]) => ({ gameVersion, catalogVersion: version as LauncherVersion | null }))
    .sort((a, b) => {
      const aRec = Boolean(a.catalogVersion?.recommended);
      const bRec = Boolean(b.catalogVersion?.recommended);
      if (aRec !== bRec) return aRec ? -1 : 1;
      return compareGameVersions(b.gameVersion, a.gameVersion);
    });

  if (entries.length > 0) {
    return entries;
  }

  const fallback = (selectedFallback || NOVA_DEFAULT_GAME_VERSION).trim();
  if (!fallback) return [];
  return [{ gameVersion: fallback, catalogVersion: null }];
}

export function isNovaTestingGameVersion(gameVersion: string): boolean {
  return gameVersion.trim() !== NOVA_DEFAULT_GAME_VERSION;
}
