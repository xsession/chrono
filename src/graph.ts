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

// Lane colours are CSS variables (defined in gk.css) so Settings → Display can
// swap in a colour-blind-safe palette without re-laying out the graph.
export const GRAPH_COLORS = [
  "var(--lane-0, #4f9cf9)", // blue
  "var(--lane-1, #70c58f)", // green
  "var(--lane-2, #d88ae6)", // purple
  "var(--lane-3, #e1a667)", // orange
  "var(--lane-4, #67c4cd)", // teal
  "var(--lane-5, #e06c75)", // red
  "var(--lane-6, #c3a15f)", // gold
  "var(--lane-7, #98c379)", // light green
];

export const LANE_W = 26;
export const LANE_PAD = 16;
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
        // A branch whose parent another lane already waits for keeps its own
        // lane down to that parent and bends in there (GitKraken / git log
        // --graph), instead of cutting across the lanes between right away.
        const ownLane = parentIndex === 0 && existing !== -1 && existing !== lane && !holds[lane];
        if (existing === -1 || ownLane) {
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

  // Tips that share a depth are shifted right past `holds` (several branch
  // tips on one parent never reserve those lanes), so count placed nodes too.
  const widest = items.reduce((max, item) => Math.max(max, item.lane + 1), 0);
  return { items, byId, depths, visThrough, laneCount: Math.max(1, holds.length, widest) };
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
// Ref tags (GitKraken Branch / Tag column): every ref that points at a
// commit, shown on that commit's row, i.e. at the top of its branch chain.
// A local branch and its remote-tracking twins (same short name) share one
// tag that says where the ref exists. Pure data, so it is unit-testable.
// ---------------------------------------------------------------------------

export type RefTagKind = "branch" | "head" | "tag" | "stash" | "worktree";

export interface RefTag {
  /** display text: refs/... prefixes and the remote name stripped */
  name: string;
  kind: RefTagKind;
  /** a local branch of this name points here */
  local: boolean;
  /** full names of remote-tracking branches of this name that point here */
  remotes: string[];
  /** the checked-out branch */
  current: boolean;
}

const stripRef = (ref: string): string =>
  ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");

/** Tags for one commit row, most important first: the current branch (or
 *  HEAD when detached), other branches, tags, stashes, worktree heads. */
export function commitRefTags(
  commitId: string,
  branches: { name: string; target: string; current: boolean; remote: boolean }[],
  headSha: string | null | undefined,
  tags: { name: string; target: string }[] = [],
  stashes: { ref: string; message: string; target: string }[] = [],
  worktrees: { path: string; branch: string | null; head: string }[] = [],
): RefTag[] {
  const byName = new Map<string, RefTag>();
  for (const branch of branches) {
    if (branch.target !== commitId) continue;
    const full = stripRef(branch.name);
    // origin/HEAD (listed as "origin") only names the remote's default branch.
    if (branch.remote && (!full.includes("/") || full.endsWith("/HEAD"))) continue;
    const name = branch.remote ? full.replace(/^[^/]+\//, "") : full;
    const tag = byName.get(name) ?? { name, kind: "branch" as const, local: false, remotes: [], current: false };
    if (branch.remote) tag.remotes.push(full);
    else tag.local = true;
    if (branch.current && !branch.remote) tag.current = true;
    byName.set(name, tag);
  }
  const out: { tag: RefTag; order: number }[] = [];
  const hasCurrent = [...byName.values()].some((tag) => tag.current);
  if (headSha && commitId === headSha && !hasCurrent) {
    out.push({ tag: { name: "HEAD", kind: "head", local: true, remotes: [], current: true }, order: 0 });
  }
  for (const tag of byName.values()) out.push({ tag, order: tag.current ? 0 : tag.local ? 1 : 2 });
  for (const tag of tags) if (tag.target === commitId) out.push({ tag: { name: stripRef(tag.name), kind: "tag", local: true, remotes: [], current: false }, order: 3 });
  for (const stash of stashes) if (stash.target === commitId) out.push({ tag: { name: stash.ref.replace(/^refs\/stash/, "stash"), kind: "stash", local: true, remotes: [], current: false }, order: 4 });
  // A worktree on a branch is already shown by that branch; only a detached
  // one needs its own tag.
  for (const worktree of worktrees) if (worktree.head === commitId && !(worktree.branch && byName.has(stripRef(worktree.branch)))) {
    out.push({ tag: { name: `wt:${worktree.branch || `detached ${worktree.head.slice(0, 8)}`}`, kind: "worktree", local: true, remotes: [], current: false }, order: 5 });
  }
  out.sort((a, b) => a.order - b.order || a.tag.name.localeCompare(b.tag.name));
  return out.map((entry) => entry.tag);
}

/** One-line description of a tag for tooltips and screen readers. */
export function describeRefTag(tag: RefTag): string {
  if (tag.kind !== "branch") return tag.name;
  const where = [tag.local ? "local" : "", ...tag.remotes].filter(Boolean).join(", ");
  return `${tag.name}${tag.current ? " (checked out)" : ""} — ${where}`;
}

// ---------------------------------------------------------------------------
// Author marks drawn inside the commit nodes: initials on a colour derived
// from the email, so one person keeps one colour across the whole graph.
// ---------------------------------------------------------------------------

export function authorInitials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((part) => [...part][0]?.toUpperCase() ?? "").join("").slice(0, 2) || "?";
}

export function authorHue(name: string, email: string): number {
  let hash = 0;
  for (const ch of (email || name).toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
