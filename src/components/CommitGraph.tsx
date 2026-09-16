import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { BranchRecord, CommitDetails, CommitRecord, HistoryChangeStat, WorktreeSummary } from "../types";
import { api } from "../api";
import { graphWidth, laneX, layoutGraph, ROW_H } from "../graph";
import type { GraphRowData } from "../graph";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";
import { CommitDiffView } from "./CommitDiffView";

type Props = {
  repositoryPath: string;
  commits: CommitRecord[];
  branches: BranchRecord[];
  headSha?: string;
  selected: CommitRecord | null;
  onSelect: (commit: CommitRecord) => void;
};

function formatDate(value: string): string {
  const date = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

type DisplayItem =
  | { kind: "commit"; item: GraphRowData }
  | { kind: "elided"; key: number; count: number; throughLanes: number[] };

/** SVG of one commit row: arriving lines (top), pass-through lines, and
 *  lines leaving toward parents (bottom), plus the commit/merge node.
 *  Branch/HEAD labels live in the subject column so they can never
 *  occlude a lane line. */
function RowGraph({ item, laneCount, isHead }: { item: GraphRowData; laneCount: number; isHead: boolean }) {
  const width = graphWidth(laneCount);
  const y = ROW_H / 2;
  return (
    <svg className="ux-graph-svg" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} aria-hidden="true">
      {item.through.map((seg, index) => (
        <line key={`t${index}`} className="ux-graph-line" style={{ stroke: seg.color }} x1={laneX(seg.lane)} y1={0} x2={laneX(seg.lane)} y2={ROW_H} />
      ))}
      {item.top.map((seg, index) => (
        <line key={`top${index}`} className="ux-graph-line" style={{ stroke: seg.color }} x1={laneX(seg.from)} y1={0} x2={laneX(seg.to)} y2={y} />
      ))}
      {item.bottom.map((seg, index) => (
        <line key={`b${index}`} className="ux-graph-line" style={{ stroke: seg.color }} x1={laneX(seg.from)} y1={y} x2={laneX(seg.to)} y2={ROW_H} />
      ))}
      {item.isMerge
        ? <>
            <circle cx={laneX(item.lane)} cy={y} r={7.5} className="ux-graph-node ux-graph-node--merge" style={{ stroke: item.color }} />
            {isHead && <circle cx={laneX(item.lane)} cy={y} r={3} style={{ fill: "var(--ux-accent)" }} />}
          </>
        : <circle cx={laneX(item.lane)} cy={y} r={5} className="ux-graph-node" style={{ stroke: item.color }} />}
    </svg>
  );
}

export function CommitGraph({ repositoryPath, commits, branches, headSha, selected, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState(380);
  const [stats, setStats] = useState<Map<string, HistoryChangeStat>>(new Map());
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([]);
  const [showChanges, setShowChanges] = useState(() => localStorage.getItem("chrono.history.changes") !== "off");
  const [graphColWidthOverride, setGraphColWidthOverride] = useState<number>(() => Number.parseInt(localStorage.getItem("chrono.history.graphWidth") ?? "0", 10) || 0);
  const graphDrag = useRef<number | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commits;
    return commits.filter((commit) => [commit.subject, commit.authorName, commit.authorEmail, commit.id]
      .some((value) => value.toLowerCase().includes(needle)));
  }, [commits, query]);

  // Layout over all loaded commits so topology stays stable while filtering;
  // hidden rows are collapsed into dashed separators showing live lanes.
  const layout = useMemo(() => layoutGraph(commits), [commits]);
  const laneCount = layout.laneCount;
  const graphWidthPx = graphWidth(laneCount);

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

  const wip = worktrees.filter((worktree) => worktree.dirtyCount > 0 || worktree.conflictCount > 0);
  const gridTemplate = showChanges
    ? `${graphColWidth}px minmax(220px, 1fr) minmax(110px, .28fr) 142px 116px 80px`
    : `${graphColWidth}px minmax(220px, 1fr) minmax(100px, .28fr) 118px 132px`;

  return (
    <div className="ux-history-view" style={{ gridTemplateColumns: `minmax(560px, 1fr) 6px ${inspectorWidth}px` }}>
      <section className="ux-history-list" aria-label="Commit history">
        <header className="ux-view-toolbar">
          <div><h2>History</h2><span>{commits.length} commits loaded</span></div>
          <div className="ux-history-toolbar-actions">
            <label className="ux-check-row"><input type="checkbox" checked={showChanges} onChange={(event) => { setShowChanges(event.target.checked); localStorage.setItem("chrono.history.changes", event.target.checked ? "on" : "off"); }} />Changes</label>
            <label className="ux-search-field"><Icon name="search" /><input value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} placeholder="Filter loaded commits" aria-label="Filter loaded commits" /></label>
          </div>
        </header>

        {wip.length > 0 && <div className="ux-wip-strip" aria-label="Working changes across worktrees">
          <span className="ux-wip-label">WIP</span>
          {wip.map((worktree) => <div className={`ux-wip-item${worktree.conflictCount ? " has-conflicts" : ""}`} key={worktree.path} title={worktree.path}><Icon name="worktree" /><span><strong>{worktree.branch || "Detached HEAD"}{worktree.isMain ? " · current" : ""}</strong><small>{worktree.conflictCount ? `${worktree.conflictCount} conflicts · ` : ""}{worktree.dirtyCount} changed</small></span></div>)}
        </div>}

        <div className={`ux-commit-grid${showChanges ? " show-changes" : ""}`} aria-label="Commit history list">
          <div className="ux-commit-grid-header" style={{ gridTemplateColumns: gridTemplate }} aria-hidden="true"><span>Graph</span><span>Commit</span><span>Author</span><span>Date</span>{showChanges && <span>Changes</span>}<span>SHA</span></div>
          <div className="ux-commit-rows" style={{ gridTemplateColumns: gridTemplate }}>
            {display.map((entry, displayIndex) => {
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
              const branchChips = branches.filter((branch) => branch.target === commit.id);
              const stat = stats.get(commit.id);
              return (
                <button key={commit.id} className={`ux-commit-row${isSelected ? " is-selected" : ""}`} style={{ gridTemplateColumns: gridTemplate }} onClick={() => onSelect(commit)} aria-pressed={isSelected}>
                  <span className="ux-graph-cell" style={{ width: graphColWidth }} aria-label={item.isMerge ? `${commit.parents.length} parents` : "Commit"}>
                    <RowGraph item={item} laneCount={laneCount} isHead={isHead} />
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
                    {isHead && <span className="ux-graph-chip ux-graph-chip--head" title="HEAD">HEAD</span>}
                    {branchChips.map((branch) => (
                      <span key={branch.name} className={branch.current ? "ux-graph-chip ux-graph-chip--current" : "ux-graph-chip"} title={`branch ${branch.name}`}>{branch.name}</span>
                    ))}
                  </span>
                  <span>{commit.authorName}</span><span>{formatDate(commit.authoredAt)}</span>
                  {showChanges && <span className="ux-change-cell" title={stat ? `${stat.filesChanged} files, +${stat.additions}, -${stat.deletions}` : "Loading changes…"}>{stat ? <><b>+{stat.additions}</b><i>−{stat.deletions}</i><small>{stat.filesChanged}</small></> : <small>…</small>}</span>}
                  <code>{commit.id.slice(0, 8)}</code>
                </button>
              );
            })}
            {!display.length && <div className="ux-empty-state">No loaded commits match “{query}”. Use Git Intelligence for full-history file, patch and range search.</div>}
          </div>
        </div>
      </section>

      <SplitHandle label="Resize commit inspector" onDelta={(delta) => setInspectorWidth((width) => Math.min(780, Math.max(300, width - delta)))} />

      <aside className="ux-inspector" aria-label="Commit details">
        {selected ? <>
          <header className="ux-inspector-header"><span className="ux-eyebrow">Selected commit</span><h2>{selected.subject}</h2></header>
          <dl className="ux-metadata-list"><dt>Commit</dt><dd><code>{selected.id}</code></dd><dt>Author</dt><dd>{selected.authorName}<small>{selected.authorEmail}</small></dd><dt>Date</dt><dd>{formatDate(selected.authoredAt)}</dd><dt>Parents</dt><dd>{selected.parents.length ? selected.parents.map((parent) => <code key={parent}>{parent.slice(0, 10)}</code>) : "Root commit"}</dd></dl>
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
                {diffFile && details.files.some((file) => file.path === diffFile) && (() => {
                  const file = details.files.find((candidate) => candidate.path === diffFile)!;
                  return <CommitDiffView repositoryPath={repositoryPath} commit={selected.id} file={file.path} additions={file.additions} deletions={file.deletions} binary={file.binary} onClose={() => setDiffFile(null)} />;
                })()}
              </>
            ) : <div className="ux-empty-state compact">Loading commit details…</div>}
          </section>
          {details?.body && details.body.trim() !== details.subject.trim() && <section className="ux-inspector-section"><div className="ux-section-title"><strong>Message</strong></div><pre className="ux-commit-body">{details.body}</pre></section>}
        </> : <div className="ux-empty-state">Select a commit to inspect it.</div>}
      </aside>
    </div>
  );
}
