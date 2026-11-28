import type { CiBadge } from "../../ciMonitor";
import { ciIcon } from "../CiView";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { BranchRecord, PullMode, PushOptions, RepositorySummary, UndoState, Workspace } from "../../types";
import { Icon, type IconName } from "../Icon";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { plural } from "../../plural";
import type { ForkStatus } from "../../types";
import { forkBadge } from "../ForksView";

type Props = {
  path: string;
  summary: RepositorySummary | null;
  branches: BranchRecord[];
  busy: boolean;
  operationActive: boolean;
  undo: UndoState | null;
  dirtyCount: number;
  stashCount: number;
  terminalOpen: boolean;
  pullMode: PullMode;
  onPullModeChange: (mode: PullMode) => void;
  onUndo: () => void;
  onRedo: () => void;
  onPull: (mode: PullMode) => void;
  onPush: (options: PushOptions) => void;
  /** Pull and Push also go into submodules, recursively. */
  recurseSubmodules: boolean;
  onRecurseSubmodulesChange: (value: boolean) => void;
  /** Initialize and update every submodule recursively (remote: to branch tips). */
  onUpdateSubmodules: (remote: boolean) => void;
  onBranch: () => void;
  onStash: () => void;
  onPop: () => void;
  onTerminal: () => void;
  /** Remotes configured (null: not known yet). With none, Pull/Push are off. */
  remoteCount?: number | null;
  /** Fork status of this repository (forks.ts), for the fork pill. */
  fork?: ForkStatus | null;
  onForks?: () => void;
  /** Latest CI run of the current branch (ciMonitor.ts), for the CI pill. */
  ci?: CiBadge | null;
  onCi?: () => void;
  onExplorer: () => void;
  onSearch: () => void;
  onSwitchBranch: (branch: BranchRecord) => void;
  onOpenRepository: () => void;
  onFetchAll?: () => void;
  /** recent repositories for the repository picker */
  workspaces?: Workspace[];
  /** enclosing superprojects when the open repository is a submodule, outermost first */
  superprojects?: Array<{ path: string; name: string }>;
  onSelectRepository?: (path: string) => void;
  onOpenFolder?: () => void;
  onClone?: () => void;
};

const PULL_LABEL: Record<PullMode, string> = {
  fetch: "Fetch All",
  ff: "Pull (fast-forward if possible)",
  "ff-only": "Pull (fast-forward only)",
  rebase: "Pull (rebase)",
};

const NO_REMOTE = "This repository has no remote. Add one with the + next to REMOTE in the left panel.";

function ToolButton({ icon, label, onClick, disabled, title, badge, active, caret, onCaret }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; title?: string; badge?: number; active?: boolean; caret?: boolean; onCaret?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  return (
    <div className={`gk-tool${caret ? " has-caret" : ""}`}>
      <button type="button" className={`gk-tool-button${active ? " is-active" : ""}`} disabled={disabled} onClick={onClick} title={title ?? label} aria-label={label}>
        <span className="gk-tool-icon"><Icon name={icon} />{badge ? <i className="gk-tool-badge">{badge}</i> : null}</span>
        <span className="gk-tool-label">{label}</span>
      </button>
      {caret && <button type="button" className="gk-tool-caret" disabled={disabled} onClick={onCaret} aria-label={`${label} options`}><Icon name="chevronDown" /></button>}
    </div>
  );
}

/** GitKraken-style main toolbar: repository / branch pickers on the left,
 *  Undo · Redo · Pull▾ · Push▾ · Branch · Stash · Pop in the middle and
 *  Explorer · Terminal · Search on the right. */
export function GkToolbar(props: Props) {
  const { path, summary, branches, busy, operationActive, undo } = props;
  const menu = useContextMenu();
  const disabled = !path || busy;
  const noRemote = props.remoteCount === 0;
  const forkPill = forkBadge(props.fork ?? undefined);
  const current = branches.find((branch) => branch.current) ?? null;
  const anchor = (event: ReactMouseEvent<HTMLElement>) => {
    const rect = (event.currentTarget.closest(".gk-tool, .gk-picker") ?? event.currentTarget).getBoundingClientRect();
    return { clientX: rect.left, clientY: rect.bottom + 2, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() };
  };

  const pullMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = (["fetch", "ff", "ff-only", "rebase"] as PullMode[]).map((mode) => ({
      id: mode,
      label: PULL_LABEL[mode],
      checked: props.pullMode === mode,
      onSelect: () => { props.onPullModeChange(mode); props.onPull(mode); },
    }));
    items.push(
      { kind: "separator", id: "s" },
      { id: "recurse", label: "Include submodules (recursive)", icon: "submodule", checked: props.recurseSubmodules, hint: "fetch them, then check out what the superproject records", onSelect: () => props.onRecurseSubmodulesChange(!props.recurseSubmodules) },
      { id: "sub-update", label: "Initialize & update submodules (recursive)", icon: "submodule", onSelect: () => props.onUpdateSubmodules(false) },
      { id: "sub-remote", label: "Update submodules to remote branch tips", icon: "submodule", onSelect: () => props.onUpdateSubmodules(true) },
      { kind: "separator", id: "s2" },
      { id: "default-note", label: "The checked options become the default for the Pull button", disabled: true },
    );
    menu.open(anchor(event), items);
  };

  const pushMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    menu.open(anchor(event), [
      { id: "push", label: "Push", icon: "upload", onSelect: () => props.onPush({}) },
      { id: "push-up", label: "Push and set upstream…", onSelect: () => props.onPush({ setUpstream: true }) },
      { id: "push-tags", label: "Push with tags", icon: "tag", onSelect: () => props.onPush({ tags: true }) },
      { id: "push-subs", label: "Push with submodules", icon: "submodule", hint: "their referenced commits first", onSelect: () => props.onPush({ recurseSubmodules: true }) },
      { id: "recurse", label: "Always include submodules", checked: props.recurseSubmodules, onSelect: () => props.onRecurseSubmodulesChange(!props.recurseSubmodules) },
      { kind: "separator", id: "s" },
      { id: "force", label: "Force push (with lease)", danger: true, onSelect: () => props.onPush({ force: true }) },
    ]);
  };

  const branchPicker = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const locals = branches.filter((branch) => !branch.remote);
    const remotes = branches.filter((branch) => branch.remote && !branch.name.endsWith("/HEAD"));
    menu.open(anchor(event), [
      { kind: "header", id: "hl", label: "Local branches" },
      ...locals.map<MenuItem>((branch) => ({ id: `l-${branch.name}`, label: branch.name, checked: branch.current, bold: branch.current, onSelect: () => props.onSwitchBranch(branch) })),
      ...(remotes.length ? [{ kind: "separator", id: "s" } as MenuItem, { id: "remote", label: `Remote branches (${remotes.length})`, icon: "cloud" as IconName, submenu: remotes.map<MenuItem>((branch) => ({ id: `r-${branch.name}`, label: branch.name, onSelect: () => props.onSwitchBranch(branch) })) }] : []),
    ], "Switch branch");
  };

  // Deep chains (root › … › parent): keep the outermost and the direct parent visible.
  const chain = props.superprojects ?? [];
  const hidden = chain.length > 2 ? chain.slice(1, -1) : [];
  const crumbs = chain.length > 2 ? [chain[0], { path: "…", name: "…" }, chain[chain.length - 1]] : chain;

  const repositoryPicker = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const recent = (props.workspaces ?? []).flatMap((workspace) => workspace.repositories).slice(0, 15);
    menu.open(anchor(event), [
      ...(recent.length ? [{ kind: "header", id: "hr", label: "Repositories" } as MenuItem] : []),
      ...recent.map<MenuItem>((repository) => ({
        id: `r-${repository.path}`,
        label: repository.alias || repository.path.split(/[\\/]/).filter(Boolean).pop() || repository.path,
        checked: repository.path === path,
        bold: repository.path === path,
        onSelect: () => props.onSelectRepository?.(repository.path),
      })),
      ...(recent.length ? [{ kind: "separator", id: "s" } as MenuItem] : []),
      { id: "open", label: "Open repository…", icon: "folderOpen", disabled: !props.onOpenFolder, onSelect: () => props.onOpenFolder?.() },
      { id: "tab", label: "Open in new tab…", icon: "plus", onSelect: props.onOpenRepository },
      { id: "clone", label: "Clone…", icon: "download", disabled: !props.onClone, onSelect: () => props.onClone?.() },
    ], summary?.path ?? "Repository");
  };

  return (
    <header className="gk-toolbar" role="toolbar" aria-label="Repository toolbar">
      <div className="gk-toolbar-pickers">
        {crumbs.map((parent) => (
          <span key={parent.path} className="gk-crumb">
            {parent.path === "…" ? (
              <button type="button" className="gk-crumb-button" title="More parent repositories" onClick={(event) => menu.open(anchor(event), hidden.map<MenuItem>((entry) => ({ id: entry.path, label: entry.name, icon: "submodule", onSelect: () => props.onSelectRepository?.(entry.path) })), "Parent repositories")}>…</button>
            ) : (
              <button type="button" className="gk-crumb-button" onClick={() => props.onSelectRepository?.(parent.path)} title={`Go to superproject ${parent.path}`}>{parent.name}</button>
            )}
            <Icon name="chevronRight" className="gk-picker-sep" />
          </span>
        ))}
        <button type="button" className="gk-picker" onClick={repositoryPicker} title={summary?.path ?? "Open a repository"}>
          <small>repository</small>
          <strong><Icon name={props.superprojects?.length ? "submodule" : "repository"} />{summary?.name ?? "Open repository"}<Icon name="chevronDown" /></strong>
        </button>
        <Icon name="chevronRight" className="gk-picker-sep" />
        <button type="button" className="gk-picker" disabled={!path} onClick={branchPicker} title="Switch branch">
          <small>branch</small>
          <strong><Icon name="branch" />{summary?.branch ?? (path ? "detached HEAD" : "—")}<Icon name="chevronDown" /></strong>
        </button>
        {path && current?.upstream && (
          <span className="gk-sync-pill" title={`Tracking ${current.upstream}`}>
            {summary?.behind ? <span className="is-behind"><Icon name="download" />{summary.behind}</span> : null}
            {summary?.ahead ? <span className="is-ahead"><Icon name="upload" />{summary.ahead}</span> : null}
            {!summary?.ahead && !summary?.behind ? <span><Icon name="check" />in sync</span> : null}
          </span>
        )}
        {path && props.ci && (
          <button type="button" className={`gk-ci-pill is-${props.ci.run.status}`} title={`${props.ci.system}: ${props.ci.run.name}${props.ci.run.number !== null ? ` #${props.ci.run.number}` : ""} — ${props.ci.run.status}\n${props.ci.run.title}\nOpen CI`} onClick={props.onCi}>{ciIcon(props.ci.run.status)} CI</button>
        )}
        {path && forkPill && (
          <button type="button" className={`gk-fork-pill${forkPill.stale ? " is-behind" : ""}`} title={`${forkPill.title}\nOpen Forks & upstreams`} onClick={props.onForks}>⑂ {forkPill.text.replace(/^fork /, "")}</button>
        )}
      </div>

      <div className="gk-toolbar-actions">
        <ToolButton icon="undo" label="Undo" disabled={disabled || !undo?.canUndo} title={undo?.undoLabel ? `Undo ${undo.undoLabel} (Ctrl+Z)` : "Nothing to undo"} onClick={props.onUndo} />
        <ToolButton icon="redo" label="Redo" disabled={disabled || !undo?.canRedo} title={undo?.redoLabel ? `Redo ${undo.redoLabel} (Ctrl+Y)` : "Nothing to redo"} onClick={props.onRedo} />
        <span className="gk-toolbar-gap" />
        <ToolButton icon="download" label={props.pullMode === "fetch" ? "Fetch" : "Pull"} badge={summary?.behind || undefined} disabled={disabled || noRemote || (operationActive && props.pullMode !== "fetch")} title={noRemote ? NO_REMOTE : PULL_LABEL[props.pullMode]} onClick={() => props.onPull(props.pullMode)} caret onCaret={pullMenu} />
        <ToolButton icon="upload" label="Push" badge={summary?.ahead || undefined} disabled={disabled || noRemote || operationActive} title={noRemote ? NO_REMOTE : undefined} onClick={() => props.onPush({})} caret onCaret={pushMenu} />
        <span className="gk-toolbar-gap" />
        <ToolButton icon="branch" label="Branch" disabled={disabled} onClick={props.onBranch} title="Create a branch at HEAD and check it out" />
        <ToolButton icon="stash" label="Stash" disabled={disabled || props.dirtyCount === 0} onClick={props.onStash} title={props.dirtyCount ? `Stash ${plural(props.dirtyCount, "changed file")}` : "No changes to stash"} />
        <ToolButton icon="pop" label="Pop" disabled={disabled || props.stashCount === 0} badge={props.stashCount || undefined} onClick={props.onPop} title={props.stashCount ? "Pop the latest stash" : "No stashes"} />
      </div>

      <div className="gk-toolbar-actions gk-toolbar-right">
        <ToolButton icon="folder" label="Explorer" disabled={!path} onClick={props.onExplorer} title="TortoiseGit-style working copy explorer" />
        <ToolButton icon="terminal" label="Terminal" active={props.terminalOpen} disabled={!path} onClick={props.onTerminal} title="Toggle terminal (Ctrl+T)" />
        <ToolButton icon="command" label="Commands" onClick={props.onSearch} title="Command palette — every action, fuzzy search (Ctrl+Shift+P)" />
      </div>
      {menu.element}
    </header>
  );
}
