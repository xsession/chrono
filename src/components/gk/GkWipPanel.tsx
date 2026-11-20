import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { api } from "../../api";
import type { CommitTemplate, ContributorRecord, FileChange, HookCommitResult } from "../../types";
import { Icon } from "../Icon";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { askConfirm, askText } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { withLiveOutput } from "../../liveOutput";

type Props = {
  repositoryPath: string;
  branch: string | null;
  changes: FileChange[];
  busy: boolean;
  operationActive: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onOpenDiff: (file: string) => void;
  openDiff: string | null;
  onResolveConflicts: () => void;
  onShowInExplorer: (file: string) => void;
  onFileHistory: (file: string) => void;
};

type Group = "unstaged" | "staged";
const VIEW_KEY = "chrono.gk.wip.view";

function letter(code: string, conflicted: boolean): { mark: string; kind: string; label: string } {
  if (conflicted) return { mark: "!", kind: "conflicted", label: "Conflicted" };
  switch (code) {
    case "?": return { mark: "+", kind: "untracked", label: "Untracked" };
    case "A": return { mark: "+", kind: "added", label: "Added" };
    case "D": return { mark: "−", kind: "deleted", label: "Deleted" };
    case "R": return { mark: "→", kind: "renamed", label: "Renamed" };
    case "C": return { mark: "⧉", kind: "renamed", label: "Copied" };
    case "T": return { mark: "T", kind: "modified", label: "Type changed" };
    default: return { mark: "✎", kind: "modified", label: "Modified" };
  }
}

const isStaged = (change: FileChange) => !change.conflicted && change.indexStatus !== " " && change.indexStatus !== "?" && change.indexStatus !== "";
const isUnstaged = (change: FileChange) => change.conflicted || change.worktreeStatus !== " " && change.worktreeStatus !== "" || change.indexStatus === "?";

/** GitKraken's right-hand WIP panel: Unstaged / Staged file lists with
 *  stage-all / unstage-all, path ⇄ tree view, per-file context menus, and the
 *  summary + description commit box with amend, sign-off and AI draft. */
export function GkWipPanel({ repositoryPath, branch, changes, busy, operationActive, run, onOpenDiff, openDiff, onResolveConflicts, onShowInExplorer, onFileHistory }: Props) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [view, setView] = useState<"path" | "tree">(() => (localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "path"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const menu = useContextMenu();
  const [templates, setTemplates] = useState<CommitTemplate[]>([]);
  const [coAuthors, setCoAuthors] = useState<string[]>([]);
  const [contributors, setContributors] = useState<ContributorRecord[] | null>(null);
  const [coAuthorQuery, setCoAuthorQuery] = useState("");
  const [showCoAuthors, setShowCoAuthors] = useState(false);
  const [explanation, setExplanation] = useState<{ text: string; source: string } | null>(null);
  const [explaining, setExplaining] = useState(false);

  useEffect(() => { api.commitTemplates(repositoryPath).then(setTemplates).catch(() => setTemplates([])); }, [repositoryPath]);
  useEffect(() => {
    if (!showCoAuthors || contributors) return;
    api.contributors(repositoryPath, 5000).then(setContributors).catch(() => setContributors([]));
  }, [showCoAuthors, contributors, repositoryPath]);

  const applyTemplate = (template: CommitTemplate) => {
    const [first, ...rest] = template.text.split(/\r?\n/);
    setSummary(first ?? "");
    setDescription(rest.join("\n").replace(/^\n+/, ""));
  };
  const templateTrigger = summary.startsWith("t:") ? summary.slice(2).trim().toLowerCase() : null;
  const templateMatches = templateTrigger === null ? [] : templates.filter((template) => template.name.toLowerCase().includes(templateTrigger));

  const unstaged = useMemo(() => changes.filter(isUnstaged), [changes]);
  const staged = useMemo(() => changes.filter(isStaged), [changes]);
  const conflicts = changes.filter((change) => change.conflicted).length;

  useEffect(() => {
    if (!amend) return;
    let cancelled = false;
    api.lastCommitMessage(repositoryPath).then((message) => {
      if (cancelled) return;
      const [first, ...rest] = message.split(/\r?\n/);
      setSummary(first ?? "");
      setDescription(rest.join("\n").replace(/^\n+/, ""));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [amend, repositoryPath]);

  const trailers = coAuthors.map((author) => `Co-authored-by: ${author}`).join("\n");
  const message = [summary.trim(), description.trim(), trailers].filter(Boolean).join("\n\n");
  const canCommit = !busy && (staged.length > 0 || amend || unstaged.length > 0) && (summary.trim().length > 0 || amend) && conflicts === 0;

  const commit = async () => {
    if (!canCommit || templateTrigger !== null) return;
    const stageAllFirst = staged.length === 0 && !amend;
    let failure: HookCommitResult | null = null;
    let succeeded = false;
    await run(amend ? "Amend commit" : "Commit", async () => {
      if (stageAllFirst) await api.stage(repositoryPath, unstaged.map((change) => change.path));
      const result = await withLiveOutput(amend ? "Amend commit" : "Commit", (streamId) => api.commitWithHooks(repositoryPath, message, { amend, signoff, streamId }));
      if (!result.ok) { failure = result; throw new Error(result.hookFailed ? `${result.hookFailed} hook failed` : result.output.trim() || "commit failed"); }
      succeeded = true;
    });
    const failed = failure as HookCommitResult | null;
    if (!succeeded && failed?.hookFailed) {
      const bypass = await askConfirm(`${failed.hookFailed} hook failed (exit ${failed.exitCode})`, (
        <div className="gk-hook-failure">
          <p>The commit was not created. Fix the problem and commit again, or bypass the hooks for this one commit.</p>
          <pre>{failed.output.replace(/\u001b\[[0-9;]*m/g, "") || "(no output)"}</pre>
          <p className="gk-hook-warning">“Commit anyway” runs git commit --no-verify: pre-commit and commit-msg hooks are skipped.</p>
        </div>
      ), { confirm: "Commit anyway (--no-verify)", danger: true });
      if (bypass) {
        await run("Commit (hooks bypassed)", async () => {
          const retry = await api.commitWithHooks(repositoryPath, message, { amend, signoff, noVerify: true });
          if (!retry.ok) throw new Error(retry.output.trim() || "commit failed");
          succeeded = true;
        });
      }
    }
    if (succeeded) { setSummary(""); setDescription(""); setAmend(false); setCoAuthors([]); setExplanation(null); }
  };

  const draft = async () => {
    setDrafting(true);
    try {
      const result = await api.draftCommit(repositoryPath, "auto", undefined, { style: "conventional" });
      const [first, ...rest] = result.message.split(/\r?\n/);
      setSummary(first ?? "");
      setDescription(rest.join("\n").replace(/^\n+/, ""));
    } catch (error) {
      pushToast(`Draft failed: ${String(error)}`, "error");
    } finally {
      setDrafting(false);
    }
  };

  const discard = async (files: string[]) => {
    if (!(await askConfirm("Discard changes", files.length === 1 ? `Discard all changes to ${files[0]}? Untracked files are deleted.` : `Discard changes to ${files.length} files? Untracked files are deleted.`, { confirm: "Discard", danger: true }))) return;
    await run("Discard changes", () => api.discard(repositoryPath, files));
  };

  const fileMenu = (change: FileChange, group: Group): MenuItem[] => {
    const targets = selected.has(change.path) && selected.size > 1 ? [...selected] : [change.path];
    const ext = change.path.includes(".") ? change.path.slice(change.path.lastIndexOf(".")) : "";
    const folder = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
    return [
      group === "unstaged"
        ? { id: "stage", label: targets.length > 1 ? `Stage ${targets.length} files` : "Stage file", icon: "plus", disabled: busy, onSelect: () => run("Stage", () => api.stage(repositoryPath, targets)) }
        : { id: "unstage", label: targets.length > 1 ? `Unstage ${targets.length} files` : "Unstage file", icon: "minus", disabled: busy, onSelect: () => run("Unstage", () => api.unstage(repositoryPath, targets)) },
      { id: "diff", label: "Open diff", icon: "diff", onSelect: () => onOpenDiff(change.path) },
      ...(change.conflicted ? [{ id: "resolve", label: "Resolve in Conflict Center", icon: "warning" as const, onSelect: onResolveConflicts }] : []),
      { kind: "separator", id: "s1" },
      { id: "discard", label: targets.length > 1 ? `Discard changes to ${targets.length} files` : "Discard changes", icon: "trash", danger: true, disabled: busy, onSelect: () => discard(targets) },
      { id: "stash", label: "Stash file(s)", icon: "stash", disabled: busy, onSelect: async () => {
        const note = await askText("Stash selected files", "Stash message", `WIP ${targets.length === 1 ? targets[0] : `${targets.length} files`}`);
        if (note !== null) await run("Stash files", () => api.explorerAction(repositoryPath, { action: "stash_save", files: targets, message: note }));
      } },
      { id: "ignore", label: "Ignore", icon: "ignore", disabled: busy, submenu: [
        { id: "ig-file", label: `Ignore ${change.path.split("/").pop()}`, onSelect: () => run("Ignore", () => api.explorerAction(repositoryPath, { action: change.indexStatus === "?" ? "ignore_name" : "ignore_and_remove", files: [change.path], scope: "root" })) },
        ...(ext ? [{ id: "ig-ext", label: `Ignore all *${ext} files`, onSelect: () => run("Ignore", () => api.explorerAction(repositoryPath, { action: "ignore_ext", files: [change.path], scope: "root" })) }] : []),
        ...(folder ? [{ id: "ig-dir", label: `Ignore ${folder}/`, onSelect: () => run("Ignore", () => api.explorerAction(repositoryPath, { action: "ignore_name", files: [folder], scope: "root" })) }] : []),
      ] },
      { kind: "separator", id: "s2" },
      { id: "history", label: "File history", icon: "history", onSelect: () => onFileHistory(change.path) },
      { id: "explorer", label: "Show in Explorer", icon: "folder", onSelect: () => onShowInExplorer(change.path) },
      { id: "open", label: "Open file", icon: "external", onSelect: async () => { try { await api.explorerOpen(repositoryPath, change.path, "open"); } catch (error) { pushToast(String(error), "error"); } } },
      { id: "copy", label: "Copy file path", icon: "copy", onSelect: async () => { try { await navigator.clipboard.writeText(change.path); pushToast("Path copied", "success", 2000); } catch { pushToast(change.path); } } },
    ];
  };

  const toggleSelect = (event: ReactMouseEvent, file: string) => {
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => { const next = new Set(current); if (next.has(file)) next.delete(file); else next.add(file); return next; });
      return true;
    }
    setSelected(new Set([file]));
    return false;
  };

  const renderRows = (list: FileChange[], group: Group) => {
    const rows = [...list].sort((a, b) => a.path.localeCompare(b.path));
    let lastFolder = "";
    return rows.map((change) => {
      const code = group === "staged" ? change.indexStatus : change.indexStatus === "?" ? "?" : change.worktreeStatus;
      const meta = letter(code, change.conflicted);
      const slash = change.path.lastIndexOf("/");
      const folder = slash >= 0 ? change.path.slice(0, slash) : "";
      const name = slash >= 0 ? change.path.slice(slash + 1) : change.path;
      const header = view === "tree" && folder !== lastFolder ? <div key={`${group}-dir-${folder}`} className="gk-wip-folder"><Icon name="folder" />{folder || "/"}</div> : null;
      lastFolder = folder;
      return [
        header,
        <div
          key={`${group}-${change.path}`}
          className={`gk-wip-file${openDiff === change.path ? " is-open" : ""}${selected.has(change.path) ? " is-selected" : ""}`}
          role="button"
          tabIndex={0}
          title={`${meta.label}: ${change.path}`}
          onClick={(event) => { if (!toggleSelect(event, change.path)) onOpenDiff(change.path); }}
          onKeyDown={(event) => { if (event.key === "Enter") onOpenDiff(change.path); }}
          onContextMenu={(event) => { if (!selected.has(change.path)) setSelected(new Set([change.path])); menu.open(event, fileMenu(change, group), change.path); }}
        >
          <span className={`gk-file-badge is-${meta.kind}`} aria-label={meta.label}>{meta.mark}</span>
          <span className="gk-wip-path" style={view === "tree" ? { paddingLeft: 14 } : undefined}>
            {view === "path" && folder && <small>{folder}/</small>}
            <span>{name}</span>
          </span>
          <button
            type="button"
            className={`gk-wip-file-action${group === "staged" ? " is-unstage" : ""}`}
            disabled={busy || (change.conflicted && group === "unstaged" && false)}
            onClick={(event) => {
              event.stopPropagation();
              if (group === "staged") void run("Unstage", () => api.unstage(repositoryPath, [change.path]));
              else if (change.conflicted) onResolveConflicts();
              else void run("Stage", () => api.stage(repositoryPath, [change.path]));
            }}
          >{group === "staged" ? "Unstage" : change.conflicted ? "Resolve" : "Stage"}</button>
        </div>,
      ];
    });
  };

  const setViewMode = (mode: "path" | "tree") => { setView(mode); localStorage.setItem(VIEW_KEY, mode); };

  return (
    <div className="gk-wip-panel" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void commit(); } }}>
      <header className="gk-wip-header">
        <div>
          <strong>{changes.length} file change{changes.length === 1 ? "" : "s"}</strong>
          <span>on {branch ?? "detached HEAD"}</span>
        </div>
        <div className="gk-wip-header-actions">
          <div className="gk-seg" role="group" aria-label="File view">
            <button type="button" className={view === "path" ? "is-active" : ""} onClick={() => setViewMode("path")} title="Path view">Path</button>
            <button type="button" className={view === "tree" ? "is-active" : ""} onClick={() => setViewMode("tree")} title="Tree view">Tree</button>
          </div>
          <button type="button" className="ux-icon-button" title="Explain my changes" aria-label="Explain my changes" disabled={explaining || changes.length === 0} onClick={async () => {
            setExplaining(true);
            try { setExplanation(await api.explain(repositoryPath, "working")); } catch (error) { pushToast(String(error), "error"); }
            finally { setExplaining(false); }
          }}>✨</button>
          <button type="button" className="ux-icon-button" title="Discard all changes" aria-label="Discard all changes" disabled={busy || changes.length === 0} onClick={async () => {
            if (await askConfirm("Discard all changes", "Reset every tracked file to HEAD and delete all untracked files? This cannot be undone.", { confirm: "Discard all", danger: true })) await run("Discard all changes", () => api.discard(repositoryPath, "all"));
          }}><Icon name="trash" /></button>
        </div>
      </header>

      {explanation && (
        <div className="gk-wip-explain">
          <pre>{explanation.text}</pre>
          <div><small>{explanation.source === "ollama" ? "local AI" : "offline summary"}</small><button type="button" className="gk-link-button" onClick={() => setExplanation(null)}>Dismiss</button></div>
        </div>
      )}

      {conflicts > 0 && (
        <button type="button" className="gk-wip-conflicts" onClick={onResolveConflicts}><Icon name="warning" />{conflicts} conflicted file{conflicts === 1 ? "" : "s"} — open Conflict Center</button>
      )}

      <section className="gk-wip-group">
        <header>
          <span>Unstaged Files ({unstaged.length})</span>
          <button type="button" className="gk-stage-all" disabled={busy || unstaged.filter((change) => !change.conflicted).length === 0} onClick={() => run("Stage all", () => api.stage(repositoryPath, unstaged.filter((change) => !change.conflicted).map((change) => change.path)))}>Stage all changes</button>
        </header>
        <div className="gk-wip-list">{unstaged.length ? renderRows(unstaged, "unstaged") : <div className="gk-empty">No unstaged changes</div>}</div>
      </section>

      <section className="gk-wip-group">
        <header>
          <span>Staged Files ({staged.length})</span>
          <button type="button" className="gk-stage-all is-unstage" disabled={busy || staged.length === 0} onClick={() => run("Unstage all", () => api.unstage(repositoryPath, staged.map((change) => change.path)))}>Unstage all changes</button>
        </header>
        <div className="gk-wip-list">{staged.length ? renderRows(staged, "staged") : <div className="gk-empty">Stage files to include them in the commit</div>}</div>
      </section>

      <section className="gk-commit-box" aria-label="Commit message">
        <div className="gk-commit-options">
          <label><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} disabled={busy || operationActive} />Amend previous commit</label>
          <label title="Append a Signed-off-by trailer"><input type="checkbox" checked={signoff} onChange={(event) => setSignoff(event.target.checked)} />Sign-off</label>
          <button type="button" className="gk-link-button" disabled={drafting || busy || changes.length === 0} onClick={() => void draft()} title="Draft a message from the staged diff (local AI or offline rules)">{drafting ? "Drafting…" : "✨ Draft message"}</button>
        </div>
        <div className="gk-summary-row">
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Commit summary  (t: inserts a template)" aria-label="Commit summary" maxLength={200}
            onKeyDown={(event) => { if (templateTrigger !== null && event.key === "Enter" && templateMatches[0]) { event.preventDefault(); applyTemplate(templateMatches[0]); } }} />
          <span className={summary.length > 72 ? "is-over" : ""}>{72 - summary.length}</span>
        </div>
        {templateTrigger !== null && (
          <div className="gk-template-popup" role="listbox" aria-label="Commit templates">
            {templateMatches.map((template) => <button key={template.id} type="button" role="option" aria-selected="false" onClick={() => applyTemplate(template)}><strong>{template.name}</strong><small>{template.text.split("\n")[0]}</small></button>)}
            {!templateMatches.length && <span className="gk-empty">No templates — add some in Settings → Commit templates.</span>}
          </div>
        )}
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" aria-label="Commit description" rows={4} />
        <div className="gk-coauthors">
          {coAuthors.map((author) => <span key={author} className="gk-chip">{author.replace(/ <.*$/, "")}<button type="button" aria-label={`Remove co-author ${author}`} onClick={() => setCoAuthors(coAuthors.filter((value) => value !== author))}>✕</button></span>)}
          <button type="button" className="gk-link-button" onClick={() => setShowCoAuthors((value) => !value)}>{showCoAuthors ? "Done" : "+ Co-author"}</button>
          {templates.length > 0 && <select className="gk-template-select" value="" aria-label="Insert commit template" onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); if (template) applyTemplate(template); }}><option value="">Template…</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>}
        </div>
        {showCoAuthors && (
          <div className="gk-coauthor-picker">
            <input autoFocus value={coAuthorQuery} onChange={(event) => setCoAuthorQuery(event.target.value)} placeholder="Search contributors or type Name <email>" aria-label="Co-author search"
              onKeyDown={(event) => { if (event.key === "Enter" && /<[^>]+@[^>]+>/.test(coAuthorQuery)) { event.preventDefault(); setCoAuthors([...new Set([...coAuthors, coAuthorQuery.trim()])]); setCoAuthorQuery(""); } }} />
            <div className="gk-coauthor-list">
              {!contributors ? <span className="gk-empty"><i className="ux-spinner" />Loading contributors…</span> : contributors
                .filter((person) => `${person.name} ${person.email}`.toLowerCase().includes(coAuthorQuery.toLowerCase()))
                .slice(0, 8)
                .map((person) => {
                  const value = `${person.name} <${person.email}>`;
                  return <button key={value} type="button" disabled={coAuthors.includes(value)} onClick={() => setCoAuthors([...coAuthors, value])}>{person.name}<small>{person.email} · {person.commits} commits</small></button>;
                })}
            </div>
          </div>
        )}
        <button type="button" className="gk-commit-button" disabled={!canCommit} onClick={() => void commit()} title="Ctrl+Enter">
          {conflicts ? "Resolve conflicts to commit"
            : amend ? "Amend previous commit"
            : staged.length ? `Commit changes to ${staged.length} file${staged.length === 1 ? "" : "s"}`
            : unstaged.length ? `Stage all & commit ${unstaged.length} file${unstaged.length === 1 ? "" : "s"}`
            : "No changes to commit"}
        </button>
      </section>
      {menu.element}
    </div>
  );
}
