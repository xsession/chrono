import { useEffect, useMemo, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { api } from "../../api";
import type { BranchRef, FlowType, GitflowConfig, RefGroups, RemoteRecord, StashFile, SubmoduleTree, TagRecord } from "../../types";
import { submoduleStatus } from "./SubmoduleMap";
import { CleanupDialog, PullRequestDialog } from "./HostingDialogs";
import type { SettingsTab } from "../settings/RepoSettings";
import { Icon, type IconName } from "../Icon";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { askChoice, askConfirm, askFields, askText } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { plural } from "../../plural";
import type { ForkStatus } from "../../types";
import { forkBadge } from "../ForksView";
import { AddRemoteDialog, createIssueBranch, LabelChip } from "./GithubDialogs";
import { ISSUE_FILTERS, useGithubPanel } from "./useGithubPanel";
import { ago, openUrl } from "../../githubContext";
import { askToken } from "../../providerTokens";

type Props = {
  repositoryPath: string;
  /** Fork status of the repository and its submodules (forks.ts). */
  forks?: ForkStatus[];
  refreshKey: number;
  busy: boolean;
  /** run a mutating action, then refresh the repository */
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onSelectRevision: (sha: string) => void;
  onOpenRepository: (path: string) => void;
  onStartRebase: () => void;
  onOpenPullRequests: () => void;
  onStashCount?: (count: number) => void;
  onOpenSettings?: (tab: SettingsTab) => void;
  onNewAgentSession?: () => void;
  onOpenSubmoduleMap?: () => void;
};

type SectionId = "local" | "remote" | "worktrees" | "stashes" | "tags" | "submodules" | "prs" | "issues";
const COLLAPSE_KEY = "chrono.gk.leftPanel.collapsed";

function loadCollapsed(): Set<SectionId> {
  // First run: keep the panel calm — only LOCAL and SUBMODULES open.
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '["remote","tags","stashes","worktrees"]') as SectionId[]); } catch { return new Set(); }
}

type TreeNode = { name: string; full: string; children: Map<string, TreeNode>; branch: BranchRef | null };

function buildTree(branches: BranchRef[], prefix = ""): TreeNode {
  const root: TreeNode = { name: "", full: prefix, children: new Map(), branch: null };
  for (const branch of branches) {
    const parts = branch.name.split("/");
    let node = root;
    parts.forEach((part, index) => {
      const full = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) { child = { name: part, full, children: new Map(), branch: null }; node.children.set(part, child); }
      if (index === parts.length - 1) child.branch = branch;
      node = child;
    });
  }
  return root;
}

const copy = async (text: string) => {
  try { await navigator.clipboard.writeText(text); pushToast(`Copied ${text}`, "success", 2500); }
  catch { pushToast(text, "info"); }
};

/** GitKraken-style left panel: LOCAL / REMOTE / WORKTREES / STASHES / TAGS /
 *  SUBMODULES / PULL REQUESTS with folder-grouped branch trees, ahead/behind
 *  counters, filter, context menus and drag-and-drop merge/rebase. */
export function GkLeftPanel({ repositoryPath, forks = [], refreshKey, busy, run, onSelectRevision, onOpenRepository, onStartRebase, onOpenPullRequests, onStashCount, onOpenSettings, onNewAgentSession, onOpenSubmoduleMap }: Props) {
  const [parents, setParents] = useState<Record<string, string>>({});
  const [flow, setFlow] = useState<GitflowConfig | null>(null);
  const [prFor, setPrFor] = useState<{ head: string; base: string } | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [refs, setRefs] = useState<RefGroups | null>(null);
  const [remotes, setRemotes] = useState<RemoteRecord[]>([]);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<SectionId>>(loadCollapsed);
  const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [openStash, setOpenStash] = useState<string | null>(null);
  const [stashFiles, setStashFiles] = useState<StashFile[] | null>(null);
  const menu = useContextMenu();
  const [subTree, setSubTree] = useState<SubmoduleTree | null>(null);
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const github = useGithubPanel(repositoryPath, refreshKey, run);
  const [openSubs, setOpenSubs] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api.submoduleTree(repositoryPath).then((tree) => {
      if (cancelled) return;
      setSubTree(tree);
      setOpenSubs((current) => (current.size ? current : new Set(tree.nodes.filter((node) => node.attentionBelow > 0).map((node) => node.path))));
    }).catch(() => { if (!cancelled) setSubTree(null); });
    return () => { cancelled = true; };
  }, [repositoryPath, refreshKey]);
  useEffect(() => { setOpenSubs(new Set()); }, [repositoryPath]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.refGroups(repositoryPath), api.remotes(repositoryPath).catch(() => []), api.stackParents(repositoryPath).catch(() => ({})), api.gitflowConfig(repositoryPath).catch(() => null)])
      .then(([groups, remoteList, stackParents, flowConfig]) => {
        if (cancelled) return;
        setRefs(groups);
        setRemotes(remoteList);
        setParents(stackParents);
        setFlow(flowConfig);
        onStashCount?.(groups.stashes.length);
      })
      .catch(() => { if (!cancelled) setRefs(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryPath, refreshKey]);

  useEffect(() => {
    if (!openStash) { setStashFiles(null); return; }
    let cancelled = false;
    api.stashFiles(repositoryPath, openStash).then((files) => { if (!cancelled) setStashFiles(files); }).catch(() => { if (!cancelled) setStashFiles([]); });
    return () => { cancelled = true; };
  }, [openStash, repositoryPath, refreshKey]);

  const toggleSection = (id: SectionId) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
    return next;
  });

  const needle = filter.trim().toLowerCase();
  const matches = (value: string) => !needle || value.toLowerCase().includes(needle);
  const local = useMemo(() => (refs?.branches ?? []).filter((branch) => !branch.remote && matches(branch.name)), [refs, needle]);
  const remoteBranches = useMemo(() => (refs?.branches ?? []).filter((branch) => branch.remote && matches(`${branch.remote}/${branch.name}`)), [refs, needle]);
  const current = refs?.branches.find((branch) => !branch.remote && branch.current) ?? null;
  const tags = (refs?.tags ?? []).filter((tag) => matches(tag.name));
  const stashes = (refs?.stashes ?? []).filter((stash) => matches(stash.message));
  const worktrees = (refs?.worktrees ?? []).filter((worktree) => matches(`${worktree.branch ?? ""} ${worktree.path}`));
  const subNodes = subTree?.nodes ?? [];
  const rootFork = forks.find((entry) => entry.path === "") ?? null;
  const forkByPath = new Map(forks.map((entry) => [entry.path, entry]));
  const subVisible = useMemo(() => {
    const byPath = new Map(subNodes.map((node) => [node.path, node]));
    if (needle) {
      const keep = new Set<string>();
      for (const node of subNodes) if (matches(node.path)) for (let cursor: string | null = node.path; cursor; cursor = byPath.get(cursor)?.parent ?? null) keep.add(cursor);
      return subNodes.filter((node) => keep.has(node.path));
    }
    const shown = (node: (typeof subNodes)[number]): boolean => !node.parent || (openSubs.has(node.parent) && shown(byPath.get(node.parent)!));
    return subNodes.filter(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subNodes, openSubs, needle]);
  const fullName = (branch: BranchRef) => (branch.remote ? `${branch.remote}/${branch.name}` : branch.name);

  // ------------------------------------------------------------------ actions
  const checkout = (branch: BranchRef) => run(`Checkout ${fullName(branch)}`, () => (branch.remote ? api.checkoutRemoteBranch(repositoryPath, fullName(branch)) : api.switchBranch(repositoryPath, branch.name)));
  const createBranchAt = async (revision: string, label: string) => {
    const name = await askText(`Create branch at ${label}`, "Branch name", "");
    if (name?.trim()) await run(`Create branch ${name.trim()}`, () => api.createBranchAt(repositoryPath, name.trim(), revision));
  };
  const createTagAt = async (revision: string, label: string) => {
    const values = await askFields(`Create tag at ${label}`, [{ name: "name", label: "Tag name" }, { name: "message", label: "Message (optional — makes an annotated tag)", multiline: true }]);
    if (values?.name.trim()) await run(`Tag ${values.name.trim()}`, () => api.createTag(repositoryPath, values.name.trim(), revision, values.message));
  };
  const resetCurrent = async (revision: string, label: string, mode: "soft" | "mixed" | "hard") => {
    if (mode === "hard" && !(await askConfirm("Hard reset", `Reset ${current?.name ?? "HEAD"} to ${label}? Uncommitted changes will be discarded.`, { confirm: "Reset hard", danger: true }))) return;
    await run(`Reset ${mode} to ${label}`, () => api.resetTo(repositoryPath, revision, mode));
  };

  const resetSubmenu = (revision: string, label: string): MenuItem => ({
    id: "reset", label: `Reset ${current?.name ?? "HEAD"} to this commit`, icon: "history", disabled: busy,
    submenu: [
      { id: "soft", label: "Soft — keep all changes staged", onSelect: () => resetCurrent(revision, label, "soft") },
      { id: "mixed", label: "Mixed — keep working copy, reset index", onSelect: () => resetCurrent(revision, label, "mixed") },
      { id: "hard", label: "Hard — discard all changes", danger: true, onSelect: () => resetCurrent(revision, label, "hard") },
    ],
  });

  /** Run merge/rebase/cherry-pick only after a local `git merge-tree`
   *  dry run; conflicts are listed before anything touches the work tree. */
  const predicted = async (mode: "merge" | "rebase", source: string, target: string | null, label: string, action: () => Promise<unknown>) => {
    try {
      const prediction = await api.predictConflicts(repositoryPath, mode, source, target);
      if (prediction.supported && !prediction.clean) {
        const ok = await askConfirm(`${label}: conflicts expected`, (
          <div className="gk-hook-failure">
            <p>{prediction.message} Chrono simulated the {mode} with git merge-tree; nothing has changed yet.</p>
            <pre>{prediction.files.join("\n")}</pre>
          </div>
        ), { confirm: `${mode === "rebase" ? "Rebase" : "Merge"} anyway`, danger: true });
        if (!ok) return;
      }
    } catch { /* prediction is advisory */ }
    await run(label, action);
  };

  const flowType = (name: string): FlowType | null => {
    if (!flow?.initialized) return null;
    for (const type of ["feature", "release", "hotfix"] as FlowType[]) if (name.startsWith(flow[type])) return type;
    return null;
  };

  const startFlow = async (type: FlowType) => {
    if (!flow?.initialized) { onOpenSettings?.("gitflow"); return; }
    const name = await askText(`Start ${type}`, `${type === "feature" ? "Feature" : type === "release" ? "Version" : "Hotfix version"} name (branch ${flow[type]}<name>)`);
    if (name?.trim()) await run(`Start ${type} ${name.trim()}`, () => api.gitflowStart(repositoryPath, type, name.trim()));
  };

  const finishFlow = async (branch: BranchRef, type: FlowType) => {
    const tagged = type !== "feature";
    const values = tagged ? await askFields(`Finish ${branch.name}`, [{ name: "message", label: `Tag message for ${flow?.versionTag ?? ""}${branch.name.slice((flow?.[type] ?? "").length)}`, initial: `${type === "release" ? "Release" : "Hotfix"} ${branch.name.slice((flow?.[type] ?? "").length)}` }]) : { message: "" };
    if (!values) return;
    if (!tagged && !(await askConfirm(`Finish ${branch.name}`, `Merge ${branch.name} into ${flow?.develop} (--no-ff) and delete it?`, { confirm: "Finish feature" }))) return;
    await run(`Finish ${branch.name}`, () => api.gitflowFinish(repositoryPath, type, branch.name, values.message || null));
  };

  const flowMenu = (): MenuItem => ({
    id: "gitflow", label: "Git-flow", icon: "branch", submenu: flow?.initialized ? [
      { id: "f", label: "Start feature…", onSelect: () => startFlow("feature") },
      { id: "r", label: "Start release…", onSelect: () => startFlow("release") },
      { id: "h", label: "Start hotfix…", onSelect: () => startFlow("hotfix") },
      { kind: "separator", id: "s" },
      { id: "settings", label: "Git-flow settings…", icon: "settings", onSelect: () => onOpenSettings?.("gitflow") },
    ] : [{ id: "init", label: "Initialise git-flow…", onSelect: () => onOpenSettings?.("gitflow") }],
  });

  const localMenu = (branch: BranchRef): MenuItem[] => {
    const isCurrent = branch.current;
    const remoteChoices = (refs?.branches ?? []).filter((candidate) => candidate.remote);
    return [
      { id: "checkout", label: `Checkout ${branch.name}`, icon: "check", disabled: busy || isCurrent, onSelect: () => checkout(branch) },
      ...(branch.upstream ? [
        { id: "pull", label: isCurrent ? "Pull (fast-forward only)" : `Fast-forward ${branch.name} to ${branch.upstream}`, icon: "download" as IconName, disabled: busy || branch.behind === 0, onSelect: () => run(`Pull ${branch.name}`, () => api.branchAction(repositoryPath, { action: "pull_branch", branch: branch.name })) },
      ] : []),
      { id: "push", label: branch.upstream ? `Push ${branch.name}` : remotes.length ? `Push ${branch.name} and set upstream` : `Push ${branch.name} (no remote yet)`, icon: "upload", disabled: busy || !remotes.length, onSelect: () => run(`Push ${branch.name}`, () => api.branchAction(repositoryPath, { action: "push", branch: branch.name })) },
      { kind: "separator", id: "s1" },
      ...(!isCurrent && current ? [
        { id: "merge", label: `Merge ${branch.name} into ${current.name}`, disabled: busy, onSelect: () => predicted("merge", branch.name, null, `Merge ${branch.name}`, () => api.branchAction(repositoryPath, { action: "merge_into_current", branch: branch.name })) },
        { id: "rebase", label: `Rebase ${current.name} onto ${branch.name}`, disabled: busy, onSelect: () => predicted("rebase", branch.name, null, `Rebase onto ${branch.name}`, () => api.branchAction(repositoryPath, { action: "rebase_current_onto", branch: branch.name })) },
        { id: "ff", label: `Fast-forward ${current.name} to ${branch.name}`, disabled: busy, onSelect: () => run(`Fast-forward to ${branch.name}`, () => api.branchAction(repositoryPath, { action: "fast_forward", branch: current.name, target: branch.name })) },
      ] as MenuItem[] : []),
      { id: "irebase", label: "Interactive rebase…", icon: "layers", disabled: busy, onSelect: onStartRebase },
      { id: "stack", label: parents[branch.name] ? `Stack (on ${parents[branch.name]})` : "Stack", icon: "layers", submenu: [
        { id: "stack-new", label: `Create stacked branch on ${branch.name}…`, disabled: busy, onSelect: async () => { const name = await askText(`New branch stacked on ${branch.name}`, "Branch name"); if (name?.trim()) await run(`Create stacked branch ${name.trim()}`, () => api.createStackedBranch(repositoryPath, branch.name, name.trim())); } },
        ...(parents[branch.name] ? [{ id: "restack", label: `Restack onto ${parents[branch.name]}`, hint: "rebase --update-refs from the stack tip", disabled: busy, onSelect: () => predicted("rebase", parents[branch.name], branch.name, `Restack ${branch.name}`, () => api.restack(repositoryPath, branch.name)) } as MenuItem] : []),
        { kind: "separator", id: "ss" },
        { id: "parent", label: "Set parent branch", submenu: (refs?.branches ?? []).filter((candidate) => !candidate.remote && candidate.name !== branch.name).map<MenuItem>((candidate) => ({ id: `p-${candidate.name}`, label: candidate.name, checked: parents[branch.name] === candidate.name, onSelect: () => run(`Set parent of ${branch.name}`, () => api.setStackParent(repositoryPath, branch.name, candidate.name)) })) },
        ...(parents[branch.name] ? [{ id: "unparent", label: "Clear parent", onSelect: () => run(`Clear parent of ${branch.name}`, () => api.setStackParent(repositoryPath, branch.name, null)) } as MenuItem] : []),
      ] },
      ...(remotes.length ? [{ id: "pr", label: "Create pull request…", icon: "compare" as IconName, disabled: busy, onSelect: () => setPrFor({ head: branch.name, base: parents[branch.name] ?? (refs?.branches.find((candidate) => !candidate.remote && (candidate.name === "main" || candidate.name === "master"))?.name ?? "main") }) }] : []),
      ...(flowType(branch.name) ? [{ id: "flow-finish", label: `Finish ${flowType(branch.name)} ${branch.name.slice((flow?.[flowType(branch.name)!] ?? "").length)}`, icon: "check" as IconName, disabled: busy, onSelect: () => finishFlow(branch, flowType(branch.name)!) }] : []),
      { kind: "separator", id: "s2" },
      { id: "branch", label: "Create branch here", icon: "branch", disabled: busy, onSelect: () => createBranchAt(branch.target, branch.name) },
      { id: "tag", label: "Create tag here", icon: "tag", disabled: busy, onSelect: () => createTagAt(branch.target, branch.name) },
      resetSubmenu(branch.target, branch.name),
      { kind: "separator", id: "s3" },
      { id: "upstream", label: "Set upstream", icon: "cloud", disabled: busy || remoteChoices.length === 0, submenu: [
        ...remoteChoices.map<MenuItem>((remote) => ({ id: `up-${fullName(remote)}`, label: fullName(remote), checked: branch.upstream === fullName(remote), onSelect: () => run(`Set upstream ${fullName(remote)}`, () => api.branchAction(repositoryPath, { action: "set_upstream", branch: branch.name, target: fullName(remote) })) })),
        ...(branch.upstream ? [{ kind: "separator", id: "us" } as MenuItem, { id: "unset", label: "Unset upstream", onSelect: () => run("Unset upstream", () => api.branchAction(repositoryPath, { action: "unset_upstream", branch: branch.name })) }] : []),
      ] },
      { id: "rename", label: `Rename ${branch.name}…`, disabled: busy, onSelect: async () => {
        const name = await askText(`Rename ${branch.name}`, "New name", branch.name);
        if (name?.trim() && name.trim() !== branch.name) await run(`Rename ${branch.name}`, () => api.branchAction(repositoryPath, { action: "rename", branch: branch.name, newName: name.trim() }));
      } },
      { id: "delete", label: `Delete ${branch.name}`, icon: "trash", danger: true, disabled: busy || isCurrent, onSelect: async () => {
        const choice = await askChoice(`Delete ${branch.name}?`, [
          { value: "safe", label: "Delete", description: "Refuses when the branch is not fully merged." },
          { value: "force", label: "Force delete", description: "Deletes even unmerged commits (undo is available).", danger: true },
        ]);
        if (choice) await run(`Delete ${branch.name}`, () => api.deleteBranch(repositoryPath, branch.name, choice === "force"));
      } },
      { kind: "separator", id: "s4" },
      { id: "copy", label: "Copy branch name", icon: "copy", onSelect: () => copy(branch.name) },
      { id: "copysha", label: "Copy commit SHA", icon: "copy", onSelect: () => copy(branch.target) },
    ];
  };

  const remoteMenu = (branch: BranchRef): MenuItem[] => {
    const name = fullName(branch);
    return [
      { id: "checkout", label: `Checkout ${name}`, icon: "check", disabled: busy, onSelect: () => checkout(branch) },
      ...(current ? [
        { id: "merge", label: `Merge ${name} into ${current.name}`, disabled: busy, onSelect: () => predicted("merge", name, null, `Merge ${name}`, () => api.branchAction(repositoryPath, { action: "merge_into_current", branch: name })) },
        { id: "rebase", label: `Rebase ${current.name} onto ${name}`, disabled: busy, onSelect: () => predicted("rebase", name, null, `Rebase onto ${name}`, () => api.branchAction(repositoryPath, { action: "rebase_current_onto", branch: name })) },
        { id: "ff", label: `Fast-forward ${current.name} to ${name}`, disabled: busy, onSelect: () => run(`Fast-forward to ${name}`, () => api.branchAction(repositoryPath, { action: "fast_forward", branch: current.name, target: name })) },
      ] as MenuItem[] : []),
      { kind: "separator", id: "s1" },
      { id: "branch", label: "Create branch here", icon: "branch", disabled: busy, onSelect: () => createBranchAt(branch.target, name) },
      { id: "tag", label: "Create tag here", icon: "tag", disabled: busy, onSelect: () => createTagAt(branch.target, name) },
      { kind: "separator", id: "s2" },
      { id: "delete", label: `Delete ${name} from ${branch.remote}`, icon: "trash", danger: true, disabled: busy, onSelect: async () => {
        if (await askConfirm("Delete remote branch", `Delete ${branch.name} on ${branch.remote}? This affects everyone using the remote.`, { confirm: "Delete remote branch", danger: true })) {
          await run(`Delete ${name}`, () => api.branchAction(repositoryPath, { action: "delete_remote", branch: name }));
        }
      } },
      { id: "copy", label: "Copy branch name", icon: "copy", onSelect: () => copy(name) },
    ];
  };

  const remoteHeaderMenu = (remote: RemoteRecord | null): MenuItem[] => remote ? [
    { id: "fetch", label: `Fetch ${remote.name}`, icon: "download", disabled: busy, onSelect: () => run(`Fetch ${remote.name}`, () => api.remoteAction(repositoryPath, "fetch", remote.name)) },
    { id: "prune", label: `Prune ${remote.name}`, disabled: busy, onSelect: () => run(`Prune ${remote.name}`, () => api.remoteAction(repositoryPath, "prune", remote.name)) },
    { kind: "separator", id: "s" },
    { id: "url", label: "Edit URL…", disabled: busy, onSelect: async () => { const url = await askText(`Edit ${remote.name} URL`, "URL", remote.fetchUrl); if (url?.trim()) await run("Set remote URL", () => api.remoteAction(repositoryPath, "set_url", remote.name, url.trim())); } },
    { id: "rename", label: "Rename…", disabled: busy, onSelect: async () => { const name = await askText(`Rename ${remote.name}`, "New name", remote.name); if (name?.trim() && name.trim() !== remote.name) await run("Rename remote", () => api.remoteAction(repositoryPath, "rename", remote.name, name.trim())); } },
    { id: "remove", label: `Remove ${remote.name}`, icon: "trash", danger: true, disabled: busy, onSelect: async () => { if (await askConfirm("Remove remote", `Remove ${remote.name} and its remote-tracking branches?`, { confirm: "Remove", danger: true })) await run("Remove remote", () => api.remoteAction(repositoryPath, "remove", remote.name)); } },
    { id: "copy", label: "Copy URL", icon: "copy", onSelect: () => copy(remote.fetchUrl) },
  ] : [];

  const addRemote = () => setAddRemoteOpen(true);

  /** Connect to GitHub from the panel: GitHub's token page with the scopes
   *  pre-selected, then the pasted token is remembered. */
  const connectGithub = async () => {
    if (!github.gh) return;
    try {
      openUrl(await api.ghTokenPage(github.gh.host.apiBase));
      const token = await askToken(github.gh.host.host, "github", `Connect to GitHub (${github.gh.host.host})`, { remember: true, message: "GitHub opened a page for a new personal access token with the scopes Chrono needs. Generate it there and paste it here." });
      if (token) github.refreshConnection();
    } catch (reason) { pushToast(String(reason).replace(/^Error: /, ""), "error"); }
  };

  const tagMenu = (tag: TagRecord): MenuItem[] => [
    { id: "checkout", label: `Checkout ${tag.name} (detached)`, icon: "check", disabled: busy, onSelect: () => run(`Checkout ${tag.name}`, () => api.workflow(repositoryPath, { operation: "checkout_tag", args: [tag.name] })) },
    { id: "branch", label: "Create branch here", icon: "branch", disabled: busy, onSelect: () => createBranchAt(tag.target, tag.name) },
    { kind: "separator", id: "s" },
    { id: "push", label: `Push ${tag.name} to ${remotes[0]?.name ?? "origin"}`, icon: "upload", disabled: busy || !remotes.length, onSelect: () => run(`Push tag ${tag.name}`, () => api.tagAction(repositoryPath, "push", tag.name, remotes[0]?.name ?? null)) },
    { id: "delete", label: `Delete ${tag.name} locally`, icon: "trash", danger: true, disabled: busy, onSelect: async () => { if (await askConfirm("Delete tag", `Delete local tag ${tag.name}?`, { confirm: "Delete", danger: true })) await run(`Delete tag ${tag.name}`, () => api.deleteTag(repositoryPath, tag.name)); } },
    { id: "delete-remote", label: `Delete ${tag.name} from ${remotes[0]?.name ?? "origin"}`, danger: true, disabled: busy || !remotes.length, onSelect: async () => { if (await askConfirm("Delete remote tag", `Delete tag ${tag.name} on ${remotes[0]?.name}?`, { confirm: "Delete", danger: true })) await run(`Delete remote tag ${tag.name}`, () => api.tagAction(repositoryPath, "delete_remote", tag.name, remotes[0]?.name ?? null)); } },
    { id: "copy", label: "Copy tag name", icon: "copy", onSelect: () => copy(tag.name) },
  ];

  // --------------------------------------------------------- drag and drop
  const onDragStart = (event: ReactDragEvent, branch: BranchRef) => {
    event.dataTransfer.setData("application/x-chrono-branch", fullName(branch));
    event.dataTransfer.effectAllowed = "move";
  };
  const onDrop = async (event: ReactDragEvent, target: BranchRef) => {
    event.preventDefault();
    setDragOver(null);
    const source = event.dataTransfer.getData("application/x-chrono-branch");
    if (!source || source === fullName(target)) return;
    // A pull request merges a pushed branch: name the head without its remote.
    const sourceRef = refs?.branches.find((branch) => fullName(branch) === source);
    const prHead = sourceRef?.remote ? sourceRef.name : source;
    const prChoice = remotes.length ? [{ value: "pr", label: `Start a pull request from ${prHead} to ${target.name}…`, description: "Opens the pull request form; push the branch first if it is not on the remote yet." }] : [];
    if (target.remote) {
      if (!prChoice.length) return;
      const choice = await askChoice(`Drop ${source} onto ${fullName(target)}`, prChoice);
      if (choice === "pr") setPrFor({ head: prHead, base: target.name });
      return;
    }
    const choices: Array<{ value: string; label: string; danger?: boolean; description?: string }> = target.current
      ? [
          { value: "merge", label: `Merge ${source} into ${target.name}` },
          { value: "rebase", label: `Rebase ${target.name} onto ${source}` },
          { value: "ff", label: `Fast-forward ${target.name} to ${source}` },
        ]
      : [
          { value: "checkout-merge", label: `Checkout ${target.name} and merge ${source}` },
          { value: "ff", label: `Fast-forward ${target.name} to ${source}` },
          { value: "reset", label: `Reset ${target.name} to ${source}`, danger: true, description: "Moves the branch pointer (undo is available)." },
        ];
    choices.push(...prChoice);
    let note: string | undefined;
    try {
      const prediction = await api.predictConflicts(repositoryPath, "merge", source, target.name);
      if (prediction.supported) note = prediction.clean ? "✓ No conflicts expected (merge-tree dry run)." : `⚠ ${plural(prediction.files.length, "file")} would conflict: ${prediction.files.slice(0, 6).join(", ")}${prediction.files.length > 6 ? "…" : ""}`;
    } catch { note = undefined; }
    const choice = await askChoice(`Drop ${source} onto ${target.name}`, choices, note);
    if (choice === "merge") await run(`Merge ${source}`, () => api.branchAction(repositoryPath, { action: "merge_into_current", branch: source }));
    else if (choice === "rebase") await run(`Rebase onto ${source}`, () => api.branchAction(repositoryPath, { action: "rebase_current_onto", branch: source }));
    else if (choice === "ff") await run(`Fast-forward ${target.name}`, () => api.branchAction(repositoryPath, { action: "fast_forward", branch: target.name, target: source }));
    else if (choice === "checkout-merge") await run(`Merge ${source} into ${target.name}`, () => api.branchAction(repositoryPath, { action: "checkout_and_merge", branch: source, target: target.name }));
    else if (choice === "reset") await run(`Reset ${target.name}`, () => api.branchAction(repositoryPath, { action: "force_to_commit", branch: target.name, target: source }));
    else if (choice === "pr") setPrFor({ head: prHead, base: target.name });
  };

  // ------------------------------------------------------------- rendering
  const branchRow = (branch: BranchRef, label: string, depth: number) => {
    const key = fullName(branch);
    return (
      <div
        key={key}
        className={`gk-ref-row${branch.current ? " is-current" : ""}${dragOver === key ? " is-drop" : ""}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        role="treeitem"
        tabIndex={0}
        draggable
        onDragStart={(event) => onDragStart(event, branch)}
        onDragOver={(event) => { if (!branch.remote || remotes.length) { event.preventDefault(); setDragOver(key); } }}
        onDragLeave={() => setDragOver((value) => (value === key ? null : value))}
        onDrop={(event) => void onDrop(event, branch)}
        onClick={() => onSelectRevision(branch.target)}
        onDoubleClick={() => { if (!branch.current) void checkout(branch); }}
        onKeyDown={(event) => { if (event.key === "Enter") onSelectRevision(branch.target); }}
        onContextMenu={(event) => menu.open(event, branch.remote ? remoteMenu(branch) : localMenu(branch), key)}
        title={`${key} → ${branch.target.slice(0, 8)}${branch.upstream ? ` · tracking ${branch.upstream}` : ""}\nClick: show in graph · Double-click: checkout · Drag onto a branch: merge/rebase`}
      >
        {branch.current ? <Icon name="check" className="gk-ref-check" /> : <Icon name={branch.remote ? "cloud" : "branch"} />}
        <span className="gk-ref-name">{label}</span>
        {!branch.remote && parents[branch.name] && <span className="gk-ref-parent" title={`Stacked on ${parents[branch.name]}`}>↳ {parents[branch.name]}</span>}
        {!branch.remote && github.issueOf(branch.name) !== null && <button type="button" className="gk-issue-badge" title={`Branch for issue #${github.issueOf(branch.name)}: click to open it`} onClick={(event) => { event.stopPropagation(); github.openIssue(github.issueOf(branch.name)!); }}>#{github.issueOf(branch.name)}</button>}
        {(branch.ahead > 0 || branch.behind > 0) && (
          <span className="gk-ref-track">{branch.behind > 0 && <span>↓{branch.behind}</span>}{branch.ahead > 0 && <span>↑{branch.ahead}</span>}</span>
        )}
      </div>
    );
  };

  const renderTree = (node: TreeNode, depth: number, scope: string): ReactNode[] => {
    const rows: ReactNode[] = [];
    const children = [...node.children.values()].sort((a, b) => (a.children.size && !a.branch ? 0 : 1) - (b.children.size && !b.branch ? 0 : 1) || a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.children.size > 0) {
        const folderKey = `${scope}:${child.full}`;
        const open = needle !== "" || !closedFolders.has(folderKey);
        rows.push(
          <button key={folderKey} type="button" className="gk-ref-folder" style={{ paddingLeft: 10 + depth * 12 }} onClick={() => setClosedFolders((current) => { const next = new Set(current); if (next.has(folderKey)) next.delete(folderKey); else next.add(folderKey); return next; })}>
            <Icon name={open ? "chevronDown" : "chevronRight"} /><Icon name={open ? "folderOpen" : "folder"} /><span>{child.name}</span>
          </button>,
        );
        if (child.branch) rows.push(branchRow(child.branch, child.name, depth + 1));
        if (open) rows.push(...renderTree(child, depth + 1, scope));
      } else if (child.branch) {
        rows.push(branchRow(child.branch, child.name, depth));
      }
    }
    return rows;
  };

  const section = (id: SectionId, title: string, icon: IconName, count: number, body: ReactNode, extra?: { onAdd?: () => void; addTitle?: string; onContext?: (event: ReactMouseEvent) => void; always?: boolean }) => {
    const isCollapsed = collapsed.has(id);
    // Empty sections are noise: hide them unless the user is filtering.
    const alwaysShown = id === "local" || id === "remote" || extra?.always === true;
    if (!alwaysShown && !needle && (count === 0 || (id === "worktrees" && count <= 1))) return null;
    return (
      <section className={`gk-section${isCollapsed ? " is-collapsed" : ""}`} aria-label={title}>
        <header onContextMenu={extra?.onContext}>
          <button type="button" className="gk-section-toggle" onClick={() => toggleSection(id)} aria-expanded={!isCollapsed}>
            <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} />
            <Icon name={icon} />
            <span>{title}</span>
            <em>{count}</em>
          </button>
          {extra?.onAdd && <button type="button" className="gk-section-add" title={extra.addTitle} aria-label={extra.addTitle} onClick={extra.onAdd}><Icon name="plus" /></button>}
        </header>
        {!isCollapsed && <div className="gk-section-body" role="tree">{body}</div>}
      </section>
    );
  };

  const remotesByName = new Map<string, BranchRef[]>();
  for (const branch of remoteBranches) {
    const list = remotesByName.get(branch.remote!) ?? [];
    list.push(branch);
    remotesByName.set(branch.remote!, list);
  }
  for (const remote of remotes) if (!remotesByName.has(remote.name) && matches(remote.name)) remotesByName.set(remote.name, []);

  return (
    <aside className="gk-left-panel" aria-label="References">
      <div className="gk-left-filter">
        <Icon name="filter" />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter (branches, tags, stashes…)" aria-label="Filter references" />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Clear filter">✕</button>}
      </div>
      <div className="gk-left-scroll">
        {!refs && <div className="ux-empty-state compact"><i className="ux-spinner" />Loading references…</div>}
        {refs && <>
          {section("local", "LOCAL", "repository", local.length, local.length ? renderTree(buildTree(local), 0, "local") : <div className="gk-empty">No local branches</div>, {
            onAdd: async () => { const name = await askText("Create branch", "Branch name (created at HEAD and checked out)"); if (name?.trim()) await run(`Create branch ${name.trim()}`, () => api.createBranch(repositoryPath, name.trim())); },
            addTitle: "Create branch",
            onContext: (event) => menu.open(event, [
              { id: "new", label: "Create branch…", icon: "plus", onSelect: async () => { const name = await askText("Create branch", "Branch name"); if (name?.trim()) await run(`Create branch ${name.trim()}`, () => api.createBranch(repositoryPath, name.trim())); } },
              { id: "cleanup", label: "Clean up merged & stale branches…", icon: "trash", onSelect: () => setCleanupOpen(true) },
              flowMenu(),
              { id: "agent", label: "New agent session…", icon: "terminal", disabled: !onNewAgentSession, onSelect: () => onNewAgentSession?.() },
              { id: "prs", label: "Pull request triage…", icon: "compare", onSelect: onOpenPullRequests },
            ], "Local branches"),
          })}
          {section("submodules", "SUBMODULES", "submodule", subNodes.length, subVisible.map((node) => {
            const absolute = `${(subTree?.root ?? repositoryPath).replace(/[\\/]$/, "")}/${node.path}`;
            const status = submoduleStatus(node);
            const isOpen = needle !== "" || openSubs.has(node.path);
            const toggleSub = () => setOpenSubs((current) => { const next = new Set(current); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next; });
            return (
              <div key={node.path} className="gk-ref-row gk-sub-row" role="treeitem" aria-level={node.depth + 1} aria-expanded={node.children ? isOpen : undefined} tabIndex={0}
                style={{ paddingLeft: 8 + node.depth * 14 }}
                title={`${node.path} — ${status.title}`}
                onClick={() => node.children && toggleSub()}
                onDoubleClick={() => node.state !== "uninitialized" && onOpenRepository(absolute)}
                onContextMenu={(event) => menu.open(event, [
                  { id: "open", label: "Open submodule", icon: "external", disabled: node.state === "uninitialized", onSelect: () => onOpenRepository(absolute) },
                  { id: "map", label: "Show in submodule map", icon: "submodule", disabled: !onOpenSubmoduleMap, onSelect: () => onOpenSubmoduleMap?.() },
                  { id: "update", label: node.state === "uninitialized" ? "Initialize (recursive)" : "Check out the recorded commit", disabled: busy, onSelect: () => run(`Update ${node.path}`, () => api.submoduleAction(repositoryPath, "update", node.path)) },
                  { id: "copy", label: "Copy path", icon: "copy", onSelect: () => copy(node.path) },
                ], node.path)}>
                {node.children ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} className="gk-sub-twisty" /> : <span className="gk-sub-twisty" />}
                <i className={`sm-dot sm-tone-${status.tone}`} aria-hidden="true" />
                <span className="gk-ref-name">{node.name}</span>
                {status.tone !== "ok" && <span className={`gk-sub-badge sm-tone-${status.tone}`}>{status.tone === "dirty" ? `✎${node.changes + node.untracked}` : status.tone === "drift" ? "moved" : status.tone === "off" ? "off" : "!"}</span>}
                {(() => { const badge = forkBadge(forkByPath.get(node.path)); return badge ? <span className={`gk-sub-badge gk-fork-badge${badge.stale ? " is-behind" : ""}`} title={badge.title}>⑂{badge.stale ? badge.text.replace(/^fork /, "") : ""}</span> : null; })()}
                {node.children > 0 && !isOpen && node.attentionBelow > 0 && <span className="gk-sub-badge sm-tone-attention" title={`${node.attentionBelow} nested submodule(s) need attention`}>{node.attentionBelow}↓</span>}
              </div>
            );
          }), { onAdd: onOpenSubmoduleMap, addTitle: "Open submodule map" })}
          {section("remote", "REMOTE", "cloud", remoteBranches.length, (
            <>{[...remotesByName.entries()].map(([remoteName, list]) => {
              const remote = remotes.find((candidate) => candidate.name === remoteName) ?? null;
              const key = `remote:${remoteName}`;
              const open = needle !== "" || !closedFolders.has(key);
              return (
                <div key={remoteName}>
                  <button type="button" className="gk-ref-folder gk-remote-folder" onClick={() => setClosedFolders((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onContextMenu={(event) => menu.open(event, remoteHeaderMenu(remote), remoteName)} title={remote?.fetchUrl}>
                    <Icon name={open ? "chevronDown" : "chevronRight"} /><Icon name="cloud" /><span>{remoteName}</span>
                    {rootFork?.upstream?.name === remoteName && <small className="gk-fork-tag" title={`The repository this fork comes from${rootFork.behind ? `; ${rootFork.defaultBranch} is ${rootFork.behind} behind it` : ""}`}>⑂ upstream{rootFork.behind ? ` ↓${rootFork.behind}` : ""}</small>}
                    {rootFork?.kind === "fork" && rootFork.origin?.name === remoteName && <small className="gk-fork-tag" title="Your fork">⑂ your fork</small>}
                    <em>{list.length}</em>
                  </button>
                  {open && renderTree(buildTree(list), 1, key)}
                </div>
              );
            })}{remotesByName.size === 0 && <div className="gk-empty">No remotes — use + to add one</div>}</>
          ), { onAdd: addRemote, addTitle: "Add remote" })}
          {github.gh && section("prs", "PULL REQUESTS", "compare", github.pulls?.length ?? 0, !github.connected ? (
            <div className="gk-empty gk-gh-connect"><span>Connect to see and review pull requests of {github.gh.fullName}.</span><button type="button" className="ux-button compact" onClick={() => void connectGithub()}>Connect to GitHub…</button></div>
          ) : github.error ? <div className="gk-empty" title={github.error}>{github.error}</div> : !github.pulls ? <div className="gk-empty"><i className="ux-spinner" />Loading…</div> : github.pulls.length === 0 ? <div className="gk-empty">No open pull requests</div> : github.pulls.filter((pull) => matches(`#${pull.number} ${pull.title} ${pull.head} ${pull.author}`)).map((pull) => (
            <div key={pull.number} className="gk-ref-row gk-gh-row" role="treeitem" tabIndex={0}
              title={`#${pull.number} ${pull.title}\n${pull.author}: ${pull.head} → ${pull.base}${pull.draft ? " (draft)" : ""}\nClick to open`}
              onClick={() => github.openPull(pull.number)}
              onKeyDown={(event) => { if (event.key === "Enter") github.openPull(pull.number); }}
              onContextMenu={(event) => menu.open(event, [
                { id: "open", label: "Open pull request", icon: "compare", onSelect: () => github.openPull(pull.number) },
                { id: "web", label: "Open on GitHub", icon: "external", onSelect: () => openUrl(pull.htmlUrl) },
                { id: "copy", label: "Copy link", icon: "copy", onSelect: () => copy(pull.htmlUrl) },
              ], `pr-${pull.number}`)}>
              <Icon name="compare" />
              <span className="gk-ref-name">{pull.draft && <em className="gk-gh-draft">draft</em>}{pull.title}</span>
              <small className="gk-gh-meta">#{pull.number} · {ago(pull.updatedAt)}</small>
            </div>
          )), {
            always: true,
            onAdd: remotes.length ? () => setPrFor({ head: current?.name ?? "HEAD", base: parents[current?.name ?? ""] ?? (refs?.branches.find((candidate) => !candidate.remote && (candidate.name === "main" || candidate.name === "master"))?.name ?? "main") }) : undefined,
            addTitle: "Create pull request from the current branch",
            onContext: (event) => menu.open(event, [
              { id: "reload", label: "Refresh", icon: "refresh", onSelect: () => void github.reload() },
              { id: "web", label: `Pull requests on GitHub`, icon: "external", onSelect: () => openUrl(`${github.gh!.webUrl}/pulls`) },
              ...(github.remotes.length > 1 ? [{ kind: "separator", id: "s" } as MenuItem, ...github.remotes.map<MenuItem>((entry) => ({ id: `r-${entry.remote}`, label: `${entry.remote}: ${entry.fullName}`, checked: entry.remote === github.gh!.remote, onSelect: () => github.chooseRemote(entry.remote) }))] : []),
            ], "Pull requests"),
          })}
          {github.gh && section("issues", "ISSUES", "flag", github.issues?.total ?? 0, !github.connected ? (
            <div className="gk-empty gk-gh-connect"><span>Connect to see the issues of {github.gh.fullName}.</span><button type="button" className="ux-button compact" onClick={() => void connectGithub()}>Connect to GitHub…</button></div>
          ) : <>
            <button type="button" className="gk-gh-filter" title="Filter with GitHub's search syntax (click to change)" onClick={async () => { const value = await askText("Filter issues", "GitHub search, e.g. is:open label:bug assignee:@me", github.query); if (value !== null) github.setQuery(value); }}><Icon name="filter" /><span>{github.query}</span></button>
            {github.error ? <div className="gk-empty" title={github.error}>{github.error}</div> : !github.issues ? <div className="gk-empty"><i className="ux-spinner" />Loading…</div> : github.issues.items.length === 0 ? <div className="gk-empty">No issues match</div> : github.issues.items.filter((issue) => matches(`#${issue.number} ${issue.title} ${issue.author}`)).map((issue) => (
              <div key={issue.number} className={`gk-ref-row gk-gh-row${issue.state === "closed" ? " is-closed" : ""}`} role="treeitem" tabIndex={0}
                title={`#${issue.number} ${issue.title}\n${issue.author} · ${issue.comments} comment(s)${issue.labels.length ? ` · ${issue.labels.map((label) => label.name).join(", ")}` : ""}\nClick to open`}
                onClick={() => github.openIssue(issue.number)}
                onKeyDown={(event) => { if (event.key === "Enter") github.openIssue(issue.number); }}
                onContextMenu={(event) => menu.open(event, [
                  { id: "open", label: "Open issue", icon: "flag", onSelect: () => github.openIssue(issue.number) },
                  { id: "branch", label: "Create a branch for this issue…", icon: "branch", disabled: busy, onSelect: () => void createIssueBranch(repositoryPath, issue, run) },
                  { id: "web", label: "Open on GitHub", icon: "external", onSelect: () => openUrl(issue.htmlUrl) },
                  { id: "copy", label: "Copy link", icon: "copy", onSelect: () => copy(issue.htmlUrl) },
                ], `issue-${issue.number}`)}>
                <Icon name="flag" />
                <span className="gk-ref-name">{issue.title}</span>
                {issue.labels.slice(0, 2).map((label) => <LabelChip key={label.name} label={label} />)}
                <small className="gk-gh-meta">#{issue.number}</small>
              </div>
            ))}
            {github.issues && github.issues.total > github.issues.items.length && <button type="button" className="gk-link-button gk-gh-more" onClick={() => openUrl(`${github.gh!.webUrl}/issues?q=${encodeURIComponent(`is:issue ${github.query}`)}`)}>{github.issues.total - github.issues.items.length} more on GitHub</button>}
          </>, {
            always: true,
            onAdd: github.connected ? github.newIssue : undefined,
            addTitle: "New issue",
            onContext: (event) => menu.open(event, [
              ...ISSUE_FILTERS.map<MenuItem>(([labelText, value]) => ({ id: `f-${value}`, label: labelText, checked: github.query === value, onSelect: () => github.setQuery(value) })),
              { id: "custom", label: "Custom filter…", icon: "filter", onSelect: async () => { const value = await askText("Filter issues", "GitHub search, e.g. is:open label:bug assignee:@me", github.query); if (value !== null) github.setQuery(value); } },
              { kind: "separator", id: "s" },
              { id: "new", label: "New issue…", icon: "plus", disabled: !github.connected, onSelect: github.newIssue },
              { id: "reload", label: "Refresh", icon: "refresh", onSelect: () => void github.reload() },
              { id: "web", label: "Issues on GitHub", icon: "external", onSelect: () => openUrl(`${github.gh!.webUrl}/issues`) },
            ], "Issues"),
          })}
          {section("worktrees", "WORKTREES", "worktree", worktrees.length, worktrees.map((worktree) => (
            <div key={worktree.path} className={`gk-ref-row${worktree.isMain ? " is-current" : ""}`} role="treeitem" tabIndex={0} title={worktree.path}
              onDoubleClick={() => onOpenRepository(worktree.path)}
              onContextMenu={(event) => menu.open(event, [
                { id: "open", label: "Open worktree", icon: "external", onSelect: () => onOpenRepository(worktree.path) },
                { id: "show", label: "Show HEAD in graph", onSelect: () => onSelectRevision(worktree.head) },
                { id: "copy", label: "Copy path", icon: "copy", onSelect: () => copy(worktree.path) },
                { kind: "separator", id: "s" },
                { id: "remove", label: "Remove worktree", icon: "trash", danger: true, disabled: worktree.isMain || busy, onSelect: async () => { if (await askConfirm("Remove worktree", `Remove the worktree at ${worktree.path}?`, { confirm: "Remove", danger: true })) await run("Remove worktree", () => api.workflow(repositoryPath, { operation: "worktree_remove", args: [worktree.path] })); } },
              ], worktree.path)}
              onClick={() => onSelectRevision(worktree.head)}>
              <Icon name="worktree" />
              <span className="gk-ref-name">{worktree.branch ?? worktree.head.slice(0, 8)}{worktree.isMain ? " (main)" : ""}</span>
              {(worktree.dirtyCount > 0 || worktree.conflictCount > 0) && <span className="gk-ref-track"><span className={worktree.conflictCount ? "is-conflict" : ""}>{worktree.conflictCount ? `${worktree.conflictCount}!` : `✎${worktree.dirtyCount}`}</span></span>}
            </div>
          )), { onAdd: async () => {
            const values = await askFields("Add worktree", [{ name: "location", label: "Folder (absolute path)" }, { name: "commit", label: "Branch or commit", initial: current?.name ?? "HEAD" }]);
            if (values?.location.trim()) await run("Add worktree", () => api.workflow(repositoryPath, { operation: "worktree_add", args: [values.location.trim(), values.commit.trim() || "HEAD"] }));
          }, addTitle: "Add worktree", onContext: (event) => menu.open(event, [{ id: "agent", label: "New agent session…", icon: "terminal", disabled: !onNewAgentSession, onSelect: () => onNewAgentSession?.() }], "Worktrees") })}
          {section("stashes", "STASHES", "stash", stashes.length, stashes.map((stash) => (
            <div key={stash.ref}>
              <div className={`gk-ref-row${openStash === stash.ref ? " is-open" : ""}`} role="treeitem" tabIndex={0} title={`${stash.ref}: ${stash.message}`}
                onClick={() => { setOpenStash(openStash === stash.ref ? null : stash.ref); onSelectRevision(stash.target); }}
                onDoubleClick={() => void run(`Apply ${stash.ref}`, () => api.workflow(repositoryPath, { operation: "stash_apply", args: [stash.ref] }))}
                onContextMenu={(event) => menu.open(event, [
                  { id: "apply", label: "Apply stash", disabled: busy, onSelect: () => run(`Apply ${stash.ref}`, () => api.workflow(repositoryPath, { operation: "stash_apply", args: [stash.ref] })) },
                  { id: "pop", label: "Pop stash", icon: "pop", disabled: busy, onSelect: () => run(`Pop ${stash.ref}`, () => api.workflow(repositoryPath, { operation: "stash_pop", args: [stash.ref] })) },
                  { id: "branch", label: "Create branch from stash commit", icon: "branch", disabled: busy, onSelect: () => createBranchAt(stash.target, stash.ref) },
                  { kind: "separator", id: "s" },
                  { id: "drop", label: "Delete stash", icon: "trash", danger: true, disabled: busy, onSelect: async () => { if (await askConfirm("Delete stash", `Drop ${stash.ref} (“${stash.message}”)? This cannot be undone from Chrono.`, { confirm: "Delete", danger: true })) await run(`Drop ${stash.ref}`, () => api.workflow(repositoryPath, { operation: "stash_drop", args: [stash.ref] })); } },
                ], stash.ref)}>
                <Icon name="stash" />
                <span className="gk-ref-name">{stash.message}</span>
              </div>
              {openStash === stash.ref && (
                <div className="gk-stash-files">
                  {!stashFiles ? <small>Loading…</small> : stashFiles.length === 0 ? <small>No files</small> : stashFiles.map((file) => (
                    <div key={file.path} className="gk-stash-file" title={file.path}>
                      <span className={`gk-status-dot is-${file.untracked ? "untracked" : "modified"}`} />
                      <span>{file.path}</span>
                      {file.additions !== null && <small><b>+{file.additions}</b> <i>−{file.deletions}</i></small>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )))}
          {section("tags", "TAGS", "tag", tags.length, tags.map((tag) => (
            <div key={tag.name} className="gk-ref-row" role="treeitem" tabIndex={0} title={`${tag.name}${tag.message ? ` — ${tag.message}` : ""}`}
              onClick={() => onSelectRevision(tag.target)}
              onContextMenu={(event) => menu.open(event, tagMenu(tag), tag.name)}>
              <Icon name="tag" />
              <span className="gk-ref-name">{tag.name}</span>
            </div>
          )), { onAdd: () => createTagAt("HEAD", "HEAD"), addTitle: "Create tag at HEAD" })}
        </>}
      </div>
      {menu.element}
      {prFor && <PullRequestDialog repositoryPath={repositoryPath} head={prFor.head} defaultBase={prFor.base} remotes={remotes.map((remote) => remote.name)} onClose={() => setPrFor(null)} run={run} />}
      {github.dialogs}
      {addRemoteOpen && <AddRemoteDialog repositoryPath={repositoryPath} remotes={remotes} run={run} onClose={() => setAddRemoteOpen(false)} onOpenSettings={onOpenSettings ? () => { setAddRemoteOpen(false); onOpenSettings("hosting"); } : undefined} />}
      {cleanupOpen && <CleanupDialog repositoryPath={repositoryPath} onClose={() => setCleanupOpen(false)} run={run} />}
    </aside>
  );
}
