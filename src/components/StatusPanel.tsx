import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import type { CommitDraft, CommitDraftOptions, FileChange } from "../types";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";
import { WorkingDiffView } from "./WorkingDiffView";

type Props = {
  changes: FileChange[];
  repositoryPath: string;
  onStage: (paths: string[]) => Promise<void>;
  onStageHunks: (file: string, hunks: number[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onDraftCommit: (options: CommitDraftOptions) => Promise<CommitDraft>;
  operationActive?: boolean;
  onResolveConflicts?: () => void;
};

type GroupProps = {
  title: string;
  hint: string;
  items: FileChange[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  diffPath: string | null;
  onDiff: (path: string) => void;
  tone?: "danger" | "normal";
  selectable?: boolean;
};

function ChangeGroup({ title, hint, items, selected, onToggle, diffPath, onDiff, tone = "normal", selectable = true }: GroupProps) {
  if (!items.length) return null;
  return (
    <section className={`ux-change-group ${tone === "danger" ? "is-danger" : ""}`}>
      <header>
        <div><strong>{title}</strong><span>{hint}</span></div>
        <span className="ux-count-pill">{items.length}</span>
      </header>
      <div className="ux-change-list">
        {items.map((change) => (
          <div key={`${title}-${change.path}`} className={`ux-change-row${diffPath === change.path ? " is-diffing" : ""}`}>
            <label className="ux-change-row-label" title={`Toggle ${change.path}`}>
              <input type="checkbox" checked={selected.has(change.path)} disabled={!selectable} onChange={() => onToggle(change.path)} />
              <span className="ux-status-code" aria-label={`Git status ${change.indexStatus}${change.worktreeStatus}`}>{change.indexStatus}{change.worktreeStatus}</span>
              <span className="ux-change-path" title={change.path}>{change.path}</span>
            </label>
            {change.conflicted && <span className="ux-critical-label">Conflict</span>}
            <button
              type="button"
              className="ux-change-diff-toggle"
              title={diffPath === change.path ? "Hide diff" : `Diff ${change.path}`}
              aria-label={`Diff ${change.path}`}
              onClick={() => onDiff(change.path)}
            >
              <Icon name="compare" />{diffPath === change.path ? "Hide" : "Diff"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export function StatusPanel({ changes, repositoryPath, onStage, onStageHunks, onUnstage, onCommit, onDraftCommit, operationActive = false, onResolveConflicts }: Props) {
  const [selectedStageable, setSelectedStageable] = useState<Set<string>>(new Set());
  const [selectedStaged, setSelectedStaged] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"stage" | "unstage" | "commit" | "draft" | null>(null);
  const [commitWidth, setCommitWidth] = useState(350);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const [draftStyle, setDraftStyle] = useState<CommitDraftOptions["style"]>("conventional");
  const [issueReference, setIssueReference] = useState("");

  const messageQuality = useMemo(() => {
    const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const conventional = /^(feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert)(\([^)]+\))?:\s+\S/.test(subject);
    const hasIssue = !issueReference.trim() || message.includes(issueReference.trim());
    return [
      { label: "Subject present", good: subject.length > 0 },
      { label: "Subject ≤ 72 characters", good: subject.length <= 72 },
      ...(draftStyle === "conventional" ? [{ label: "Conventional prefix", good: conventional }] : []),
      ...(issueReference.trim() ? [{ label: "Issue reference included", good: hasIssue }] : []),
    ];
  }, [draftStyle, issueReference, message]);

  const grouped = useMemo(() => {
    const conflicts = changes.filter((change) => change.conflicted);
    const staged = changes.filter((change) => !change.conflicted && change.indexStatus !== " " && change.indexStatus !== "?");
    const unstaged = changes.filter((change) => !change.conflicted && (change.worktreeStatus !== " " || change.indexStatus === "?"));
    return { conflicts, staged, unstaged };
  }, [changes]);

  // A refresh can remove or reclassify files while this panel stays mounted.
  // Drop stale selections so the action buttons never target paths that are
  // no longer in the corresponding staging set.
  useEffect(() => {
    const stageable = new Set(changes.filter((change) => !change.conflicted).map((change) => change.path));
    const staged = new Set(grouped.staged.map((change) => change.path));
    setSelectedStageable((current) => new Set([...current].filter((path) => stageable.has(path))));
    setSelectedStaged((current) => new Set([...current].filter((path) => staged.has(path))));
  }, [changes, grouped.staged]);

  const toggleIn = (setter: Dispatch<SetStateAction<Set<string>>>, path: string) => {
    setter((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const run = async (kind: "stage" | "unstage", paths: string[]) => {
    if (!paths.length) return;
    setPending(kind);
    try {
      if (kind === "stage") await onStage(paths);
      else await onUnstage(paths);
      if (kind === "stage") setSelectedStageable(new Set());
      else setSelectedStaged(new Set());
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="ux-changes-view" style={{ gridTemplateColumns: `minmax(360px, 1fr) 6px ${commitWidth}px` }}>
      <section className="ux-changes-pane" aria-label="Working tree changes">
        <header className="ux-view-toolbar">
          <div>
            <h2>{grouped.conflicts.length ? "Resolve changes" : "Working tree"}</h2>
            <span>{changes.length ? `${changes.length} changed file${changes.length === 1 ? "" : "s"}` : "No local changes"}</span>
          </div>
          <div className="ux-toolbar-actions" role="toolbar" aria-label="Staging actions">
            <button className="ux-button" disabled={!selectedStageable.size || pending !== null} onClick={() => run("stage", [...selectedStageable])}>
              Stage selected
            </button>
            <button className="ux-button" disabled={!selectedStaged.size || pending !== null} onClick={() => run("unstage", [...selectedStaged])}>
              Unstage selected
            </button>
          </div>
        </header>

        {grouped.conflicts.length > 0 && (
          <div className="ux-operation-banner is-critical" role="status">
            <Icon name="warning" />
            <div><strong>{grouped.conflicts.length} unresolved conflict{grouped.conflicts.length === 1 ? "" : "s"}</strong><span>Use the three-way Conflict Center, then continue the active Git operation.</span></div>
            {onResolveConflicts && <button className="ux-button" onClick={onResolveConflicts}>Open Conflict Center</button>}
          </div>
        )}

        <div className="ux-change-groups">
          <ChangeGroup title="Conflicts" hint="Resolve before continuing the Git operation" items={grouped.conflicts} selected={selectedStageable} onToggle={(path) => toggleIn(setSelectedStageable, path)} diffPath={diffFile} onDiff={setDiffFile} tone="danger" selectable={false} />
          <ChangeGroup title="Staged" hint="Included in the next commit" items={grouped.staged} selected={selectedStaged} onToggle={(path) => toggleIn(setSelectedStaged, path)} diffPath={diffFile} onDiff={setDiffFile} />
          <ChangeGroup title="Unstaged" hint="Working directory changes" items={grouped.unstaged} selected={selectedStageable} onToggle={(path) => toggleIn(setSelectedStageable, path)} diffPath={diffFile} onDiff={setDiffFile} />
          {!changes.length && (
            <div className="ux-empty-state large">
              <Icon name="changes" />
              <strong>Working tree is clean</strong>
              <span>There is nothing to stage or commit.</span>
            </div>
          )}
        </div>

        {diffFile && <WorkingDiffView repositoryPath={repositoryPath} file={diffFile} onClose={() => setDiffFile(null)} onStageHunks={onStageHunks} />}
      </section>

      <SplitHandle
        label="Resize commit panel"
        onDelta={(delta) => setCommitWidth((width) => Math.min(620, Math.max(300, width - delta)))}
      />

      <aside className="ux-commit-pane" aria-label="Create commit">
        <header>
          <span className="ux-eyebrow">Next commit</span>
          <h2>{grouped.staged.length ? `${grouped.staged.length} staged file${grouped.staged.length === 1 ? "" : "s"}` : "Nothing staged"}</h2>
        </header>
        <label className="ux-field-label" htmlFor="commit-message">Commit message</label>
        <div className="ux-commit-options" aria-label="Commit drafting options">
          <label><span>Style</span><select value={draftStyle} onChange={(event) => setDraftStyle(event.target.value as CommitDraftOptions["style"])}><option value="conventional">Conventional</option><option value="plain">Plain</option></select></label>
          <label><span>Issue reference</span><input value={issueReference} onChange={(event) => setIssueReference(event.target.value)} placeholder="#123 or PROJ-123" spellCheck={false} /></label>
        </div>
        <div className="ux-commit-assist">
          <button
            type="button"
            className="ux-button"
            disabled={operationActive || !grouped.staged.length || grouped.conflicts.length > 0 || pending !== null}
            onClick={async () => {
              setPending("draft");
              setDraftNotice("Drafting from staged changes…");
              try {
                const draft = await onDraftCommit({ style: draftStyle, issueReference: issueReference.trim() || undefined });
                setMessage(draft.message);
                setIssueReference(draft.issueReference || issueReference);
                setDraftNotice(draft.source === "ollama" ? `Local model: ${draft.model || "Ollama"}` : "Offline local draft");
              } catch (error) {
                setDraftNotice(String(error));
              } finally {
                setPending(null);
              }
            }}
          >
            {pending === "draft" ? "Drafting…" : "Draft with local AI"}
          </button>
          <span title="Uses loopback Ollama when available, otherwise a deterministic offline draft.">{draftNotice || "Loopback model when available · offline fallback"}</span>
        </div>
        <textarea
          id="commit-message"
          value={message}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { setMessage(event.target.value); setDraftNotice(""); }}
          placeholder="Summary\n\nOptional description…"
        />
        <div className="ux-commit-meta">
          <span>{message.trim().split(/\s+/).filter(Boolean).length} words</span>
          <span>{message.length} characters</span>
        </div>
        <div className="ux-commit-quality" aria-label="Commit message quality checks">
          {messageQuality.map((check) => <span key={check.label} className={check.good ? "is-good" : "is-warn"}><i>{check.good ? "✓" : "!"}</i>{check.label}</span>)}
        </div>
        <button
          className="ux-primary-button"
          disabled={operationActive || !message.trim() || !grouped.staged.length || grouped.conflicts.length > 0 || pending !== null}
          onClick={async () => {
            setPending("commit");
            try {
              await onCommit(message.trim());
              setMessage("");
              setDraftNotice("");
            } finally {
              setPending(null);
            }
          }}
        >
          {pending === "commit" ? "Committing…" : "Commit staged changes"}
        </button>
        {operationActive && <p className="ux-help-text">Normal commit is locked while a Git operation is in progress. Resolve/stage changes, then use Continue in the operation banner.</p>}
        {!operationActive && grouped.conflicts.length > 0 && <p className="ux-help-text">Commit is blocked until conflicts are resolved.</p>}
        {!operationActive && !grouped.staged.length && !grouped.conflicts.length && <p className="ux-help-text">Stage one or more files to enable commit.</p>}
      </aside>
    </div>
  );
}
