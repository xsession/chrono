import { useEffect, useMemo, useState } from "react";
import type { CommitDiffHunk, WorkingTreeDiff } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

type Props = {
  repositoryPath: string;
  file: string;
  onStageHunks: (file: string, hunks: number[]) => Promise<void>;
  onClose: () => void;
};

function HunkBody({ hunk }: { hunk: CommitDiffHunk }) {
  return <div className="ux-commit-diff-body">
    {hunk.lines.map((line, lineIndex) => <div key={lineIndex} className={`ux-diff-line ux-diff-line--${line.kind}`}>
      <span className="ux-diff-no ux-diff-no--old">{line.kind === "del" || line.kind === "ctx" ? line.number : ""}</span>
      <span className="ux-diff-no ux-diff-no--new">{line.kind === "add" || line.kind === "ctx" ? line.number : ""}</span>
      <span className="ux-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
      <code>{line.text}</code>
    </div>)}
  </div>;
}

export function StageHunksPanel({ repositoryPath, file, onStageHunks, onClose }: Props) {
  const [diff, setDiff] = useState<WorkingTreeDiff | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setSelected(new Set());
    setFailed(null);
    api.unstagedFileDiff(repositoryPath, file)
      .then((value) => { if (!cancelled) setDiff(value); })
      .catch((error) => { if (!cancelled) setFailed(String(error)); });
    return () => { cancelled = true; };
  }, [repositoryPath, file]);

  const allIndexes = useMemo(() => new Set((diff?.hunks ?? []).map((_hunk, index) => index)), [diff]);
  const toggle = (index: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  const stage = async () => {
    if (!selected.size) return;
    setBusy(true);
    setFailed(null);
    try {
      await onStageHunks(file, [...selected].sort((a, b) => a - b));
      onClose();
    } catch (error) {
      setFailed(String(error));
    } finally {
      setBusy(false);
    }
  };

  return <section className="ux-hunk-stage-panel" aria-label={`Stage selected hunks of ${file}`}>
    <header className="ux-hunk-stage-header">
      <div><strong>Stage selected hunks</strong><span>Only unstaged changes are shown; staged changes stay untouched.</span></div>
      <div className="ux-toolbar-actions">
        <button className="ux-button" disabled={busy || !diff?.hunks.length} onClick={() => setSelected(new Set(allIndexes))}>Select all</button>
        <button className="ux-button" disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>Clear</button>
        <button className="ux-icon-button" disabled={busy} onClick={onClose} title="Close hunk staging" aria-label="Close hunk staging">✕</button>
      </div>
    </header>
    {failed && <div className="ux-inline-warning"><Icon name="warning" /><span>{failed}</span></div>}
    {!failed && !diff && <div className="ux-empty-state compact"><i className="ux-spinner" />Loading unstaged hunks…</div>}
    {!failed && diff?.binary && <div className="ux-empty-state compact"><Icon name="file" />Binary files cannot be staged by text hunk.</div>}
    {!failed && diff && !diff.binary && !diff.hunks.length && <div className="ux-empty-state compact"><Icon name="check" />No unstaged text hunks remain.</div>}
    {!failed && diff && !diff.binary && diff.hunks.length > 0 && <>
      <div className="ux-hunk-stage-summary"><span>{selected.size} of {diff.hunks.length} hunks selected</span><button className="ux-primary-button" disabled={busy || !selected.size} onClick={() => void stage()}>{busy ? "Staging…" : `Stage ${selected.size} hunk${selected.size === 1 ? "" : "s"}`}</button></div>
      <div className="ux-hunk-stage-list">
        {diff.hunks.map((hunk, index) => <article key={index} className={`ux-hunk-stage-item${selected.has(index) ? " is-selected" : ""}`}>
          <label className="ux-hunk-stage-check"><input type="checkbox" checked={selected.has(index)} onChange={() => toggle(index)} /><strong>Hunk {index + 1}</strong><code>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header ? ` ${hunk.header}` : ""}</code></label>
          <HunkBody hunk={hunk} />
        </article>)}
      </div>
    </>}
  </section>;
}
