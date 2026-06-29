// Instance naming / id helpers. Pure functions extracted from App.tsx.
import type { Instance, Loader } from "../types";

export function loaderLabelKey(loader: Loader) {
  if (loader === "forge") return "loader.forge" as const;
  if (loader === "fabric") return "loader.fabric" as const;
  return "loader.vanilla" as const;
}

export function slugifyInstanceKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "instance";
}

export function createDuplicatedInstanceName(sourceName: string, instances: Instance[]): string {
  const existingNames = new Set(instances.map((item) => item.name.trim().toLowerCase()));
  const baseName = `${sourceName} Copy`;
  if (!existingNames.has(baseName.trim().toLowerCase())) {
    return baseName;
  }

  let index = 2;
  while (index < 1000) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.has(candidate.trim().toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${baseName} ${Date.now()}`;
}

export function createDuplicatedVersionId(sourceVersionId: string, instances: Instance[]): string {
  const existingIds = new Set(instances.map((item) => item.versionId.trim().toLowerCase()));
  const slugBase = slugifyInstanceKey(sourceVersionId);
  let index = 1;
  while (index < 1000) {
    const candidate = `${slugBase}-copy-${index}`;
    if (!existingIds.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${slugBase}-copy-${Date.now()}`;
}

export function isLegacyDefaultGameDir(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/").toLowerCase();
  return normalized === "" || normalized === "./.minecraft" || normalized === ".minecraft";
}
