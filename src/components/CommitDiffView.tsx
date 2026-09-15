import { useEffect, useState } from "react";
import type { CommitFileDiff } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

type Props = {
  repositoryPath: string;
  commit: string;
  file: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  onClose: () => void;
};

/** Inline diff of one commit file, shown beneath the file list in the
 *  commit inspector. Fetches lazily and caches per commit+file. */
export function CommitDiffView({ repositoryPath, commit, file, additions, deletions, binary, onClose }: Props) {
  const [diff, setDiff] = useState<CommitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    if (binary) return;
    api.commitFileDiff(repositoryPath, commit, file)
      .then((value) => { if (!cancelled) setDiff(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [repositoryPath, commit, file, binary]);

  const status = binary ? "binary" : diff?.status ?? "…";
  const shownAdditions = diff?.additions ?? additions ?? 0;
  const shownDeletions = diff?.deletions ?? deletions ?? 0;

  return (
    <section className="ux-commit-diff" aria-label={`Diff of ${file}`}>
      <header className="ux-commit-diff-header">
        <span className="ux-commit-diff-path" title={file}>{file}</span>
        <span className="ux-commit-diff-meta">
          <em>{status}</em>
          {!binary && <small><b>+{shownAdditions}</b><i>−{shownDeletions}</i></small>}
          <button className="ux-icon-button" onClick={onClose} title="Close diff" aria-label="Close diff">✕</button>
        </span>
      </header>
      {binary ? <div className="ux-empty-state compact"><Icon name="file" />Binary file — no text diff available.</div>
        : failed ? <div className="ux-empty-state compact"><Icon name="warning" />Failed to load the diff.</div>
        : !diff ? <div className="ux-empty-state compact"><i className="ux-spinner" />Loading diff…</div>
        : diff.hunks.length === 0
          ? <div className="ux-empty-state compact"><Icon name="file" />No text changes to show.</div>
          : <div className="ux-commit-diff-body">
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
            </div>}
    </section>
  );
}
