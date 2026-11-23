import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { plural } from "../plural";

type FileStat = { path: string; size: number; churn: number; commits: number };
type Node = { name: string; path: string; size: number; churn: number; commits: number; files: number; isDir: boolean };
type Rect = { x: number; y: number; w: number; h: number; node: Node };
type Metric = "size" | "churn";

/** Squarified treemap layout (Bruls et al.) of `nodes` inside a w×h box. */
function squarify(nodes: Node[], weight: (node: Node) => number, x: number, y: number, w: number, h: number): Rect[] {
  const items = nodes.map((node) => ({ node, value: weight(node) })).filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const rects: Rect[] = [];
  let rest = items.map((item) => ({ ...item, area: item.value * scale }));
  let box = { x, y, w, h };
  const worst = (row: typeof rest, side: number) => {
    const sum = row.reduce((total, item) => total + item.area, 0);
    const max = Math.max(...row.map((item) => item.area)); const min = Math.min(...row.map((item) => item.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(box.w, box.h);
    const row = [rest[0]];
    let index = 1;
    while (index < rest.length && worst([...row, rest[index]], side) <= worst(row, side)) { row.push(rest[index]); index += 1; }
    const sum = row.reduce((total, item) => total + item.area, 0);
    if (box.w >= box.h) {
      const width = sum / box.h; let cy = box.y;
      for (const item of row) { const height = item.area / width; rects.push({ x: box.x, y: cy, w: width, h: height, node: item.node }); cy += height; }
      box = { x: box.x + width, y: box.y, w: box.w - width, h: box.h };
    } else {
      const height = sum / box.w; let cx = box.x;
      for (const item of row) { const width = item.area / height; rects.push({ x: cx, y: box.y, w: width, h: height, node: item.node }); cx += width; }
      box = { x: box.x, y: box.y + height, w: box.w, h: box.h - height };
    }
    rest = rest.slice(index);
  }
  return rects;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** Repository treemap (Fork-style): area = file size or recent churn,
 *  colour = churn heat. Click a folder to drill in. */
export function RepoTreemap({ repositoryPath, onOpenFileHistory }: { repositoryPath: string; onOpenFileHistory?: (file: string) => void }) {
  const [data, setData] = useState<{ files: FileStat[]; truncated: boolean } | null>(null);
  const [days, setDays] = useState(90);
  const [metric, setMetric] = useState<Metric>("size");
  const [dir, setDir] = useState("");
  const [hover, setHover] = useState<Node | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 800, h: 480 });

  useEffect(() => { setData(null); setDir(""); api.treemap(repositoryPath, "HEAD", days).then(setData).catch(() => setData({ files: [], truncated: false })); }, [repositoryPath, days]);
  useEffect(() => {
    const element = boxRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBox({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo(() => {
    const prefix = dir ? `${dir}/` : "";
    const map = new Map<string, Node>();
    for (const file of data?.files ?? []) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash >= 0 ? rest.slice(0, slash) : rest;
      const key = prefix + name;
      const node = map.get(key) ?? { name, path: key, size: 0, churn: 0, commits: 0, files: 0, isDir: slash >= 0 };
      node.size += file.size; node.churn += file.churn; node.commits += file.commits; node.files += 1;
      map.set(key, node);
    }
    return [...map.values()];
  }, [data, dir]);

  const maxHeat = useMemo(() => Math.max(1, ...nodes.map((node) => node.churn / Math.max(1, node.files))), [nodes]);
  const rects = useMemo(() => squarify(nodes, (node) => (metric === "size" ? node.size : node.churn), 0, 0, box.w, box.h), [nodes, metric, box]);
  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="tm-view">
      <div className="tm-bar">
        <nav className="tg-breadcrumb" aria-label="Treemap location">
          <button type="button" onClick={() => setDir("")}>repository</button>
          {crumbs.map((part, index) => <span key={index}>/<button type="button" onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>{part}</button></span>)}
        </nav>
        <div className="gk-seg" role="group" aria-label="Area by"><button type="button" className={metric === "size" ? "is-active" : ""} onClick={() => setMetric("size")}>Area: size</button><button type="button" className={metric === "churn" ? "is-active" : ""} onClick={() => setMetric("churn")}>Area: churn</button></div>
        <label className="tm-days">Churn window<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value={3650}>all</option></select></label>
      </div>
      <div className="tm-canvas" ref={boxRef} role="img" aria-label={`Treemap of ${dir || "the repository"} by ${metric}`}>
        {!data && <div className="gk-empty"><i className="ux-spinner" />Measuring files…</div>}
        {data && !rects.length && <div className="gk-empty">{metric === "churn" ? "No changes in this window." : "No files."}</div>}
        {rects.map((rect) => {
          const heat = Math.min(1, (rect.node.churn / Math.max(1, rect.node.files)) / maxHeat);
          return (
            <button
              key={rect.node.path}
              type="button"
              className={`tm-cell${rect.node.isDir ? " is-dir" : ""}`}
              style={{ left: rect.x, top: rect.y, width: Math.max(0, rect.w - 1), height: Math.max(0, rect.h - 1), background: `hsl(${200 - heat * 200} ${45 + heat * 30}% ${22 + heat * 18}%)` }}
              onMouseEnter={() => setHover(rect.node)}
              onFocus={() => setHover(rect.node)}
              onClick={() => (rect.node.isDir ? setDir(rect.node.path) : onOpenFileHistory?.(rect.node.path))}
              title={`${rect.node.path}\n${formatBytes(rect.node.size)} · ${plural(rect.node.files, "file")} · ${rect.node.churn} lines changed in ${rect.node.commits} commit-file changes`}
            >
              {rect.w > 60 && rect.h > 18 && <span>{rect.node.name}{rect.node.isDir ? "/" : ""}</span>}
            </button>
          );
        })}
      </div>
      <footer className="tm-foot">
        {hover ? <span><b>{hover.path}</b> · {formatBytes(hover.size)} · {plural(hover.files, "file")} · {hover.churn} lines changed recently</span> : <span>Area = {metric === "size" ? "file size at HEAD" : "lines changed"}; colour = recent churn per file (blue calm → red hot). Click a folder to drill in.</span>}
        {data?.truncated && <em>Showing the 60,000 largest files.</em>}
      </footer>
    </div>
  );
}
