import { useEffect, useState } from "react";
import type { CommitFileDiff } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { DiffHunks } from "./DiffHunks";
import { ImageDiff, isImagePath } from "./ImageDiff";

type Props = {
  repositoryPath: string;
  commit: string;
  file: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  onClose: () => void;
};

/** Inline diff of one commit file, docked above the History rows. Fetches
 *  lazily and keeps the file selection in the commit inspector. */
export function CommitDiffView({ repositoryPath, commit, file, additions, deletions, binary, onClose }: Props) {
  const [diff, setDiff] = useState<CommitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    if (binary && !isImagePath(file)) return;
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
      {isImagePath(file) ? <ImageDiff repositoryPath={repositoryPath} file={file} before={diff?.status === "A" ? null : `${commit}^`} after={diff?.status === "D" ? `${commit}^` : commit} />
        : binary ? <div className="ux-empty-state compact"><Icon name="file" />Binary file — no text diff available.</div>
        : failed ? <div className="ux-empty-state compact"><Icon name="warning" />Failed to load the diff.</div>
        : !diff ? <div className="ux-empty-state compact"><i className="ux-spinner" />Loading diff…</div>
        : diff.hunks.length === 0
          ? <div className="ux-empty-state compact"><Icon name="file" />No text changes to show.</div>
          : <DiffHunks hunks={diff.hunks} />}
    </section>
  );
}
