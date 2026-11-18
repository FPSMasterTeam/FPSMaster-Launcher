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

const BLOCKED_JVM_FLAGS = ["-cp", "-classpath", "--class-path", "-jar", "--module-path", "-p", "-m", "--module"];

/** Mirrors `apply_custom_launch_options` in main.rs; returns the first rejected argument. */
export function findInvalidJvmArg(args: readonly string[] | undefined): string | null {
  for (const raw of args ?? []) {
    const arg = raw.trim();
    if (!arg) continue;
    if (!arg.startsWith("-") || arg.length > 8192 || arg.includes("\0") || BLOCKED_JVM_FLAGS.includes(arg)
      || arg.startsWith("--class-path=") || arg.startsWith("-Xmx")) return arg;
  }
  return null;
}
