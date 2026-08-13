// Global toast store.
//
// Deliberately a module-level store rather than a React context: the launcher
// reports failures from places that are not components (data hooks, async
// helpers, event callbacks), and the component that owns most of those calls is
// the same one that would have to render the provider. A subscribable store lets
// any caller raise a toast while `ToastViewport` stays the only renderer.
export type ToastTone = "error" | "warning" | "success" | "info";

export type Toast = {
  id: number;
  tone: ToastTone;
  title: string | null;
  message: string;
};

export type ToastInput = {
  tone: ToastTone;
  message: string;
  title?: string | null;
  /** Overrides the tone's default auto-dismiss delay. Pass 0 to keep it until dismissed. */
  durationMs?: number;
};

const MAX_VISIBLE = 4;
// Repeated identical failures (a poll that keeps failing every second) must not
// stack into a wall of toasts; within this window the existing toast is kept and
// its dismiss timer restarted instead.
const DEDUPE_WINDOW_MS = 5000;

const DEFAULT_DURATION_MS: Record<ToastTone, number> = {
  error: 9000,
  warning: 7000,
  info: 5000,
  success: 4000
};

type TrackedToast = Toast & { raisedAt: number; durationMs: number };

let toasts: TrackedToast[] = [];
let publicSnapshot: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish() {
  publicSnapshot = toasts.map((item) => ({
    id: item.id,
    tone: item.tone,
    title: item.title,
    message: item.message
  }));
  for (const listener of listeners) {
    listener();
  }
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function scheduleDismiss(id: number, durationMs: number) {
  clearTimer(id);
  if (durationMs <= 0) {
    return;
  }
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      dismissToast(id);
    }, durationMs)
  );
}

export function pushToast(input: ToastInput): number {
  const message = input.message.trim();
  if (message === "") {
    return 0;
  }
  const title = input.title?.trim() || null;
  const durationMs = input.durationMs ?? DEFAULT_DURATION_MS[input.tone];
  const now = Date.now();

  const duplicate = toasts.find(
    (item) =>
      item.tone === input.tone &&
      item.message === message &&
      item.title === title &&
      now - item.raisedAt <= DEDUPE_WINDOW_MS
  );
  if (duplicate) {
    duplicate.raisedAt = now;
    scheduleDismiss(duplicate.id, durationMs);
    return duplicate.id;
  }

  const id = nextId++;
  const next: TrackedToast = { id, tone: input.tone, title, message, raisedAt: now, durationMs };
  toasts = [...toasts, next];
  // Oldest entries fall off first so the newest failure is always on screen.
  while (toasts.length > MAX_VISIBLE) {
    const dropped = toasts[0];
    toasts = toasts.slice(1);
    clearTimer(dropped.id);
  }
  scheduleDismiss(id, durationMs);
  publish();
  return id;
}

export function dismissToast(id: number) {
  const remaining = toasts.filter((item) => item.id !== id);
  if (remaining.length === toasts.length) {
    return;
  }
  clearTimer(id);
  toasts = remaining;
  publish();
}

export function clearToasts() {
  for (const id of timers.keys()) {
    clearTimer(id);
  }
  if (toasts.length === 0) {
    return;
  }
  toasts = [];
  publish();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToastSnapshot(): Toast[] {
  return publicSnapshot;
}

export function notifyError(message: string, title?: string) {
  return pushToast({ tone: "error", message, title });
}

export function notifyWarning(message: string, title?: string) {
  return pushToast({ tone: "warning", message, title });
}

export function notifySuccess(message: string, title?: string) {
  return pushToast({ tone: "success", message, title });
}

export function notifyInfo(message: string, title?: string) {
  return pushToast({ tone: "info", message, title });
}
