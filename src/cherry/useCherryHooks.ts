import { useEffect, useRef, useState } from "react";

export function useFrameCounter(enabled: boolean) {
  const [frames, setFrames] = useState(0);
  const [fps, setFps] = useState(0);
  const frameRef = useRef(0);
  const lastRef = useRef(performance.now());
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const tick = (now: number) => {
      frameRef.current += 1;
      if (now - lastRef.current >= 1000) {
        setFrames((value) => value + frameRef.current);
        setFps(frameRef.current);
        frameRef.current = 0;
        lastRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled]);

  return { frames, fps };
}
