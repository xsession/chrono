import { useEffect, useState } from "react";
import type { CommitRecord, FileAtRevision, RevisionDiff } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

type Props = {
  repositoryPath: string;
  file: string;
  history: CommitRecord[];
  selectedIndex: number | null;
  onSelectIndex: (index: number) => void;
  onOpenCommit?: (commit: CommitRecord) => void;
};

function formatDate(value: string | number) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** File-history revision viewer. History is newest-first, so Previous moves
 * toward the older entry while Next moves back toward the newer entry. */
export function RevisionDiffView({ repositoryPath, file, history, selectedIndex, onSelectIndex, onOpenCommit }: Props) {
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [content, setContent] = useState<FileAtRevision | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const selected = selectedIndex === null ? null : history[selectedIndex] ?? null;
  const parent = selected?.parents[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setContent(null);
    setFailed(false);
    if (!selected || !file.trim()) return;
    setLoading(true);

    const load = parent
      ? api.diffRevisions(repositoryPath, parent, selected.id, file.trim()).then((value) => {
          if (!cancelled) setDiff(value);
        })
      : api.fileAtRevision(repositoryPath, selected.id, file.trim()).then((value) => {
          if (!cancelled) setContent(value);
        });
    load.catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [repositoryPath, file, selected, parent]);

  if (!history.length) {
    return <section className="ux-revision-viewer" aria-label="Revision viewer"><div className="ux-empty-state">Load file history to review a revision.</div></section>;
  }
  if (!selected || selectedIndex === null) {
    return <section className="ux-revision-viewer" aria-label="Revision viewer"><div className="ux-empty-state">Select a file-history revision to inspect it.</div></section>;
  }

  const renderDiff = () => {
    if (failed) return <div className="ux-empty-state compact"><Icon name="warning" />Failed to load this revision.</div>;
    if (loading) return <div className="ux-empty-state compact"><i className="ux-spinner" />Loading revision…</div>;
    if (!parent && content) {
      if (content.binary) return <div className="ux-empty-state compact"><Icon name="file" />Binary file at the root revision — no text preview available.</div>;
      return <>
        <div className="ux-revision-content-note">Root revision content{content.truncated ? " (preview truncated)" : ""} · {content.size} bytes</div>
        <pre className="ux-revision-content">{content.content}</pre>
      </>;
    }
    if (!diff) return <div className="ux-empty-state compact">No revision data available.</div>;
    if (diff.binary) return <div className="ux-empty-state compact"><Icon name="file" />Binary file — no text diff available.</div>;
    if (!diff.hunks.length) return <div className="ux-empty-state compact"><Icon name="file" />No text changes to show.</div>;
    return <div className="ux-commit-diff-body">
      {diff.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="ux-diff-hunk">
          <div className="ux-diff-hunk-header">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header ? ` ${hunk.header}` : ""}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`ux-diff-line ux-diff-line--${line.kind}`}>
              <span className="ux-diff-no ux-diff-no--old">{line.kind === "del" || line.kind === "ctx" ? line.number : ""}</span>
              <span className="ux-diff-no ux-diff-no--new">{line.kind === "add" || line.kind === "ctx" ? line.number : ""}</span>
              <span className="ux-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
              <code>{line.text}</code>
            </div>
          ))}
        </div>
      ))}
    </div>;
  };

  return (
    <section className="ux-revision-viewer" aria-label="Revision viewer">
      <header className="ux-revision-header">
        <div className="ux-revision-title">
          <strong>Revision viewer</strong>
          <span title={file}>{file}</span>
        </div>
        <div className="ux-revision-navigation">
          <button className="ux-button" disabled={selectedIndex >= history.length - 1} onClick={() => onSelectIndex(selectedIndex + 1)} title="Move to the older file revision">Previous revision</button>
          <span>{selectedIndex + 1} / {history.length}</span>
          <button className="ux-button" disabled={selectedIndex <= 0} onClick={() => onSelectIndex(selectedIndex - 1)} title="Move to the newer file revision">Next revision</button>
        </div>
      </header>
      <div className="ux-revision-meta">
        <code>{selected.id.slice(0, 12)}</code>
        <strong>{selected.subject}</strong>
        <span>{selected.authorName} · {formatDate(selected.authoredAt)}</span>
        <button className="ux-button" onClick={() => onOpenCommit?.(selected)}>Open commit</button>
      </div>
      <div className="ux-revision-diff">
        <div className="ux-revision-diff-summary">
          <span>{parent ? `Compared with ${parent.slice(0, 12)}` : "Initial file revision"}</span>
          {diff && <small><b>+{diff.additions}</b> <i>−{diff.deletions}</i></small>}
        </div>
        {renderDiff()}
      </div>
    </section>
  );
}
