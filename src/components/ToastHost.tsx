import { useEffect, useState } from "react";
import { clearToasts, dismissToast, subscribeToasts, type Toast } from "../toastBus";

// Renders the toast stack (GitKraken RE §Toast namespace: showToast / hideToast).
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (!toasts.length) return null;
  return (
    <div className="ux-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`ux-toast is-${toast.kind}`} onClick={() => dismissToast(toast.id)}>
          <span>{toast.message}</span>
          <i aria-hidden="true">×</i>
        </button>
      ))}
      {toasts.length > 1 && (
        <button type="button" className="ux-toast-clear" onClick={clearToasts}>Clear all</button>
      )}
    </div>
  );
}
