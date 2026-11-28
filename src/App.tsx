import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { abandonRepositoryReads, api, getApiConnection, isAbandoned, saveApiConnection } from "./api";
import { Capacitor } from "@capacitor/core";
import type { BranchRecord, CommitRecord, FileChange, ForkStatus, RepositoryOperationAction, RepositoryOperationState, RepositorySummary, Workspace } from "./types";
import { HISTORY_PAGE_SIZE, addHistoryPage, summarizeHistoryWindow, type HistorySegment } from "./historyWindow";
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
import { SplitHandle } from "./components/SplitHandle";
import { useStoredWidth } from "./components/ColumnGrip";
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
import { GkToolbar } from "./components/gk/GkToolbar";
import { GkLeftPanel } from "./components/gk/GkLeftPanel";
import { GkWipPanel } from "./components/gk/GkWipPanel";
import { SubmoduleMap } from "./components/gk/SubmoduleMap";
import { LineStagingDiff } from "./components/gk/LineStagingDiff";
import { FileExplorer } from "./components/explorer/FileExplorer";
import { DialogHost, askConfirm, askText } from "./components/DialogHost";
import type { GraphExtraAction } from "./components/CommitGraph";
import type { CloneOptions, CustomCommand, PullMode, PushOptions, UndoState } from "./types";
import { RepoSettings, type SettingsTab } from "./components/settings/RepoSettings";
import { AgentSessionDialog, CleanupDialog } from "./components/gk/HostingDialogs";
import { notifyIfHidden } from "./notify";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LiveOutputHost, withLiveOutput } from "./liveOutput";
import type { ExplorerFocus } from "./components/explorer/FileExplorer";
import { askFields } from "./components/DialogHost";
import { chooseFolder, FolderPickerHost } from "./components/FolderPicker";
import { LandscapeView } from "./components/gk/LandscapeView";
import { RepositoryOpening } from "./components/RepositoryOpening";
import { ForksView } from "./components/ForksView";
import { plural } from "./plural";

type RepositorySnapshot = {
  summary: RepositorySummary;
  historySegments: HistorySegment[];
  selectedCommit: CommitRecord | null;
  changes: FileChange[];
  branches: BranchRecord[];
  operation: RepositoryOperationState;
  undoState: UndoState | null;
};

const emptyWorkspace: Workspace = { id: "local", name: "Local repositories", repositories: [] };

// Folder selection goes through Chrono's own picker: it works in the browser
// build and does not depend on the native dialog, which fails silently on
// some Linux desktops. The picker still offers the system dialog.
const promptRepositoryPath = (title: string, initial = ""): Promise<string | null> =>
  chooseFolder(title, { initial, confirm: "Open" });

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
  const [historySegments, setHistorySegments] = useState<HistorySegment[]>([]);
  const [historyLoadingDirection, setHistoryLoadingDirection] = useState<"older" | "newer" | null>(null);

  // Bounded sliding history window (see src/historyWindow.ts): offsets are
  // positions in `git log --all --date-order` (0 = newest commits).
  const historyWindow = useMemo(() => summarizeHistoryWindow(historySegments), [historySegments]);
  const commits = historyWindow.commits;
  const historyHasMore = historyWindow.hasOlder;
  const historyHasNewer = historyWindow.hasNewer;
  const historyLoading = historyLoadingDirection !== null;
  const [selectedCommit, setSelectedCommit] = useState<CommitRecord | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [branches, setBranches] = useState<BranchRecord[]>([]);
  const [operation, setOperation] = useState<RepositoryOperationState>(idleOperation);
  const [view, setView] = useState<RepositoryView>("history");
  const [busy, setBusy] = useState(false);
  const [superprojects, setSuperprojects] = useState<Array<{ path: string; name: string }>>([]);
  const [message, setMessage] = useState("Ready");
  // Set when git refuses a repository owned by another user ("dubious ownership").
  const [untrusted, setUntrusted] = useState<{ path: string; directory: string | null } | null>(null);
  const [palette, setPalette] = useState(false);
  // v2 key: the navigation now defaults to the slim icon rail (Ctrl+B expands it).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("chrono.sidebar.v2") !== "expanded");
  useEffect(() => { localStorage.setItem("chrono.sidebar.v2", sidebarCollapsed ? "collapsed" : "expanded"); }, [sidebarCollapsed]);

  // GitKraken parity state: undo journal, pull default, WIP node, left panel refresh.
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [pullMode, setPullMode] = useState<PullMode>(() => (localStorage.getItem("chrono.gk.pullMode") as PullMode | null) ?? "ff-only");
  const [refreshKey, setRefreshKey] = useState(0);
  const [stashCount, setStashCount] = useState(0);
  const [wipSelected, setWipSelected] = useState(false);
  const [wipDiff, setWipDiff] = useState<string | null>(null);
  const [wipDiffSide, setWipDiffSide] = useState<"unstaged" | "staged">("unstaged");
  // Set when the open WIP diff is a file inside a submodule (its checkout).
  const [wipDiffRepo, setWipDiffRepo] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ id: string; nonce: number } | null>(null);
  const [explorerFocus, setExplorerFocus] = useState<ExplorerFocus | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  useEffect(() => { api.customCommands().then(setCustomCommands).catch(() => undefined); }, [view]);
  const openSettings = useCallback((tab?: SettingsTab) => { setSettingsTab(tab); setView("settings"); }, []);
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => localStorage.getItem("chrono.gk.leftPanel") !== "hidden");
  const [leftPanelWidth, resizeLeftPanel, resetLeftPanel] = useStoredWidth("chrono.gk.leftWidth", 250, 170, 640);
  const [cloneOpen, setCloneOpen] = useState(false);
  const historyRequestRef = useRef(0);

  // v6 GitKraken-style additions: multi-repo tabs, terminal panel, modals, zoom.
  const [repoTabs, setRepoTabs] = useState<string[]>([]);
  const lastClosedTabRef = useRef<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [gitLogOpen, setGitLogOpen] = useState(false);
  const [keybindingsOpen, setKeybindingsOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const terminalRef = useRef<TerminalPanelHandle | null>(null);

  // The saved repository list. Changes wait until it has loaded and always
  // start from the latest list: a deep link handled at startup used to save a
  // list holding only its own repository over the saved one.
  const workspacesRef = useRef<Workspace[]>([emptyWorkspace]);
  const workspacesReady = useRef<{ promise: Promise<void>; done: () => void } | null>(null);
  if (!workspacesReady.current) {
    let done = () => {};
    const promise = new Promise<void>((resolve) => { done = resolve; });
    workspacesReady.current = { promise, done };
  }
  const commitWorkspaces = useCallback((next: Workspace[]) => {
    workspacesRef.current = next;
    setWorkspaces(next);
    return api.saveWorkspaces(next);
  }, []);

  useEffect(() => {
    api.loadWorkspaces()
      .then((loaded) => { const list = loaded.length ? loaded : [emptyWorkspace]; workspacesRef.current = list; setWorkspaces(list); })
      .finally(() => workspacesReady.current?.done())
      .catch((error) => {
        // A server started with CHRONO_API_TOKEN (Docker, remote) needs the
        // token from the browser too — ask for it instead of failing silently.
        if (/API token/i.test(String(error))) setConnectionOpen(true);
      });
  }, []);

  // Per-tab snapshots: switching to a tab shows its last known state at once
  // and refreshes it in the background, instead of waiting for git.
  const snapshotsRef = useRef(new Map<string, RepositorySnapshot>());
  const [revalidating, setRevalidating] = useState(false);
  // A repository being opened with nothing to show yet (no cached snapshot).
  const [opening, setOpening] = useState<{ path: string; since: number } | null>(null);
  useEffect(() => {
    if (!path || !summary) return;
    snapshotsRef.current.set(path, { summary, historySegments, selectedCommit, changes, branches, operation, undoState });
  }, [path, summary, historySegments, selectedCommit, changes, branches, operation, undoState]);

  // Once another repository is on screen, stop the reads still running for the
  // one that was left, so they don't hold the browser's connections.
  const shownPathRef = useRef("");
  useEffect(() => {
    const previous = shownPathRef.current;
    shownPathRef.current = path;
    if (previous && previous !== path) abandonRepositoryReads(previous);
  }, [path]);

  const refresh = useCallback(async (repositoryPath = path) => {
    if (!repositoryPath) return;
    const requestId = ++historyRequestRef.current;
    setHistoryLoadingDirection(null);
    const switching = repositoryPath !== path;
    const snapshot = switching ? snapshotsRef.current.get(repositoryPath) : undefined;
    if (snapshot) {
      setPath(repositoryPath);
      setSummary(snapshot.summary);
      setHistorySegments(snapshot.historySegments);
      setSelectedCommit(snapshot.selectedCommit);
      setChanges(snapshot.changes);
      setBranches(snapshot.branches);
      setOperation(snapshot.operation);
      setUndoState(snapshot.undoState);
      setWipSelected(false); setWipDiff(null);
      setRefreshKey((value) => value + 1);
      setMessage(`${snapshot.summary.name} · updating…`);
    }
    const background = Boolean(snapshot) || (!switching && Boolean(summary));
    if (background) setRevalidating(true); else setBusy(true);
    if (switching && !snapshot) {
      setOpening({ path: repositoryPath, since: Date.now() });
      setMessage(`Opening ${repositoryPath.split(/[\\/]/).filter(Boolean).pop() ?? repositoryPath}…`);
    }
    try {
      const [nextSummary, nextHistory, nextChanges, nextBranches, nextOperation, nextUndo] = await Promise.all([
        api.summary(repositoryPath),
        api.historyPage(repositoryPath),
        api.status(repositoryPath),
        api.branches(repositoryPath),
        api.operationState(repositoryPath),
        api.undoState(repositoryPath).catch(() => null)
      ]);
      if (requestId !== historyRequestRef.current) return;
      setPath(repositoryPath);
      setSummary(nextSummary);
      setHistorySegments([{ offset: 0, page: nextHistory }]);
      setSelectedCommit((current) => (switching && !snapshot ? null : nextHistory.commits.find((commit) => commit.id === current?.id)) || nextHistory.commits.find((commit) => commit.id === nextSummary.head) || nextHistory.commits[0] || null);
      setChanges(nextChanges);
      setBranches(nextBranches);
      setOperation(nextOperation);
      setUndoState(nextUndo);
      setRefreshKey((value) => value + 1);
      if (nextChanges.length === 0) { setWipSelected(false); setWipDiff(null); }
      setUntrusted((current) => (current?.path === repositoryPath ? null : current));
      setMessage(`Refreshed ${nextSummary.name}`);
    } catch (error) {
      if (isAbandoned(error) || requestId !== historyRequestRef.current) return;
      const text = String(error);
      if (/dubious ownership/i.test(text)) {
        const directory = text.match(/repository at '([^']+)'/)?.[1] ?? null;
        setUntrusted({ path: repositoryPath, directory });
        setMessage(`Git refuses ${directory ?? repositoryPath}: the folder belongs to another user`);
      } else {
        setMessage(text);
      }
    } finally {
      if (requestId === historyRequestRef.current) { setBusy(false); setRevalidating(false); setOpening(null); }
    }
  }, [path, summary]);

  // Live changes: the server watches the open repository and answers this
  // long-poll as soon as something changes, so edits made in an editor or a
  // terminal reach the Changes list and the graph's WIP row within ~0.2 s.
  // Working-tree edits reload the status only; HEAD, ref or operation changes
  // (a commit, checkout, fetch or rebase elsewhere) reload the graph as well.
  const [liveTick, setLiveTick] = useState(0);
  const liveRef = useRef({ busy, atTop: true, refresh });
  liveRef.current = { busy, atTop: historySegments.length <= 1 && (historySegments[0]?.offset ?? 0) === 0, refresh };
  useEffect(() => {
    if (!path) return;
    const target = path;
    let stopped = false;
    const update = async (gitChanged: boolean) => {
      const live = liveRef.current;
      if (live.busy) return; // the running action refreshes when it finishes
      if (gitChanged && live.atTop) { await live.refresh(target); setLiveTick((value) => value + 1); return; }
      const [nextChanges, nextSummary, nextBranches] = await Promise.all([
        api.status(target),
        gitChanged ? api.summary(target) : Promise.resolve(null),
        gitChanged ? api.branches(target) : Promise.resolve(null),
      ]);
      if (stopped) return;
      setChanges(nextChanges);
      if (nextSummary) setSummary(nextSummary);
      if (nextBranches) setBranches(nextBranches);
      if (nextChanges.length === 0) { setWipSelected(false); setWipDiff(null); }
      setLiveTick((value) => value + 1);
    };
    void (async () => {
      let seen = -1;
      let seenGit = -1;
      while (!stopped) {
        try {
          const change = await api.waitForChange(target, seen);
          if (stopped) return;
          if (seen >= 0 && change.version !== seen) await update(change.gitVersion !== seenGit).catch(() => undefined);
          seen = change.version;
          seenGit = change.gitVersion;
        } catch (error) {
          if (stopped || isAbandoned(error)) return;
          await new Promise((resolve) => setTimeout(resolve, 2000)); // backend restarting: try again
        }
      }
    })();
    return () => { stopped = true; };
  }, [path]);

  const trustUntrusted = useCallback(async () => {
    if (!untrusted) return;
    setBusy(true);
    try {
      await api.trustRepository(untrusted.path);
      const target = untrusted.path;
      setUntrusted(null);
      pushToast(`Trusted ${untrusted.directory ?? target}`, "success");
      setBusy(false);
      await refresh(target);
    } catch (error) {
      setBusy(false);
      pushToast(String(error).replace(/^Error: /, ""), "error", 9000);
    }
  }, [untrusted, refresh]);

  const loadOlderHistory = useCallback(async () => {
    const cursor = historyWindow.olderCursor;
    const offset = historyWindow.olderOffset;
    if (!path || !historyHasMore || historyLoading || cursor === null || offset === null) return;
    const requestId = ++historyRequestRef.current;
    setHistoryLoadingDirection("older");
    try {
      const page = await api.historyPage(path, cursor, HISTORY_PAGE_SIZE);
      if (requestId !== historyRequestRef.current) return;
      setHistorySegments((current) => addHistoryPage(current, offset, page, "older"));
    } catch (error) {
      setMessage(String(error));
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoadingDirection(null);
    }
  }, [historyHasMore, historyLoading, historyWindow, path]);

  const loadNewerHistory = useCallback(async () => {
    const offset = historyWindow.newerOffset;
    if (!path || !historyHasNewer || historyLoading || offset === null) return;
    const requestId = ++historyRequestRef.current;
    setHistoryLoadingDirection("newer");
    try {
      const page = await api.historyPage(path, String(offset), HISTORY_PAGE_SIZE);
      if (requestId !== historyRequestRef.current) return;
      setHistorySegments((current) => addHistoryPage(current, offset, page, "newer"));
    } catch (error) {
      setMessage(String(error));
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoadingDirection(null);
    }
  }, [historyHasNewer, historyLoading, historyWindow, path]);

  // Forks: the repository and its submodules vs their upstreams (badges in the
  // toolbar, left panel and submodule views; the Forks view has the actions).
  const [forkTreeState, setForkTreeState] = useState<ForkStatus[]>([]);
  useEffect(() => {
    if (!path) { setForkTreeState([]); return; }
    let cancelled = false;
    api.forkTree(path).then((tree) => { if (!cancelled) setForkTreeState(tree); }).catch(() => { if (!cancelled) setForkTreeState([]); });
    return () => { cancelled = true; };
  }, [path, refreshKey]);

  // Whether the repository has any remote: without one, Pull and Push can
  // only fail with git's "no tracking information", so they are disabled.
  const [remoteCount, setRemoteCount] = useState<number | null>(null);
  useEffect(() => {
    if (!path) { setRemoteCount(null); return; }
    let cancelled = false;
    api.remotes(path).then((list) => { if (!cancelled) setRemoteCount(list.length); }).catch(() => { if (!cancelled) setRemoteCount(null); });
    return () => { cancelled = true; };
  }, [path, refreshKey]);

  // Close the WIP diff once its file has no changes left (committed, discarded
  // or reverted elsewhere) instead of showing an empty diff. Files inside a
  // submodule are listed under the submodule, so only top-level ones are checked.
  useEffect(() => {
    if (!wipDiff || wipDiffRepo) return;
    if (!changes.some((change) => change.path === wipDiff)) setWipDiff(null);
  }, [changes, wipDiff, wipDiffRepo]);

  // Start on HEAD, not on whatever is newest (a stash or another branch). The
  // history can arrive before HEAD is known, so an automatic pick moves to HEAD
  // once it is; a commit the user chose stays chosen.
  const autoPickRef = useRef<string | null>(null);
  useEffect(() => {
    const head = commits.find((commit) => commit.id === summary?.head);
    const kept = selectedCommit && commits.some((commit) => commit.id === selectedCommit.id);
    if (kept && !(head && autoPickRef.current === selectedCommit.id && selectedCommit.id !== head.id)) return;
    const pick = head ?? commits[0] ?? null;
    autoPickRef.current = pick?.id ?? null;
    setSelectedCommit(pick);
  }, [commits, selectedCommit, summary?.head]);

  const rememberRepository = async (repositoryPath: string) => {
    await workspacesReady.current?.promise;
    const current = workspacesRef.current;
    const next = structuredClone(current.length ? current : [emptyWorkspace]);
    const workspace = next[0];
    if (!workspace.repositories.some((repository) => repository.path === repositoryPath)) {
      workspace.repositories.push({ path: repositoryPath });
      await commitWorkspaces(next);
    }
  };

  // The repository list in the sidebar: reorder, remove and clear. Only the
  // list changes; open tabs and the repositories on disk stay as they are.
  const updateWorkspace = (workspaceId: string, change: (paths: Workspace["repositories"]) => Workspace["repositories"]) => {
    const next = structuredClone(workspacesRef.current).map((workspace) => (workspace.id === workspaceId ? { ...workspace, repositories: change(workspace.repositories) } : workspace));
    void commitWorkspaces(next).catch((error) => pushToast(`Could not save the repository list: ${String(error)}`, "error", 9000));
  };
  const removeListedRepository = (workspaceId: string, repositoryPath: string) =>
    updateWorkspace(workspaceId, (list) => list.filter((repository) => repository.path !== repositoryPath));
  const moveListedRepository = (workspaceId: string, repositoryPath: string, index: number) =>
    updateWorkspace(workspaceId, (list) => {
      const from = list.findIndex((repository) => repository.path === repositoryPath);
      if (from < 0) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(index > from ? index - 1 : index, 0, moved);
      return next;
    });
  const clearListedRepositories = (workspaceId: string) => updateWorkspace(workspaceId, () => []);

  // Stops waiting for a repository that is still opening; the one shown before
  // (if any) stays.
  const cancelOpening = () => {
    if (!opening) return;
    historyRequestRef.current += 1;
    abandonRepositoryReads(opening.path);
    setOpening(null);
    setBusy(false);
    setMessage("Opening cancelled");
  };

  const openRepository = async () => {
    const selected = await promptRepositoryPath("Open Git repository");
    if (selected) {
      await rememberRepository(selected);
      await refresh(selected);
    }
  };

  const cloneRepository = () => setCloneOpen(true);

  useEffect(() => {
    if (!path) { setSuperprojects([]); return; }
    let cancelled = false;
    api.superprojectChain(path).then((chain) => { if (!cancelled) setSuperprojects(chain); }).catch(() => { if (!cancelled) setSuperprojects([]); });
    return () => { cancelled = true; };
  }, [path]);

  const submitClone = async (url: string, destination: string, options: CloneOptions = {}) => {
    setBusy(true);
    setMessage("Cloning repository…");
    try {
      const cloned = await api.clone({ url, destination, ...options });
      notifyIfHidden("Clone finished", cloned.name);
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
      if (/^(fetch|pull|push|force push|rebase|restack|merge|clone|finish)/i.test(label)) notifyIfHidden(`${label} completed`, path.split(/[\\/]/).pop() ?? path);
    } catch (error) {
      setMessage(String(error));
      pushToast(`${label} failed: ${String(error).replace(/^Error: /, "")}`, "error", 9000);
      await refresh(path).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [path, refresh]);

  // Working-tree / operation state derived for header pills and panels.
  const conflictCount = changes.filter((change) => change.conflicted).length;
  const dirtyCount = changes.length;
  const operationActive = operation.operation !== null;

  const runOperationAction = useCallback(async (action: RepositoryOperationAction): Promise<boolean> => {
    if (!path) return false;
    setBusy(true);
    setMessage(`${action}…`);
    try {
      await api.controlOperation(path, action);
      await refresh();
      setMessage(`${action} completed`);
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [path, refresh]);

  const copyCommitSha = useCallback(async (commit: string) => {
    try {
      await navigator.clipboard?.writeText(commit);
      setMessage(`Copied ${commit.slice(0, 8)} to the clipboard`);
    } catch {
      setMessage(`Commit ${commit}`);
    }
  }, []);

  const runCommitAction = useCallback(async (action: "cherry-pick" | "revert", commit: CommitRecord) => {
    if (!path) return;
    const label = action === "cherry-pick" ? "Cherry-pick" : "Revert";
    try {
      const prediction = await api.predictConflicts(path, action, commit.id);
      if (prediction.supported && !prediction.clean && !(await askConfirm(`${label}: conflicts expected`, `${prediction.message}\n${prediction.files.join(", ")}`, { confirm: `${label} anyway`, danger: true }))) return;
    } catch { /* advisory */ }
    await runRepositoryAction(`${label} ${commit.id.slice(0, 8)}`, () => api.workflow(path, { operation: action.replace("-", "_") as "cherry_pick" | "revert", args: [commit.id] }));
  }, [path, runRepositoryAction]);

  const createBranchAt = useCallback(async (commit: CommitRecord) => {
    if (!path) return;
    const branch = await askText("Create branch", `New branch at ${commit.id.slice(0, 8)} — “${commit.subject}”`, "feature/");
    if (!branch?.trim()) return;
    await runRepositoryAction(`Create branch ${branch.trim()}`, async () => {
      await api.createBranchAt(path, branch.trim(), commit.id);
    });
  }, [path, runRepositoryAction]);

  const createTagAt = useCallback(async (commit: CommitRecord) => {
    if (!path) return;
    const name = await askText("Create tag", `Tag ${commit.id.slice(0, 8)} — “${commit.subject}”`, "");
    if (!name?.trim()) return;
    await runRepositoryAction(`Tag ${name.trim()}`, async () => {
      await api.createTag(path, name.trim(), commit.id, `Created from Chrono at ${new Date().toISOString()}`);
    });
  }, [path, runRepositoryAction]);

  const resetToCommit = useCallback(async (commit: CommitRecord, mode: "soft" | "mixed" | "hard") => {
    if (!path) return;
    await runRepositoryAction(`Reset to ${commit.id.slice(0, 8)} (${mode})`, async () => {
      await api.resetTo(path, commit.id, mode);
    });
  }, [path, runRepositoryAction]);

  // ---------------------------------------------------------------------------
  // GitKraken toolbar actions
  // ---------------------------------------------------------------------------
  const runUndo = useCallback(async (direction: "undo" | "redo") => {
    if (!path) return;
    setBusy(true);
    try {
      const result = direction === "undo" ? await api.undo(path) : await api.redo(path);
      pushToast(result, "success");
      setMessage(result);
      await refresh(path);
    } catch (error) {
      pushToast(String(error).replace(/^Error: /, ""), "error", 9000);
    } finally {
      setBusy(false);
    }
  }, [path, refresh]);

  const [recurseSubmodules, setRecurseSubmodules] = useState(() => localStorage.getItem("chrono.gk.recurseSubmodules") === "1");
  const changeRecurseSubmodules = useCallback((value: boolean) => {
    setRecurseSubmodules(value);
    localStorage.setItem("chrono.gk.recurseSubmodules", value ? "1" : "0");
    pushToast(value ? "Pull and Push now include submodules" : "Pull and Push no longer include submodules", "info", 3000);
  }, []);

  const runPull = useCallback((mode: PullMode) => {
    const base = mode === "fetch" ? "Fetch" : mode === "rebase" ? "Pull (rebase)" : "Pull";
    const label = recurseSubmodules ? `${base} with submodules` : base;
    void runRepositoryAction(label, () => withLiveOutput(label, (streamId) => api.pull(path, mode, streamId, recurseSubmodules)));
  }, [path, runRepositoryAction, recurseSubmodules]);

  const runPush = useCallback(async (options: PushOptions) => {
    if (options.force && !(await askConfirm("Force push", `Force push ${summary?.branch ?? "HEAD"} with --force-with-lease? Remote commits not present locally will be overwritten.`, { confirm: "Force push", danger: true }))) return;
    const withSubs = options.recurseSubmodules ?? recurseSubmodules;
    const label = `${options.force ? "Force push" : "Push"}${withSubs ? " with submodules" : ""}`;
    await runRepositoryAction(label, () => withLiveOutput(label, (streamId) => api.push(path, { ...options, recurseSubmodules: withSubs, streamId })));
  }, [path, runRepositoryAction, summary?.branch, recurseSubmodules]);

  const updateAllSubmodules = useCallback((remote: boolean) => {
    const label = remote ? "Update submodules to remote tips" : "Initialize & update submodules";
    void runRepositoryAction(label, () => withLiveOutput(label, (streamId) => api.updateAllSubmodules(path, remote, streamId)));
  }, [path, runRepositoryAction]);

  const quickBranch = useCallback(async () => {
    const name = await askText("Create branch", `New branch from ${summary?.branch ?? "HEAD"} (checked out immediately)`, "");
    if (name?.trim()) await runRepositoryAction(`Create branch ${name.trim()}`, () => api.createBranch(path, name.trim()));
  }, [path, runRepositoryAction, summary?.branch]);

  const quickStash = useCallback(async () => {
    const note = await askText("Stash changes", "Stash message (optional)", "");
    if (note === null) return;
    await runRepositoryAction("Stash", () => api.workflow(path, { operation: "stash_push", args: note.trim() ? [note.trim()] : [] }));
  }, [path, runRepositoryAction]);

  const quickPop = useCallback(() => runRepositoryAction("Pop stash", () => api.workflow(path, { operation: "stash_pop", args: [] })), [path, runRepositoryAction]);

  const selectRevision = useCallback(async (sha: string) => {
    const commit = commits.find((candidate) => candidate.id === sha);
    setView("history");
    setWipSelected(false);
    setWipDiff(null);
    if (commit) {
      setSelectedCommit(commit);
      setScrollTo({ id: commit.id, nonce: Date.now() });
      return;
    }
    // Outside the loaded window: load the history page that contains it
    // (GitKraken jumps straight to the commit instead of refusing).
    if (!path) return;
    const requestId = ++historyRequestRef.current;
    setHistoryLoadingDirection("older");
    try {
      const offset = await api.commitOffset(path, sha);
      if (offset === null) { pushToast(`Commit ${sha.slice(0, 8)} is not reachable from any ref`, "info"); return; }
      const start = Math.max(0, offset - Math.floor(HISTORY_PAGE_SIZE / 3));
      const page = await api.historyPage(path, String(start), HISTORY_PAGE_SIZE);
      if (requestId !== historyRequestRef.current) return;
      const target = page.commits.find((candidate) => candidate.id === sha) ?? null;
      setHistorySegments([{ offset: start, page }]);
      if (target) {
        setSelectedCommit(target);
        setScrollTo({ id: target.id, nonce: Date.now() });
      }
    } catch (error) {
      pushToast(`Cannot jump to ${sha.slice(0, 8)}: ${String(error).replace(/^Error: /, "")}`, "error");
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoadingDirection(null);
    }
  }, [commits, path]);

  const runCustom = useCallback(async (command: CustomCommand, context: { sha?: string; branch?: string; files?: string[] } = {}) => {
    if (!path) return;
    let params: Record<string, string> = {};
    if (command.params.length) {
      const values = await askFields(command.name, command.params.map((param) => ({ name: param.name, label: `${param.label}${param.type === "checkbox" ? " (yes/no)" : param.type === "branch" ? " (branch)" : ""}`, initial: param.default ?? (param.type === "branch" ? summary?.branch ?? "" : "") })), { confirm: "Run" });
      if (!values) return;
      params = Object.fromEntries(command.params.map((param) => [param.name, param.type === "checkbox" ? (/^(y|yes|true|1)$/i.test(values[param.name]) ? "true" : "") : values[param.name]]));
    } else if (command.confirm && !(await askConfirm(command.name, `Run ${command.argv.join(" ")}?`, { confirm: "Run" }))) return;
    let output = "";
    await runRepositoryAction(command.name, async () => {
      const result = await api.runCustomCommand(path, command.id, { ...context, params });
      output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (result.exitCode !== 0) throw new Error(`${command.name} exited with ${result.exitCode}: ${output.slice(0, 400)}`);
    });
    if (output) pushToast(`${command.name}: ${output.slice(0, 300)}${output.length > 300 ? "…" : ""}`, "info", 9000);
  }, [path, runRepositoryAction, summary?.branch]);

  const graphExtraActions = useMemo<GraphExtraAction[]>(() => [
    { id: "checkout", label: "Checkout this commit (detached)", onSelect: (commit) => runRepositoryAction(`Checkout ${commit.id.slice(0, 8)}`, () => api.workflow(path, { operation: "checkout_tag", args: [commit.id] })) },
    { id: "copy-msg", label: "Copy commit message", onSelect: async (commit) => { try { await navigator.clipboard.writeText(commit.subject); pushToast("Message copied", "success", 2000); } catch { pushToast(commit.subject); } } },
    { id: "rebase", label: "Interactive rebase from here…", onSelect: () => setView("rebase") },
    { id: "patch", label: "Save commit as patch", onSelect: async (commit) => {
      try {
        const patch = await api.createPatch(path, `${commit.id}~1`, commit.id).catch(() => api.createPatch(path, commit.id, ""));
        const bytes = Uint8Array.from(atob(patch.base64), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "text/x-diff" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = patch.name; anchor.click(); URL.revokeObjectURL(url);
      } catch (error) { pushToast(String(error), "error"); }
    } },
    { id: "browse", label: "Browse files at this revision", onSelect: () => setView("repo") },
    { id: "explorer", label: "Open working copy explorer", onSelect: () => setView("explorer") },
    ...customCommands.filter((command) => command.scope === "commit").map<GraphExtraAction>((command) => ({ id: `custom-${command.id}`, label: `▶ ${command.name}`, onSelect: (commit) => runCustom(command, { sha: commit.id }) })),
  ], [customCommands, path, runCustom, runRepositoryAction]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const typing = event.target instanceof HTMLElement && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable);
      if (modifier && !typing && path && !event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); void runUndo("undo"); return; }
      if (modifier && !typing && path && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) { event.preventDefault(); void runUndo("redo"); return; }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); setPalette(true); return; }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "j") { event.preventDefault(); setLeftPanelOpen((value) => { localStorage.setItem("chrono.gk.leftPanel", value ? "hidden" : "shown"); return !value; }); return; }
      if (modifier && path && event.key === "4") { event.preventDefault(); setView("explorer"); return; }
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
      if (event.key === "F5" && path && view !== "explorer") {
        event.preventDefault();
        void refresh();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [path, refresh, runUndo, view]);

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

  // Drop the shown repository before switching tabs. If the next tab fails to
  // load (for example git refuses it), the closed repository must not stay on screen.
  const clearRepositoryView = useCallback(() => {
    historyRequestRef.current++;
    setPath(""); setSummary(null); setHistorySegments([]); setSelectedCommit(null); setChanges([]); setBranches([]);
    setOperation(idleOperation); setUndoState(null); setSuperprojects([]); setWipSelected(false); setWipDiff(null);
  }, []);

  const closeTab = useCallback((target: string) => {
    if (!target) return;
    lastClosedTabRef.current = target;
    snapshotsRef.current.delete(target);
    abandonRepositoryReads(target);
    const next = repoTabs.filter((tab) => tab !== target);
    setRepoTabs(next);
    setUntrusted((current) => (current?.path === target ? null : current));
    if (target === path || next.length === 0) {
      clearRepositoryView();
      if (next.length > 0) void refresh(next[next.length - 1]).catch(() => undefined);
    }
  }, [repoTabs, path, refresh, clearRepositoryView]);

  // Drag-and-drop or Ctrl+Shift+←/→ in the tab strip: put `target` at `index`
  // (an index into the list before the move).
  const moveTab = useCallback((target: string, index: number) => {
    setRepoTabs((current) => {
      const from = current.indexOf(target);
      if (from < 0) return current;
      const next = current.filter((tab) => tab !== target);
      const at = Math.max(0, Math.min(next.length, index > from ? index - 1 : index));
      next.splice(at, 0, target);
      return next.every((tab, position) => tab === current[position]) ? current : next;
    });
  }, []);

  const closeOtherTabs = useCallback((keep: string) => {
    for (const tab of repoTabs) if (tab !== keep) { snapshotsRef.current.delete(tab); abandonRepositoryReads(tab); }
    setRepoTabs((current) => current.filter((tab) => tab === keep));
    if (keep !== path) void refresh(keep).catch(() => undefined);
  }, [repoTabs, path, refresh]);

  const closeActiveTab = useCallback(() => { if (path) closeTab(path); }, [path, closeTab]);

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
    shellAction: async (action, paths) => {
      try {
        const resolved = await api.resolveShellPaths(paths);
        await rememberRepository(resolved.root);
        setRepoTabs((current) => (current.includes(resolved.root) ? current : [...current, resolved.root]));
        await refresh(resolved.root);
        if (action === "graph") { setView("history"); return { ok: true }; }
        if (action === "terminal") {
          setTerminalOpen(true);
          requestAnimationFrame(() => terminalRef.current?.createTab(resolved.directory ? `${resolved.root}/${resolved.directory}` : resolved.root));
          return { ok: true };
        }
        setView("explorer");
        setExplorerFocus({ path: resolved.paths[0], paths: resolved.paths, isDir: resolved.isDir, action, nonce: Date.now() });
        return { ok: true };
      } catch (error) {
        pushToast(String(error).replace(/^Error: /, ""), "error", 9000);
        return { ok: false, error: String(error) };
      }
    },
    openRepo: async (repositoryPath) => { await rememberRepository(repositoryPath); setRepoTabs((current) => current.includes(repositoryPath) ? current : [...current, repositoryPath]); try { await refresh(repositoryPath); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    promptOpenRepo: async () => { const selected = await promptRepositoryPath("Open Git repository"); if (!selected) return { ok: false, error: "cancelled" }; await rememberRepository(selected); setRepoTabs((current) => current.includes(selected) ? current : [...current, selected]); try { await refresh(selected); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    refresh: async () => { if (!path) return { ok: false, error: "no repository open" }; try { await refresh(); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    listKnownRepos: async () => workspaces[0]?.repositories.map((repository) => repository.path) ?? [],
    selectBranch: async (name) => { if (!path) return { ok: false, error: "no repository open" }; try { const record = branches.find((branch) => branch.name === name); if (!record) return { ok: false, error: `branch not found: ${name}` }; if (record.remote) await api.checkoutRemoteBranch(path, name); else await api.switchBranch(path, name); await refresh(); return { ok: true }; } catch (error) { return { ok: false, error: String(error) }; } },
    selectCommit: async (sha) => { const commit = commits.find((candidate) => candidate.id === sha || candidate.id.startsWith(sha)); if (!commit) return { ok: false, error: `commit not found: ${sha}` }; setSelectedCommit(commit); setView("history"); return { ok: true }; },
    runSearch: async (query, mode = "message") => { if (!path) return { ok: false, error: "no repository open" }; try { const results = await api.historyQuery(path, { query, mode }); setSelectedCommit(results[0] ?? null); setView("history"); setMessage(`Found ${plural(results.length, "commit")} matching “${query}”`); return { ok: true, result: results.length }; } catch (error) { return { ok: false, error: String(error) }; } },
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
    return () => setSagaActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keep the saga actions current: deep links and IPC must see live state
  // (workspaces, path, branches), not the values from the first render.
  useEffect(() => { setSagaActions(sagaActions); });

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
    { id: "fetch", title: "Fetch all remotes", category: "Remote", disabled: !path || remoteCount === 0, run: () => void runRepositoryAction("Fetch", () => api.fetch(path)) },
    { id: "pull", title: "Pull current branch (fast-forward only)", category: "Remote", disabled: !path || remoteCount === 0 || operationActive, run: () => runPull("ff-only") },
    { id: "pull-ff", title: "Pull (fast-forward if possible)", category: "Remote", disabled: !path || remoteCount === 0 || operationActive, run: () => runPull("ff") },
    { id: "pull-rebase", title: "Pull (rebase)", category: "Remote", disabled: !path || remoteCount === 0 || operationActive, run: () => runPull("rebase") },
    { id: "push", title: "Push current branch", category: "Remote", disabled: !path || remoteCount === 0 || operationActive, run: () => void runPush({}) },
    { id: "push-force", title: "Force push (with lease)", category: "Remote", disabled: !path || remoteCount === 0 || operationActive, run: () => void runPush({ force: true }) },
    { id: "undo", title: undoState?.undoLabel ? `Undo ${undoState.undoLabel}` : "Undo", category: "Edit", shortcut: "Ctrl+Z", disabled: !undoState?.canUndo, run: () => void runUndo("undo") },
    { id: "redo", title: undoState?.redoLabel ? `Redo ${undoState.redoLabel}` : "Redo", category: "Edit", shortcut: "Ctrl+Y", disabled: !undoState?.canRedo, run: () => void runUndo("redo") },
    { id: "new-branch", title: "Create branch", category: "Branch", disabled: !path, run: () => void quickBranch() },
    { id: "stash", title: "Stash all changes", category: "Stash", disabled: !path || dirtyCount === 0, run: () => void quickStash() },
    { id: "pop", title: "Pop latest stash", category: "Stash", disabled: !path, run: () => void quickPop() },
    { id: "wip", title: "Review & commit changes (WIP)", category: "Commit", disabled: !path || dirtyCount === 0, run: () => { setView("history"); setWipSelected(true); } },
    { id: "explorer", title: "Open working copy explorer (TortoiseGit)", category: "View", shortcut: "Ctrl+4", keywords: ["tortoise", "files", "overlay", "shell"], disabled: !path, run: () => setView("explorer") },
    { id: "terminal", title: "Toggle terminal", category: "View", shortcut: "Ctrl+T", run: () => setTerminalOpen((value) => !value) },
    { id: "left-panel", title: "Toggle reference panel", category: "View", shortcut: "Ctrl+J", run: () => setLeftPanelOpen((value) => !value) },
    { id: "settings", title: "Repository settings", category: "Settings", disabled: !path, run: () => openSettings() },
    { id: "settings-signing", title: "Set up commit signing (GPG / SSH)", category: "Settings", keywords: ["gpg", "ssh", "verify", "sign"], disabled: !path, run: () => openSettings("identity") },
    { id: "settings-profiles", title: "Identity profiles", category: "Settings", keywords: ["email", "user", "account"], disabled: !path, run: () => openSettings("identity") },
    { id: "settings-hosting", title: "Hosting connections (GitHub, GitLab, Gitea, Bitbucket)", category: "Settings", keywords: ["token", "certificate", "self-signed", "ca", "bitbucket cloud", "enterprise", "api"], disabled: !path, run: () => openSettings("hosting") },
    { id: "settings-perf", title: "Large-repo performance preset", category: "Settings", keywords: ["commit-graph", "fsmonitor", "maintenance", "speed"], disabled: !path, run: () => openSettings("performance") },
    { id: "settings-hooks", title: "Manage git hooks", category: "Settings", disabled: !path, run: () => openSettings("hooks") },
    { id: "settings-links", title: "Issue tracker links", category: "Settings", keywords: ["jira", "autolink", "bugtraq"], disabled: !path, run: () => openSettings("links") },
    { id: "settings-templates", title: "Commit templates", category: "Settings", disabled: !path, run: () => openSettings("templates") },
    { id: "settings-commands", title: "Custom commands", category: "Settings", disabled: !path, run: () => openSettings("commands") },
    { id: "settings-gitflow", title: "Git-flow settings", category: "Settings", disabled: !path, run: () => openSettings("gitflow") },
    { id: "settings-sparse", title: "Sparse checkout", category: "Settings", keywords: ["monorepo", "cone"], disabled: !path, run: () => openSettings("sparse") },
    { id: "settings-display", title: "Display & accessibility", category: "Settings", keywords: ["diff", "whitespace", "colorblind", "contrast", "notifications"], disabled: !path, run: () => openSettings("display") },
    { id: "cleanup-branches", title: "Clean up merged & stale branches", category: "Branch", keywords: ["prune", "squash", "gone"], disabled: !path, run: () => setCleanupDialogOpen(true) },
    { id: "agent-session", title: "New agent session (worktree + terminal)", category: "AI", keywords: ["claude", "codex", "agent", "worktree"], disabled: !path, run: () => setAgentDialogOpen(true) },
    ...customCommands.map<Command>((command) => ({ id: `custom-${command.id}`, title: `Run: ${command.name}`, category: "Custom", keywords: command.argv, disabled: !path, run: () => void runCustom(command, { sha: selectedCommit?.id, branch: summary?.branch ?? undefined }) })),
    ...branches.filter((branch) => !branch.remote && !branch.current).map<Command>((branch) => ({ id: `checkout-${branch.name}`, title: `Checkout ${branch.name}`, category: "Branch", keywords: ["switch"], disabled: !path, run: () => void runRepositoryAction(`Checkout ${branch.name}`, () => api.switchBranch(path, branch.name)) })),
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
    { id: "forks", title: "Forks & upstreams (sync forks, also in submodules)", category: "Repository", disabled: !path, run: () => setView("forks") },
    { id: "landscape", title: "Open codebase landscape map", category: "Explore", keywords: ["map", "islands", "imports", "dependencies", "architecture", "terrain"], disabled: !path, run: () => setView("landscape") },
    { id: "refs", title: "Open references browser", category: "Repository", keywords: ["branches", "remotes", "tags", "worktrees", "stashes", "submodules"], disabled: !path, run: () => setView("refs") },
    { id: "stashes", title: "Manage stashes", category: "Repository", disabled: !path, run: () => setView("stashes") },
    { id: "recovery", title: "Open recovery & maintenance", category: "Repository", keywords: ["reflog", "fsck", "lfs"], disabled: !path, run: () => setView("recovery") },
    { id: "sidebar", title: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", category: "View", shortcut: "Ctrl+B", run: () => setSidebarCollapsed((value) => !value) },
    { id: "cherry", title: "Open UI workbench", category: "Developer", run: () => setView("cherry") }
  ], [customCommands, openSettings, runCustom, selectedCommit, summary?.branch, branches, conflictCount, dirtyCount, operation.canContinue, operation.canSkip, operationActive, path, quickBranch, quickPop, quickStash, refresh, runOperationAction, runPull, runPush, runRepositoryAction, runUndo, sidebarCollapsed, undoState, remoteCount]);

  const currentBranch = summary?.branch || "Detached HEAD";

  return (
    <div className={`ux-app${sidebarCollapsed ? " sidebar-collapsed" : ""}${nativeMobile ? " native-mobile" : " no-topbar"}`}>
      {nativeMobile && <button className="mobile-connection-button" onClick={() => setConnectionOpen(true)}>Backend</button>}
      {connectionOpen && <div className="connection-backdrop"><form className="connection-dialog" onSubmit={(event) => {
        event.preventDefault(); const data=new FormData(event.currentTarget);
        saveApiConnection({url:String(data.get("url")??""),token:String(data.get("token")??"")}); window.location.reload();
      }}><h2>Connect to Chrono server</h2><p>{nativeMobile ? "Enter the HTTPS address and access token of your Chrono server." : "This server requires an access token (CHRONO_API_TOKEN). Leave the address empty to use this server."}</p>
      <label>Backend URL<input name="url" type="url" required={nativeMobile} defaultValue={getApiConnection().url} placeholder={nativeMobile ? "https://chrono.example.com" : "(this server)"} /></label>
      <label>API token<input name="token" type="password" required defaultValue={getApiConnection().token} /></label>
      <div className="connection-actions"><button type="button" onClick={()=>setConnectionOpen(false)}>Cancel</button><button type="submit">Save</button></div></form></div>}
      {nativeMobile && <header className="ux-topbar">
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
      </header>}

      <RepositorySidebar
        workspaces={workspaces}
        activePath={path}
        activeView={view}
        summary={summary}
        changeCount={dirtyCount}
        conflictCount={conflictCount}
        collapsed={sidebarCollapsed}
        onSelect={(target) => { void openRepoTab(target).then((opened) => { if (!opened.ok && opened.error !== "cancelled") pushToast(`Could not open ${target}: ${opened.error}`, "error", 9000); }); }}
        onView={setView}
        onOpen={openRepository}
        onClone={cloneRepository}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onRemove={removeListedRepository}
        onMove={moveListedRepository}
        onClear={clearListedRepositories}
      />

      <main className={`ux-main${operationActive ? " has-operation" : ""}`}>
        <GkToolbar
          path={path}
          remoteCount={remoteCount}
          fork={forkTreeState.find((entry) => entry.path === "") ?? null}
          onForks={() => setView("forks")}
          summary={summary}
          branches={branches}
          busy={busy}
          operationActive={operationActive}
          undo={undoState}
          dirtyCount={dirtyCount}
          stashCount={stashCount}
          terminalOpen={terminalOpen}
          pullMode={pullMode}
          onPullModeChange={(mode) => { setPullMode(mode); localStorage.setItem("chrono.gk.pullMode", mode); }}
          onUndo={() => void runUndo("undo")}
          onRedo={() => void runUndo("redo")}
          onPull={runPull}
          onPush={(options) => void runPush(options)}
          recurseSubmodules={recurseSubmodules}
          onRecurseSubmodulesChange={changeRecurseSubmodules}
          onUpdateSubmodules={updateAllSubmodules}
          onBranch={() => void quickBranch()}
          onStash={() => void quickStash()}
          onPop={() => void quickPop()}
          onTerminal={() => setTerminalOpen((value) => !value)}
          onExplorer={() => setView("explorer")}
          onSearch={() => setPalette(true)}
          onSwitchBranch={(branch) => void runRepositoryAction(`Checkout ${branch.name}`, () => (branch.remote ? api.checkoutRemoteBranch(path, branch.name) : api.switchBranch(path, branch.name)))}
          onOpenRepository={() => void openRepoTab()}
          workspaces={workspaces}
          superprojects={superprojects}
          onSelectRepository={(target) => void openRepoTab(target)}
          onOpenFolder={() => void openRepository()}
          onClone={cloneRepository}
        />
        {path && (dirtyCount > 0 || conflictCount > 0) && view !== "history" && view !== "changes" && (
          <div className="gk-dirty-banner">
            <span>{summary?.dirty && <><b>{dirtyCount}</b> uncommitted change{dirtyCount === 1 ? "" : "s"}</>}{conflictCount > 0 && <> · <b>{conflictCount}</b> conflicts</>}</span>
            <button type="button" className="gk-link-button" onClick={() => { setView("history"); setWipSelected(true); }}>Review &amp; commit</button>
            {conflictCount > 0 && <button type="button" className="gk-link-button" onClick={() => setView("conflicts")}>Resolve conflicts</button>}
          </div>
        )}

        {repoTabs.length > 0 && (
          <RepoTabs
            tabs={repoTabs.map((tabPath) => ({ id: tabPath, path: tabPath, name: tabPath.split("/").filter(Boolean).pop() || tabPath }))}
            activeId={path || null}
            onSelect={(id) => void refresh(id)}
            onClose={(id) => closeTab(id)}
            onCloseOthers={(id) => closeOtherTabs(id)}
            onMove={moveTab}
            onNew={() => void openRepoTab()}
          />
        )}

        {untrusted && (
          <section className="ux-git-operation has-conflicts ux-trust-banner" role="alert" aria-label="Repository not trusted">
            <div className="ux-operation-status-icon"><Icon name="warning" /></div>
            <div className="ux-operation-copy">
              <div className="ux-operation-title-row"><strong>Git won't open {untrusted.directory ?? untrusted.path}</strong></div>
              <p>The folder belongs to another user, so git treats it as unsafe. Trusting it adds the folder to <code>safe.directory</code> in your global git config. Only do this for folders you own or trust; submodules may need trusting separately.</p>
            </div>
            <div className="ux-operation-actions" role="toolbar" aria-label="Trust controls">
              <button className="ux-primary-button" disabled={busy} onClick={() => void trustUntrusted()}>Trust this folder</button>
              <button className="ux-button" onClick={() => setUntrusted(null)}>Dismiss</button>
            </div>
          </section>
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
          <ErrorBoundary label="This view" resetKey={`${path}|${view}`}>
          {opening && <RepositoryOpening key={opening.path} path={opening.path} since={opening.since} overlay={Boolean(path)} onCancel={cancelOpening} />}
          {!path && view !== "cherry" && busy && repoTabs.length > 0 && !opening && (
            <div className="ux-welcome is-loading" role="status">
              <div className="ux-welcome-mark"><i className="ux-spinner" /></div>
              <h1>Opening repository…</h1>
              <p>Reading history, branches and working changes.</p>
            </div>
          )}
          {!path && view !== "cherry" && !(busy && repoTabs.length > 0) && (
            <div className="ux-welcome">
              <div className="ux-welcome-mark"><Icon name="repository" /></div>
              <h1>Open a repository</h1>
              <p>Chrono keeps history, working changes, branches, worktrees and recovery tools in one repository-centered workspace.</p>
              <div><button className="ux-primary-button" onClick={openRepository}>Open repository</button><button className="ux-button" onClick={cloneRepository}>Clone from URL</button></div>
              <span><kbd>Ctrl⇧P</kbd> opens the command palette anywhere.</span>
            </div>
          )}

          {path && view === "changes" && (
            <StatusPanel
              changes={changes}
              repositoryPath={path}
              onStage={async (paths) => { await api.stage(path, paths); await refresh(); }}
              onStageHunks={async (file, hunks) => { await api.stageHunks(path, file, hunks); await refresh(); }}
              onUnstage={async (paths) => { await api.unstage(path, paths); await refresh(); }}
              onCommit={async (message) => { await api.commit(path, message); await refresh(); }}
              onDraftCommit={(options) => api.draftCommit(path, "auto", undefined, options)}
              operationActive={operationActive}
              onResolveConflicts={() => setView("conflicts")}
              onRefresh={() => refresh()}
              onOpenRepository={(target) => void openRepoTab(target)}
            />
          )}
          {path && view === "conflicts" && conflictCount > 0 && (
            <ConflictCenter repositoryPath={path} operation={operation.operation} onRepositoryChanged={() => refresh()} />
          )}
          {path && view === "history" && (
            <div className={`gk-workspace${leftPanelOpen ? "" : " no-left"}`} style={leftPanelOpen ? { gridTemplateColumns: `${leftPanelWidth}px 6px minmax(0, 1fr)` } : undefined}>
              {leftPanelOpen && (
                <GkLeftPanel
                  repositoryPath={path}
                  forks={forkTreeState}
                  refreshKey={refreshKey}
                  busy={busy}
                  run={runRepositoryAction}
                  onSelectRevision={selectRevision}
                  onOpenRepository={(target) => void openRepoTab(target)}
                  onStartRebase={() => setView("rebase")}
                  onOpenPullRequests={() => setView("insights")}
                  onStashCount={setStashCount}
                  onOpenSettings={openSettings}
                  onNewAgentSession={() => setAgentDialogOpen(true)}
                  onOpenSubmoduleMap={() => setView("submodules")}
                />
              )}
              {leftPanelOpen && <SplitHandle label="Resize branches panel" onDelta={resizeLeftPanel} onReset={resetLeftPanel} />}
              <CommitGraph
                repositoryPath={path} commits={commits} branches={branches} headSha={summary?.head ?? undefined}
                selected={wipSelected ? null : selectedCommit}
                onSelect={(commit) => { setWipSelected(false); setWipDiff(null); setSelectedCommit(commit); }}
                onCopyCommit={copyCommitSha} onCommitAction={runCommitAction} onCreateBranchAt={createBranchAt} onCreateTagAt={createTagAt} onResetTo={resetToCommit}
                actionBusy={busy || operationActive} onOpenWorktree={refresh}
                historyHasNewer={historyHasNewer} historyHasMore={historyHasMore} historyLoading={historyLoading} historyLoadingDirection={historyLoadingDirection} onLoadNewer={loadNewerHistory} onLoadMore={loadOlderHistory}
                wipNode={{ count: dirtyCount, conflicts: conflictCount, branch: summary?.branch ?? null, selected: wipSelected, onSelect: () => setWipSelected(true) }}
                scrollTo={scrollTo}
                extraActions={graphExtraActions}
                onRestoreFile={(revision, file) => runRepositoryAction(`Restore ${file} from ${revision.slice(0, 8)}`, () => api.explorerAction(path, { action: "checkout_revision", files: [file], revision }))}
                overlay={wipSelected && wipDiff ? (
                  <div className="gk-center-overlay">
                    <LineStagingDiff repositoryPath={wipDiffRepo ?? path} file={wipDiff} initialSide={wipDiffSide} liveKey={liveTick} onClose={() => setWipDiff(null)} onChanged={() => refresh()} />
                  </div>
                ) : undefined}
                inspector={wipSelected && dirtyCount > 0 ? (
                  <GkWipPanel
                    repositoryPath={path}
                    branch={summary?.branch ?? null}
                    changes={changes}
                    busy={busy}
                    operationActive={operationActive}
                    run={runRepositoryAction}
                    openDiff={wipDiff}
                    openDiffRepository={wipDiffRepo}
                    onOpenDiff={(file, group, repository) => {
                      const same = wipDiff === file && wipDiffSide === group && wipDiffRepo === (repository ?? null);
                      setWipDiffSide(group);
                      setWipDiffRepo(same ? null : repository ?? null);
                      setWipDiff(same ? null : file);
                    }}
                    onOpenRepository={(target) => void openRepoTab(target)}
                    onResolveConflicts={() => setView("conflicts")}
                    onShowInExplorer={(file) => { setExplorerFocus({ path: file, nonce: Date.now() }); setView("explorer"); }}
                    onFileHistory={() => setView("insights")}
                  />
                ) : undefined}
              />
            </div>
          )}
          {path && view === "settings" && (
            <RepoSettings repositoryPath={path} busy={busy} run={runRepositoryAction} initialTab={settingsTab} />
          )}
          {path && view === "explorer" && (
            <FileExplorer
              repositoryPath={path}
              refreshKey={refreshKey + liveTick}
              branches={branches}
              currentBranch={summary?.branch ?? null}
              busy={busy}
              run={runRepositoryAction}
              onNavigate={(next) => setView(next)}
              onOpenTerminal={(dir) => { setTerminalOpen(true); requestAnimationFrame(() => terminalRef.current?.createTab(dir ? `${path.replace(/[\\/]$/, "")}/${dir}` : path)); }}
              focus={explorerFocus}
            />
          )}
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
              onCheckoutTag={async (tag) => { await api.workflow(path, { operation: "checkout_tag", args: [tag] }); await refresh(); }}
              onOpenWorktree={refresh}
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
          {path && view === "forks" && (
            <ForksView
              repositoryPath={path}
              refreshKey={refreshKey}
              busy={busy}
              run={runRepositoryAction}
              onOpenRepository={(target) => void openRepoTab(target).then(() => setView("history"))}
            />
          )}
          {path && view === "submodules" && (
            <SubmoduleMap
              repositoryPath={path}
              forks={forkTreeState}
              refreshKey={refreshKey}
              busy={busy}
              run={runRepositoryAction}
              onOpenRepository={(target) => void openRepoTab(target).then(() => setView("history"))}
              onOpenTerminal={(dir) => { setTerminalOpen(true); requestAnimationFrame(() => terminalRef.current?.createTab(dir)); }}
            />
          )}
          {path && view === "landscape" && (
            <LandscapeView
              repositoryPath={path}
              liveKey={liveTick}
              onFileAction={async (action, file, repository) => {
                // Files inside a submodule open in that submodule's own tab.
                if (repository !== path) {
                  const opened = await openRepoTab(repository);
                  if (!opened.ok) { pushToast(`Could not open ${repository}: ${opened.error}`, "error", 9000); return; }
                }
                setView("explorer");
                setExplorerFocus({ path: file, paths: [file], isDir: [false], action: action === "explorer" ? undefined : action, nonce: Date.now() });
              }}
            />
          )}
          {path && (view === "worktrees" || view === "stashes" || view === "recovery") && (
            <WorkflowPanel section={view} repositoryPath={path} operationLocked={operationActive} onOpenWorktree={refresh} onRun={(request) => api.workflow(path, request)} />
          )}
          {view === "cherry" && <CherryParityPanel />}
          </ErrorBoundary>
        </section>
      </main>

      <footer className="ux-statusbar">
        <span className={message.toLowerCase().includes("error") ? "is-error" : ""} role="status" aria-live="polite">{message}</span>
        <span>{busy ? <><i className="ux-spinner" />Working…</> : revalidating ? <><i className="ux-spinner" />Updating…</> : path ? `${summary?.head?.slice(0, 8) || "no HEAD"} · ${changes.length ? `${changes.length} changed` : "clean"}` : "Ready"}</span>
      </footer>

      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
      <CloneDialog openDialog={cloneOpen} busy={busy} onClose={() => setCloneOpen(false)} onClone={submitClone} />

      {/* v6 GitKraken-style additions: integrated terminal, git executor log, keybindings, toasts */}
      <TerminalPanel ref={terminalRef} open={terminalOpen} repositoryPath={path || undefined} />
      <GitLogModal open={gitLogOpen} onClose={() => setGitLogOpen(false)} />
      <KeyBindingsModal open={keybindingsOpen} onClose={() => setKeybindingsOpen(false)} onZoom={(direction) => zoom(direction)} />
      <ToastHost />
      <DialogHost />
      <FolderPickerHost />
      <LiveOutputHost />
      {agentDialogOpen && path && (
        <AgentSessionDialog repositoryPath={path} defaultBase={summary?.branch ?? "HEAD"} onClose={() => setAgentDialogOpen(false)} onStarted={(worktree, command) => {
          setTerminalOpen(true);
          requestAnimationFrame(() => terminalRef.current?.createTab(worktree, command || undefined));
          void refresh();
        }} />
      )}
      {cleanupDialogOpen && path && <CleanupDialog repositoryPath={path} onClose={() => setCleanupDialogOpen(false)} run={runRepositoryAction} />}
    </div>
  );
}
