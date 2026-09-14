import { useEffect, useMemo, useRef, useState } from "react";
import type { BranchRecord, RebaseAction, RebasePlan, RebasePlanItem } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

const actionLabels: Record<RebaseAction, string> = {
  pick: "Pick",
  reword: "Reword",
  edit: "Edit / pause",
  squash: "Squash",
  fixup: "Fixup",
  drop: "Drop"
};

type PlannedCommit = RebasePlanItem & {
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  additions: number;
  deletions: number;
  filesChanged: number;
};

type Props = {
  repositoryPath: string;
  branches: BranchRecord[];
  operationActive: boolean;
  onStarted: () => Promise<void> | void;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function validatePlan(items: PlannedCommit[]): string[] {
  const issues: string[] = [];
  let priorKept = false;
  for (const item of items) {
    if ((item.action === "squash" || item.action === "fixup") && !priorKept) {
      issues.push(`${actionLabels[item.action]} cannot be the first surviving action.`);
    }
    if (item.action === "reword" && !item.newMessage?.trim()) {
      issues.push(`Reword for ${item.commit.slice(0, 8)} needs a new message.`);
    }
    if (item.action !== "drop") priorKept = true;
  }
  if (!priorKept) issues.push("The plan drops every commit.");
  return issues;
}

export function RebasePlanner({ repositoryPath, branches, operationActive, onStarted }: Props) {
  const localBranches = useMemo(() => branches.filter((branch) => !branch.remote), [branches]);
  const suggestedTarget = useMemo(() => {
    const current = localBranches.find((branch) => branch.current);
    const preferred = localBranches.find((branch) => ["main", "master", "develop"].includes(branch.name) && !branch.current);
    return preferred?.name || current?.upstream || "main";
  }, [localBranches]);

  const [target, setTarget] = useState(suggestedTarget);
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [items, setItems] = useState<PlannedCommit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Choose a target branch or revision, then load the commits that would be replayed.");
  const [confirmStart, setConfirmStart] = useState(false);
  const [updateRefs, setUpdateRefs] = useState(false);
  const startButtonRef = useRef<HTMLButtonElement>(null);

  const selectedItem = items.find((item) => item.commit === selected) || items[0] || null;
  const issues = useMemo(() => validatePlan(items), [items]);
  const rewriteCount = items.filter((item) => item.action !== "pick").length;

  useEffect(() => {
    setTarget(suggestedTarget);
    setPlan(null);
    setItems([]);
    setSelected(null);
    setDragging(null);
    setConfirmStart(false);
    setUpdateRefs(false);
    setMessage("Choose a target branch or revision, then load the commits that would be replayed.");
  }, [repositoryPath, suggestedTarget]);

  const closeConfirm = () => {
    setConfirmStart(false);
    window.requestAnimationFrame(() => startButtonRef.current?.focus());
  };

  const load = async () => {
    if (!target.trim()) return;
    setBusy(true);
    setMessage("Analyzing branch ancestry and rebase range…");
    try {
      const next = await api.prepareRebase(repositoryPath, target.trim());
      setPlan(next);
      const nextItems: PlannedCommit[] = next.commits.map((commit) => ({
        commit: commit.commit,
        subject: commit.subject,
        action: "pick",
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        authoredAt: commit.authoredAt,
        additions: commit.additions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged
      }));
      setItems(nextItems);
      setSelected(nextItems[0]?.commit || null);
      setMessage(next.blockedReason || `${nextItems.length} commit${nextItems.length === 1 ? "" : "s"} ready to plan.`);
    } catch (error) {
      setPlan(null);
      setItems([]);
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const move = (commit: string, delta: number) => {
    setItems((current) => {
      const index = current.findIndex((item) => item.commit === commit);
      const nextIndex = index + delta;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  };

  const dropAt = (targetCommit: string) => {
    if (!dragging || dragging === targetCommit) return setDragging(null);
    setItems((current) => {
      const from = current.findIndex((item) => item.commit === dragging);
      const to = current.findIndex((item) => item.commit === targetCommit);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setDragging(null);
  };

  const changeAction = (commit: string, action: RebaseAction) => {
    setItems((current) => current.map((item) => item.commit === commit ? { ...item, action, newMessage: action === "reword" ? (item.newMessage || item.subject) : item.newMessage } : item));
  };

  const start = async () => {
    if (!plan || issues.length || plan.blockedReason) return;
    setBusy(true);
    setMessage("Starting interactive rebase…");
    try {
      const result = await api.startRebase(repositoryPath, {
        target: plan.target,
        base: plan.base,
        items: items.map(({ commit, subject, action, newMessage }) => ({ commit, subject, action, newMessage })),
        updateRefs: updateRefs && plan.supportsUpdateRefs
      });
      setConfirmStart(false);
      if (result.operation.operation) {
        setMessage(result.operation.hasConflicts ? "Rebase paused on conflicts. Continue in Conflict Center." : "Rebase paused at an edit step.");
      } else {
        setMessage("Interactive rebase completed successfully.");
      }
      await onStarted();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ux-rebase-planner">
      <header className="ux-view-toolbar">
        <div><h2>Interactive rebase</h2><span>Reorder and shape local history before it is shared</span></div>
        <div className="ux-rebase-target">
          <label><span>Rebase onto</span><input list="rebase-targets" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="main" /></label>
          <datalist id="rebase-targets">{branches.map((branch) => <option key={`${branch.remote}-${branch.name}`} value={branch.name} />)}</datalist>
          <button className="ux-button" disabled={busy || operationActive || !target.trim()} onClick={() => void load()}><Icon name="refresh" />Load plan</button>
        </div>
      </header>

      {operationActive && <div className="ux-inline-warning"><Icon name="warning" /><span>Finish or abort the current Git operation before starting a new interactive rebase.</span></div>}
      {plan?.warnings.map((warning) => <div className="ux-inline-warning is-info" key={warning}><Icon name="activity" /><span>{warning}</span></div>)}
      {plan?.blockedReason && <div className="ux-inline-warning"><Icon name="warning" /><span>{plan.blockedReason}</span></div>}

      <div className="ux-rebase-body">
        <section className="ux-rebase-list" aria-label="Interactive rebase plan">
          <div className="ux-rebase-plan-header">
            <span>Action</span><span>Commit</span><span>Author</span><span>Changes</span><span>Order</span>
          </div>
          {items.map((item, index) => (
            <div
              key={item.commit}
              className={`ux-rebase-row${selected === item.commit ? " is-selected" : ""}${dragging === item.commit ? " is-dragging" : ""}`}
              draggable
              onDragStart={() => setDragging(item.commit)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropAt(item.commit)}
              onClick={() => setSelected(item.commit)}
            >
              <select aria-label={`Action for ${item.subject}`} value={item.action} onChange={(event) => changeAction(item.commit, event.target.value as RebaseAction)}>
                {Object.entries(actionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              <button className="ux-rebase-commit" onClick={() => setSelected(item.commit)}>
                <code>{item.commit.slice(0, 8)}</code><strong>{item.subject}</strong>
              </button>
              <span title={item.authorEmail}>{item.authorName}</span>
              <span className="ux-diffstat"><b>+{item.additions}</b><i>−{item.deletions}</i><small>{item.filesChanged} files</small></span>
              <span className="ux-order-controls">
                <button className="ux-icon-button" disabled={index === 0} onClick={(event) => { event.stopPropagation(); move(item.commit, -1); }} aria-label="Move commit up">↑</button>
                <button className="ux-icon-button" disabled={index === items.length - 1} onClick={(event) => { event.stopPropagation(); move(item.commit, 1); }} aria-label="Move commit down">↓</button>
                <span className="ux-drag-handle" title="Drag to reorder">⋮⋮</span>
              </span>
            </div>
          ))}
          {!items.length && <div className="ux-empty-state">{busy ? "Loading rebase plan…" : "No plan loaded."}</div>}
        </section>

        <aside className="ux-rebase-inspector">
          {selectedItem ? <>
            <span className="ux-eyebrow">Planned commit</span>
            <h3>{selectedItem.subject}</h3>
            <dl className="ux-metadata-list compact">
              <dt>Commit</dt><dd><code>{selectedItem.commit}</code></dd>
              <dt>Author</dt><dd>{selectedItem.authorName}<small>{selectedItem.authorEmail}</small></dd>
              <dt>Date</dt><dd>{formatDate(selectedItem.authoredAt)}</dd>
              <dt>Changes</dt><dd><b>+{selectedItem.additions}</b> / <span>−{selectedItem.deletions}</span> across {selectedItem.filesChanged} files</dd>
            </dl>
            <label className="ux-field-stack"><span>Action</span>
              <select value={selectedItem.action} onChange={(event) => changeAction(selectedItem.commit, event.target.value as RebaseAction)}>
                {Object.entries(actionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            {selectedItem.action === "reword" && <label className="ux-field-stack"><span>New commit message</span><textarea value={selectedItem.newMessage || ""} onChange={(event) => setItems((current) => current.map((item) => item.commit === selectedItem.commit ? { ...item, newMessage: event.target.value } : item))} /></label>}
            <div className="ux-rebase-action-help">
              <strong>{actionLabels[selectedItem.action]}</strong>
              <span>{{ pick: "Replay this commit unchanged.", reword: "Replay it and replace its commit message.", edit: "Pause after replaying this commit so you can amend it manually.", squash: "Combine it with the previous surviving commit and keep both messages.", fixup: "Combine it with the previous surviving commit and discard this message.", drop: "Remove this commit from the rewritten history." }[selectedItem.action]}</span>
            </div>
          </> : <div className="ux-empty-state">Select a commit to inspect it.</div>}
        </aside>
      </div>

      <footer className="ux-rebase-footer">
        <div>
          <span>{message}</span>
          {issues.length > 0 && <strong className="ux-validation-error">{issues[0]}{issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}</strong>}
        </div>
        <div className="ux-rebase-footer-actions">
          <label className="ux-check-row" title={plan?.supportsUpdateRefs ? "Move other local branch refs that point into the rewritten range." : "Requires Git 2.38 or newer."}>
            <input type="checkbox" checked={updateRefs} disabled={!plan?.supportsUpdateRefs} onChange={(event) => setUpdateRefs(event.target.checked)} />Update related branches
          </label>
          <span>{rewriteCount ? `${rewriteCount} rewritten action${rewriteCount === 1 ? "" : "s"}` : "All commits picked"}</span>
          <button ref={startButtonRef} className="ux-primary-button" disabled={busy || operationActive || !plan || Boolean(plan.blockedReason) || issues.length > 0 || items.length === 0} onClick={() => setConfirmStart(true)}>Start rebase…</button>
        </div>
      </footer>

      {confirmStart && plan && (
        <div className="ux-confirm-backdrop" role="presentation" onMouseDown={closeConfirm}>
          <div
            className="ux-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rebase-confirm-title"
            aria-describedby="rebase-confirm-description"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); closeConfirm(); return; }
              if (event.key !== "Tab") return;
              const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")] as HTMLButtonElement[];
              if (!buttons.length) return;
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }}
          >
            <div className="ux-confirm-icon"><Icon name="warning" /></div>
            <div><h2 id="rebase-confirm-title">Rewrite {items.length} local commit{items.length === 1 ? "" : "s"}?</h2><p id="rebase-confirm-description">This rebases the selected commits onto <strong>{plan.target}</strong>. Commit IDs will change.{updateRefs ? " Related local branch refs inside the rewritten range will also move." : ""} Do not use this on history other people are already depending on unless you have coordinated the rewrite.</p></div>
            <div className="ux-confirm-actions"><button className="ux-button" autoFocus onClick={closeConfirm}>Review plan</button><button className="ux-danger-button solid" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Rewrite history"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
