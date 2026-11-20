import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { FileBlob } from "../types";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const isImagePath = (file: string) => IMAGE_RE.test(file);

type Mode = "side" | "swipe" | "onion" | "difference";

/** Fork-style image diff: side-by-side, swipe, onion skin and pixel
 *  difference. Revisions: a commit-ish, "INDEX" or "WORKTREE". LFS pointers
 *  are smudged server-side via `git cat-file --filters`. */
export function ImageDiff({ repositoryPath, file, before, after }: { repositoryPath: string; file: string; before: string | null; after: string }) {
  const [left, setLeft] = useState<FileBlob | null>(null);
  const [right, setRight] = useState<FileBlob | null>(null);
  const [mode, setMode] = useState<Mode>("side");
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const [sizes, setSizes] = useState<{ left?: string; right?: string }>({});
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLeft(null); setRight(null);
    const missing: FileBlob = { exists: false, mime: "", size: 0, base64: "", lfs: false };
    (before ? api.fileBlob(repositoryPath, before, file) : Promise.resolve(missing)).then((value) => { if (!cancelled) setLeft(value); }).catch(() => { if (!cancelled) setLeft(missing); });
    api.fileBlob(repositoryPath, after, file).then((value) => { if (!cancelled) setRight(value); }).catch(() => { if (!cancelled) setRight(missing); });
    return () => { cancelled = true; };
  }, [repositoryPath, file, before, after]);

  const src = (blob: FileBlob | null) => (blob?.exists && blob.base64 ? `data:${blob.mime};base64,${blob.base64}` : "");
  const leftSrc = src(left);
  const rightSrc = src(right);

  useEffect(() => {
    if (mode !== "difference" || !leftSrc || !rightSrc || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const a = new Image(); const b = new Image();
    let loaded = 0;
    const draw = () => {
      loaded += 1; if (loaded < 2) return;
      const width = Math.max(a.naturalWidth, b.naturalWidth); const height = Math.max(a.naturalHeight, b.naturalHeight);
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      ctx.drawImage(a, 0, 0);
      ctx.globalCompositeOperation = "difference";
      ctx.drawImage(b, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    };
    a.onload = draw; b.onload = draw; a.src = leftSrc; b.src = rightSrc;
  }, [mode, leftSrc, rightSrc]);

  if (!left || !right) return <div className="ux-empty-state compact"><i className="ux-spinner" />Loading images…</div>;
  if (left.lfs || right.lfs) return <div className="ux-empty-state compact">Git LFS pointer — run LFS pull to fetch the image content.</div>;
  const kb = (blob: FileBlob) => (blob.exists ? `${(blob.size / 1024).toFixed(1)} KB` : "—");
  return (
    <div className="img-diff">
      <div className="img-diff-bar" role="group" aria-label="Image diff mode">
        {(["side", "swipe", "onion", "difference"] as Mode[]).map((value) => (
          <button key={value} type="button" className={mode === value ? "is-active" : ""} disabled={value !== "side" && (!leftSrc || !rightSrc)} onClick={() => setMode(value)}>{value === "side" ? "Side by side" : value === "swipe" ? "Swipe" : value === "onion" ? "Onion skin" : "Difference"}</button>
        ))}
        {mode === "swipe" && <input type="range" min={0} max={100} value={split} onChange={(event) => setSplit(Number(event.target.value))} aria-label="Swipe position" />}
        {mode === "onion" && <input type="range" min={0} max={100} value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} aria-label="New image opacity" />}
        <span>{before ? `${kb(left)}${sizes.left ? ` · ${sizes.left}` : ""}` : "added"} → {right.exists ? `${kb(right)}${sizes.right ? ` · ${sizes.right}` : ""}` : "deleted"}</span>
      </div>
      <div className="img-diff-stage">
        {mode === "side" && (
          <div className="img-side">
            <figure><figcaption>Before</figcaption>{leftSrc ? <img src={leftSrc} alt={`${file} before`} onLoad={(event) => { const label = `${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`; setSizes((value) => ({ ...value, left: label })); }} /> : <div className="img-missing">(none)</div>}</figure>
            <figure><figcaption>After</figcaption>{rightSrc ? <img src={rightSrc} alt={`${file} after`} onLoad={(event) => { const label = `${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`; setSizes((value) => ({ ...value, right: label })); }} /> : <div className="img-missing">(deleted)</div>}</figure>
          </div>
        )}
        {mode === "swipe" && (
          <div className="img-stack">
            <img src={leftSrc} alt={`${file} before`} />
            <img src={rightSrc} alt={`${file} after`} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
            <div className="img-swipe-line" style={{ left: `${split}%` }} aria-hidden="true" />
          </div>
        )}
        {mode === "onion" && (
          <div className="img-stack">
            <img src={leftSrc} alt={`${file} before`} />
            <img src={rightSrc} alt={`${file} after`} style={{ opacity: opacity / 100 }} />
          </div>
        )}
        {mode === "difference" && <canvas ref={canvasRef} className="img-canvas" aria-label="Pixel difference (black = identical)" />}
      </div>
    </div>
  );
}
