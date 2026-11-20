import type { MouseEvent as ReactMouseEvent } from "react";
import type { BranchRecord, PullMode, PushOptions, RepositorySummary, UndoState } from "../../types";
import { Icon, type IconName } from "../Icon";
import { useContextMenu, type MenuItem } from "../ContextMenu";

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
  onBranch: () => void;
  onStash: () => void;
  onPop: () => void;
  onTerminal: () => void;
  onExplorer: () => void;
  onSearch: () => void;
  onSwitchBranch: (branch: BranchRecord) => void;
  onOpenRepository: () => void;
  onFetchAll?: () => void;
};

const PULL_LABEL: Record<PullMode, string> = {
  fetch: "Fetch All",
  ff: "Pull (fast-forward if possible)",
  "ff-only": "Pull (fast-forward only)",
  rebase: "Pull (rebase)",
};

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
    items.push({ kind: "separator", id: "s" }, { id: "default-note", label: "The checked option becomes the default for the Pull button", disabled: true });
    menu.open(anchor(event), items);
  };

  const pushMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    menu.open(anchor(event), [
      { id: "push", label: "Push", icon: "upload", onSelect: () => props.onPush({}) },
      { id: "push-up", label: "Push and set upstream…", onSelect: () => props.onPush({ setUpstream: true }) },
      { id: "push-tags", label: "Push with tags", icon: "tag", onSelect: () => props.onPush({ tags: true }) },
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

  return (
    <header className="gk-toolbar" role="toolbar" aria-label="Repository toolbar">
      <div className="gk-toolbar-pickers">
        <button type="button" className="gk-picker" onClick={props.onOpenRepository} title={summary?.path ?? "Open a repository"}>
          <small>repository</small>
          <strong><Icon name="repository" />{summary?.name ?? "Open repository"}</strong>
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
      </div>

      <div className="gk-toolbar-actions">
        <ToolButton icon="undo" label="Undo" disabled={disabled || !undo?.canUndo} title={undo?.undoLabel ? `Undo ${undo.undoLabel} (Ctrl+Z)` : "Nothing to undo"} onClick={props.onUndo} />
        <ToolButton icon="redo" label="Redo" disabled={disabled || !undo?.canRedo} title={undo?.redoLabel ? `Redo ${undo.redoLabel} (Ctrl+Y)` : "Nothing to redo"} onClick={props.onRedo} />
        <span className="gk-toolbar-gap" />
        <ToolButton icon="download" label={props.pullMode === "fetch" ? "Fetch" : "Pull"} badge={summary?.behind || undefined} disabled={disabled || (operationActive && props.pullMode !== "fetch")} title={PULL_LABEL[props.pullMode]} onClick={() => props.onPull(props.pullMode)} caret onCaret={pullMenu} />
        <ToolButton icon="upload" label="Push" badge={summary?.ahead || undefined} disabled={disabled || operationActive} onClick={() => props.onPush({})} caret onCaret={pushMenu} />
        <span className="gk-toolbar-gap" />
        <ToolButton icon="branch" label="Branch" disabled={disabled} onClick={props.onBranch} title="Create a branch at HEAD and check it out" />
        <ToolButton icon="stash" label="Stash" disabled={disabled || props.dirtyCount === 0} onClick={props.onStash} title={props.dirtyCount ? `Stash ${props.dirtyCount} changed file(s)` : "No changes to stash"} />
        <ToolButton icon="pop" label="Pop" disabled={disabled || props.stashCount === 0} badge={props.stashCount || undefined} onClick={props.onPop} title={props.stashCount ? "Pop the latest stash" : "No stashes"} />
      </div>

      <div className="gk-toolbar-actions gk-toolbar-right">
        <ToolButton icon="folder" label="Explorer" disabled={!path} onClick={props.onExplorer} title="TortoiseGit-style working copy explorer" />
        <ToolButton icon="terminal" label="Terminal" active={props.terminalOpen} disabled={!path} onClick={props.onTerminal} title="Toggle terminal (Ctrl+T)" />
        <ToolButton icon="search" label="Search" onClick={props.onSearch} title="Fuzzy finder (Ctrl+P)" />
      </div>
      {menu.element}
    </header>
  );
}
