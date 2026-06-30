// Pure helpers for the launch-prepare dialog: parsing launcher/JDK progress
// logs and reducing per-item progress state. Extracted from App.tsx — no React
// state here, just data transforms.
import type { TranslationKey } from "../i18n";
import type {
  InstallIpcEvent,
  LaunchPrepareItem,
  LaunchPrepareItemStatus,
  LaunchPreparePhaseKey,
  LaunchPreparePhaseState
} from "../types";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function parseLaunchProgressLog(message: string): { percent?: number; text: string } | null {
  const text = message.trim();
  if (!text) return null;

  const match = text.match(/JDK download progress:\s*(\d+)%/);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) {
      return { percent: Math.min(100, Math.max(0, parsed)), text };
    }
  }

  if (text.startsWith("JDK download succeeded") || text.startsWith("JDK ready") || text.startsWith("JDK already exists")) {
    return { percent: 100, text };
  }

  if (text.startsWith("Downloading JDK ")) {
    return { percent: 30, text };
  }

  if (text.startsWith("Extracting JDK archive")) {
    return { percent: 60, text };
  }

  if (text.startsWith("launch game:")) {
    return { percent: 90, text: text.replace(/^launch game:\s*/i, "Starting game process") };
  }

  if (text.startsWith("[process] started pid=")) {
    return { percent: 100, text: "Game process started" };
  }
  return null;
}

export function parseLaunchPrepareJdkLog(message: string): {
  message: string;
  stage?: string;
  phaseStatus?: LaunchPreparePhaseState["status"];
  current?: number;
  total?: number;
  downloaded?: number;
  cached?: number;
  item: LaunchPrepareItem;
} | null {
  const text = message.trim();
  if (!text) {
    return null;
  }

  const progressMatch = text.match(/^JDK download progress:\s*(\d+)%\s*\((\d+)\/(\d+)\s+bytes\)$/i);
  if (progressMatch) {
    const percent = Number.parseInt(progressMatch[1], 10);
    const currentBytes = Number.parseInt(progressMatch[2], 10);
    const totalBytes = Number.parseInt(progressMatch[3], 10);
    return {
      message: text,
      stage: "download",
      phaseStatus: "running",
      current: Number.isFinite(percent) ? percent : 0,
      total: 100,
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: percent >= 100 ? "done" : "running",
        currentBytes,
        totalBytes,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  const bytesOnlyMatch = text.match(/^JDK download progress:\s*(\d+)\s+bytes$/i);
  if (bytesOnlyMatch) {
    const currentBytes = Number.parseInt(bytesOnlyMatch[1], 10);
    return {
      message: text,
      stage: "download",
      phaseStatus: "running",
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "running",
        currentBytes,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("Managed JDK already exists")) {
    return {
      message: text,
      stage: "complete",
      phaseStatus: "done",
      current: 100,
      total: 100,
      downloaded: 0,
      cached: 1,
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "cached",
        currentBytes: 0,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("Resolving Mojang runtime") || text.startsWith("Installing Mojang runtime")) {
    return {
      message: text,
      stage: "prepare",
      phaseStatus: "running",
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "running",
        currentBytes: 0,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("Fetching Mojang Java all.json") || text.startsWith("Fetching Mojang Java manifest")) {
    return {
      message: text,
      stage: "prepare",
      phaseStatus: "running",
      item: {
        id: "jdk-manifest",
        name: text.includes("all.json") ? "Runtime Index" : "Runtime Manifest",
        kind: "jdk-meta",
        status: "running",
        currentBytes: 0,
        totalBytes: null,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  const runtimeMatch = text.match(/^Mojang runtime progress:\s*(\d+)\/(\d+)\s+downloaded=(\d+)\s+cached=(\d+)$/i);
  if (runtimeMatch) {
    const current = Number.parseInt(runtimeMatch[1], 10);
    const total = Number.parseInt(runtimeMatch[2], 10);
    const downloaded = Number.parseInt(runtimeMatch[3], 10);
    const cached = Number.parseInt(runtimeMatch[4], 10);
    return {
      message: text,
      stage: current >= total ? "complete" : "download",
      phaseStatus: current >= total ? "done" : "running",
      current,
      total,
      downloaded,
      cached,
      item: {
        id: "jdk-runtime-files",
        name: "Runtime Files",
        kind: "jdk",
        status: current >= total ? "done" : "running",
        currentBytes: current,
        totalBytes: total,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  if (text.startsWith("JDK ready ") || text.startsWith("JDK download succeeded")) {
    return {
      message: text,
      stage: "complete",
      phaseStatus: "done",
      current: 100,
      total: 100,
      item: {
        id: "jdk-download",
        name: "JDK Runtime",
        kind: "jdk",
        status: "done",
        currentBytes: 100,
        totalBytes: 100,
        message: text,
        updatedAt: Date.now()
      }
    };
  }

  return null;
}

export function mapLaunchPreparePhaseKey(phase?: string): LaunchPreparePhaseKey | null {
  if (phase === "login") return "login";
  if (phase === "verify") return "verify";
  if (phase === "vanilla") return "vanilla";
  if (phase === "fabric") return "fabric";
  if (phase === "forge") return "forge";
  if (phase === "optifine") return "optifine";
  if (phase === "mods") return "mods";
  if (phase === "runtime") return "runtime";
  return null;
}

export function translateLaunchPrepareMessage(ipc: InstallIpcEvent, t: Translator): string | null {
  if (ipc.phase !== "login") {
    return ipc.message ?? null;
  }
  if (ipc.stage === "microsoft") return t("launch.progress.loginMicrosoft");
  if (ipc.stage === "xbox") return t("launch.progress.loginXbox");
  if (ipc.stage === "xsts") return t("launch.progress.loginXsts");
  if (ipc.stage === "minecraft") return t("launch.progress.loginMinecraft");
  if (ipc.stage === "profile") return t("launch.progress.loginProfile");
  return ipc.message ?? null;
}

export function reduceLaunchPrepareItems(items: LaunchPrepareItem[], ipc: InstallIpcEvent): LaunchPrepareItem[] {
  if (!ipc.event.startsWith("item-")) {
    return items;
  }
  const itemId = ipc.itemId?.trim();
  if (!itemId) {
    return items;
  }

  const existingIndex = items.findIndex((item) => item.id === itemId);
  const existing = existingIndex >= 0 ? items[existingIndex] : null;
  const nextStatus = resolveLaunchPrepareItemStatus(ipc, existing?.status);
  const nextItem: LaunchPrepareItem = {
    id: itemId,
    name: ipc.itemName?.trim() || existing?.name || itemId,
    kind: ipc.itemKind?.trim() || existing?.kind || "file",
    status: nextStatus,
    currentBytes: typeof ipc.itemCurrentBytes === "number" ? ipc.itemCurrentBytes : existing?.currentBytes ?? 0,
    totalBytes:
      typeof ipc.itemTotalBytes === "number"
        ? ipc.itemTotalBytes
        : existing?.totalBytes ?? null,
    message: ipc.message?.trim() || existing?.message || "",
    updatedAt: Date.now()
  };

  const next = existingIndex >= 0 ? [...items] : [nextItem, ...items];
  if (existingIndex >= 0) {
    next[existingIndex] = nextItem;
  }

  next.sort((left, right) => {
    const leftRank = launchPrepareItemRank(left.status);
    const rightRank = launchPrepareItemRank(right.status);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return right.updatedAt - left.updatedAt;
  });

  return next;
}

export function resolveLaunchPrepareItemStatus(
  ipc: InstallIpcEvent,
  previous?: LaunchPrepareItemStatus
): LaunchPrepareItemStatus {
  if (ipc.event === "item-error") return "error";
  if (ipc.event === "item-complete") {
    return ipc.itemCached ? "cached" : "done";
  }
  if (ipc.event === "item-progress" || ipc.event === "item-start") {
    if ((ipc.message ?? "").trim().toLowerCase() === "queued") {
      return "pending";
    }
    return "running";
  }
  return previous ?? "pending";
}

export function launchPrepareItemRank(status: LaunchPrepareItemStatus): number {
  if (status === "running") return 0;
  if (status === "pending") return 1;
  if (status === "error") return 2;
  if (status === "done") return 3;
  return 4;
}

export function upsertLaunchPrepareLogItem(items: LaunchPrepareItem[], item: LaunchPrepareItem): LaunchPrepareItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  const next = index >= 0 ? [...items] : [item, ...items];
  if (index >= 0) {
    next[index] = item;
  }
  next.sort((left, right) => {
    const leftRank = launchPrepareItemRank(left.status);
    const rightRank = launchPrepareItemRank(right.status);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return right.updatedAt - left.updatedAt;
  });
  return next.slice(0, 4);
}
