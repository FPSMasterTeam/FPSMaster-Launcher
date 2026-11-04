import type { LaunchOptions } from "../types";

export function normalizeLaunchOptions(value: unknown): LaunchOptions {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: LaunchOptions = {};
  for (const [key, min, max] of [
    ["maxMemoryMb", 1024, 65536], ["windowWidth", 320, 16384], ["windowHeight", 240, 16384]
  ] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.max(min, Math.min(max, Math.round(value)));
  }
  if (typeof raw.javaPath === "string" && raw.javaPath.trim()) out.javaPath = raw.javaPath.trim();
  if (Array.isArray(raw.jvmArgs)) {
    const args = raw.jvmArgs.filter((arg): arg is string => typeof arg === "string" && !!arg.trim()).map((arg) => arg.trim());
    if (args.length) out.jvmArgs = args.slice(0, 256);
  }
  return out;
}

export function resolveLaunchOptions(
  settings: { maxMemoryMb: number; launchOptions?: LaunchOptions },
  instance?: LaunchOptions
): LaunchOptions & { maxMemoryMb: number; jvmArgs: string[] } {
  return {
    maxMemoryMb: settings.maxMemoryMb, jvmArgs: [],
    ...normalizeLaunchOptions(settings.launchOptions), ...normalizeLaunchOptions(instance)
  };
}
