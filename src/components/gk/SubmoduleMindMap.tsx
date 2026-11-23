import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { SubmoduleNode, SubmoduleTree } from "../../types";
import { submoduleStatus } from "./SubmoduleMap";
import type { ForkStatus } from "../../types";

// Mind-map view of a nested submodule hierarchy. The superproject sits in the
// middle; top-level submodules are split left/right by subtree size so the
// map stays balanced, and nested levels branch outwards. Collapsed branches
// keep a badge with how many nested submodules need attention, so a 4-level,
// 100-node tree can be read from the root without opening everything.

type Props = {
  tree: SubmoduleTree;
  rootName: string;
  selected: string | null;
  picked: Set<string>;
  passes: (node: SubmoduleNode) => boolean;
  filtering: boolean;
  onSelect: (path: string | null, additive: boolean) => void;
  onOpen: (node: SubmoduleNode) => void;
  onContextMenu: (event: ReactMouseEvent, node: SubmoduleNode) => void;
  /** Fork status by submodule path (forks.ts): a ⑂ mark and the upstream in the tooltip. */
  forks?: Map<string, ForkStatus>;
};

const NODE_W = 188;
const NODE_H = 28;
const ROW = 38;
const COL = 236;
const ROOT_W = 210;
const ROOT_GAP = 150;

type Placed = { node: SubmoduleNode; x: number; y: number; side: 1 | -1; parentX: number; parentY: number; collapsed: boolean; hiddenChildren: number };

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function SubmoduleMindMap({ tree, rootName, selected, picked, passes, filtering, onSelect, onOpen, onContextMenu, forks }: Props) {
  const children = useMemo(() => {
    const map = new Map<string | null, SubmoduleNode[]>();
    for (const node of tree.nodes) map.set(node.parent, [...(map.get(node.parent) ?? []), node]);
    return map;
  }, [tree]);

  // Big trees start with deep levels folded, except branches that contain problems.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed(tree));
  useEffect(() => { setCollapsed(initialCollapsed(tree)); }, [tree.root]); // eslint-disable-line react-hooks/exhaustive-deps

  // With a filter active, keep only matches and their ancestors.
  const visibleSet = useMemo(() => {
    if (!filtering) return null;
    const byPath = new Map(tree.nodes.map((node) => [node.path, node]));
    const keep = new Set<string>();
    for (const node of tree.nodes) {
      if (!passes(node)) continue;
      for (let cursor: string | null = node.path; cursor; cursor = byPath.get(cursor)?.parent ?? null) keep.add(cursor);
    }
    return keep;
  }, [tree, passes, filtering]);

  const layout = useMemo(() => {
    const kids = (path: string | null) => (children.get(path) ?? []).filter((node) => !visibleSet || visibleSet.has(node.path));
    const isOpen = (node: SubmoduleNode) => filtering || !collapsed.has(node.path);
    const weight = new Map<string, number>();
    const measure = (node: SubmoduleNode): number => {
      const list = isOpen(node) ? kids(node.path) : [];
      const value = list.length ? list.reduce((sum, child) => sum + measure(child), 0) : 1;
      weight.set(node.path, value);
      return value;
    };
    const top = kids(null);
    top.forEach(measure);
    // Balance the two halves by leaf count, keeping the original order on each side.
    const right: SubmoduleNode[] = [];
    const left: SubmoduleNode[] = [];
    let rightWeight = 0;
    let leftWeight = 0;
    // Largest branches first, each to the lighter side; then restore the original order per side.
    const order = new Map(top.map((node, index) => [node.path, index]));
    for (const node of [...top].sort((a, b) => (weight.get(b.path) ?? 1) - (weight.get(a.path) ?? 1))) {
      const w = weight.get(node.path) ?? 1;
      if (rightWeight <= leftWeight) { right.push(node); rightWeight += w; } else { left.push(node); leftWeight += w; }
    }
    const byOrder = (a: SubmoduleNode, b: SubmoduleNode) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
    right.sort(byOrder);
    left.sort(byOrder);
    const placed: Placed[] = [];
    const place = (list: SubmoduleNode[], side: 1 | -1, depth: number, top: number, parentX: number, parentY: number) => {
      let cursor = top;
      for (const node of list) {
        const w = weight.get(node.path) ?? 1;
        const y = (cursor + w / 2) * ROW;
        const x = side * (ROOT_W / 2 + ROOT_GAP + depth * COL) + (side === 1 ? 0 : -NODE_W);
        const open = isOpen(node);
        const all = children.get(node.path) ?? [];
        placed.push({ node, x, y, side, parentX, parentY, collapsed: !open && all.length > 0, hiddenChildren: open ? 0 : all.length });
        if (open) place(kids(node.path), side, depth + 1, cursor, side === 1 ? x + NODE_W : x, y);
        cursor += w;
      }
    };
    const total = Math.max(rightWeight, leftWeight, 1);
    place(right, 1, 0, -rightWeight / 2, ROOT_W / 2, 0);
    place(left, -1, 0, -leftWeight / 2, -ROOT_W / 2, 0);
    let minX = -ROOT_W / 2, maxX = ROOT_W / 2, minY = -ROW, maxY = ROW;
    for (const item of placed) {
      minX = Math.min(minX, item.x - 30); maxX = Math.max(maxX, item.x + NODE_W + 30);
      minY = Math.min(minY, item.y - ROW); maxY = Math.max(maxY, item.y + ROW);
    }
    return { placed, bounds: { minX, maxX, minY, maxY }, total };
  }, [children, collapsed, visibleSet, filtering]);

  // ---- pan & zoom -------------------------------------------------------
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 500 });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    setSize({ w: element.clientWidth, h: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    const { minX, maxX, minY, maxY } = layout.bounds;
    const k = Math.min(1.2, Math.max(0.25, Math.min(size.w / (maxX - minX), size.h / (maxY - minY))));
    setView({ k, x: size.w / 2 - ((minX + maxX) / 2) * k, y: size.h / 2 - ((minY + maxY) / 2) * k });
  }, [layout.bounds, size]);
  const fitted = useRef<string>("");
  useEffect(() => {
    const key = `${tree.root}|${size.w}x${size.h}`;
    if (fitted.current !== key && size.w > 0) { fitted.current = key; fit(); }
  }, [fit, size, tree.root]);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent) => {
    if ((event.target as Element).closest(".mm-node, .mm-toggle")) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
    setView((current) => ({ ...current, x: state.vx + dx, y: state.vy + dy }));
  };
  const onPointerUp = () => {
    if (drag.current && !drag.current.moved) onSelect(null, false);
    drag.current = null;
  };
  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) => setView((current) => {
    const k = Math.min(2.5, Math.max(0.15, current.k * factor));
    const ratio = k / current.k;
    return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
  });
  const onWheel = (event: ReactWheelEvent) => {
    const rect = host.current!.getBoundingClientRect();
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
  };
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const stop = (event: WheelEvent) => event.preventDefault();
    element.addEventListener("wheel", stop, { passive: false });
    return () => element.removeEventListener("wheel", stop);
  }, []);

  const toggle = (path: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const expandAll = () => setCollapsed(new Set());
  const collapseLevel = (depth: number) => setCollapsed(new Set(tree.nodes.filter((node) => node.depth >= depth && node.children > 0).map((node) => node.path)));

  // Keep the selected node in view (e.g. when picked from search).
  useEffect(() => {
    if (!selected) return;
    const item = layout.placed.find((entry) => entry.node.path === selected);
    if (!item) return;
    const sx = item.x * view.k + view.x;
    const sy = item.y * view.k + view.y;
    if (sx < 0 || sx + NODE_W * view.k > size.w || sy < 0 || sy > size.h) {
      setView((current) => ({ ...current, x: size.w / 2 - (item.x + NODE_W / 2) * current.k, y: size.h / 2 - item.y * current.k }));
    }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const edge = (item: Placed) => {
    const startX = item.parentX;
    const startY = item.parentY;
    const endX = item.side === 1 ? item.x : item.x + NODE_W;
    const endY = item.y;
    const mid = (startX + endX) / 2;
    return `M ${startX} ${startY} C ${mid} ${startY}, ${mid} ${endY}, ${endX} ${endY}`;
  };

  const rootDirty = tree.nodes.filter((node) => !node.parent && (node.attentionBelow > 0 || submoduleStatus(node).tone !== "ok")).length;

  return (
    <div className="mm-wrap">
      <div className="mm-tools" role="toolbar" aria-label="Mind map controls">
        <span className="mm-legend" aria-hidden="true"><i className="mm-tone-ok" />clean <i className="mm-tone-dirty" />changed <i className="mm-tone-drift" />moved <i className="mm-tone-off is-off" />not initialized <i className="mm-tone-bad" />conflict <b>⇣n</b> behind branch</span>
        <span className="mm-sep" />
        <button type="button" className="ux-button compact" onClick={fit} title="Fit the whole map">Fit</button>
        <button type="button" className="ux-icon-button" onClick={() => zoomAt(1.2)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className="ux-icon-button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" title="Zoom out">−</button>
        <span className="mm-sep" />
        <button type="button" className="ux-button compact" onClick={expandAll}>Expand all</button>
        <button type="button" className="ux-button compact" onClick={() => collapseLevel(1)} title="Show only top-level submodules">Level 1</button>
        <button type="button" className="ux-button compact" onClick={() => collapseLevel(2)} title="Show two levels">Level 2</button>
        <span className="mm-hint" title="Drag to pan · wheel to zoom · Ctrl/Shift+click to select several · Space folds a branch">Drag · wheel · Ctrl+click</span>
      </div>
      <div
        ref={host}
        className="mm-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      >
        <svg width={size.w} height={size.h} role="tree" aria-label="Submodule mind map">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {layout.placed.map((item) => (
              <path key={`e:${item.node.path}`} d={edge(item)} className={`mm-edge mm-tone-${submoduleStatus(item.node).tone}${filtering && !passes(item.node) ? " is-context" : ""}`} />
            ))}
            <g className="mm-root" transform={`translate(${-ROOT_W / 2} ${-NODE_H})`}>
              <rect width={ROOT_W} height={NODE_H * 2} rx={14} />
              <text x={ROOT_W / 2} y={rootDirty ? 20 : 25} textAnchor="middle" className="mm-root-name">{truncate(rootName, 24)}</text>
              <text x={ROOT_W / 2} y={rootDirty ? 35 : 42} textAnchor="middle" className="mm-root-sub">{tree.totals.all} submodules · {tree.maxDepth} level{tree.maxDepth === 1 ? "" : "s"}</text>
              {rootDirty > 0 && <text x={ROOT_W / 2} y={49} textAnchor="middle" className="mm-root-warn">{rootDirty} branch{rootDirty === 1 ? "" : "es"} need attention</text>}
            </g>
            {layout.placed.map((item) => {
              const { node } = item;
              const status = submoduleStatus(node);
              const isSelected = selected === node.path;
              const isPicked = picked.has(node.path);
              const badge = item.collapsed ? (node.attentionBelow ? `${node.attentionBelow}!` : `+${item.hiddenChildren}`) : null;
              const toggleX = item.side === 1 ? NODE_W + 10 : -10;
              return (
                <g key={node.path} transform={`translate(${item.x} ${item.y - NODE_H / 2})`} role="treeitem" aria-level={node.depth + 1} aria-selected={isSelected} aria-expanded={node.children ? !item.collapsed : undefined}>
                  <g
                    className={`mm-node mm-tone-${status.tone}${isSelected ? " is-selected" : ""}${isPicked ? " is-picked" : ""}${filtering && !passes(node) ? " is-context" : ""}`}
                    tabIndex={0}
                    onClick={(event) => onSelect(node.path, event.ctrlKey || event.metaKey || event.shiftKey)}
                    onDoubleClick={() => onOpen(node)}
                    onContextMenu={(event) => { onSelect(node.path, false); onContextMenu(event, node); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onOpen(node);
                      if (event.key === " " && node.children) { event.preventDefault(); toggle(node.path); }
                    }}
                  >
                    <title>{`${node.path}\n${status.title}${node.branch ? `\nbranch ${node.branch}` : `\n${node.commit.slice(0, 10)}`}${node.tracking ? `\ntracks origin/${node.tracking.branch}${node.tracking.behind ? ` — ${node.tracking.behind} commits behind` : ""}` : ""}${node.url ? `\n${node.url}` : ""}${forks?.get(node.path)?.kind === "fork" ? `\nfork of ${forks.get(node.path)!.upstream?.url}${forks.get(node.path)!.behind ? ` — ${forks.get(node.path)!.behind} commits behind upstream` : ""}` : ""}`}</title>
                    <rect width={NODE_W} height={NODE_H} rx={7} />
                    <circle cx={13} cy={NODE_H / 2} r={4.5} className="mm-dot" />
                    <text x={24} y={NODE_H / 2 + 4} className="mm-name">{forks?.get(node.path)?.kind === "fork" ? "⑂ " : ""}{truncate(node.name, status.tone === "ok" ? 22 : 15)}</text>
                    {status.tone !== "ok"
                      ? <text x={NODE_W - 8} y={NODE_H / 2 + 4} textAnchor="end" className="mm-state">{truncate(status.label.split(" · ")[0], 12)}</text>
                      : (node.tracking?.behind ?? 0) > 0 && <text x={NODE_W - 8} y={NODE_H / 2 + 4} textAnchor="end" className="mm-behind">⇣{node.tracking!.behind}</text>}
                    {isPicked && <rect className="mm-pick" x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={9} />}
                  </g>
                  {node.children > 0 && (
                    <g className={`mm-toggle${node.attentionBelow && item.collapsed ? " has-attention" : ""}`} transform={`translate(${toggleX} ${NODE_H / 2})`} onClick={() => toggle(node.path)} role="button" aria-label={item.collapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}>
                      <title>{item.collapsed ? `${node.children} nested submodule(s)${node.attentionBelow ? `, ${node.attentionBelow} need attention` : ""} — click to expand` : "Collapse"}</title>
                      <circle r={badge && badge.length > 2 ? 12 : 9} />
                      <text y={4} textAnchor="middle">{badge ?? "−"}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {filtering && layout.placed.length === 0 && <div className="mm-empty">No submodule matches.</div>}
      </div>
    </div>
  );
}

function initialCollapsed(tree: SubmoduleTree): Set<string> {
  if (tree.nodes.length <= 60) return new Set();
  // Large maps: fold everything below level 1 unless it hides a problem.
  return new Set(tree.nodes.filter((node) => node.children > 0 && node.depth >= 1 && node.attentionBelow === 0).map((node) => node.path));
}
