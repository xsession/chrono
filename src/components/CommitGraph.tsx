import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { CommitDetails, CommitRecord, HistoryChangeStat, WorktreeSummary } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";

type Props = {
  repositoryPath: string;
  commits: CommitRecord[];
  selected: CommitRecord | null;
  onSelect: (commit: CommitRecord) => void;
};

function formatDate(value: string): string {
  const date = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

export function CommitGraph({ repositoryPath, commits, selected, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState(380);
  const [stats, setStats] = useState<Map<string, HistoryChangeStat>>(new Map());
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([]);
  const [showChanges, setShowChanges] = useState(() => localStorage.getItem("chrono.history.changes") !== "off");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commits;
    return commits.filter((commit) => [commit.subject, commit.authorName, commit.authorEmail, commit.id]
      .some((value) => value.toLowerCase().includes(needle)));
  }, [commits, query]);

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
          <div className="ux-commit-grid-header" aria-hidden="true"><span>Graph</span><span>Commit</span><span>Author</span><span>Date</span>{showChanges && <span>Changes</span>}<span>SHA</span></div>
          <div className="ux-commit-rows">
            {filtered.map((commit, index) => {
              const isSelected = selected?.id === commit.id;
              const mergeParents = Math.max(0, commit.parents.length - 1);
              const stat = stats.get(commit.id);
              return <button key={commit.id} className={`ux-commit-row${isSelected ? " is-selected" : ""}`} onClick={() => onSelect(commit)} aria-pressed={isSelected}>
                <span className="ux-graph-cell" aria-label={mergeParents ? `${commit.parents.length} parents` : "Commit"}><i className={`ux-graph-node lane-${index % 5}`} />{mergeParents > 0 && <small>+{mergeParents}</small>}</span>
                <span className="ux-commit-subject">{commit.subject}</span><span>{commit.authorName}</span><span>{formatDate(commit.authoredAt)}</span>
                {showChanges && <span className="ux-change-cell" title={stat ? `${stat.filesChanged} files, +${stat.additions}, -${stat.deletions}` : "Loading changes…"}>{stat ? <><b>+{stat.additions}</b><i>−{stat.deletions}</i><small>{stat.filesChanged}</small></> : <small>…</small>}</span>}
                <code>{commit.id.slice(0, 8)}</code>
              </button>;
            })}
            {!filtered.length && <div className="ux-empty-state">No loaded commits match “{query}”. Use Git Intelligence for full-history file, patch and range search.</div>}
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
            {details ? <div className="ux-commit-file-list">{details.files.map((file, index) => <div key={`${file.path}-${index}`}><span title={file.path}>{file.path}</span>{file.binary ? <small>binary</small> : <small><b>+{file.additions ?? 0}</b><i>−{file.deletions ?? 0}</i></small>}</div>)}</div> : <div className="ux-empty-state compact">Loading commit details…</div>}
          </section>
          {details?.body && details.body.trim() !== details.subject.trim() && <section className="ux-inspector-section"><div className="ux-section-title"><strong>Message</strong></div><pre className="ux-commit-body">{details.body}</pre></section>}
        </> : <div className="ux-empty-state">Select a commit to inspect it.</div>}
      </aside>
    </div>
  );
}
