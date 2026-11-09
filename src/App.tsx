import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getApiConnection, saveApiConnection } from "./api";
import { Capacitor } from "@capacitor/core";
import type { BranchRecord, CommitRecord, FileChange, RepositoryOperationAction, RepositoryOperationState, RepositorySummary, Workspace } from "./types";
import { RepositorySidebar, type RepositoryView } from "./components/RepositorySidebar";
import { CommitGraph } from "./components/CommitGraph";
import { StatusPanel } from "./components/StatusPanel";
import { BranchPanel } from "./components/BranchPanel";
import { RepoBrowser } from "./components/RepoBrowser";
import { RefsBrowser } from "./components/RefsBrowser";
import { WorkflowPanel } from "./components/WorkflowPanel";
import { CherryParityPanel } from "./components/CherryParityPanel";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { CloneDialog } from "./components/CloneDialog";
import { OperationBanner } from "./components/OperationBanner";
import { ConflictCenter } from "./components/ConflictCenter";
import { RebasePlanner } from "./components/RebasePlanner";
import { RepoTabs } from "./components/RepoTabs";
import { TerminalPanel, type TerminalPanelHandle } from "./components/TerminalPanel";
import { GitLogModal } from "./components/GitLogModal";
import { KeyBindingsModal } from "./components/KeyBindingsModal";
import { ToastHost } from "./components/ToastHost";
import { sagaBus } from "./sagas/bus";
import { buildSagaHandlers } from "./sagas/registry";
import { setSagaActions, type SagaActions } from "./sagas/actions";
import type { SagaResult } from "./sagas/bus";
import { pushToast, clearToasts } from "./toastBus";
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

  // v6 GitKraken-style additions: multi-repo tabs, terminal panel, modals, zoom.
  const [repoTabs, setRepoTabs] = useState<string[]>([]);
  const lastClosedTabRef = useRef<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [gitLogOpen, setGitLogOpen] = useState(false);
  const [keybindingsOpen, setKeybindingsOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const terminalRef = useRef<TerminalPanelHandle | null>(null);

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
      // v6 GitKraken-style shortcuts (RE §View/§TerminalPanel)
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); setTerminalOpen((value) => !value); return; }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "g") { event.preventDefault(); setGitLogOpen(true); return; }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); setKeybindingsOpen(true); return; }
      if (modifier && (event.key === "=" || event.key === "+")) { event.preventDefault(); zoom("up"); return; }
      if (modifier && event.key === "-") { event.preventDefault(); zoom("down"); return; }
      if (modifier && !event.shiftKey && event.key === "0") { event.preventDefault(); zoom("reset"); return; }
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

  // ---------------------------------------------------------------------------
  // v6 multi-repo tabs (GitKraken RE §Tabs) + saga bridge wiring (§11.2)
  // ---------------------------------------------------------------------------
  const openRepoTab = useCallback(async (repositoryPath?: string): Promise<SagaResult> => {
    let target = repositoryPath;
    if (!target) {
      const selected = await promptRepositoryPath("Open Git repository");
      if (!selected) return { ok: false, error: "cancelled" };
      target = selected;
    }
    try {
      await rememberRepository(target);
      setRepoTabs((current) => (current.includes(target) ? current : [...current, target]));
      await refresh(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }, [refresh]);

  const closeActiveTab = useCallback(() => {
    if (!path) return;
    lastClosedTabRef.current = path;
    setRepoTabs((current) => {
      const next = current.filter((tab) => tab !== path);
      if (next.length > 0) void refresh(next[next.length - 1]).catch(() => undefined);
      else { setSummary(null); setCommits([]); setSelectedCommit(null); setChanges([]); setBranches([]); }
      return next;
    });
  }, [path, refresh]);

  const closeTab = useCallback((target: string) => {
    lastClosedTabRef.current = target;
    setRepoTabs((current) => {
      const next = current.filter((tab) => tab !== target);
      if (next.length > 0 && target === path) void refresh(next[next.length - 1]).catch(() => undefined);
      return next;
    });
  }, [path, refresh]);

  const selectTab = useCallback((index: number) => {
    setRepoTabs((current) => {
      const target = current[index];
      if (target && target !== path) void refresh(target).catch(() => undefined);
      return current;
    });
  }, [path, refresh]);

  const zoom = useCallback((direction: "up" | "down" | "reset") => {
    setZoomLevel((current) => {
      const next = direction === "reset" ? 1 : Math.min(2, Math.max(0.6, current + (direction === "up" ? 0.1 : -0.1)));
      document.documentElement.style.fontSize = `${Math.round(next * 100)}%`;
      return next;
    });
  }, []);

  const sagaActions: SagaActions = {
    openRepo: async (repositoryPath) => { await rememberRepository(repositoryPath); setRepoTabs((current) => current.includes(repositoryPath) ? current : [...current, repositoryPath]); try { await refresh(repositoryPath); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    promptOpenRepo: async () => { const selected = await promptRepositoryPath("Open Git repository"); if (!selected) return { ok: false, error: "cancelled" }; await rememberRepository(selected); setRepoTabs((current) => current.includes(selected) ? current : [...current, selected]); try { await refresh(selected); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    refresh: async () => { if (!path) return { ok: false, error: "no repository open" }; try { await refresh(); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    listKnownRepos: async () => workspaces[0]?.repositories.map((repository) => repository.path) ?? [],
    selectBranch: async (name) => { if (!path) return { ok: false, error: "no repository open" }; try { const record = branches.find((branch) => branch.name === name); if (!record) return { ok: false, error: `branch not found: ${name}` }; if (record.remote) await api.checkoutRemoteBranch(path, name); else await api.switchBranch(path, name); await refresh(); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    selectCommit: async (sha) => { const commit = commits.find((candidate) => candidate.id === sha || candidate.id.startsWith(sha)); if (!commit) return { ok: false, error: `commit not found: ${sha}` }; setSelectedCommit(commit); setView("history"); return { ok: true }; },
    runSearch: async (query, mode = "message") => { if (!path) return { ok: false, error: "no repository open" }; try { const results = await api.historyQuery(path, { query, mode }); setSelectedCommit(results[0] ?? null); setView("history"); setMessage(`Found ${results.length} commit(s) matching “${query}”`); return { ok: true, result: results.length }; } catch (error) { return { ok: false, error: String(error) }; } },
    toggleLeftPanel: () => setSidebarCollapsed((value) => !value),
    toggleDetailPanel: () => { if (selectedCommit) setView("history"); else pushToast("Select a commit first — details show in the history view", "info"); },
    closeModals: () => { setPalette(false); setCloneOpen(false); setGitLogOpen(false); setKeybindingsOpen(false); },
    openPreferences: (section) => { if (section === "protocol") pushToast("Deep links: chrono://repo?path=… — registered in the desktop build", "info"); else setConnectionOpen(true); },
    openErrorLog: async () => { setGitLogOpen(true); return; },
    showToast: (message, kind = "info") => pushToast(message, kind),
    hideToasts: () => clearToasts(),
    openRepoTab,
    closeActiveTab,
    selectNextTab: () => selectTab(Math.min(repoTabs.length - 1, Math.max(0, repoTabs.indexOf(path)) + 1)),
    selectPreviousTab: () => selectTab(Math.max(0, (repoTabs.indexOf(path) < 0 ? 0 : repoTabs.indexOf(path) - 1))),
    selectTabIndex: (index) => selectTab(index),
    toggleTabDropdown: () => pushToast(`Open repositories: ${repoTabs.join(", ") || "none"}`, "info"),
    reopenClosedTab: () => { const last = lastClosedTabRef.current; if (!last) return; setRepoTabs((current) => (current.includes(last) ? current : [...current, last])); void refresh(last).catch(() => undefined); },
    toggleFuzzyFinder: () => setPalette((value) => !value),
    openKeyBindingsModal: () => setKeybindingsOpen(true),
    zoom,
    openExternal: async (target, p) => { const targetPath = p || path; if (!targetPath) return { ok: false, error: "no repository path" }; try { const desktop = (window as unknown as { chronoDesktop?: { openPath?: (kind: string, dir: string) => Promise<string> } }).chronoDesktop; if (desktop?.openPath) { const result = await desktop.openPath(target, targetPath); return { ok: true, result }; } pushToast(`Open ${target} at ${targetPath}`, "info"); return { ok: true, result: targetPath }; } catch (error) { return { ok: false, error: String(error) }; } },
    createTerminalTab: async (repoPath) => { setTerminalOpen(true); requestAnimationFrame(() => terminalRef.current?.createTab(repoPath || path || undefined)); return { ok: true }; },
    closeActiveTerminalTab: () => terminalRef.current?.closeActiveTab(),
    selectNextTerminalTab: () => terminalRef.current?.selectNextTab(),
    selectPreviousTerminalTab: () => terminalRef.current?.selectPreviousTab(),
    selectTerminalTabByIndex: (index) => terminalRef.current?.selectTabIndex(index),
    toggleTerminalPanel: () => setTerminalOpen((value) => !value),
  };

  // Register the GitKraken-compatible saga registry once; expose actions to it.
  useEffect(() => {
    for (const [name, handler] of Object.entries(buildSagaHandlers())) sagaBus.register(name, handler);
    setSagaActions(sagaActions);
    return () => setSagaActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep-link entry points: Electron IPC (chrono:deep-link), desktop bridge, web ?chrono=… fallback.
  useEffect(() => {
    const dispatchUri = (uri: string) => { void sagaBus.dispatch("DeepLink.handleOpenDeepLink", { uri }); };
    const onWindowEvent = (event: Event) => { const detail = (event as CustomEvent).detail; if (typeof detail === "string") dispatchUri(detail); else if (detail?.uri) dispatchUri(String(detail.uri)); };
    window.addEventListener("chrono:deep-link", onWindowEvent);
    const desktop = (window as unknown as { chronoDesktop?: { onDeepLink?: (cb: (uri: string) => void) => () => void } }).chronoDesktop;
    const offDesktop = desktop?.onDeepLink ? desktop.onDeepLink((uri) => dispatchUri(uri)) : undefined;
    // Surface saga failures as toasts so deep-link/IPC errors are visible.
    const offBus = sagaBus.on((event) => { if (event.kind === "failure") pushToast(`Saga ${event.name} failed: ${event.error}`, "error"); });
    const params = new URLSearchParams(window.location.search);
    const chronoParam = params.get("chrono");
    if (chronoParam) {
      // Forward every query parameter except the command marker itself.
      const forwarded = [...params.entries()].filter(([key]) => key !== "chrono").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
      dispatchUri(`chrono://${chronoParam}${forwarded ? `?${forwarded}` : ""}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
    return () => { window.removeEventListener("chrono:deep-link", onWindowEvent); offDesktop?.(); offBus(); };
  }, []);

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
    { id: "refs", title: "Open references browser", category: "Repository", keywords: ["branches", "remotes", "tags", "worktrees", "stashes", "submodules"], disabled: !path, run: () => setView("refs") },
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

        {repoTabs.length > 0 && (
          <RepoTabs
            tabs={repoTabs.map((tabPath) => ({ id: tabPath, path: tabPath, name: tabPath.split("/").filter(Boolean).pop() || tabPath }))}
            activeId={path || null}
            onSelect={(id) => void refresh(id)}
            onClose={(id) => closeTab(id)}
            onNew={() => void openRepoTab()}
          />
        )}

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
              repositoryPath={path}
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
              repositoryPath={path}
              headSha={summary?.head ?? undefined}
              disabled={operationActive}
              onCheckout={async (branch) => { await api.switchBranch(path, branch); await refresh(); }}
              onCreate={async (branch) => { await api.createBranch(path, branch); await refresh(); }}
              onDelete={async (branch, force) => { const result = await api.deleteBranch(path, branch, force); await refresh(); return result; }}
              onNotify={(message) => setMessage(message)}
            />
          )}
          {path && view === "refs" && (
            <RefsBrowser
              repositoryPath={path}
              headSha={summary?.head ?? undefined}
              onCheckout={async (branch) => { await api.switchBranch(path, branch); await refresh(); }}
              onCheckoutRemote={async (remoteBranch) => { await api.checkoutRemoteBranch(path, remoteBranch); await refresh(); }}
              onNotify={(message) => setMessage(message)}
              onRefresh={async () => { await refresh(); }}
            />
          )}
          {path && view === "rebase" && (
            <RebasePlanner repositoryPath={path} branches={branches} operationActive={operationActive} onStarted={() => refresh(path)} />
          )}
          {path && view === "insights" && (
            <GitIntelligencePanel repositoryPath={path} branches={branches} onOpenCommit={(commit) => { setSelectedCommit(commit); setView("history"); }} />
          )}
          {path && view === "repo" && (
            <RepoBrowser
              repositoryPath={path}
              branches={branches.filter((branch) => !branch.remote).map((branch) => branch.name)}
              onExport={async (revision, destination) => {
                const result = await api.exportRevision(path, revision, destination);
                await refresh();
                return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || `Exported ${revision} to ${destination}.`;
              }}
            />
          )}
          {path && (view === "worktrees" || view === "submodules" || view === "stashes" || view === "recovery") && (
            <WorkflowPanel section={view} repositoryPath={path} operationLocked={operationActive} onRun={(request) => api.workflow(path, request)} />
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

      {/* v6 GitKraken-style additions: integrated terminal, git executor log, keybindings, toasts */}
      <TerminalPanel ref={terminalRef} open={terminalOpen} repositoryPath={path || undefined} />
      <GitLogModal open={gitLogOpen} onClose={() => setGitLogOpen(false)} />
      <KeyBindingsModal open={keybindingsOpen} onClose={() => setKeybindingsOpen(false)} onZoom={(direction) => zoom(direction)} />
      <ToastHost />
    </div>
  );
}
