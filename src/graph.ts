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
export const ROW_H = 30;

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
  /** lines crossing the whole row */
  through: { lane: number; color: string }[];
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
}

interface ActiveSpan {
  lane: number;
  color: string;
  from: number; // lowest visRow the edge starts below
  to: number; // target commit's visRow (-1 until the target is placed)
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
  const usedColors = new Set<string>();
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
    for (const color of GRAPH_COLORS) if (!usedColors.has(color)) return color;
    return GRAPH_COLORS[usedColors.size % GRAPH_COLORS.length];
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
      const sources: { lane: number; color: string; visRow: number }[] = [];
      for (let lane = 0; lane < holds.length; lane += 1) {
        const hold = holds[lane];
        if (hold && hold.id === commit.id) {
          const srcVis = Math.min(...hold.sourceRows);
          sources.push({ lane, color: hold.color, visRow: srcVis });
          // Finalize the span that fed this lane: it now ends at this commit.
          const span = spans.find((s) => s.lane === lane && s.to === -1 && s.color === hold.color);
          if (span) { span.to = visRow; span.from = srcVis; }
          else spans.push({ lane, color: hold.color, from: srcVis, to: visRow });
          holds[lane] = null;
          usedColors.delete(hold.color);
        }
      }
      const minLane = sources.length > 0 ? Math.min(...sources.map((source) => source.lane)) : -1;
      let lane = minLane === -1 ? firstFree() : minLane;
      // Two tips (or shallow boundaries) can share a depth: shift right until
      // the lane is unique within this depth.
      while (placedLanes.has(lane)) lane += 1;
      placedLanes.add(lane);
      const sourceColors = new Set(sources.map((source) => source.color));
      const color = sourceColors.size > 0 ? sources.find((source) => source.lane === minLane)!.color : pickColor();
      usedColors.add(color);

      const data: GraphRowData = {
        commit,
        row: depth,
        visRow,
        lane,
        color,
        top: sources.map((source) => ({ from: source.lane, to: lane, color: source.color })),
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
          usedColors.add(childColor);
          const hold: Hold = { id: parentId, color: childColor, sourceRows: [visRow] };
          holds[toLane] = hold;
          spans.push({ lane: toLane, color: childColor, from: visRow, to: -1 });
          data.bottom.push({ from: lane, to: toLane, color: childColor });
        } else {
          const hold = holds[existing]!;
          hold.sourceRows.push(visRow);
          const span = spans.find((s) => s.lane === existing && s.color === hold.color && s.to === -1);
          if (span) span.from = Math.min(span.from, visRow);
          else spans.push({ lane: existing, color: hold.color, from: visRow, to: -1 });
          data.bottom.push({ from: lane, to: existing, color: hold.color });
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
  const throughAt = (vis: number): { lane: number; color: string }[] => {
    const out: { lane: number; color: string }[] = [];
    const seen = new Set<number>();
    for (const span of spans) {
      if (vis > span.from && vis < span.to && !seen.has(span.lane)) {
        seen.add(span.lane);
        out.push({ lane: span.lane, color: span.color });
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
