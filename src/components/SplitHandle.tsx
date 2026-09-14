import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

type Props = {
  label: string;
  onDelta: (deltaX: number) => void;
  step?: number;
};

export function SplitHandle({ label, onDelta, step = 24 }: Props) {
  const lastX = useRef<number | null>(null);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    lastX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    if (lastX.current === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = event.clientX - lastX.current;
    if (delta !== 0) {
      onDelta(delta);
      lastX.current = event.clientX;
    }
  };

  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    lastX.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onDelta(-step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onDelta(step);
    }
  };

  return (
    <div
      className="ux-split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={keyResize}
    >
      <span aria-hidden="true" />
    </div>
  );
}
