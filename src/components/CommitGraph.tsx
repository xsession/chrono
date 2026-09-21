import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { BranchRecord, CommitDetails, CommitRecord, HistoryChangeStat, StashRef, TagRecord, WorktreeSummary } from "../types";
import { api } from "../api";
import {
  graphLabelYs, graphLabels, graphLabelsWidth, graphWidth, labelTextWidth,
  firstParentChain, laneX, layoutGraph, ROW_H, unionIds,
} from "../graph";
import type { GraphLabel, GraphRowData } from "../graph";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";
import { CommitDiffView } from "./CommitDiffView";
import { reachableCommitIds, referenceKey, visibleRefCommitIds } from "../refVisibility";
import { visibleHistoryRows } from "../historyWindow";

type Props = {
  repositoryPath: string;
  commits: CommitRecord[];
  branches: BranchRecord[];
  headSha?: string;
  selected: CommitRecord | null;
  onSelect: (commit: CommitRecord) => void;
  onCopyCommit?: (commit: string) => void | Promise<void>;
  onCommitAction?: (action: "cherry-pick" | "revert", commit: CommitRecord) => void | Promise<void>;
  onCreateBranchAt?: (commit: CommitRecord) => void | Promise<void>;
  onCreateTagAt?: (commit: CommitRecord) => void | Promise<void>;
  onResetTo?: (commit: CommitRecord, mode: "soft" | "mixed" | "hard") => void | Promise<void>;
  actionBusy?: boolean;
  onOpenWorktree?: (path: string) => void | Promise<void>;
  historyHasNewer?: boolean;
  historyHasMore?: boolean;
  historyLoading?: boolean;
  historyLoadingDirection?: "older" | "newer" | null;
  onLoadNewer?: () => void | Promise<void>;
  onLoadMore?: () => void | Promise<void>;
};

type HighlightMode = "all" | "current" | "selected";
type FilterMode = "message" | "author" | "path";
type GraphScope = "all" | "current" | `branch:${string}`;

const HIGHLIGHT_STORAGE = "chrono.history.highlight";
const FILTER_HISTORY_STORAGE = "chrono.history.filterHistory";
const GRAPH_SCOPE_STORAGE = "chrono.history.scope";
const HIDDEN_REFS_STORAGE = "chrono.history.hiddenRefs";
const FILTER_HISTORY_MAX = 10;

function formatDate(value: string): string {
  const date = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function loadStoredHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_HISTORY_STORAGE) ?? "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string").slice(0, FILTER_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function loadHiddenRefs(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_REFS_STORAGE) ?? "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

type DisplayItem =
  | { kind: "commit"; item: GraphRowData }
  | { kind: "elided"; key: number; count: number; throughLanes: number[] };

type CommitContextMenu = {
  commit: CommitRecord;
  x: number;
  y: number;
};

/** SVG of one commit row: arriving lines (top), pass-through lines, lines
 *  leaving toward parents (bottom), the node, and inline ref pills.
 *  When `highlight` is a set, every piece of geometry not feeding from / to
 *  a highlighted commit is dimmed (SourceGit highlight modes). */
function RowGraph({
  item, isHead, highlight, labels, labelX, svgWidth,
}: {
  item: GraphRowData;
  isHead: boolean;
  /** null = no dimming; otherwise the highlighted commit id set */
  highlight: Set<string> | null;
  labels: GraphLabel[];
  labelX: number;
  svgWidth: number;
}) {
  const y = ROW_H / 2;
  const dimOf = (ids: string[] | undefined): boolean =>
    highlight !== null && !(ids ?? []).some((id) => highlight.has(id));
  const nodeDim = highlight !== null && !highlight.has(item.commit.id);
  const visibleLabels = labels.slice(0, 3);
  const labelYs = graphLabelYs(visibleLabels.length);
  let labelOffset = labelX;
  return (
    <svg className="ux-graph-svg" width={svgWidth} height={ROW_H} viewBox={`0 0 ${svgWidth} ${ROW_H}`} aria-hidden="true">
      {item.through.map((seg, index) => (
        <line key={`t${index}`} className={`ux-graph-line${dimOf(seg.childIds) ? " is-dim" : ""}`} style={{ stroke: seg.color }} x1={laneX(seg.lane)} y1={0} x2={laneX(seg.lane)} y2={ROW_H} />
      ))}
      {item.top.map((seg, index) => (
        <line key={`top${index}`} className={`ux-graph-line${dimOf(seg.sourceIds) ? " is-dim" : ""}`} style={{ stroke: seg.color }} x1={laneX(seg.from)} y1={0} x2={laneX(seg.to)} y2={y} />
      ))}
      {item.bottom.map((seg, index) => (
        <line key={`b${index}`} className={`ux-graph-line${dimOf(seg.targetId ? [seg.targetId] : undefined) ? " is-dim" : ""}`} style={{ stroke: seg.color }} x1={laneX(seg.from)} y1={y} x2={laneX(seg.to)} y2={ROW_H} />
      ))}
      {item.isMerge
        ? <>
            <circle cx={laneX(item.lane)} cy={y} r={7.5} className={`ux-graph-node ux-graph-node--merge${nodeDim ? " is-dim" : ""}`} style={{ stroke: item.color }} />
            {isHead && <circle cx={laneX(item.lane)} cy={y} r={3} style={{ fill: "var(--ux-accent)" }} />}
          </>
        : <circle cx={laneX(item.lane)} cy={y} r={5} className={`ux-graph-node${nodeDim ? " is-dim" : ""}`} style={{ stroke: item.color }} />}
      {visibleLabels.map((label, index) => {
        const width = labelTextWidth(label.name);
        const pillX = labelOffset;
        const pillY = labelYs[index];
        labelOffset += width + 4;
        return (
          <g key={label.name} className={`ux-graph-label${nodeDim ? " is-dim" : ""}`}>
            <title>{label.name}</title>
            <rect x={pillX} y={pillY} width={width} height={12} rx={6} className={`ux-graph-label-box ux-graph-label-box--${label.kind}`} />
            <text x={pillX + width / 2} y={pillY + 9} textAnchor="middle" className={`ux-graph-label-text${label.kind === "head" ? " ux-graph-label-text--head" : ""}`}>{label.name}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function CommitGraph({ repositoryPath, commits, branches, headSha, selected, onSelect, onCopyCommit, onCommitAction, onCreateBranchAt, onCreateTagAt, onResetTo, actionBusy = false, onOpenWorktree, historyHasNewer = false, historyHasMore = false, historyLoading = false, historyLoadingDirection = null, onLoadNewer, onLoadMore }: Props) {
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("message");
  const [filterBusy, setFilterBusy] = useState(false);
  const [filteredCommits, setFilteredCommits] = useState<CommitRecord[] | null>(null);
  const [filterHistory, setFilterHistory] = useState<string[]>(loadStoredHistory);
  const [filterHistoryIndex, setFilterHistoryIndex] = useState<number | null>(null);
  const [highlightMode, setHighlightMode] = useState<HighlightMode>(() => {
    const stored = localStorage.getItem(HIGHLIGHT_STORAGE);
    return stored === "current" || stored === "selected" ? stored : "all";
  });
  const [graphScope, setGraphScope] = useState<GraphScope>(() => {
    const stored = localStorage.getItem(GRAPH_SCOPE_STORAGE);
    return stored === "all" || stored === "current" || stored?.startsWith("branch:") ? stored as GraphScope : "all";
  });
  const [hiddenRefs, setHiddenRefs] = useState<string[]>(loadHiddenRefs);
  const [refMenuOpen, setRefMenuOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(380);
  const [stats, setStats] = useState<Map<string, HistoryChangeStat>>(new Map());
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([]);
  const [showChanges, setShowChanges] = useState(() => localStorage.getItem("chrono.history.changes") !== "off");
  const [graphColWidthOverride, setGraphColWidthOverride] = useState<number>(() => Number.parseInt(localStorage.getItem("chrono.history.graphWidth") ?? "0", 10) || 0);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [stashes, setStashes] = useState<StashRef[]>([]);
  const [openingWorktree, setOpeningWorktree] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<CommitContextMenu | null>(null);
  const [historyViewport, setHistoryViewport] = useState({ scrollTop: 0, height: 720 });
  const historyGridRef = useRef<HTMLDivElement | null>(null);
  const graphDrag = useRef<number | null>(null);
  const currentBranch = branches.find((branch) => branch.current);
  const refBranches = useMemo(() => branches.filter((branch) => branch.name.length > 0), [branches]);

  const setHighlight = (mode: HighlightMode) => {
    setHighlightMode(mode);
    localStorage.setItem(HIGHLIGHT_STORAGE, mode);
  };

  const setScope = (scope: GraphScope) => {
    setGraphScope(scope);
    localStorage.setItem(GRAPH_SCOPE_STORAGE, scope);
    const branch = scope === "current" ? currentBranch : scope.startsWith("branch:")
      ? branches.find((candidate) => !candidate.remote && `branch:${candidate.name}` === scope)
      : null;
    if (branch) {
      setHiddenRefs((previous) => {
        const next = previous.filter((value) => value !== referenceKey(branch));
        localStorage.setItem(HIDDEN_REFS_STORAGE, JSON.stringify(next));
        return next;
      });
    }
  };

  const focusedBranch = graphScope === "current"
    ? currentBranch
    : graphScope.startsWith("branch:")
      ? branches.find((branch) => !branch.remote && `branch:${branch.name}` === graphScope)
      : undefined;

  useEffect(() => {
    const valid = new Set(refBranches.map(referenceKey));
    setHiddenRefs((previous) => {
      const next = previous.filter((value) => valid.has(value));
      if (next.length !== previous.length) localStorage.setItem(HIDDEN_REFS_STORAGE, JSON.stringify(next));
      return next;
    });
  }, [refBranches]);

  const persistHiddenRefs = (next: string[]) => {
    setHiddenRefs(next);
    localStorage.setItem(HIDDEN_REFS_STORAGE, JSON.stringify(next));
  };
  const toggleRef = (branch: BranchRecord) => {
    const key = referenceKey(branch);
    persistHiddenRefs(hiddenRefs.includes(key) ? hiddenRefs.filter((value) => value !== key) : [...hiddenRefs, key]);
  };
  const soloRef = (branch: BranchRecord) => {
    const key = referenceKey(branch);
    persistHiddenRefs(refBranches.filter((candidate) => referenceKey(candidate) !== key).map(referenceKey));
  };

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextMenu]);

  const runContextAction = (action: () => void | Promise<void>) => {
    setContextMenu(null);
    void action();
  };

  // Server-side filter (SourceGit QueryCommits): message = per-word --grep
  // AND, author = --author, path = literal pathspec; scans --all. `null`
  // means "no active filter" → show the loaded HEAD history.
  const filterKey = `${filterMode}\u0000${query.trim()}`;
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setFilteredCommits(null);
      setFilterBusy(false);
      return;
    }
    let cancelled = false;
    setFilterBusy(true);
    setFilterHistoryIndex(null);
    const timer = setTimeout(() => {
      api.historyQuery(repositoryPath, { query: needle, mode: filterMode, limit: 300 })
        .then((rows) => { if (!cancelled) setFilteredCommits(rows); })
        .catch(() => { if (!cancelled) setFilteredCommits([]); })
        .finally(() => { if (!cancelled) setFilterBusy(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [filterKey, repositoryPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter-history completion (gitg entry history): ↑/↓ cycle previous
  // filters, Enter commits the current one to the persisted list.
  const commitFilterHistory = (value: string) => {
    const needle = value.trim();
    if (!needle) return;
    setFilterHistory((previous) => {
      const next = [needle, ...previous.filter((entry) => entry !== needle)].slice(0, FILTER_HISTORY_MAX);
      localStorage.setItem(FILTER_HISTORY_STORAGE, JSON.stringify(next));
      return next;
    });
    setFilterHistoryIndex(null);
  };
  const onFilterKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitFilterHistory(query);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      if (filterHistory.length === 0) return;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      const nextIndex = filterHistoryIndex === null
        ? (direction === 1 ? 0 : filterHistory.length - 1)
        : (filterHistoryIndex + direction + filterHistory.length) % filterHistory.length;
      setFilterHistoryIndex(nextIndex);
      setQuery(filterHistory[nextIndex]);
    }
  };

  const onFilterChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setQuery(value);
    if (filterHistoryIndex !== null && value !== filterHistory[filterHistoryIndex]) {
      setFilterHistoryIndex(null);
    }
  };

  // Keep loaded history as the graph backbone, but merge in search results
  // that predate the loaded window so filtering never silently hides a match.
  // Missing parents still render as explicit graph gaps.
  const graphCandidates = useMemo(() => {
    if (!filteredCommits) return commits;
    const seen = new Set(commits.map((commit) => commit.id));
    return [...commits, ...filteredCommits.filter((commit) => !seen.has(commit.id))];
  }, [commits, filteredCommits]);
  const scopeIds = useMemo(() => {
    const visibleIds = visibleRefCommitIds(graphCandidates, branches, hiddenRefs);
    if (!focusedBranch) return visibleIds;
    const focusedIds = reachableCommitIds(graphCandidates, focusedBranch.target);
    return new Set([...focusedIds].filter((id) => visibleIds.has(id)));
  }, [branches, focusedBranch, graphCandidates, hiddenRefs]);
  const activeCommits = (filteredCommits ?? commits).filter((commit) => scopeIds.has(commit.id));
  const filtered = activeCommits;
  const graphCommits = graphCandidates.filter((commit) => scopeIds.has(commit.id));
  const layout = useMemo(() => layoutGraph(graphCommits), [graphCommits]);
  const laneCount = layout.laneCount;
  const graphWidthPx = graphWidth(laneCount);

  // Highlight set for the active mode (SourceGit): the current branch's
  // first-parent chain, or the selected commit's first-parent chain.
  const highlight: Set<string> | null =
    highlightMode === "current" && currentBranch
      ? firstParentChain(graphCommits, currentBranch.target)
      : highlightMode === "selected" && selected
        ? firstParentChain(graphCommits, selected.id)
        : null;

  // Inline ref pills (GitEmber drawLabel) paint at the end of the lanes; rows
  // whose pills don't fit in the graph column overflow into the subject
  // cell's 8px padding only (never over the commit text).
  const labelBudget = graphWidthPx + 8;

  // The graph column is at least as wide as the graph itself (so lanes never
  // clip into the commit text) and the user can widen it for breathing room.
  const graphColWidth = Math.max(graphWidthPx, graphColWidthOverride);

  const applyGraphWidth = (width: number) => {
    const clamped = Math.min(600, Math.max(graphWidthPx, Math.round(width)));
    setGraphColWidthOverride(clamped);
    localStorage.setItem("chrono.history.graphWidth", String(clamped));
  };
  const startGraphResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    graphDrag.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveGraphResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (graphDrag.current === null) return;
    applyGraphWidth(graphColWidth + (event.clientX - graphDrag.current));
    graphDrag.current = event.clientX;
  };
  const stopGraphResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (graphDrag.current !== null && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    graphDrag.current = null;
  };
  const keyGraphResize = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); applyGraphWidth(graphColWidth - 12); }
    else if (event.key === "ArrowRight") { event.preventDefault(); applyGraphWidth(graphColWidth + 12); }
  };

  const display = useMemo(() => {
    const visible = new Set(filtered.map((commit) => commit.id));
    const items: DisplayItem[] = [];
    let previousVis = -1;
    for (const item of layout.items) {
      if (!visible.has(item.commit.id)) continue;
      if (previousVis >= 0 && item.visRow > previousVis + 1) {
        // Union of lanes still carrying lines through the hidden rows.
        const lanes = new Set<number>();
        for (let hidden = previousVis + 1; hidden < item.visRow; hidden += 1) {
          for (const lane of layout.visThrough[hidden] ?? []) lanes.add(lane);
        }
        items.push({ kind: "elided", key: previousVis, count: item.visRow - previousVis - 1, throughLanes: [...lanes] });
      }
      items.push({ kind: "commit", item });
      previousVis = item.visRow;
    }
    return items;
  }, [layout, filtered]);

  const historyRowViewport = useMemo(() => {
    // The grid header is 26px tall and the optional top loader is 58px tall;
    // both sit before the virtualized rows in the same scroll container.
    const headerHeight = 26;
    const topLoaderHeight = historyHasNewer && !filteredCommits ? 58 : 0;
    return visibleHistoryRows(
      display.length,
      Math.max(0, historyViewport.scrollTop - headerHeight - topLoaderHeight),
      historyViewport.height,
    );
  }, [display.length, filteredCommits, historyHasNewer, historyViewport]);

  const updateHistoryViewport = () => {
    const element = historyGridRef.current;
    if (!element) return;
    setHistoryViewport((previous) => {
      const next = { scrollTop: element.scrollTop, height: element.clientHeight || previous.height };
      return previous.scrollTop === next.scrollTop && previous.height === next.height ? previous : next;
    });
  };

  useEffect(() => {
    const element = historyGridRef.current;
    if (!element) return;
    updateHistoryViewport();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHistoryViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!repositoryPath || !showChanges) { setStats(new Map()); return; }
    api.historyStats(repositoryPath, commits.length || 300).then((rows) => {
      if (!cancelled) setStats(new Map(rows.map((row) => [row.commit, row])));
    }).catch(() => { if (!cancelled) setStats(new Map()); });
    return () => { cancelled = true; };
  }, [commits.length, repositoryPath, showChanges]);

  useEffect(() => {
    let cancelled = false;
    if (!repositoryPath || !selected) { setDetails(null); return; }
    setDetails(null);
    setDiffFile(null);
    api.commitDetails(repositoryPath, selected.id).then((value) => { if (!cancelled) setDetails(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [repositoryPath, selected]);

  useEffect(() => {
    let cancelled = false;
    if (!repositoryPath) return;
    api.worktreeSummaries(repositoryPath).then((value) => { if (!cancelled) setWorktrees(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [repositoryPath, commits]);

  useEffect(() => {
    let cancelled = false;
    if (!repositoryPath) { setTags([]); setStashes([]); return; }
    api.refGroups(repositoryPath).then((value) => {
      if (!cancelled) {
        setTags(value.tags);
        setStashes(value.stashes);
      }
    }).catch(() => {
      if (!cancelled) { setTags([]); setStashes([]); }
    });
    return () => { cancelled = true; };
  }, [repositoryPath]);

  const wip = worktrees.filter((worktree) => worktree.dirtyCount > 0 || worktree.conflictCount > 0);
  const gridTemplate = showChanges
    ? `${graphColWidth}px minmax(220px, 1fr) minmax(110px, .28fr) 142px 116px 80px`
    : `${graphColWidth}px minmax(220px, 1fr) minmax(100px, .28fr) 118px 132px`;
  const contextMenuStyle = contextMenu ? {
    left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 244)),
    top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 330)),
  } : undefined;

  return (
    <div className="ux-history-view" style={{ gridTemplateColumns: `minmax(560px, 1fr) 6px ${inspectorWidth}px` }}>
      <section className="ux-history-list" aria-label="Commit history">
        <header className="ux-view-toolbar">
          <div><h2>History</h2><span>{commits.length} commits in window{historyHasNewer || historyHasMore ? " · paged" : ""}{filteredCommits !== null ? ` · ${activeCommits.length} match` : ""}</span></div>
          <div className="ux-history-toolbar-actions">
            <div className="ux-highlight-modes" role="group" aria-label="Graph highlight mode">
              <button type="button" className={highlightMode === "all" ? " is-active" : ""} onClick={() => setHighlight("all")} title="Show all lanes in full color">All</button>
              <button type="button" className={highlightMode === "current" ? " is-active" : ""} disabled={!currentBranch} onClick={() => setHighlight("current")} title={`Highlight ${currentBranch?.name ?? "the current branch"}'s first-parent chain`}>Branch</button>
              <button type="button" className={highlightMode === "selected" ? " is-active" : ""} disabled={!selected} onClick={() => setHighlight("selected")} title="Highlight the selected commit's first-parent chain">Selected</button>
            </div>
            <select className="ux-filter-mode" value={graphScope} onChange={(event) => setScope(event.target.value as GraphScope)} aria-label="Graph scope" title="Show the complete graph or focus one branch">
              <option value="all">All branches</option>
              <option value="current" disabled={!currentBranch}>Current branch</option>
              {branches.filter((branch) => !branch.remote).map((branch) => <option key={branch.name} value={`branch:${branch.name}`}>{branch.name}</option>)}
            </select>
            <div className="ux-ref-visibility">
              <button type="button" className={`ux-button${hiddenRefs.length ? " is-active" : ""}`} aria-label="Reference visibility" aria-expanded={refMenuOpen} onClick={() => setRefMenuOpen((open) => !open)} title="Hide or solo local and remote branches">
                Refs{hiddenRefs.length ? ` · ${hiddenRefs.length} hidden` : ""}
              </button>
              {refMenuOpen && <div className="ux-ref-menu" role="dialog" aria-label="Reference visibility">
                <header><strong>Reference visibility</strong><span>{hiddenRefs.length ? `${hiddenRefs.length} hidden` : "All visible"}</span></header>
                <div className="ux-ref-menu-actions">
                  <button type="button" className="ux-button" onClick={() => persistHiddenRefs([])}>Show all</button>
                  <button type="button" className="ux-button" disabled={!currentBranch} onClick={() => { if (currentBranch) soloRef(currentBranch); }}>Solo current</button>
                </div>
                <div className="ux-ref-list">
                  {refBranches.map((branch) => {
                    const key = referenceKey(branch);
                    return <label key={key} title={`${branch.remote ? "Remote" : "Local"} ref ${branch.name}`}>
                      <input type="checkbox" checked={!hiddenRefs.includes(key)} onChange={() => toggleRef(branch)} />
                      <span>{branch.remote ? "↗" : "●"} {branch.name}</span>
                      <code>{branch.target.slice(0, 8)}</code>
                    </label>;
                  })}
                  {!refBranches.length && <span className="ux-help-text">No branch refs were found.</span>}
                </div>
              </div>}
            </div>
            <select className="ux-filter-mode" value={filterMode} onChange={(event) => setFilterMode(event.target.value as FilterMode)} aria-label="Filter mode" title="Which field to search">
              <option value="message">message</option>
              <option value="author">author</option>
              <option value="path">path</option>
            </select>
            <label className={`ux-search-field${filterBusy ? " is-busy" : ""}`}>
              <Icon name="search" />
              <input
                value={query}
                onChange={onFilterChange}
                onKeyDown={onFilterKeyDown}
                placeholder={filterMode === "path" ? "Filter by path · all refs" : filterMode === "author" ? "Filter by author · all refs" : "Filter by message · all refs"}
                aria-label="Filter commits"
              />
            </label>
            <label className="ux-check-row"><input type="checkbox" checked={showChanges} onChange={(event) => { setShowChanges(event.target.checked); localStorage.setItem("chrono.history.changes", event.target.checked ? "on" : "off"); }} />Changes</label>
          </div>
        </header>

        {contextMenu && <>
          <button type="button" className="ux-context-backdrop" aria-label="Close commit menu" onClick={() => setContextMenu(null)} />
          <div className="ux-commit-context-menu" role="menu" aria-label={`Actions for ${contextMenu.commit.subject}`} style={contextMenuStyle}>
            <header><strong>{contextMenu.commit.subject}</strong><code>{contextMenu.commit.id.slice(0, 8)}</code></header>
            <button type="button" role="menuitem" disabled={actionBusy || !onCopyCommit} onClick={() => runContextAction(() => onCopyCommit?.(contextMenu.commit.id))}>Copy SHA</button>
            <button type="button" role="menuitem" disabled={actionBusy || !onCommitAction} onClick={() => runContextAction(() => onCommitAction?.("cherry-pick", contextMenu.commit))}>Cherry-pick</button>
            <button type="button" role="menuitem" disabled={actionBusy || !onCommitAction} onClick={() => runContextAction(() => onCommitAction?.("revert", contextMenu.commit))}>Revert</button>
            <button type="button" role="menuitem" disabled={actionBusy || !onCreateBranchAt} onClick={() => runContextAction(() => onCreateBranchAt?.(contextMenu.commit))}>Create branch here</button>
            <button type="button" role="menuitem" disabled={actionBusy || !onCreateTagAt} onClick={() => runContextAction(() => onCreateTagAt?.(contextMenu.commit))}>Create tag here</button>
            <div className="ux-context-divider" />
            <span className="ux-context-label">Reset current branch to this commit</span>
            <button type="button" role="menuitem" disabled={actionBusy || !onResetTo} onClick={() => runContextAction(() => onResetTo?.(contextMenu.commit, "soft"))}>Reset soft</button>
            <button type="button" role="menuitem" disabled={actionBusy || !onResetTo} onClick={() => runContextAction(() => onResetTo?.(contextMenu.commit, "mixed"))}>Reset mixed</button>
            <button type="button" role="menuitem" className="is-danger" disabled={actionBusy || !onResetTo} onClick={() => runContextAction(() => onResetTo?.(contextMenu.commit, "hard"))}>Reset hard</button>
          </div>
        </>}

        {wip.length > 0 && <div className="ux-wip-strip" aria-label="Working changes across worktrees">
          <span className="ux-wip-label">WIP</span>
          {wip.map((worktree) => (
            <button
              type="button"
              className={`ux-wip-item${worktree.conflictCount ? " has-conflicts" : ""}`}
              key={worktree.path}
              title={onOpenWorktree ? `Open worktree ${worktree.path}` : worktree.path}
              disabled={!onOpenWorktree || openingWorktree !== null}
              onClick={async () => {
                if (!onOpenWorktree || openingWorktree !== null) return;
                setOpeningWorktree(worktree.path);
                try { await onOpenWorktree(worktree.path); }
                finally { setOpeningWorktree(null); }
              }}
            >
              <Icon name="worktree" />
              <span><strong>{worktree.branch || "Detached HEAD"}{worktree.isMain ? " · current" : ""}</strong><small>{openingWorktree === worktree.path ? "opening…" : `${worktree.conflictCount ? `${worktree.conflictCount} conflicts · ` : ""}${worktree.dirtyCount} changed`}</small></span>
            </button>
          ))}
        </div>}

        {diffFile && details && details.files.some((file) => file.path === diffFile) && (() => {
          const file = details.files.find((candidate) => candidate.path === diffFile)!;
          return <section className="ux-history-diff-dock" aria-label={`Diff for ${file.path}`}>
            <div className="ux-history-diff-title"><strong>Diff above History</strong><span title={file.path}>{file.path}</span><button type="button" className="ux-icon-button" onClick={() => setDiffFile(null)} title="Close diff" aria-label="Close diff">✕</button></div>
            <CommitDiffView repositoryPath={repositoryPath} commit={selected?.id ?? ""} file={file.path} additions={file.additions} deletions={file.deletions} binary={file.binary} onClose={() => setDiffFile(null)} />
          </section>;
        })()}

        <div ref={historyGridRef} className={`ux-commit-grid${showChanges ? " show-changes" : ""}`} aria-label="Commit history list" onScroll={updateHistoryViewport}>
          <div className="ux-commit-grid-header" style={{ gridTemplateColumns: gridTemplate }} aria-hidden="true"><span>Graph</span><span>Commit</span><span>Author</span><span>Date</span>{showChanges && <span>Changes</span>}<span>SHA</span></div>
          <div className="ux-commit-rows" style={{ gridTemplateColumns: gridTemplate }}>
            {historyHasNewer && !filteredCommits && (
              <div className="ux-history-load-more ux-history-load-more--top">
                <button type="button" className="ux-button" disabled={historyLoading || !onLoadNewer} onClick={() => { if (onLoadNewer) void onLoadNewer(); }}>
                  {historyLoadingDirection === "newer" ? "Loading newer commits…" : "Load newer commits"}
                </button>
                <small>Newer graph pages are outside the bounded history window.</small>
              </div>
            )}
            {historyRowViewport.topSpacer > 0 && <div className="ux-history-virtual-spacer" style={{ height: historyRowViewport.topSpacer }} aria-hidden="true" />}
            {display.slice(historyRowViewport.start, historyRowViewport.end).map((entry, relativeIndex) => {
              const displayIndex = historyRowViewport.start + relativeIndex;
              if (entry.kind === "elided") {
                return (
                  <div key={`elided-${displayIndex}`} className="ux-commit-row ux-elided-row" style={{ gridTemplateColumns: gridTemplate }} aria-hidden="true">
                    <span className="ux-graph-cell" style={{ width: graphColWidth }}>
                      <svg className="ux-graph-svg" width={graphWidthPx} height={ROW_H} viewBox={`0 0 ${graphWidthPx} ${ROW_H}`}>
                        {entry.throughLanes.map((lane) => (
                          <line key={lane} className="ux-graph-line ux-graph-line--dashed" x1={laneX(lane)} y1={0} x2={laneX(lane)} y2={ROW_H} style={{ stroke: "var(--ux-text-3)" }} />
                        ))}
                        {entry.throughLanes.length === 0 && <line className="ux-graph-line ux-graph-line--dashed" x1={0} y1={ROW_H / 2} x2={graphWidthPx} y2={ROW_H / 2} style={{ stroke: "var(--ux-text-3)" }} />}
                      </svg>
                    </span>
                    <span className="ux-elided-label">{entry.count} more commit{entry.count === 1 ? "" : "s"} hidden by filter</span>
                    <span /><span />
                    {showChanges && <span />}
                    <code />
                  </div>
                );
              }
              const { item } = entry;
              const commit = item.commit;
              const isSelected = selected?.id === commit.id;
              const isHead = headSha === commit.id;
              const isDimmed = highlight !== null && !highlight.has(commit.id);
              const stat = stats.get(commit.id);
              // Inline ref pills (prefix-stripped, HEAD first) clipped to the
              // label budget — refs that don't fit collapse into a "+n" chip.
              const labelX = laneX(item.lane) + 12;
              const allLabels = graphLabels(commit.id, branches, headSha, tags, stashes, worktrees);
              const rowLabels: GraphLabel[] = [];
              let labelUsed = 0;
              for (const label of allLabels) {
                if (rowLabels.length >= 3) break;
                const width = labelTextWidth(label.name) + (rowLabels.length > 0 ? 4 : 0);
                if (labelUsed + width > labelBudget - labelX) break;
                rowLabels.push(label);
                labelUsed += width;
              }
              const clippedRefs = allLabels.length - rowLabels.length;
              const svgWidth = Math.max(graphWidthPx, labelX + labelUsed + 2);
              return (
                <div
                  key={commit.id}
                  className={`ux-commit-row${isSelected ? " is-selected" : ""}${isDimmed ? " is-dimmed" : ""}`}
                  style={{ gridTemplateColumns: gridTemplate }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  aria-label={`Select commit ${commit.subject}`}
                  onClick={() => onSelect(commit)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onSelect(commit);
                    setContextMenu({ commit, x: event.clientX, y: event.clientY });
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(commit);
                    }
                  }}
                >
                  <span className="ux-graph-cell" style={{ width: graphColWidth }} aria-label={item.isMerge ? `${commit.parents.length} parents` : "Commit"}>
                    <RowGraph item={item} isHead={isHead} highlight={highlight} labels={rowLabels} labelX={labelX} svgWidth={svgWidth} />
                    <span
                      className="ux-graph-resize"
                      title="Drag to resize the graph column (or use ←/→)"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize graph column"
                      tabIndex={0}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={startGraphResize}
                      onPointerMove={moveGraphResize}
                      onPointerUp={stopGraphResize}
                      onPointerCancel={stopGraphResize}
                      onKeyDown={keyGraphResize}
                    />
                  </span>
                  <span className="ux-commit-subject">
                    <span className="ux-commit-subject-text">{commit.subject}</span>
                    {clippedRefs > 0 && (
                      <span className="ux-graph-chip ux-graph-chip--muted" title={`${clippedRefs} more ref${clippedRefs === 1 ? "" : "s"} on this commit`}>+{clippedRefs}</span>
                    )}
                  </span>
                  <span>{commit.authorName}</span><span>{formatDate(commit.authoredAt)}</span>
                  {showChanges && <span className="ux-change-cell" title={stat ? `${stat.filesChanged} files, +${stat.additions}, -${stat.deletions}` : "Loading changes…"}>{stat ? <><b>+{stat.additions}</b><i>−{stat.deletions}</i><small>{stat.filesChanged}</small></> : <small>…</small>}</span>}
                  <code>{commit.id.slice(0, 8)}</code>
                </div>
              );
            })}
            {historyRowViewport.bottomSpacer > 0 && <div className="ux-history-virtual-spacer" style={{ height: historyRowViewport.bottomSpacer }} aria-hidden="true" />}
            {!display.length && (
              <div className="ux-empty-state">
                {hiddenRefs.length >= refBranches.length && refBranches.length > 0
                  ? "All branch refs are hidden. Open Refs to show one or more branches."
                  : filterBusy
                  ? "Filtering…"
                  : `No commits match ${filterMode === "path" ? "path" : filterMode === "author" ? "author" : "message"} “${query.trim()}” (searched all refs).`}
              </div>
            )}
            {historyHasMore && !filteredCommits && (
              <div className="ux-history-load-more">
                <button type="button" className="ux-button" disabled={historyLoading || !onLoadMore} onClick={() => { if (onLoadMore) void onLoadMore(); }}>
                  {historyLoadingDirection === "older" ? "Loading older commits…" : "Load older commits"}
                </button>
                <small>Older graph pages replace the oldest page when the window is full.</small>
              </div>
            )}
          </div>
        </div>
      </section>

      <SplitHandle label="Resize commit inspector" onDelta={(delta) => setInspectorWidth((width) => Math.min(780, Math.max(300, width - delta)))} />

      <aside className="ux-inspector" aria-label="Commit details">
        {selected ? <>
          <header className="ux-inspector-header"><span className="ux-eyebrow">Selected commit</span><h2>{selected.subject}</h2></header>
          <dl className="ux-metadata-list"><dt>Commit</dt><dd><code>{selected.id}</code></dd><dt>Author</dt><dd>{selected.authorName}<small>{selected.authorEmail}</small></dd><dt>Date</dt><dd>{formatDate(selected.authoredAt)}</dd><dt>Parents</dt><dd>{selected.parents.length ? selected.parents.map((parent) => <code key={parent}>{parent.slice(0, 10)}</code>) : "Root commit"}</dd></dl>
          <section className="ux-inspector-section ux-inspector-actions">
            <div className="ux-section-title"><strong>Commit actions</strong><span>Apply to the selected revision</span></div>
            <div className="ux-card-actions wrap">
              <button type="button" className="ux-button" disabled={actionBusy || !onCopyCommit} onClick={() => { if (onCopyCommit) void onCopyCommit(selected.id); }}>Copy SHA</button>
              <button type="button" className="ux-button" disabled={actionBusy || !onCommitAction} onClick={() => { if (onCommitAction) void onCommitAction("cherry-pick", selected); }}>Cherry-pick</button>
              <button type="button" className="ux-button" disabled={actionBusy || !onCommitAction} onClick={() => { if (onCommitAction) void onCommitAction("revert", selected); }}>Revert</button>
              <button type="button" className="ux-button" disabled={actionBusy || !onCreateBranchAt} onClick={() => { if (onCreateBranchAt) void onCreateBranchAt(selected); }}>Create branch here</button>
              <button type="button" className="ux-button" disabled={actionBusy || !onCreateTagAt} onClick={() => { if (onCreateTagAt) void onCreateTagAt(selected); }}>Create tag here</button>
              <button type="button" className="ux-button" disabled={actionBusy || !onResetTo} onClick={() => { if (onResetTo) void onResetTo(selected, "soft"); }}>Reset soft</button>
              <button type="button" className="ux-button" disabled={actionBusy || !onResetTo} onClick={() => { if (onResetTo) void onResetTo(selected, "mixed"); }}>Reset mixed</button>
              <button type="button" className="ux-danger-button" disabled={actionBusy || !onResetTo} onClick={() => { if (onResetTo) void onResetTo(selected, "hard"); }}>Reset hard</button>
            </div>
          </section>
          <section className="ux-inspector-section">
            <div className="ux-section-title"><strong>Changes</strong><span>{details ? `${details.files.length} files · +${details.additions} −${details.deletions}` : "Loading…"}</span></div>
            {details ? (
              <>
                <div className="ux-commit-file-list">{details.files.map((file, index) => {
                  const isDiffOpen = diffFile === file.path;
                  return (
                    <button key={`${file.path}-${index}`} type="button" className={`ux-commit-file-row${isDiffOpen ? " is-open" : ""}`} title={`${file.path} — click to ${isDiffOpen ? "close" : "view"} diff`} onClick={() => setDiffFile(isDiffOpen ? null : file.path)} aria-expanded={isDiffOpen}>
                      <span title={file.path}>{file.path}</span>
                      {file.binary ? <small>binary</small> : <small><b>+{file.additions ?? 0}</b><i>−{file.deletions ?? 0}</i></small>}
                    </button>
                  );
                })}</div>
                {diffFile && <div className="ux-diff-docked-hint">The selected diff is pinned above History.</div>}
              </>
            ) : <div className="ux-empty-state compact">Loading commit details…</div>}
          </section>
          {details?.body && details.body.trim() !== details.subject.trim() && <section className="ux-inspector-section"><div className="ux-section-title"><strong>Message</strong></div><pre className="ux-commit-body">{details.body}</pre></section>}
        </> : <div className="ux-empty-state">Select a commit to inspect it.</div>}
      </aside>
    </div>
  );
}
