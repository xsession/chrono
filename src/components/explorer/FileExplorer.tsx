import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { api } from "../../api";
import type { BranchRecord, ExplorerEntry, ExplorerListing, OverlayStatus } from "../../types";
import type { RepositoryView } from "../RepositorySidebar";
import { Icon } from "../Icon";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { askChoice, askConfirm, askFields, askText } from "../DialogHost";
import { ExplorerDialogView, type ExplorerDialog } from "./ExplorerDialogs";
import { pushToast } from "../../toastBus";
import { SplitHandle } from "../SplitHandle";
import { ColumnGrip, useStoredColumns, useStoredWidth } from "../ColumnGrip";

// Resizable list columns (Name takes the free space, at least NAME_MIN).
const LIST_COLUMNS = { status: 150, modified: 140, type: 120, size: 80 };
const NAME_MIN = 160;

/** Reveal (and optionally act on) items — used by "Show in Explorer" and by
 *  chrono://tgit deep links from the operating system's file manager. */
export type ExplorerFocus = { path: string; nonce: number; paths?: string[]; isDir?: boolean[]; action?: string };

type Props = {
  repositoryPath: string;
  refreshKey: number;
  branches: BranchRecord[];
  currentBranch: string | null;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onNavigate: (view: RepositoryView) => void;
  onOpenTerminal: (dir: string) => void;
  /** reveal and select this repository-relative path */
  focus?: ExplorerFocus | null;
};

const OVERLAY_LABEL: Record<OverlayStatus, string> = {
  normal: "Normal (unchanged)",
  modified: "Modified",
  staged: "Staged",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  conflicted: "Conflicted",
  untracked: "Unversioned",
  ignored: "Ignored",
  "unversioned-dir": "Unversioned",
};

const SETTINGS_KEY = "chrono.tg.explorer";
type ExplorerSettings = { showIgnored: boolean; showUnversioned: boolean; showTree: boolean };
function loadSettings(): ExplorerSettings {
  try { return { showIgnored: true, showUnversioned: true, showTree: true, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<ExplorerSettings>) }; }
  catch { return { showIgnored: true, showUnversioned: true, showTree: true }; }
}

function formatSize(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024).toLocaleString()} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function kindLabel(entry: ExplorerEntry): string {
  if (entry.type === "dir") return "File folder";
  if (entry.type === "submodule") return "Git submodule";
  if (entry.type === "symlink") return "Symbolic link";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? `${entry.name.slice(dot + 1).toUpperCase()} file` : "File";
}

const ROW_HEIGHT = 24;
const VIRTUALIZE_AFTER = 200;
const OVERSCAN = 20;
/** header (26px) + optional ".." parent row; close enough for scroll math */
const ROW_OFFSET = 26;

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Overlay icon: file/folder glyph with the TortoiseGit status badge. */
function OverlayIcon({ entry }: { entry: Pick<ExplorerEntry, "type" | "status" | "assumeUnchanged" | "skipWorktree"> }) {
  const icon = entry.type === "dir" ? "folder" : entry.type === "submodule" ? "submodule" : "file";
  return (
    <span className={`tg-icon is-${entry.type}`}>
      <Icon name={icon} />
      {entry.status !== "unversioned-dir" && <span className={`tg-overlay is-${entry.status}${entry.assumeUnchanged || entry.skipWorktree ? " is-flagged" : ""}`} aria-hidden="true" />}
    </span>
  );
}

/** Folder tree on the left (lazily expanded via explorer_list). */
function FolderTree({ repositoryPath, refreshKey, current, onOpen, rootName }: { repositoryPath: string; refreshKey: number; current: string; onOpen: (dir: string) => void; rootName: string }) {
  const [children, setChildren] = useState<Record<string, ExplorerEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));

  const load = useCallback((dir: string) => {
    api.explorerList(repositoryPath, dir)
      .then((listing) => setChildren((value) => ({ ...value, [dir]: listing.entries.filter((entry) => entry.type === "dir" && entry.status !== "ignored") })))
      .catch(() => setChildren((value) => ({ ...value, [dir]: [] })));
  }, [repositoryPath]);

  useEffect(() => { setChildren({}); }, [repositoryPath]);
  useEffect(() => { for (const dir of expanded) load(dir); }, [refreshKey, load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // expand ancestors of the current folder
    const parts = current ? current.split("/") : [];
    const ancestors = parts.map((_, index) => parts.slice(0, index).join("/"));
    setExpanded((value) => {
      const next = new Set(value);
      for (const dir of ancestors) if (!next.has(dir)) { next.add(dir); load(dir); }
      return next;
    });
  }, [current, load]);

  const toggle = (dir: string) => setExpanded((value) => {
    const next = new Set(value);
    if (next.has(dir)) next.delete(dir); else { next.add(dir); if (!children[dir]) load(dir); }
    return next;
  });

  const render = (dir: string, depth: number) => (children[dir] ?? []).map((entry) => (
    <div key={entry.path}>
      <div className={`tg-tree-row${current === entry.path ? " is-current" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => onOpen(entry.path)} title={`${entry.path} — ${OVERLAY_LABEL[entry.status]}`}>
        <button type="button" className="tg-tree-twisty" onClick={(event) => { event.stopPropagation(); toggle(entry.path); }} aria-label={expanded.has(entry.path) ? "Collapse" : "Expand"}>
          <Icon name={expanded.has(entry.path) ? "chevronDown" : "chevronRight"} />
        </button>
        <OverlayIcon entry={entry} />
        <span>{entry.name}</span>
      </div>
      {expanded.has(entry.path) && render(entry.path, depth + 1)}
    </div>
  ));

  return (
    <nav className="tg-tree" aria-label="Folders">
      <div className={`tg-tree-row is-root${current === "" ? " is-current" : ""}`} onClick={() => onOpen("")}>
        <Icon name="repository" />
        <strong>{rootName}</strong>
      </div>
      {render("", 1)}
    </nav>
  );
}

/** TortoiseGit-style Windows-Explorer view of the working copy: folder tree,
 *  detail list with icon overlays, multi-select and the full TortoiseGit
 *  shell context menu. */
export function FileExplorer({ repositoryPath, refreshKey, branches, currentBranch, busy, run, onNavigate, onOpenTerminal, focus }: Props) {
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<ExplorerListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [settings, setSettings] = useState<ExplorerSettings>(loadSettings);
  const [treeWidth, resizeTree, resetTree] = useStoredWidth("chrono.explorer.treeWidth", 240, 150, 640);
  const [columns, resizeColumn, resetColumn] = useStoredColumns("chrono.explorer.columns", LIST_COLUMNS, 48);
  const [dialog, setDialog] = useState<ExplorerDialog | null>(null);
  const [localTick, setLocalTick] = useState(0);
  const [sort, setSort] = useState<{ key: "name" | "status" | "size" | "modified" | "type"; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [diffLater, setDiffLater] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const menu = useContextMenu();
  const listRef = useRef<HTMLDivElement | null>(null);
  // Row virtualization: large folders (node_modules, asset dumps) keep only
  // the visible rows mounted. Rows have a fixed 24px height.
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const update = () => setViewport((current) => (current.top === element.scrollTop && current.height === element.clientHeight ? current : { top: element.scrollTop, height: element.clientHeight }));
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => { element.removeEventListener("scroll", update); observer?.disconnect(); };
  }, []);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [dir]);

  const refreshAll = () => setLocalTick((value) => value + 1);
  const exec = useCallback(async (label: string, action: () => Promise<unknown>) => {
    await run(label, action);
    setLocalTick((value) => value + 1);
  }, [run]);

  useEffect(() => { setDir(""); setSelection([]); history.current = []; }, [repositoryPath]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.explorerList(repositoryPath, dir)
      .then((value) => { if (!cancelled) setListing(value); })
      .catch((reason) => { if (!cancelled) { setError(String(reason)); if (dir) setDir(parentOf(dir)); } });
    return () => { cancelled = true; };
  }, [repositoryPath, dir, refreshKey, localTick]);

  useEffect(() => {
    if (!focus) return;
    const paths = focus.paths?.length ? focus.paths : [focus.path];
    const firstIsDir = focus.isDir?.[0] ?? false;
    const target = paths[0] === "." ? "" : paths[0];
    // A folder chosen alone opens that folder; files reveal in their parent.
    if (paths.length === 1 && firstIsDir) { setDir(target); setSelection([]); }
    else { setDir(parentOf(target)); setSelection(paths.filter((item) => item !== ".")); setAnchor(target); }
    const files = paths.map((item) => item || ".");
    const single = paths.length === 1 ? files[0] : null;
    const isFile = single !== null && !firstIsDir;
    switch (focus.action) {
      case "commit": setDialog({ kind: "commit", files }); break;
      case "revert": setDialog({ kind: "revert", files }); break;
      case "add": setDialog({ kind: "add", files }); break;
      case "cleanup": setDialog({ kind: "cleanup", files }); break;
      case "modifications": setDialog({ kind: "modifications", files }); break;
      case "patch": setDialog({ kind: "patch", files }); break;
      case "sync": setDialog({ kind: "sync" }); break;
      case "log": setDialog({ kind: "log", file: single ?? files[0] }); break;
      case "properties": setDialog({ kind: "properties", file: single ?? files[0] }); break;
      case "diff": setDialog(isFile ? { kind: "diff", file: single!, mode: "working" } : paths.length === 2 && !focus.isDir?.some(Boolean) ? { kind: "diff-files", left: files[0], right: files[1] } : { kind: "modifications", files }); break;
      case "diffprev": if (isFile) setDialog({ kind: "diff", file: single!, mode: "previous" }); else pushToast("Diff with previous version needs a single file", "info"); break;
      case "blame": if (isFile) setDialog({ kind: "blame", file: single! }); else pushToast("Blame needs a single file", "info"); break;
      case "resolve": void (async () => { if (await askConfirm("Resolve", `Mark ${files.length === 1 ? files[0] : `${files.length} items`} as resolved (git add)?`, { confirm: "Mark resolved" })) await exec("Resolve", () => api.explorerAction(repositoryPath, { action: "resolve", files })); })(); break;
      case "stash": void (async () => { const message = await askText("Stash Save", "Message", `WIP on ${files.join(", ")}`); if (message !== null) await exec("Stash save", () => api.explorerAction(repositoryPath, { action: "stash_save", files, message })); })(); break;
      default: break;
    }
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSettings = (patch: Partial<ExplorerSettings>) => setSettings((value) => {
    const next = { ...value, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  });

  const entries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = (listing?.entries ?? []).filter((entry) =>
      (settings.showIgnored || entry.status !== "ignored") &&
      (settings.showUnversioned || (entry.status !== "untracked" && entry.status !== "unversioned-dir")) &&
      (!needle || entry.name.toLowerCase().includes(needle)));
    const rank = (entry: ExplorerEntry) => (entry.type === "dir" || entry.type === "submodule" ? 0 : 1);
    const value = (entry: ExplorerEntry): string | number => {
      switch (sort.key) {
        case "status": return entry.status;
        case "size": return entry.size ?? -1;
        case "modified": return entry.modifiedAt ?? "";
        case "type": return kindLabel(entry);
        default: return entry.name.toLowerCase();
      }
    };
    return [...list].sort((a, b) => {
      const byDir = rank(a) - rank(b);
      if (byDir) return byDir;
      if (sort.key === "name") return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * sort.dir;
      const av = value(a); const bv = value(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir || a.name.localeCompare(b.name);
    });
  }, [listing, filter, settings, sort]);

  const windowed = useMemo(() => {
    const total = entries.length;
    if (total <= VIRTUALIZE_AFTER) return { start: 0, end: total, topSpacer: 0, bottomSpacer: 0 };
    const first = Math.max(0, Math.floor((viewport.top - ROW_OFFSET) / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(total, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
    return { start: first, end: last, topSpacer: first * ROW_HEIGHT, bottomSpacer: (total - last) * ROW_HEIGHT };
  }, [entries.length, viewport]);

  const byPath = useMemo(() => new Map((listing?.entries ?? []).map((entry) => [entry.path, entry])), [listing]);
  const selectedEntries = selection.map((path) => byPath.get(path)).filter((entry): entry is ExplorerEntry => Boolean(entry));

  const navigate = (next: string) => {
    if (next === dir) return;
    history.current.push(dir);
    setDir(next);
    setSelection([]);
    setFilter("");
  };
  const goBack = () => { const previous = history.current.pop(); if (previous !== undefined) { setDir(previous); setSelection([]); } };

  const clickEntry = (event: ReactMouseEvent, entry: ExplorerEntry) => {
    if (event.shiftKey && anchor) {
      const paths = entries.map((item) => item.path);
      const a = paths.indexOf(anchor); const b = paths.indexOf(entry.path);
      if (a >= 0 && b >= 0) { setSelection(paths.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelection((value) => (value.includes(entry.path) ? value.filter((path) => path !== entry.path) : [...value, entry.path]));
      setAnchor(entry.path);
      return;
    }
    setSelection([entry.path]);
    setAnchor(entry.path);
  };

  const openEntry = (entry: ExplorerEntry) => {
    if (entry.type === "dir") { navigate(entry.path); return; }
    if (entry.type === "submodule") { pushToast("Submodule: use the context menu to update or open it.", "info"); return; }
    if (["modified", "staged", "added", "deleted", "renamed"].includes(entry.status)) setDialog({ kind: "diff", file: entry.path, mode: "working" });
    else if (entry.status === "conflicted") onNavigate("conflicts");
    else void api.explorerOpen(repositoryPath, entry.path, "open").catch(() => setDialog({ kind: "properties", file: entry.path }));
  };

  // ---------------------------------------------------------------- menu
  const buildMenu = (targets: ExplorerEntry[], background: boolean): MenuItem[] => {
    const files = background ? [dir || "."] : targets.map((entry) => entry.path);
    const single = targets.length === 1 ? targets[0] : null;
    const isFile = Boolean(single && single.type === "file");
    const any = (statuses: OverlayStatus[]) => targets.some((entry) => statuses.includes(entry.status));
    const hasModified = background || any(["modified", "staged", "added", "deleted", "renamed", "conflicted"]) || targets.some((entry) => entry.type === "dir" && entry.changedCount > 0);
    const hasUntracked = background || any(["untracked", "unversioned-dir"]) || targets.some((entry) => entry.type === "dir");
    const hasConflict = background || any(["conflicted"]) || targets.some((entry) => entry.type === "dir" && entry.status === "conflicted");
    const tracked = background || targets.some((entry) => entry.tracked);
    const allTracked = !background && targets.length > 0 && targets.every((entry) => entry.tracked);
    const label = background ? (dir || listing?.root.split(/[\\/]/).pop() || "/") : single ? single.name : `${targets.length} items`;
    const branchName = currentBranch ?? "detached HEAD";
    const localBranches = branches.filter((branch) => !branch.remote);
    const otherBranches = branches.filter((branch) => !branch.current && !branch.name.endsWith("/HEAD"));
    const singlePath = single?.path ?? (background ? dir || "." : "");
    const ext = single && single.type === "file" && single.name.includes(".") ? single.name.slice(single.name.lastIndexOf(".")) : "";

    const tortoise: MenuItem[] = [
      { id: "pull", label: "Pull…", icon: "download", disabled: busy, onSelect: () => exec("Pull", () => api.pull(repositoryPath, "ff-only")) },
      { id: "fetch", label: "Fetch…", disabled: busy, onSelect: () => exec("Fetch", () => api.pull(repositoryPath, "fetch")) },
      { id: "push", label: "Push…", icon: "upload", disabled: busy, onSelect: () => exec("Push", () => api.push(repositoryPath)) },
      { kind: "separator", id: "s1" },
      { id: "diff", label: "Diff", icon: "diff", disabled: !isFile || !hasModified, onSelect: () => setDialog({ kind: "diff", file: single!.path, mode: "working" }) },
      { id: "diffprev", label: "Diff with previous version", disabled: !isFile || !single?.tracked, onSelect: () => setDialog({ kind: "diff", file: single!.path, mode: "previous" }) },
      { id: "diffwith", label: targets.length === 2 ? "Diff the two selected files" : diffLater ? `Diff with "${diffLater.split("/").pop()}"` : "Diff later", disabled: !(targets.length === 2 && targets.every((entry) => entry.type === "file")) && !isFile, onSelect: () => {
        if (targets.length === 2) { setDialog({ kind: "diff-files", left: targets[0].path, right: targets[1].path }); return; }
        if (diffLater && single && diffLater !== single.path) { setDialog({ kind: "diff-files", left: diffLater, right: single.path }); setDiffLater(null); return; }
        if (single) { setDiffLater(single.path); pushToast(`Marked ${single.name} — choose “Diff with…” on another file`, "info"); }
      } },
      { kind: "separator", id: "s2" },
      { id: "log", label: "Show log", icon: "history", disabled: !background && !single, onSelect: () => setDialog({ kind: "log", file: singlePath }) },
      { id: "reflog", label: "Show Reflog", onSelect: async () => { try { const result = await api.workflow(repositoryPath, { operation: "reflog", args: [] }); setDialog({ kind: "output", title: "Reflog", text: result.stdout }); } catch (reason) { pushToast(String(reason), "error"); } } },
      { id: "refs", label: "Browse References", icon: "list", onSelect: () => onNavigate("refs") },
      { id: "graph", label: "Revision graph", icon: "branch", onSelect: () => onNavigate("history") },
      { id: "repobrowser", label: "Repo-browser", icon: "repository", onSelect: () => onNavigate("repo") },
      { id: "mods", label: "Check for modifications", icon: "changes", onSelect: () => setDialog({ kind: "modifications", files }) },
      { id: "blame", label: "Blame", icon: "users", disabled: !isFile || !single?.tracked, onSelect: () => setDialog({ kind: "blame", file: single!.path }) },
      { kind: "separator", id: "s3" },
      { id: "resolve", label: "Resolve…", icon: "check", disabled: !hasConflict, onSelect: () => exec("Resolve", () => api.explorerAction(repositoryPath, { action: "resolve", files })) },
      { id: "resolve-side", label: "Resolve conflict using", disabled: !hasConflict, submenu: [
        { id: "mine", label: "Mine (ours)", onSelect: () => exec("Resolve using mine", () => api.explorerAction(repositoryPath, { action: "resolve_ours", files })) },
        { id: "theirs", label: "Theirs", onSelect: () => exec("Resolve using theirs", () => api.explorerAction(repositoryPath, { action: "resolve_theirs", files })) },
        { kind: "separator", id: "x" },
        { id: "center", label: "Edit conflicts (Conflict Center)…", icon: "warning", onSelect: () => onNavigate("conflicts") },
      ] },
      { id: "revert", label: "Revert…", icon: "undo", disabled: !hasModified, onSelect: () => setDialog({ kind: "revert", files }) },
      { id: "cleanup", label: "Clean up…", icon: "trash", onSelect: () => setDialog({ kind: "cleanup", files }) },
      { kind: "separator", id: "s4" },
      { id: "switch", label: "Switch/Checkout…", icon: "branch", disabled: busy, submenu: [
        ...localBranches.map<MenuItem>((branch) => ({ id: `sw-${branch.name}`, label: branch.name, checked: branch.current, disabled: branch.current, onSelect: () => exec(`Checkout ${branch.name}`, () => api.switchBranch(repositoryPath, branch.name)) })),
        { kind: "separator", id: "x" },
        { id: "sw-other", label: "Other revision…", onSelect: async () => { const rev = await askText("Switch/Checkout", "Branch, tag or commit"); if (rev?.trim()) await exec(`Checkout ${rev.trim()}`, () => api.workflow(repositoryPath, { operation: "checkout_tag", args: [rev.trim()] })); } },
      ] },
      { id: "merge", label: "Merge…", disabled: busy || otherBranches.length === 0, submenu: otherBranches.slice(0, 40).map<MenuItem>((branch) => ({ id: `m-${branch.name}`, label: `${branch.name} → ${branchName}`, onSelect: async () => {
        const strategy = await askChoice(`Merge ${branch.name} into ${branchName}`, [
          { value: "no-ff", label: "Create merge commit (--no-ff)" },
          { value: "ff-only", label: "Fast-forward only" },
          { value: "squash", label: "Squash (stage the result, commit manually)" },
        ]);
        if (strategy) await exec(`Merge ${branch.name}`, () => api.mergeBranch(repositoryPath, branch.name, strategy as "no-ff" | "ff-only" | "squash"));
      } })) },
      { id: "branch", label: "Create Branch…", icon: "branch", disabled: busy, onSelect: async () => {
        const values = await askFields("Create Branch", [{ name: "name", label: "Branch name" }, { name: "base", label: "Base on (branch, tag or commit)", initial: "HEAD" }, { name: "switch", label: "Switch to new branch? (yes/no)", initial: "yes" }]);
        if (!values?.name.trim()) return;
        await exec(`Create branch ${values.name.trim()}`, async () => {
          await api.createBranchAt(repositoryPath, values.name.trim(), values.base.trim() || "HEAD");
          if (/^y/i.test(values.switch)) await api.switchBranch(repositoryPath, values.name.trim());
        });
      } },
      { id: "tag", label: "Create Tag…", icon: "tag", disabled: busy, onSelect: async () => {
        const values = await askFields("Create Tag", [{ name: "name", label: "Tag name" }, { name: "base", label: "Base on", initial: "HEAD" }, { name: "message", label: "Message (annotated tag)", multiline: true }]);
        if (values?.name.trim()) await exec(`Tag ${values.name.trim()}`, () => api.createTag(repositoryPath, values.name.trim(), values.base.trim() || "HEAD", values.message));
      } },
      { id: "export", label: "Export…", icon: "external", onSelect: async () => {
        const values = await askFields("Export", [{ name: "revision", label: "Revision", initial: "HEAD" }, { name: "destination", label: "Destination archive (absolute path, .zip / .tar / .tar.gz)", placeholder: "/tmp/export.zip" }]);
        if (values?.destination.trim()) await exec("Export", () => api.explorerAction(repositoryPath, { action: "export", files, revision: values.revision.trim() || "HEAD", destination: values.destination.trim() }));
      } },
      { kind: "separator", id: "s5" },
      { id: "rebase", label: "Rebase…", icon: "layers", onSelect: () => onNavigate("rebase") },
      { id: "stash", label: "Stash Save", icon: "stash", disabled: busy || !hasModified, onSelect: async () => {
        const message = await askText("Stash Save", "Message", background ? "" : `WIP on ${label}`);
        if (message !== null) await exec("Stash save", () => api.explorerAction(repositoryPath, { action: "stash_save", files, message }));
      } },
      { id: "stashpop", label: "Stash Pop", icon: "pop", disabled: busy, onSelect: () => exec("Stash pop", () => api.workflow(repositoryPath, { operation: "stash_pop", args: [] })) },
      { id: "stashlist", label: "Stash List", onSelect: () => setDialog({ kind: "stashes" }) },
      { id: "bisect", label: "Bisect start", onSelect: () => onNavigate("recovery") },
      { kind: "separator", id: "s6" },
      { id: "add", label: "Add…", icon: "plus", disabled: !hasUntracked, onSelect: () => setDialog({ kind: "add", files }) },
      { id: "ignore", label: "Add to ignore list", icon: "ignore", disabled: background || targets.length === 0, submenu: [
        { id: "ig-name", label: single ? single.name : "Selected names", hint: "Adds an entry to .gitignore in the item's folder", onSelect: () => exec("Add to ignore list", () => api.explorerAction(repositoryPath, { action: "ignore_name", files, scope: "local" })) },
        { id: "ig-name-root", label: `${single ? single.name : "Selected names"} (recursively, root .gitignore)`, onSelect: () => exec("Add to ignore list", () => api.explorerAction(repositoryPath, { action: "ignore_name", files, scope: "root" })) },
        ...(ext ? [{ id: "ig-ext", label: `*${ext}`, onSelect: () => exec("Add to ignore list", () => api.explorerAction(repositoryPath, { action: "ignore_ext", files, scope: "local" })) }, { id: "ig-ext-root", label: `*${ext} (root .gitignore)`, onSelect: () => exec("Add to ignore list", () => api.explorerAction(repositoryPath, { action: "ignore_ext", files, scope: "root" })) }] as MenuItem[] : []),
      ] },
      { id: "delignore", label: "Delete and add to ignore list", disabled: background || !tracked, hint: "Removes from the index (keeps the file) and ignores it", onSelect: () => exec("Delete and ignore", () => api.explorerAction(repositoryPath, { action: "ignore_and_remove", files, scope: "local" })) },
      { id: "rmkeep", label: "Delete (keep local)", disabled: background || !allTracked, onSelect: () => exec("Remove from version control", () => api.explorerAction(repositoryPath, { action: "remove_keep_local", files })) },
      { id: "rename", label: "Rename…", disabled: !single || busy, shortcut: "F2", onSelect: () => renameEntry(single!) },
      { id: "delete", label: "Delete", icon: "trash", danger: true, disabled: background || targets.length === 0, shortcut: "Del", onSelect: () => deleteEntries(targets) },
      { id: "revrev", label: "Revert to revision…", disabled: background || !allTracked, onSelect: async () => {
        const rev = await askText("Revert to revision", "Commit, branch or tag to restore the selection from", "HEAD~1");
        if (rev?.trim()) await exec(`Revert to ${rev.trim()}`, () => api.explorerAction(repositoryPath, { action: "checkout_revision", files, revision: rev.trim() }));
      } },
      { kind: "separator", id: "s7" },
      { id: "flags", label: "Index flags", disabled: background || !allTracked, submenu: [
        { id: "au", label: "Assume unchanged", checked: targets.every((entry) => entry.assumeUnchanged), onSelect: () => exec("Assume unchanged", () => api.explorerAction(repositoryPath, { action: targets.every((entry) => entry.assumeUnchanged) ? "no_assume_unchanged" : "assume_unchanged", files })) },
        { id: "sw", label: "Skip worktree", checked: targets.every((entry) => entry.skipWorktree), onSelect: () => exec("Skip worktree", () => api.explorerAction(repositoryPath, { action: targets.every((entry) => entry.skipWorktree) ? "no_skip_worktree" : "skip_worktree", files })) },
      ] },
      { id: "lfs", label: "LFS", icon: "lock", submenu: [
        { id: "lock", label: "Lock", disabled: !isFile, onSelect: () => exec("LFS lock", () => api.explorerAction(repositoryPath, { action: "lfs_lock", files })) },
        { id: "unlock", label: "Unlock", disabled: !isFile, onSelect: () => exec("LFS unlock", () => api.explorerAction(repositoryPath, { action: "lfs_unlock", files })) },
        { id: "track", label: ext ? `Track *${ext} with LFS` : "Track with LFS", disabled: background, onSelect: () => exec("LFS track", () => api.explorerAction(repositoryPath, { action: "lfs_track", files })) },
        { kind: "separator", id: "x" },
        { id: "locks", label: "Show locks", onSelect: async () => { try { const result = await api.workflow(repositoryPath, { operation: "lfs_locks", args: [] }); setDialog({ kind: "output", title: "LFS locks", text: result.stdout }); } catch (reason) { pushToast(String(reason), "error"); } } },
        { id: "lfspull", label: "LFS pull", onSelect: () => exec("LFS pull", () => api.workflow(repositoryPath, { operation: "lfs_pull", args: [] })) },
      ] },
      { id: "submodule", label: "Submodule Update…", icon: "submodule", disabled: busy, onSelect: () => exec("Submodule update", () => (single?.type === "submodule" ? api.explorerAction(repositoryPath, { action: "submodule_update", files }) : api.workflow(repositoryPath, { operation: "submodule_update", args: [] }))) },
      { kind: "separator", id: "s8" },
      { id: "patch", label: "Create Patch…", icon: "patch", disabled: !hasModified, onSelect: () => setDialog({ kind: "patch", files }) },
      { id: "applypatch", label: "Apply Patch…", onSelect: () => setDialog({ kind: "apply-patch", dir: background ? dir : single?.type === "dir" ? single.path : parentOf(singlePath) }) },
      { kind: "separator", id: "s9" },
      { id: "settings", label: "Settings", icon: "settings", submenu: [
        { id: "show-ignored", label: "Show ignored items", checked: settings.showIgnored, onSelect: () => updateSettings({ showIgnored: !settings.showIgnored }) },
        { id: "show-unv", label: "Show unversioned items", checked: settings.showUnversioned, onSelect: () => updateSettings({ showUnversioned: !settings.showUnversioned }) },
        { id: "show-tree", label: "Show folder tree", checked: settings.showTree, onSelect: () => updateSettings({ showTree: !settings.showTree }) },
      ] },
      { id: "about", label: "About", icon: "info", onSelect: () => setDialog({ kind: "about" }) },
    ];

    return [
      ...(single?.type === "dir" && !background ? [{ id: "open", label: "Open", bold: true, onSelect: () => navigate(single.path) } as MenuItem] : []),
      ...(isFile ? [{ id: "open", label: "Open", bold: true, icon: "external" as const, onSelect: () => openEntry(single!) }] as MenuItem[] : []),
      { id: "open-folder", label: "Open containing folder", icon: "folderOpen", onSelect: async () => { try { await api.explorerOpen(repositoryPath, singlePath, "reveal"); } catch (reason) { pushToast(String(reason), "error"); } } },
      { id: "terminal", label: "Open Git terminal here", icon: "terminal", onSelect: () => onOpenTerminal(single?.type === "dir" ? single.path : background ? dir : parentOf(singlePath)) },
      { kind: "separator", id: "t0" },
      { id: "sync", label: "Git Sync…", icon: "refresh", onSelect: () => setDialog({ kind: "sync" }) },
      { id: "commit", label: `Git Commit -> "${branchName}"…`, icon: "commit", bold: hasModified, onSelect: () => setDialog({ kind: "commit", files }) },
      ...(isFile && hasModified ? [{ id: "qdiff", label: "Git Diff", icon: "diff" as const, onSelect: () => setDialog({ kind: "diff", file: single!.path, mode: "working" }) }] : []),
      ...(!background && hasUntracked && any(["untracked", "unversioned-dir"]) ? [{ id: "qadd", label: "Git Add", icon: "plus" as const, onSelect: () => exec("Add", () => api.explorerAction(repositoryPath, { action: "add", files })) }] : []),
      ...(!background && any(["conflicted"]) ? [{ id: "qresolve", label: "Git Resolve", icon: "check" as const, onSelect: () => exec("Resolve", () => api.explorerAction(repositoryPath, { action: "resolve", files })) }] : []),
      { id: "tgit", label: "TortoiseGit", icon: "repository", submenu: tortoise },
      { kind: "separator", id: "t1" },
      { id: "copy", label: "Copy path", icon: "copy", submenu: [
        { id: "rel", label: "Relative path", onSelect: () => copyText(files.join("\n")) },
        { id: "abs", label: "Full path", onSelect: () => copyText(files.map((file) => `${listing?.root ?? repositoryPath}/${file === "." ? "" : file}`.replace(/\/$/, "")).join("\n")) },
        { id: "name", label: "Name only", onSelect: () => copyText((background ? [dir || "."] : targets.map((entry) => entry.name)).join("\n")) },
      ] },
      ...(background ? [
        { kind: "separator", id: "t2" } as MenuItem,
        { id: "new", label: "New", icon: "plus", submenu: [
          { id: "nf", label: "Folder", icon: "folder", onSelect: async () => { const name = await askText("New folder", "Name", "New folder"); if (name?.trim()) await exec("New folder", () => api.explorerAction(repositoryPath, { action: "new_folder", files: [dir], newName: name.trim() })); } },
          { id: "nfile", label: "Text file", icon: "file", onSelect: async () => { const name = await askText("New file", "Name", "new-file.txt"); if (name?.trim()) await exec("New file", () => api.explorerAction(repositoryPath, { action: "new_file", files: [dir], newName: name.trim() })); } },
        ] } as MenuItem,
        { id: "refresh", label: "Refresh", icon: "refresh", shortcut: "F5", onSelect: refreshAll } as MenuItem,
      ] : []),
      { kind: "separator", id: "t3" },
      { id: "props", label: "Properties", icon: "info", disabled: !background && !single, onSelect: () => setDialog({ kind: "properties", file: singlePath }) },
    ];
  };

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); pushToast("Copied to clipboard", "success", 2000); } catch { pushToast(text, "info"); }
  };

  const renameEntry = async (entry: ExplorerEntry) => {
    const name = await askText(`Rename ${entry.name}`, entry.tracked ? "New name (git mv)" : "New name", entry.name);
    if (name?.trim() && name.trim() !== entry.name) await exec(`Rename ${entry.name}`, () => api.explorerAction(repositoryPath, { action: "rename", files: [entry.path], newName: name.trim() }));
  };

  const deleteEntries = async (targets: ExplorerEntry[]) => {
    if (!targets.length) return;
    const tracked = targets.filter((entry) => entry.tracked).length;
    const ok = await askConfirm("Delete", `Delete ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`}? ${tracked ? `${tracked} versioned item(s) are removed with git rm and can be restored with Revert until you commit.` : "Unversioned items are permanently deleted."}`, { confirm: "Delete", danger: true });
    if (ok) { await exec("Delete", () => api.explorerAction(repositoryPath, { action: "delete", files: targets.map((entry) => entry.path) })); setSelection([]); }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (event.key === "F5") { event.preventDefault(); refreshAll(); }
    else if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) { event.preventDefault(); if (dir) navigate(parentOf(dir)); }
    else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); }
    else if (event.key === "Delete") { event.preventDefault(); void deleteEntries(selectedEntries); }
    else if (event.key === "F2" && selectedEntries.length === 1) { event.preventDefault(); void renameEntry(selectedEntries[0]); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelection(entries.map((entry) => entry.path)); }
    else if (event.key === "Enter" && selectedEntries.length === 1) { event.preventDefault(); openEntry(selectedEntries[0]); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const paths = entries.map((entry) => entry.path);
      const at = paths.indexOf(selection[selection.length - 1] ?? "");
      const next = paths[Math.max(0, Math.min(paths.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        setSelection([next]); setAnchor(next);
        const list = listRef.current;
        if (list) {
          const top = ROW_OFFSET + paths.indexOf(next) * ROW_HEIGHT;
          if (top < list.scrollTop + ROW_OFFSET) list.scrollTop = top - ROW_OFFSET;
          else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
        }
      }
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = listRef.current?.getBoundingClientRect();
      menu.open({ clientX: (rect?.left ?? 0) + 60, clientY: (rect?.top ?? 0) + 60 }, buildMenu(selectedEntries, selectedEntries.length === 0));
    }
  };

  const crumbs = dir ? dir.split("/") : [];
  const counts = useMemo(() => {
    const result: Partial<Record<OverlayStatus, number>> = {};
    for (const entry of listing?.entries ?? []) result[entry.status] = (result[entry.status] ?? 0) + 1;
    return result;
  }, [listing]);
  // Each header's right edge resizes its column; Name's edge moves Git status's left side.
  const sortHeader = (key: typeof sort.key, title: string) => {
    const column = key === "name" ? "status" : key;
    const sign = key === "name" ? -1 : 1;
    return (
      <span className="tg-head-cell">
        <button type="button" onClick={() => setSort((value) => ({ key, dir: value.key === key ? (value.dir === 1 ? -1 : 1) : 1 }))}>{title}{sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button>
        <ColumnGrip label={`Resize ${title} column`} onDelta={(delta) => resizeColumn(column, sign * delta)} onReset={() => resetColumn(column)} />
      </span>
    );
  };
  const listColumns = `minmax(${NAME_MIN}px, 1fr) ${columns.status}px ${columns.modified}px ${columns.type}px ${columns.size}px`;
  const listMinWidth = NAME_MIN + columns.status + columns.modified + columns.type + columns.size;

  return (
    <div className="tg-explorer" onKeyDown={onKeyDown}>
      <header className="tg-explorer-bar">
        <div className="tg-nav-buttons">
          <button type="button" className="ux-icon-button" onClick={goBack} disabled={!history.current.length} title="Back (Alt+←)" aria-label="Back"><Icon name="chevronLeft" /></button>
          <button type="button" className="ux-icon-button" onClick={() => navigate(parentOf(dir))} disabled={!dir} title="Up (Backspace)" aria-label="Up one level"><Icon name="upload" /></button>
          <button type="button" className="ux-icon-button" onClick={refreshAll} title="Refresh (F5)" aria-label="Refresh"><Icon name="refresh" /></button>
        </div>
        <nav className="tg-breadcrumb" aria-label="Location">
          <button type="button" onClick={() => navigate("")}><Icon name="repository" />{listing?.root.split(/[\\/]/).pop() ?? "repository"}</button>
          {crumbs.map((part, index) => (
            <span key={index}><Icon name="chevronRight" /><button type="button" onClick={() => navigate(crumbs.slice(0, index + 1).join("/"))}>{part}</button></span>
          ))}
        </nav>
        <label className="tg-search"><Icon name="search" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Search ${crumbs[crumbs.length - 1] ?? "repository"}`} aria-label="Filter items" /></label>
        <button type="button" className="ux-button" onClick={(event) => menu.open({ clientX: event.currentTarget.getBoundingClientRect().left, clientY: event.currentTarget.getBoundingClientRect().bottom + 2 }, buildMenu(selectedEntries, selectedEntries.length === 0))} title="TortoiseGit menu for the selection">
          <Icon name="more" />TortoiseGit
        </button>
      </header>

      <div className={`tg-explorer-body${settings.showTree ? "" : " no-tree"}`} style={settings.showTree ? { gridTemplateColumns: `${treeWidth}px 6px minmax(0, 1fr)` } : undefined}>
        {settings.showTree && <FolderTree repositoryPath={repositoryPath} refreshKey={refreshKey + localTick} current={dir} onOpen={navigate} rootName={listing?.root.split(/[\\/]/).pop() ?? "repository"} />}
        {settings.showTree && <SplitHandle label="Resize folder tree" onDelta={resizeTree} onReset={resetTree} />}
        <div
          className="tg-list"
          style={{ ["--tg-cols" as string]: listColumns, ["--tg-min" as string]: `${listMinWidth}px` }}
          ref={listRef}
          tabIndex={0}
          onClick={(event) => { if (event.target === event.currentTarget) setSelection([]); }}
          onContextMenu={(event) => { if ((event.target as HTMLElement).closest(".tg-row")) return; setSelection([]); menu.open(event, buildMenu([], true), dir || "/"); }}
          aria-label="Working copy items"
          role="grid"
          aria-multiselectable="true"
        >
          <div className="tg-list-head" role="row">
            {sortHeader("name", "Name")}{sortHeader("status", "Git status")}{sortHeader("modified", "Date modified")}{sortHeader("type", "Type")}{sortHeader("size", "Size")}
          </div>
          {error && <div className="ux-empty-state compact"><Icon name="warning" />{error}</div>}
          {!listing && !error && <div className="gk-empty"><i className="ux-spinner" />Loading…</div>}
          {dir && listing && (
            <div className="tg-row is-parent" role="row" onDoubleClick={() => navigate(parentOf(dir))}>
              <span className="tg-name"><span className="tg-icon is-dir"><Icon name="folder" /></span>..</span><span /><span /><span>Parent folder</span><span />
            </div>
          )}
          {windowed.topSpacer > 0 && <div style={{ height: windowed.topSpacer }} aria-hidden="true" />}
          {entries.slice(windowed.start, windowed.end).map((entry) => {
            const isSelected = selection.includes(entry.path);
            return (
              <div
                key={entry.path}
                data-path={entry.path}
                className={`tg-row${isSelected ? " is-selected" : ""} st-${entry.status}${entry.missing ? " is-missing" : ""}${diffLater === entry.path ? " is-diff-later" : ""}`}
                role="row"
                aria-selected={isSelected}
                onClick={(event) => clickEntry(event, entry)}
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(event) => {
                  const targets = isSelected ? selectedEntries : [entry];
                  if (!isSelected) { setSelection([entry.path]); setAnchor(entry.path); }
                  menu.open(event, buildMenu(targets, false), targets.length === 1 ? entry.name : `${targets.length} items`);
                }}
                title={`${entry.path}\n${OVERLAY_LABEL[entry.status]}${entry.changedCount && entry.type === "dir" ? ` · ${entry.changedCount} changed inside` : ""}${entry.assumeUnchanged ? " · assume-unchanged" : ""}${entry.skipWorktree ? " · skip-worktree" : ""}`}
              >
                <span className="tg-name"><OverlayIcon entry={entry} /><span>{entry.name}</span>{entry.type === "dir" && entry.changedCount > 0 && <em>{entry.changedCount}</em>}</span>
                <span className={`tg-status-text is-${entry.status}`}>{entry.missing ? "missing" : OVERLAY_LABEL[entry.status]}{entry.indexStatus || entry.worktreeStatus ? <code>{(entry.indexStatus || " ") + (entry.worktreeStatus || " ")}</code> : null}</span>
                <span>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : ""}</span>
                <span>{kindLabel(entry)}</span>
                <span className="tg-size">{formatSize(entry.size)}</span>
              </div>
            );
          })}
          {windowed.bottomSpacer > 0 && <div style={{ height: windowed.bottomSpacer }} aria-hidden="true" />}
          {listing && entries.length === 0 && !error && <div className="gk-empty">{filter ? "No items match the search." : "This folder is empty."}</div>}
        </div>
      </div>

      <footer className="tg-explorer-status">
        <span>{entries.length} item{entries.length === 1 ? "" : "s"}{selection.length ? ` · ${selection.length} selected` : ""}</span>
        <span className="tg-legend-inline">
          {(["modified", "staged", "added", "deleted", "conflicted", "untracked", "ignored"] as OverlayStatus[]).filter((status) => counts[status]).map((status) => (
            <span key={status}><i className={`tg-overlay-dot is-${status}`} />{counts[status]} {OVERLAY_LABEL[status].toLowerCase()}</span>
          ))}
        </span>
        <span>{currentBranch ? <><Icon name="branch" />{currentBranch}</> : "detached HEAD"}</span>
      </footer>

      {menu.element}
      {dialog && (
        <ExplorerDialogView
          dialog={dialog}
          repositoryPath={repositoryPath}
          branch={currentBranch}
          busy={busy}
          run={exec}
          onClose={() => setDialog(null)}
          onOpenDialog={setDialog}
        />
      )}
    </div>
  );
}
