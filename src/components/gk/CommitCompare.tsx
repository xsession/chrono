import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CommitFileChange, CommitRecord, RevisionDiff } from "../../types";
import { DiffHunks } from "../DiffHunks";
import { Icon } from "../Icon";
import { ImageDiff, isImagePath } from "../ImageDiff";

/** GitKraken-style comparison of two commits selected with Ctrl+click:
 *  the changed files between them, and the diff of the chosen file. */
export function CommitCompareInspector({ repositoryPath, from, to, openFile, onOpenFile, onClose, onSwap }: {
  repositoryPath: string;
  from: CommitRecord;
  to: CommitRecord;
  openFile: string | null;
  onOpenFile: (file: string | null) => void;
  onClose: () => void;
  onSwap: () => void;
}) {
  const [files, setFiles] = useState<CommitFileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFiles(null); setError(null);
    api.diffCommitFiles(repositoryPath, from.id, to.id)
      .then((value) => { if (!cancelled) setFiles(value); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [repositoryPath, from.id, to.id]);
  const additions = files?.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0;
  const deletions = files?.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0;
  return (
    <div className="gk-compare">
      <header className="gk-compare-header">
        <span className="ux-eyebrow">Comparing commits</span>
        <div className="gk-compare-pair">
          <div><code>{from.id.slice(0, 8)}</code><span>{from.subject}</span></div>
          <button type="button" className="ux-icon-button" onClick={onSwap} title="Swap direction" aria-label="Swap direction"><Icon name="compare" /></button>
          <div><code>{to.id.slice(0, 8)}</code><span>{to.subject}</span></div>
        </div>
        <div className="gk-compare-meta">
          <span>{files ? `${files.length} files · ` : ""}<b>+{additions}</b> <i>−{deletions}</i></span>
          <button type="button" className="gk-link-button" onClick={onClose}>Clear comparison</button>
        </div>
      </header>
      <div className="gk-compare-files">
        {error && <div className="ux-empty-state compact">{error}</div>}
        {!files && !error && <div className="gk-empty"><i className="ux-spinner" />Comparing…</div>}
        {files?.length === 0 && <div className="gk-empty">The two commits have identical trees.</div>}
        {files?.map((file) => (
          <button key={file.path} type="button" className={`ux-commit-file-row${openFile === file.path ? " is-open" : ""}`} onClick={() => onOpenFile(openFile === file.path ? null : file.path)} title={file.path}>
            <span>{file.path}</span>
            {file.binary ? <small>binary</small> : <small><b>+{file.additions ?? 0}</b><i>−{file.deletions ?? 0}</i></small>}
          </button>
        ))}
      </div>
      <p className="gk-compare-hint">Ctrl+click another commit to change the second side; click a commit to leave comparison.</p>
    </div>
  );
}

export function CommitCompareDiff({ repositoryPath, from, to, file, onClose }: { repositoryPath: string; from: string; to: string; file: string; onClose: () => void }) {
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDiff(null); setError(null);
    api.diffRevisions(repositoryPath, from, to, file).then((value) => { if (!cancelled) setDiff(value); }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [repositoryPath, from, to, file]);
  return (
    <div className="gk-center-overlay">
      <section className="ux-commit-diff" aria-label={`Diff of ${file}`}>
        <header className="ux-commit-diff-header">
          <span className="ux-commit-diff-path" title={file}>{file}</span>
          <span className="ux-commit-diff-meta">
            <em>{from.slice(0, 8)} → {to.slice(0, 8)}</em>
            {diff && !diff.binary && <small><b>+{diff.additions}</b><i>−{diff.deletions}</i></small>}
            <button className="ux-icon-button" onClick={onClose} title="Close diff" aria-label="Close diff">✕</button>
          </span>
        </header>
        {isImagePath(file) ? <ImageDiff repositoryPath={repositoryPath} file={file} before={from} after={to} />
          : error ? <div className="ux-empty-state compact">{error}</div>
          : !diff ? <div className="ux-empty-state compact"><i className="ux-spinner" />Loading diff…</div>
          : diff.binary ? <div className="ux-empty-state compact">Binary file — no text diff available.</div>
          : diff.hunks.length ? <DiffHunks hunks={diff.hunks} /> : <div className="ux-empty-state compact">No text changes.</div>}
      </section>
    </div>
  );
}
