import type { CommitRecord, HistoryPage } from "./types";

/** The UI requests a fixed-size page so offsets remain meaningful when the
 * user moves between newer and older history windows. */
export const HISTORY_PAGE_SIZE = 300;

/** Keep the graph bounded while still allowing a useful multi-thousand commit
 * inspection window. Older/newer pages are fetched again when the user moves
 * across the window boundary. */
export const HISTORY_MAX_PAGES = 12;

/** The fixed row height used by the history graph. Keeping this value next to
 * the viewport math makes the spacer dimensions deterministic and prevents a
 * large history from requiring one DOM node per commit. */
export const HISTORY_ROW_HEIGHT = 38;

export const HISTORY_VIEWPORT_OVERSCAN = 40;

export type HistoryViewport = {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
};

/** Return the bounded row slice that should be mounted for a scroll viewport.
 * The graph is still laid out for every loaded commit; only row DOM is
 * virtualized. Overscan keeps keyboard focus, wheel scrolling, and fast track
 * pad movement from exposing a blank edge. */
export function visibleHistoryRows(
  totalRows: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = HISTORY_VIEWPORT_OVERSCAN,
): HistoryViewport {
  const total = Math.max(0, Math.floor(Number.isFinite(totalRows) ? totalRows : 0));
  if (total === 0) return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 };
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const height = Math.max(HISTORY_ROW_HEIGHT, Number.isFinite(viewportHeight) ? viewportHeight : HISTORY_ROW_HEIGHT);
  const padding = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : HISTORY_VIEWPORT_OVERSCAN));
  const firstVisible = Math.min(total - 1, Math.floor(top / HISTORY_ROW_HEIGHT));
  const visibleCount = Math.max(1, Math.ceil(height / HISTORY_ROW_HEIGHT));
  const start = Math.max(0, firstVisible - padding);
  const end = Math.min(total, firstVisible + visibleCount + padding);
  return {
    start,
    end: Math.max(start, end),
    topSpacer: start * HISTORY_ROW_HEIGHT,
    bottomSpacer: Math.max(0, (total - end) * HISTORY_ROW_HEIGHT),
  };
}

export type HistorySegment = {
  offset: number;
  page: HistoryPage;
};

export type HistoryWindow = {
  commits: CommitRecord[];
  hasNewer: boolean;
  hasOlder: boolean;
  newerOffset: number | null;
  olderCursor: string | null;
  olderOffset: number | null;
};

function segmentOffset(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Insert a page and evict from the opposite edge of the navigation action.
 * This keeps the newest window when paging older, and keeps the oldest window
 * when paging newer; both cases retain a stable, bounded graph backbone. */
export function addHistoryPage(
  segments: HistorySegment[],
  offset: number,
  page: HistoryPage,
  direction: "older" | "newer",
  maxPages = HISTORY_MAX_PAGES,
): HistorySegment[] {
  const byOffset = new Map(segments.map((segment) => [segment.offset, segment]));
  byOffset.set(segmentOffset(offset), { offset: segmentOffset(offset), page });
  const sorted = [...byOffset.values()].sort((a, b) => a.offset - b.offset);
  const bounded = Math.max(1, Math.floor(maxPages));
  while (sorted.length > bounded) {
    if (direction === "older") sorted.shift();
    else sorted.pop();
  }
  return sorted;
}

export function flattenHistorySegments(segments: HistorySegment[]): CommitRecord[] {
  const seen = new Set<string>();
  const commits: CommitRecord[] = [];
  for (const segment of [...segments].sort((a, b) => a.offset - b.offset)) {
    for (const commit of segment.page.commits) {
      if (seen.has(commit.id)) continue;
      seen.add(commit.id);
      commits.push(commit);
    }
  }
  return commits;
}

export function summarizeHistoryWindow(segments: HistorySegment[]): HistoryWindow {
  const sorted = [...segments].sort((a, b) => a.offset - b.offset);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const hasNewer = Boolean(first && first.offset > 0);
  const newerOffset = hasNewer && first
    ? Math.max(0, first.offset - HISTORY_PAGE_SIZE)
    : null;
  const hasOlder = Boolean(last?.page.hasMore && last.page.nextCursor !== null);
  const olderCursor = hasOlder ? last.page.nextCursor : null;
  const olderOffset = olderCursor === null ? null : segmentOffset(Number(olderCursor));
  return {
    commits: flattenHistorySegments(sorted),
    hasNewer,
    hasOlder,
    newerOffset,
    olderCursor,
    olderOffset,
  };
}
