import { useEffect, useState } from "react";
import type { WorkingTreeDiff } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { DiffHunks } from "./DiffHunks";
import { StageHunksPanel } from "./StageHunksPanel";

type Props = {
  repositoryPath: string;
  file: string;
  onClose: () => void;
  onStageHunks?: (file: string, hunks: number[]) => Promise<void>;
};

/** TortoiseGit-style diff for one uncommitted file. The main view compares
 *  HEAD to the working tree; the hunk panel separately compares index to the
 *  working tree so selected changes can be staged safely. */
export function WorkingDiffView({ repositoryPath, file, onClose, onStageHunks }: Props) {
  const [diff, setDiff] = useState<WorkingTreeDiff | null>(null);
  const [failed, setFailed] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    setStageOpen(false);
    api.workingTreeDiff(repositoryPath, file)
      .then((value) => { if (!cancelled) setDiff(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [repositoryPath, file]);

  return (
    <section className="ux-commit-diff" aria-label={`Working tree diff of ${file}`}>
      <header className="ux-commit-diff-header">
        <span className="ux-commit-diff-path" title={file}>{file}</span>
        <span className="ux-commit-diff-meta">
          <em>{diff ? (diff.status || "worktree") : "worktree"}</em>
          {diff && !diff.binary && <small><b>+{diff.additions}</b><i>−{diff.deletions}</i></small>}
          {onStageHunks && <button className="ux-button" disabled={!diff || diff.binary} onClick={() => setStageOpen(true)} title="Select and stage individual unstaged hunks">Stage hunks</button>}
          <button className="ux-icon-button" onClick={onClose} title="Close diff" aria-label="Close diff">✕</button>
        </span>
      </header>
      {diff?.binary ? <div className="ux-empty-state compact"><Icon name="file" />Binary file — no text diff available.</div>
        : failed ? <div className="ux-empty-state compact"><Icon name="warning" />Failed to load the diff.</div>
        : !diff ? <div className="ux-empty-state compact"><i className="ux-spinner" />Loading diff…</div>
        : diff.hunks.length === 0
          ? <div className="ux-empty-state compact"><Icon name="file" />No text changes to show.</div>
          : <DiffHunks hunks={diff.hunks} />}
      {stageOpen && onStageHunks && <StageHunksPanel repositoryPath={repositoryPath} file={file} onStageHunks={onStageHunks} onClose={() => setStageOpen(false)} />}
    </section>
  );
}
