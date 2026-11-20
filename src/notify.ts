// OS notifications for long operations that finish while Chrono is in the
// background (fetch / pull / push / rebase / clone / CI state changes).
const KEY = "chrono.notifications";

export function notificationsEnabled(): boolean {
  return localStorage.getItem(KEY) === "on" && typeof Notification !== "undefined" && Notification.permission === "granted";
}

export async function setNotificationsEnabled(enabled: boolean): Promise<boolean> {
  if (!enabled) { localStorage.setItem(KEY, "off"); return false; }
  if (typeof Notification === "undefined") return false;
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  localStorage.setItem(KEY, permission === "granted" ? "on" : "off");
  return permission === "granted";
}

export function notifyIfHidden(title: string, body: string): void {
  if (!notificationsEnabled() || !document.hidden) return;
  try { new Notification(title, { body, icon: "/rsrc/icon_32x32.png" }); } catch { /* unsupported */ }
}
