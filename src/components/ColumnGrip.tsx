import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

// Resizable layout: a grip on the right edge of a column header (or any
// positioned box) plus hooks that keep the chosen widths in localStorage.
// Drag to resize, ←/→ for keyboard users, double-click to restore the default.

type GripProps = {
  label: string;
  onDelta: (deltaX: number) => void;
  onReset?: () => void;
  step?: number;
};

export function ColumnGrip({ label, onDelta, onReset, step = 16 }: GripProps) {
  const lastX = useRef<number | null>(null);
  const start = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    lastX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    if (lastX.current === null) return;
    const delta = event.clientX - lastX.current;
    if (delta !== 0) { onDelta(delta); lastX.current = event.clientX; }
  };
  const stop = (event: PointerEvent<HTMLSpanElement>) => {
    lastX.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      onDelta(event.key === "ArrowLeft" ? -step : step);
    } else if ((event.key === "Enter" || event.key === "Home") && onReset) {
      event.preventDefault();
      onReset();
    }
  };
  return (
    <span
      className="ux-col-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} (drag, or ←/→; double-click to reset)`}
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => { event.stopPropagation(); onReset?.(); }}
      onKeyDown={key}
    />
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

function readNumber(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

/** One stored width, e.g. a side panel. */
export function useStoredWidth(key: string, fallback: number, min: number, max: number) {
  const [width, setWidth] = useState(() => clamp(readNumber(key) ?? fallback, min, max));
  const save = (next: number) => { try { localStorage.setItem(key, String(next)); } catch { /* storage full */ } return next; };
  const resize = useCallback((delta: number) => setWidth((current) => save(clamp(current + delta, min, max))), [key, min, max]);
  const reset = useCallback(() => { try { localStorage.removeItem(key); } catch { /* ignore */ } setWidth(clamp(fallback, min, max)); }, [key, fallback, min, max]);
  return [width, resize, reset] as const;
}

/** A set of stored column widths, e.g. the columns of a table. */
export function useStoredColumns<K extends string>(key: string, defaults: Record<K, number>, min: number, max = 900) {
  const [widths, setWidths] = useState<Record<K, number>>(() => {
    let saved: Partial<Record<K, number>> = {};
    try { saved = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}; } catch { saved = {}; }
    const next = { ...defaults };
    for (const column of Object.keys(defaults) as K[]) {
      const value = Number(saved[column]);
      if (Number.isFinite(value) && value > 0) next[column] = clamp(value, min, max);
    }
    return next;
  });
  const store = (next: Record<K, number>) => { try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage full */ } return next; };
  const resize = useCallback((column: K, delta: number) => {
    setWidths((current) => store({ ...current, [column]: clamp(current[column] + delta, min, max) }));
  }, [key, min, max]);
  const reset = useCallback((column: K) => {
    setWidths((current) => store({ ...current, [column]: defaults[column] }));
  }, [key]); // defaults is a module constant at every call site
  return [widths, resize, reset] as const;
}
