// Global store for content (mod / resource pack / modpack / world) tasks.
//
// These used to live in the Content page's local state, so leaving the page
// lost the progress, re-enabled the install buttons (two concurrent installs of
// the same pack) and the launch buttons never knew an instance was being
// written to (launcher-ui-11). A module-level store survives page unmounts and
// lets the launch flow refuse to start an instance that is mid-install. Same
// subscribe/snapshot shape as lib/toast.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { ContentInstallProgressEvent, ModpackInstallProgressEvent } from "../types";

export type ContentTaskKind = "install" | "modpack" | "uninstall" | "world-import";

export type ContentTask = {
  /** ipcSession of the backend command; cancel_install(id) stops it. */
  id: string;
  kind: ContentTaskKind;
  /** `<source>:<type>:<projectId>`, matches the backend progress events. */
  projectKey: string | null;
  title: string;
  /** Instance directory being written; null for a modpack (creates a new one). */
  versionId: string | null;
  progress: ContentInstallProgressEvent | null;
  modpackProgress: ModpackInstallProgressEvent | null;
  cancelling: boolean;
};

export type ContentTaskError = { versionId: string | null; message: string; at: number };

type State = {
  tasks: ContentTask[];
  /** Bumped per versionId whenever a task that changed it ends. */
  revisions: Record<string, number>;
  lastError: ContentTaskError | null;
  /** A batch update in progress: the page shows it, the next item is driven by its loop. */
  batch: { versionId: string; current: number; total: number } | null;
};

let state: State = { tasks: [], revisions: {}, lastError: null, batch: null };
const listeners = new Set<() => void>();

function setState(update: (prev: State) => State) {
  state = update(state);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeContentTasks(listener: () => void): () => void {
  ensureProgressListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getContentTasksSnapshot(): State {
  return state;
}

export function useContentTasks(): State {
  return useSyncExternalStore(subscribeContentTasks, getContentTasksSnapshot);
}

export function isContentTaskRunningFor(versionId: string): boolean {
  return (
    state.tasks.some((task) => task.versionId === versionId) ||
    state.batch?.versionId === versionId
  );
}

export function hasContentTasks(): boolean {
  return state.tasks.length > 0 || state.batch !== null;
}

export function findContentTask(projectKey: string): ContentTask | null {
  return state.tasks.find((task) => task.projectKey === projectKey) ?? null;
}

export function beginContentTask(task: Omit<ContentTask, "progress" | "modpackProgress" | "cancelling">) {
  setState((prev) => ({
    ...prev,
    lastError: null,
    tasks: [...prev.tasks, { ...task, progress: null, modpackProgress: null, cancelling: false }]
  }));
}

export function endContentTask(id: string, error?: string) {
  setState((prev) => {
    const task = prev.tasks.find((item) => item.id === id);
    if (!task) return prev;
    const revisions = task.versionId
      ? { ...prev.revisions, [task.versionId]: (prev.revisions[task.versionId] ?? 0) + 1 }
      : prev.revisions;
    return {
      ...prev,
      tasks: prev.tasks.filter((item) => item.id !== id),
      revisions,
      lastError: error ? { versionId: task.versionId, message: error, at: Date.now() } : prev.lastError
    };
  });
}

export function setContentBatch(batch: State["batch"]) {
  setState((prev) => ({ ...prev, batch }));
}

export function clearContentTaskError() {
  if (state.lastError) {
    setState((prev) => ({ ...prev, lastError: null }));
  }
}

export async function cancelContentTask(id: string): Promise<void> {
  setState((prev) => ({
    ...prev,
    tasks: prev.tasks.map((task) => (task.id === id ? { ...task, cancelling: true } : task))
  }));
  await invoke("cancel_install", { sessionId: id });
}

let progressListenersBound = false;

// Bound once for the app lifetime: the events must keep updating tasks while
// the Content page is not mounted.
function ensureProgressListeners() {
  if (progressListenersBound) return;
  progressListenersBound = true;
  const bind = <T extends { projectKey: string }>(
    event: string,
    apply: (task: ContentTask, payload: T) => ContentTask
  ) =>
    listen<T>(event, ({ payload }) => {
      if (!state.tasks.some((task) => task.projectKey === payload.projectKey)) return;
      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((task) => (task.projectKey === payload.projectKey ? apply(task, payload) : task))
      }));
    }).catch((error) => {
      progressListenersBound = false;
      console.warn(`[content] cannot listen to ${event}:`, error);
    });
  void bind<ContentInstallProgressEvent>("content-install-progress", (task, progress) => ({ ...task, progress }));
  void bind<ModpackInstallProgressEvent>("modpack-install-progress", (task, modpackProgress) => ({
    ...task,
    modpackProgress
  }));
}
