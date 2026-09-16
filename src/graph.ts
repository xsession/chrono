// Commit graph layout engine for the History timeline.
//
// Produces, for every commit, the line segments needed to render the DAG as one
// row per commit (top = lines arriving at the node, through = lines that cross
// the row, bottom = lines leaving toward the parents):
//
//   * `row`    — topological depth (children above parents, 0 = newest)
//   * `visRow` — unique render row index, in display order (one per commit)
//   * `lane`   — the column the node sits in
//   * `top`    — segments arriving at the node from its children
//   * `bottom` — segments leaving the node toward its parents
//   * `through`— lanes carrying a line that crosses this whole row
//
// `through` is computed from *edge spans*: every child→parent edge is active in
// each band strictly between the child's and the parent's visRows. That keeps a
// lane continuous across rows even when several commits share a depth (a merge
// and a branch tip on the same depth each get their own band) — which is what
// previously left gaps in a line.
//
// Pure + layout-only. Unit-tested in tests/graph-layout.test.ts.

import type { CommitRecord } from "./types";

export const GRAPH_COLORS = [
  "#4f9cf9", // blue
  "#70c58f", // green
  "#d88ae6", // purple
  "#e1a667", // orange
  "#67c4cd", // teal
  "#e06c75", // red
  "#c3a15f", // gold
  "#98c379", // light green
];

export const LANE_W = 19;
export const LANE_PAD = 13;
// Must equal the rendered row height (.ux-commit-rows .ux-commit-row in
// ux.css): each row's SVG spans the full row so vertical lines connect
// across row boundaries without a gap.
export const ROW_H = 38;

export function laneX(lane: number): number {
  return LANE_PAD + lane * LANE_W;
}

export function graphWidth(laneCount: number): number {
  return Math.max(96, LANE_PAD * 2 + Math.max(0, laneCount - 1) * LANE_W);
}

export interface GraphSegment {
  from: number;
  to: number;
  color: string;
  /** child commit ids feeding this arriving segment (top only) */
  sourceIds?: string[];
  /** parent commit id this departing segment targets (bottom only) */
  targetId?: string;
}

export interface GraphRowData {
  commit: CommitRecord;
  /** topological depth: children above parents, 0 = newest */
  row: number;
  /** unique render row index (display order) */
  visRow: number;
  /** lane the commit node sits in */
  lane: number;
  /** chain color of the node */
  color: string;
  /** segments arriving at the node (top half of the row) */
  top: GraphSegment[];
  /** lines crossing the whole row (from/to = the edge's row span) */
  through: { lane: number; color: string; from: number; to: number; childIds?: string[] }[];
  /** segments leaving the node toward parents (bottom half) */
  bottom: GraphSegment[];
  /** two or more parents */
  isMerge: boolean;
}

export interface GraphDepth {
  depth: number;
  /** commits at this depth, sorted by lane */
  items: GraphRowData[];
  /** lanes carrying a line through this whole depth (elision separators) */
  throughLanes: number[];
}

export interface GraphLayout {
  /** all commits in display order (visRow ascending) — render one row each */
  items: GraphRowData[];
  byId: Map<string, GraphRowData>;
  depths: GraphDepth[];
  /** lanes crossing each visRow (index = visRow); for filter-gap separators */
  visThrough: number[][];
  laneCount: number;
}

interface Hold {
  id: string;
  color: string;
  /** visRows of the children feeding this lane (span lower bound = min) */
  sourceRows: number[];
  /** ids of the children feeding this lane (mirrors sourceRows) */
  sourceIds: string[];
}

interface ActiveSpan {
  lane: number;
  color: string;
  from: number; // lowest visRow the edge starts below
  to: number; // target commit's visRow (-1 until the target is placed)
  /** commit ids of the children feeding this span */
  childIds?: string[];
}

function commitTime(commit: CommitRecord): number {
  const raw = commit.authoredAt ?? "";
  const value = Number(raw);
  const time = Number.isFinite(value) && /^\d+$/.test(raw)
    ? new Date(value * 1000).getTime()
    : new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function layoutGraph(commits: CommitRecord[]): GraphLayout {
  const empty: GraphLayout = { items: [], byId: new Map(), depths: [], visThrough: [], laneCount: 1 };
  if (commits.length === 0) return empty;

  const index = new Map(commits.map((commit) => [commit.id, commit]));
  const childrenOf = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (!index.has(parent)) continue;
      const list = childrenOf.get(parent) ?? [];
      list.push(commit.id);
      childrenOf.set(parent, list);
    }
  }

  // Depth (row) assignment: Kahn over child→parent edges, tips first.
  const rowOf = new Map<string, number>();
  const remaining = new Map<string, number>();
  for (const commit of commits) remaining.set(commit.id, childrenOf.get(commit.id)?.length ?? 0);
  const queue: string[] = [];
  for (const commit of commits) if ((remaining.get(commit.id) ?? 0) === 0) queue.push(commit.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const kids = childrenOf.get(id) ?? [];
    let deepest = -1;
    for (const kid of kids) {
      const kidRow = rowOf.get(kid);
      if (kidRow !== undefined && kidRow > deepest) deepest = kidRow;
    }
    rowOf.set(id, deepest + 1);
    const commit = index.get(id)!;
    for (const parent of commit.parents) {
      if (!index.has(parent)) continue;
      const left = (remaining.get(parent) ?? 1) - 1;
      remaining.set(parent, left);
      if (left === 0) queue.push(parent);
    }
  }
  commits.forEach((commit, inputOrder) => {
    if (!rowOf.has(commit.id)) rowOf.set(commit.id, inputOrder);
  });

  const maxDepth = Math.max(...[...rowOf.values()]);
  const atDepth = new Map<number, CommitRecord[]>();
  commits.forEach((commit, inputOrder) => {
    const depth = rowOf.get(commit.id) ?? inputOrder;
    const list = atDepth.get(depth) ?? [];
    list.push(commit);
    atDepth.set(depth, list);
  });
  for (const list of atDepth.values()) {
    list.sort((a, b) => commitTime(b) - commitTime(a) || (a.subject ?? "").localeCompare(b.subject ?? "") || a.id.localeCompare(b.id));
  }

  const holds: (Hold | null)[] = [];
  const spans: ActiveSpan[] = [];
  const byId = new Map<string, GraphRowData>();
  const items: GraphRowData[] = [];
  const depths: GraphDepth[] = [];
  // FIFO recycled palette (SourceGit ColorPicker): new edges dequeue a color;
  // when a hold dies the color goes back to the tail of the queue. Bounded to
  // the palette size and stable across merges — a lane keeps its color for
  // its whole lifetime instead of jumping when lane indices shift.
  const colorQueue: string[] = [];
  let nextVisRow = 0;

  const findHold = (id: string): number => {
    for (let lane = 0; lane < holds.length; lane += 1) if (holds[lane]?.id === id) return lane;
    return -1;
  };
  const firstFree = (): number => {
    for (let lane = 0; lane < holds.length; lane += 1) if (!holds[lane]) return lane;
    holds.push(null);
    return holds.length - 1;
  };
  // Lane for a new edge to `parentId`: reuse a lane already reserved for it
  // (merge the edge there) or the first unreserved lane. Never a lane held for
  // a different commit — that would drop the reserved edge.
  const laneForParent = (parentId: string): number => {
    const existing = findHold(parentId);
    if (existing !== -1) return existing;
    for (let lane = 0; lane < holds.length; lane += 1) if (!holds[lane]) return lane;
    return firstFree();
  };
  const pickColor = (): string => {
    // When nothing is free the palette is fully in flight, so re-arming it is
    // safe (no in-flight color can ever reappear mid-cycle).
    if (colorQueue.length === 0) colorQueue.push(...GRAPH_COLORS);
    return colorQueue.shift()!;
  };
  // A hold being consumed frees its color; the queue holds only FREE colors
  // (in-flight colors live on their holds), so a plain push keeps it unique
  // and oldest-first, exactly like SourceGit's ColorPicker.
  const recycleColor = (color: string): void => {
    colorQueue.push(color);
  };

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const list = atDepth.get(depth) ?? [];
    const placed: GraphRowData[] = [];
    const placedLanes = new Set<number>();
    // Held commits claim their reserved lanes before fresh tips are placed.
    const ordered = [...list.filter((commit) => findHold(commit.id) !== -1), ...list.filter((commit) => findHold(commit.id) === -1)];

    for (const commit of ordered) {
      const visRow = nextVisRow++;

      // Consume every hold targeting this commit (one per in-set child).
      const sources: { lane: number; color: string; visRow: number; ids: string[] }[] = [];
      for (let lane = 0; lane < holds.length; lane += 1) {
        const hold = holds[lane];
        if (hold && hold.id === commit.id) {
          const srcVis = Math.min(...hold.sourceRows);
          sources.push({ lane, color: hold.color, visRow: srcVis, ids: hold.sourceIds });
          // Finalize the span that fed this lane: it now ends at this commit.
          const span = spans.find((s) => s.lane === lane && s.to === -1 && s.color === hold.color);
          if (span) { span.to = visRow; span.from = srcVis; }
          else spans.push({ lane, color: hold.color, from: srcVis, to: visRow, childIds: hold.sourceIds });
          holds[lane] = null;
          recycleColor(hold.color);
        }
      }
      const minLane = sources.length > 0 ? Math.min(...sources.map((source) => source.lane)) : -1;
      let lane = minLane === -1 ? firstFree() : minLane;
      // Two tips (or shallow boundaries) can share a depth: shift right until
      // the lane is unique within this depth.
      while (placedLanes.has(lane)) lane += 1;
      placedLanes.add(lane);
      // The node inherits the min-lane source color; every other arriving
      // hold keeps its color queued (it stays a live edge into the node).
      const color = sources.length > 0 ? sources.find((source) => source.lane === minLane)!.color : pickColor();

      const data: GraphRowData = {
        commit,
        row: depth,
        visRow,
        lane,
        color,
        top: sources.map((source) => ({ from: source.lane, to: lane, color: source.color, sourceIds: source.ids })),
        through: [], // filled in a final pass once all spans are finalized
        bottom: [],
        isMerge: commit.parents.length >= 2,
      };

      commit.parents.forEach((parentId, parentIndex) => {
        if (!index.has(parentId)) return;
        const existing = findHold(parentId);
        if (existing === -1) {
          const toLane = parentIndex === 0 ? lane : laneForParent(parentId);
          const childColor = parentIndex === 0 ? color : pickColor();
          const hold: Hold = { id: parentId, color: childColor, sourceRows: [visRow], sourceIds: [commit.id] };
          holds[toLane] = hold;
          spans.push({ lane: toLane, color: childColor, from: visRow, to: -1, childIds: [commit.id] });
          data.bottom.push({ from: lane, to: toLane, color: childColor, targetId: parentId });
        } else {
          const hold = holds[existing]!;
          hold.sourceRows.push(visRow);
          if (!hold.sourceIds.includes(commit.id)) hold.sourceIds.push(commit.id);
          const span = spans.find((s) => s.lane === existing && s.color === hold.color && s.to === -1);
          if (span) {
            span.from = Math.min(span.from, visRow);
            if (!span.childIds!.includes(commit.id)) span.childIds!.push(commit.id);
          } else spans.push({ lane: existing, color: hold.color, from: visRow, to: -1, childIds: [commit.id] });
          data.bottom.push({ from: lane, to: existing, color: hold.color, targetId: parentId });
        }
      });

      byId.set(commit.id, data);
      items.push(data);
      placed.push(data);
    }

    const throughSet = new Set<number>();
    for (const span of spans) {
      if (span.from < nextVisRow - 1 && span.to > nextVisRow - 1) throughSet.add(span.lane);
    }
    depths.push({ depth, items: placed, throughLanes: [...throughSet] });
  }

  // Finalize dangling spans (parent outside the loaded set) at the last band.
  for (const span of spans) if (span.to === -1) span.to = nextVisRow - 1;

  // One pass to fill `through` and the visThrough table from finalized spans.
  const visThrough: number[][] = Array.from({ length: nextVisRow }, () => []);
  const throughAt = (vis: number): { lane: number; color: string; from: number; to: number; childIds?: string[] }[] => {
    const out: { lane: number; color: string; from: number; to: number; childIds?: string[] }[] = [];
    const seen = new Set<number>();
    for (const span of spans) {
      if (vis > span.from && vis < span.to && !seen.has(span.lane)) {
        seen.add(span.lane);
        out.push({ lane: span.lane, color: span.color, from: span.from, to: span.to, childIds: span.childIds });
      }
    }
    return out;
  };
  for (const item of items) {
    item.through = throughAt(item.visRow);
    visThrough[item.visRow] = item.through.map((t) => t.lane);
  }

  // `items` is already in visRow (display) order from the loop above.
  for (const depthInfo of depths) depthInfo.items.sort((a, b) => a.lane - b.lane);

  return { items, byId, depths, visThrough, laneCount: Math.max(1, holds.length) };
}

/**
 * First-parent ancestry of `startId` (SourceGit "SelectedCommitsOnly" walk):
 * the commit itself, then each first parent in turn, until a root or a parent
 * outside the loaded set. Returns the id set to highlight; the rest of the
 * graph renders dimmed.
 */
export function firstParentChain(commits: CommitRecord[], startId: string | null | undefined): Set<string> {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const chain = new Set<string>();
  let current = startId ?? null;
  while (current) {
    const commit = byId.get(current);
    if (!commit) break;
    chain.add(current);
    current = commit.parents[0] ?? null;
  }
  return chain;
}

/** Union of several id sets (all `null` → empty set). */
export function unionIds(...sets: Array<Set<string> | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const set of sets) if (set) for (const id of set) out.add(id);
  return out;
}

// ---------------------------------------------------------------------------
// Inline ref labels (GitEmber drawLabel / gitg LabelRenderer): branch/tag
// names painted as small rounded pills at the end of the lane in the graph
// column, prefix-stripped. Pure text math (no DOM) so it is unit-testable and
// usable from any renderer.
// ---------------------------------------------------------------------------

export type GraphLabelKind = "branch" | "tag" | "head";

export interface GraphLabel {
  /** display text, refs/…/ prefixes stripped */
  name: string;
  kind: GraphLabelKind;
}

const CHAR_W = 5.4;
const LABEL_PAD = 9;

export function labelTextWidth(text: string): number {
  return Math.round(text.length * CHAR_W + LABEL_PAD);
}

/** Pills shown for a commit row, in paint order (HEAD first, then
 *  branches, then tags). Prefix-stripped names, first-parent branch first. */
export function graphLabels(
  commitId: string,
  branches: { name: string; target: string; current: boolean; remote: boolean }[],
  headSha: string | null | undefined,
  tags: { name: string; target: string }[] = [],
): GraphLabel[] {
  const strip = (ref: string): string =>
    ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
  const entries: { label: GraphLabel; order: number }[] = [];
  if (headSha && commitId === headSha) entries.push({ label: { name: "HEAD", kind: "head" }, order: 0 });
  for (const branch of branches) {
    if (branch.target !== commitId || branch.remote) continue;
    entries.push({ label: { name: strip(branch.name), kind: "branch" }, order: branch.current ? 1 : 2 });
  }
  for (const tag of tags) if (tag.target === commitId) entries.push({ label: { name: tag.name, kind: "tag" }, order: 3 });
  // HEAD first, then the current branch, other branches, tags (name-stable).
  entries.sort((a, b) => a.order - b.order || a.label.name.localeCompare(b.label.name));
  return entries.map((entry) => entry.label);
}

/** Total px needed by a row's label pills (name width + 4px gaps + 6px start). */
export function graphLabelsWidth(labels: GraphLabel[]): number {
  if (labels.length === 0) return 0;
  return 6 + labels.reduce((sum, label) => sum + labelTextWidth(label.name), 0) + 4 * (labels.length - 1);
}

/** Y positions (row is ROW_H tall) for up to three 12px pills, step 12px —
 *  the whole stack always fits inside the row, so pills from adjacent rows
 *  can never collide. */
export function graphLabelYs(count: number): number[] {
  const out: number[] = [];
  const pillH = 12;
  const step = 12;
  const start = (ROW_H - (step * Math.max(0, count - 1) + pillH)) / 2;
  for (let i = 0; i < count; i += 1) out.push(Math.round(start + i * step));
  return out;
}
