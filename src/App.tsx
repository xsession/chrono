import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getApiConnection, saveApiConnection } from "./api";
import { Capacitor } from "@capacitor/core";
import type { BranchRecord, CommitRecord, FileChange, RepositoryOperationAction, RepositoryOperationState, RepositorySummary, Workspace } from "./types";
import { RepositorySidebar, type RepositoryView } from "./components/RepositorySidebar";
import { CommitGraph } from "./components/CommitGraph";
import { StatusPanel } from "./components/StatusPanel";
import { BranchPanel } from "./components/BranchPanel";
import { WorkflowPanel } from "./components/WorkflowPanel";
import { CherryParityPanel } from "./components/CherryParityPanel";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { CloneDialog } from "./components/CloneDialog";
import { OperationBanner } from "./components/OperationBanner";
import { ConflictCenter } from "./components/ConflictCenter";
import { RebasePlanner } from "./components/RebasePlanner";
import { GitIntelligencePanel } from "./components/GitIntelligencePanel";

const emptyWorkspace: Workspace = { id: "local", name: "Local repositories", repositories: [] };

// The browser cannot open native directory pickers; ask for a repository path
// via prompt() instead of the Tauri dialog the desktop build used.
const promptRepositoryPath = (title: string, initial = ""): Promise<string | null> =>
  window.chronoDesktop?.pickDirectory() ?? new Promise((resolve) => {
    const value = window.prompt(
      `${title}\nEnter an absolute path to a Git repository on the machine running the Chrono server:`,
      initial,
    );
    resolve(value ? value.trim() : null);
  });

const idleOperation: RepositoryOperationState = {
  operation: null,
  hasConflicts: false,
  conflictCount: 0,
  canContinue: false,
  canSkip: false,
  canAbort: false,
  currentCommit: null,
  currentSubject: null,
  step: null,
  total: null,
  message: "No merge, rebase, cherry-pick or revert is in progress."
};

export default function App() {
  const nativeMobile = Capacitor.isNativePlatform();
  const [connectionOpen, setConnectionOpen] = useState(nativeMobile && !getApiConnection().url);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([emptyWorkspace]);
  const [path, setPath] = useState("");
  const [summary, setSummary] = useState<RepositorySummary | null>(null);
  const [commits, setCommits] = useState<CommitRecord[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<CommitRecord | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [branches, setBranches] = useState<BranchRecord[]>([]);
  const [operation, setOperation] = useState<RepositoryOperationState>(idleOperation);
  const [view, setView] = useState<RepositoryView>("history");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [palette, setPalette] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);

  useEffect(() => {
    api.loadWorkspaces()
      .then((loaded) => setWorkspaces(loaded.length ? loaded : [emptyWorkspace]))
      .catch(() => undefined);
  }, []);

  const refresh = useCallback(async (repositoryPath = path) => {
    if (!repositoryPath) return;
    setBusy(true);
    try {
      const [nextSummary, nextCommits, nextChanges, nextBranches, nextOperation] = await Promise.all([
        api.summary(repositoryPath),
        api.history(repositoryPath),
        api.status(repositoryPath),
        api.branches(repositoryPath),
        api.operationState(repositoryPath)
      ]);
      setPath(repositoryPath);
      setSummary(nextSummary);
      setCommits(nextCommits);
      setSelectedCommit((current) => nextCommits.find((commit) => commit.id === current?.id) || nextCommits[0] || null);
      setChanges(nextChanges);
      setBranches(nextBranches);
      setOperation(nextOperation);
      setMessage(`Refreshed ${nextSummary.name}`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [path]);

  const rememberRepository = async (repositoryPath: string) => {
    const next = structuredClone(workspaces.length ? workspaces : [emptyWorkspace]);
    const workspace = next[0];
    if (!workspace.repositories.some((repository) => repository.path === repositoryPath)) {
      workspace.repositories.push({ path: repositoryPath });
      setWorkspaces(next);
      await api.saveWorkspaces(next);
    }
  };

  const openRepository = async () => {
    const selected = await promptRepositoryPath("Open Git repository");
    if (selected) {
      await rememberRepository(selected);
      await refresh(selected);
    }
  };

  const cloneRepository = () => setCloneOpen(true);

  const submitClone = async (url: string, destination: string) => {
    setBusy(true);
    setMessage("Cloning repository…");
    try {
      const cloned = await api.clone({ url, destination });
      await rememberRepository(cloned.path);
      await refresh(cloned.path);
      setCloneOpen(false);
      setMessage(`Cloned ${cloned.name}`);
    } catch (error) {
      setMessage(String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const runRepositoryAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    if (!path) return;
    setBusy(true);
    setMessage(`${label}…`);
    try {
      await action();
      await refresh(path);
      setMessage(`${label} completed`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [path, refresh]);

  const runOperationAction = useCallback(async (action: RepositoryOperationAction) => {
    if (!path || !operation.operation) return false;
    const label = action === "continue" ? "Continue operation" : action === "skip" ? "Skip commit" : "Abort operation";
    setBusy(true);
    setMessage(`${label}…`);
    try {
      await api.controlOperation(path, action);
      await refresh(path);
      setMessage(`${label} completed`);
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [operation.operation, path, refresh]);

  const conflictCount = changes.filter((change) => change.conflicted).length;
  const dirtyCount = changes.length;
  const operationActive = operation.operation !== null;

  useEffect(() => {
    if (view === "conflicts" && conflictCount === 0) setView("changes");
  }, [conflictCount, view]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPalette(true);
        return;
      }
      if (modifier && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
        return;
      }
      if (modifier && path && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        setView(event.key === "1" ? "changes" : event.key === "2" ? "history" : "branches");
        return;
      }
      if (event.key === "F5" && path) {
        event.preventDefault();
        void refresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [path, refresh]);

  const commands = useMemo<Command[]>(() => [
    { id: "open", title: "Open repository", category: "File", keywords: ["folder", "repo"], run: () => void openRepository() },
    { id: "clone", title: "Clone repository", category: "File", keywords: ["remote", "url"], run: () => void cloneRepository() },
    { id: "refresh", title: "Refresh repository", category: "Repository", shortcut: "F5", disabled: !path, run: () => void refresh() },
    { id: "fetch", title: "Fetch all remotes", category: "Remote", disabled: !path, run: () => void runRepositoryAction("Fetch", () => api.fetch(path)) },
    { id: "pull", title: "Pull current branch (fast-forward only)", category: "Remote", disabled: !path || operationActive, run: () => void runRepositoryAction("Pull", () => api.pull(path)) },
    { id: "push", title: "Push current branch", category: "Remote", disabled: !path || operationActive, run: () => void runRepositoryAction("Push", () => api.push(path)) },
    { id: "operation-continue", title: "Continue current Git operation", category: "Operation", disabled: !operation.canContinue, run: () => void runOperationAction("continue") },
    { id: "operation-skip", title: "Skip current commit", category: "Operation", disabled: !operation.canSkip, run: () => void runOperationAction("skip") },
    { id: "conflicts", title: "Open Conflict Center", category: "Operation", keywords: ["merge", "resolve", "three-way"], disabled: !path || conflictCount === 0, run: () => setView("conflicts") },
    { id: "changes", title: "Show working tree", category: "View", shortcut: "Ctrl+1", disabled: !path, run: () => setView("changes") },
    { id: "history", title: "Show history", category: "View", shortcut: "Ctrl+2", disabled: !path, run: () => setView("history") },
    { id: "branches", title: "Show branches", category: "View", shortcut: "Ctrl+3", disabled: !path, run: () => setView("branches") },
    { id: "rebase", title: "Plan interactive rebase", category: "History", keywords: ["rewrite", "squash", "fixup", "reword"], disabled: !path || operationActive, run: () => setView("rebase") },
    { id: "intelligence", title: "Open Git Intelligence", category: "Explore", keywords: ["search", "compare", "blame", "file history", "contributors"], disabled: !path, run: () => setView("insights") },
    { id: "worktrees", title: "Manage worktrees", category: "Repository", keywords: ["parallel", "checkout"], disabled: !path, run: () => setView("worktrees") },
    { id: "submodules", title: "Manage submodules", category: "Repository", disabled: !path, run: () => setView("submodules") },
    { id: "stashes", title: "Manage stashes", category: "Repository", disabled: !path, run: () => setView("stashes") },
    { id: "recovery", title: "Open recovery & maintenance", category: "Repository", keywords: ["reflog", "fsck", "lfs"], disabled: !path, run: () => setView("recovery") },
    { id: "sidebar", title: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", category: "View", shortcut: "Ctrl+B", run: () => setSidebarCollapsed((value) => !value) },
    { id: "cherry", title: "Open UI workbench", category: "Developer", run: () => setView("cherry") }
  ], [conflictCount, operation.canContinue, operation.canSkip, operationActive, path, refresh, runOperationAction, runRepositoryAction, sidebarCollapsed]);

  const currentBranch = summary?.branch || "Detached HEAD";

  return (
    <div className={`ux-app${sidebarCollapsed ? " sidebar-collapsed" : ""}${nativeMobile ? " native-mobile" : ""}`}>
      {nativeMobile && <button className="mobile-connection-button" onClick={() => setConnectionOpen(true)}>Backend</button>}
      {connectionOpen && <div className="connection-backdrop"><form className="connection-dialog" onSubmit={(event) => {
        event.preventDefault(); const data=new FormData(event.currentTarget);
        saveApiConnection({url:String(data.get("url")??""),token:String(data.get("token")??"")}); window.location.reload();
      }}><h2>Connect Android client</h2><p>Enter the HTTPS address and access token of your Chrono server.</p>
      <label>Backend URL<input name="url" type="url" required defaultValue={getApiConnection().url} placeholder="https://chrono.example.com" /></label>
      <label>API token<input name="token" type="password" required defaultValue={getApiConnection().token} /></label>
      <div className="connection-actions"><button type="button" onClick={()=>setConnectionOpen(false)}>Cancel</button><button type="submit">Save</button></div></form></div>}
      <header className="ux-topbar">
        <div className="ux-brand-lockup">
          <img src="/rsrc/icon_32x32.png" alt="" />
          <span>Chrono</span>
          <small>Next</small>
        </div>

        <div className="ux-topbar-context" title={summary?.path || undefined}>
          <strong>{summary?.name || "No repository open"}</strong>
          <span>{summary?.path || "Open or clone a repository to begin"}</span>
        </div>

        <div className="ux-global-actions" role="toolbar" aria-label="Global actions">
          <button className="ux-button" onClick={openRepository}>Open</button>
          <button className="ux-button" onClick={cloneRepository}>Clone</button>
          <button className="ux-command-button" onClick={() => setPalette(true)} title="Command palette (Ctrl+Shift+P)">
            <Icon name="command" /><span>Commands</span><kbd>Ctrl⇧P</kbd>
          </button>
        </div>
      </header>

      <RepositorySidebar
        workspaces={workspaces}
        activePath={path}
        activeView={view}
        summary={summary}
        changeCount={dirtyCount}
        conflictCount={conflictCount}
        collapsed={sidebarCollapsed}
        onSelect={refresh}
        onView={setView}
        onOpen={openRepository}
        onClone={cloneRepository}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />

      <main className={`ux-main${operationActive ? " has-operation" : ""}`}>
        <header className="ux-repository-header">
          <div className="ux-branch-context">
            <span className="ux-branch-icon"><Icon name="branch" /></span>
            <div><small>Current branch</small><strong>{path ? currentBranch : "—"}</strong></div>
            {summary?.dirty && <span className="ux-dirty-pill">{dirtyCount} changed</span>}
            {conflictCount > 0 && <button className="ux-conflict-pill" onClick={() => setView("conflicts")}><Icon name="warning" />{conflictCount} conflicts</button>}
          </div>

          <div className="ux-sync-summary" aria-label="Remote status">
            <span title="Commits behind upstream"><Icon name="download" />{summary?.behind ?? 0}</span>
            <span title="Commits ahead of upstream"><Icon name="upload" />{summary?.ahead ?? 0}</span>
          </div>

          <div className="ux-repo-actions" role="toolbar" aria-label="Repository actions">
            <button className="ux-icon-button" disabled={!path || busy} onClick={() => void refresh()} title="Refresh (F5)" aria-label="Refresh repository"><Icon name="refresh" /></button>
            <button className="ux-button" disabled={!path || busy} onClick={() => void runRepositoryAction("Fetch", () => api.fetch(path))}><Icon name="download" />Fetch</button>
            <button className="ux-button" disabled={!path || busy || operationActive} onClick={() => void runRepositoryAction("Pull", () => api.pull(path))} title={operationActive ? "Finish or abort the current Git operation first" : undefined}>Pull</button>
            <button className="ux-primary-button compact" disabled={!path || busy || operationActive} onClick={() => void runRepositoryAction("Push", () => api.push(path))} title={operationActive ? "Finish or abort the current Git operation first" : undefined}><Icon name="upload" />Push</button>
          </div>
        </header>

        {path && operationActive && (
          <OperationBanner
            state={operation}
            busy={busy}
            onResolve={() => setView("conflicts")}
            onContinue={() => runOperationAction("continue")}
            onSkip={() => runOperationAction("skip")}
            onAbort={() => runOperationAction("abort")}
          />
        )}

        <section className="ux-content" aria-live="polite">
          {!path && view !== "cherry" && (
            <div className="ux-welcome">
              <div className="ux-welcome-mark"><Icon name="repository" /></div>
              <h1>Open a repository</h1>
              <p>Chrono keeps history, working changes, branches, worktrees and recovery tools in one repository-centered workspace.</p>
              <div><button className="ux-primary-button" onClick={openRepository}>Open repository</button><button className="ux-button" onClick={cloneRepository}>Clone from URL</button></div>
              <span><kbd>Ctrl⇧P</kbd> opens the command palette anywhere.</span>
            </div>
          )}

          {path && view === "conflicts" && conflictCount > 0 && (
            <ConflictCenter
              repositoryPath={path}
              operation={operation.operation}
              onRepositoryChanged={() => refresh(path)}
            />
          )}
          {path && view === "changes" && (
            <StatusPanel
              changes={changes}
              onStage={async (files) => { await api.stage(path, files); await refresh(); }}
              onUnstage={async (files) => { await api.unstage(path, files); await refresh(); }}
              operationActive={operationActive}
              onResolveConflicts={() => setView("conflicts")}
              onCommit={async (commitMessage) => { await api.commit(path, commitMessage); await refresh(); }}
            />
          )}
          {path && view === "history" && <CommitGraph repositoryPath={path} commits={commits} branches={branches} headSha={summary?.head ?? undefined} selected={selectedCommit} onSelect={setSelectedCommit} />}
          {path && view === "branches" && (
            <BranchPanel
              branches={branches}
              disabled={operationActive}
              onCheckout={async (branch) => { await api.switchBranch(path, branch); await refresh(); }}
              onCreate={async (branch) => { await api.createBranch(path, branch); await refresh(); }}
            />
          )}
          {path && view === "rebase" && (
            <RebasePlanner repositoryPath={path} branches={branches} operationActive={operationActive} onStarted={() => refresh(path)} />
          )}
          {path && view === "insights" && (
            <GitIntelligencePanel repositoryPath={path} branches={branches} onOpenCommit={(commit) => { setSelectedCommit(commit); setView("history"); }} />
          )}
          {path && (view === "worktrees" || view === "submodules" || view === "stashes" || view === "recovery") && (
            <WorkflowPanel section={view} operationLocked={operationActive} onRun={(request) => api.workflow(path, request)} />
          )}
          {view === "cherry" && <CherryParityPanel />}
        </section>
      </main>

      <footer className="ux-statusbar">
        <span className={message.toLowerCase().includes("error") ? "is-error" : ""}>{message}</span>
        <span>{busy ? <><i className="ux-spinner" />Working…</> : path ? `${summary?.head?.slice(0, 8) || "no HEAD"} · ${changes.length ? `${changes.length} changed` : "clean"}` : "Ready"}</span>
      </footer>

      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
      <CloneDialog openDialog={cloneOpen} busy={busy} onClose={() => setCloneOpen(false)} onClone={submitClone} />
    </div>
  );
}
