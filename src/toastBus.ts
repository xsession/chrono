// Toast bus (GitKraken RE §Toast namespace): a tiny pub/sub so any module —
// saga registry, deep links, components — can push notifications to the UI.

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

export function pushToast(message: string, kind: ToastKind = "info", ttlMs = 5000): number {
  const id = nextId++;
  toasts = [...toasts, { id, message, kind }];
  emit();
  if (ttlMs > 0) window.setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function clearToasts(): void {
  if (!toasts.length) return;
  toasts = [];
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}
