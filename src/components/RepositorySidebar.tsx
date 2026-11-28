import { useEffect, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import type { RepositorySummary, Workspace } from "../types";
import { useContextMenu } from "./ContextMenu";
import { Icon, type IconName } from "./Icon";

export type RepositoryView =
  | "conflicts"
  | "changes"
  | "history"
  | "explorer"
  | "settings"
  | "branches"
  | "refs"
  | "rebase"
  | "insights"
  | "repo"
  | "worktrees"
  | "submodules"
  | "lfs"
  | "ci"
  | "forks"
  | "landscape"
  | "stashes"
  | "recovery"
  | "cherry";

type Props = {
  workspaces: Workspace[];
  activePath: string;
  activeView: RepositoryView;
  summary: RepositorySummary | null;
  changeCount: number;
  conflictCount: number;
  collapsed: boolean;
  onSelect: (path: string) => void;
  onView: (view: RepositoryView) => void;
  onOpen: () => void;
  onClone: () => void;
  onToggleCollapsed: () => void;
  /** Take a repository off the list (nothing on disk changes). */
  onRemove?: (workspaceId: string, path: string) => void;
  /** Move `path` so it lands before the entry now at `index` (length = end). */
  onMove?: (workspaceId: string, path: string, index: number) => void;
  /** Empty the list (nothing on disk changes). */
  onClear?: (workspaceId: string) => void;
};

type NavItem = {
  id: RepositoryView;
  label: string;
  icon: IconName;
  badge?: number;
  critical?: boolean;
  /** starts a new visual group (a thin divider in the rail) */
  group?: boolean;
};

export function RepositorySidebar({
  workspaces,
  activePath,
  activeView,
  summary,
  changeCount,
  conflictCount,
  collapsed,
  onSelect,
  onView,
  onOpen,
  onClone,
  onToggleCollapsed,
  onRemove,
  onMove,
  onClear,
}: Props) {
  const menu = useContextMenu();
  const [drag, setDrag] = useState<{ workspace: string; path: string } | null>(null);
  const [drop, setDrop] = useState<{ workspace: string; index: number } | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  // The "Clear list?" confirmation gives up after a few seconds.
  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(null), 6000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const endDrag = () => { setDrag(null); setDrop(null); };
  const overRow = (event: DragEvent<HTMLDivElement>, workspace: string, index: number) => {
    if (!drag || drag.workspace !== workspace || !onMove) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const at = event.clientY < box.top + box.height / 2 ? index : index + 1;
    if (drop?.index !== at || drop.workspace !== workspace) setDrop({ workspace, index: at });
  };
  const dropRow = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (drag && drop && drag.workspace === drop.workspace && onMove) onMove(drag.workspace, drag.path, drop.index);
    endDrag();
  };
  const rowKeys = (event: KeyboardEvent<HTMLDivElement>, workspace: Workspace, path: string, index: number) => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && onMove) {
      event.preventDefault();
      onMove(workspace.id, path, event.key === "ArrowUp" ? Math.max(0, index - 1) : Math.min(workspace.repositories.length, index + 2));
    } else if (event.key === "Delete" && onRemove) {
      event.preventDefault();
      onRemove(workspace.id, path);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(path);
    }
  };
  const rowMenu = (event: MouseEvent<HTMLDivElement>, workspace: Workspace, path: string, name: string, index: number) => {
    const last = workspace.repositories.length - 1;
    menu.open(event, [
      { id: "open", label: "Open", onSelect: () => onSelect(path) },
      { id: "copy", label: "Copy path", onSelect: () => void navigator.clipboard?.writeText(path) },
      { kind: "separator", id: "s1" },
      { id: "top", label: "Move to top", disabled: index === 0 || !onMove, onSelect: () => onMove?.(workspace.id, path, 0) },
      { id: "up", label: "Move up", shortcut: "Alt+↑", disabled: index === 0 || !onMove, onSelect: () => onMove?.(workspace.id, path, index - 1) },
      { id: "down", label: "Move down", shortcut: "Alt+↓", disabled: index === last || !onMove, onSelect: () => onMove?.(workspace.id, path, index + 2) },
      { kind: "separator", id: "s2" },
      { id: "remove", label: "Remove from list", shortcut: "Delete", disabled: !onRemove, onSelect: () => onRemove?.(workspace.id, path) },
      { id: "clear", label: "Clear list…", disabled: !onClear, onSelect: () => setConfirmClear(workspace.id) },
    ], name);
  };

  // Grouped by how often they are needed: everyday views first, then
  // reference lists, then power tools. The rail shows dividers between groups.
  const navigation: NavItem[] = [
    ...(conflictCount > 0 ? [{ id: "conflicts" as RepositoryView, label: "Conflict Center", icon: "warning" as IconName, badge: conflictCount, critical: true }] : []),
    { id: "history", label: "Graph", icon: "history" },
    { id: "changes", label: "Changes", icon: "changes", badge: changeCount },
    { id: "explorer", label: "Explorer", icon: "folder" },
    { id: "submodules", label: "Submodules", icon: "submodule" },
    { id: "lfs", label: "Git LFS", icon: "layers" },
    { id: "forks", label: "Forks & upstreams", icon: "cloud" },
    { id: "ci", label: "CI / Actions", icon: "activity" },
    { id: "landscape", label: "Landscape map", icon: "map" },
    { id: "branches", label: "Branches", icon: "branch", group: true },
    { id: "refs", label: "References", icon: "list" },
    { id: "worktrees", label: "Worktrees", icon: "worktree" },
    { id: "stashes", label: "Stashes", icon: "stash" },
    { id: "rebase", label: "Interactive rebase", icon: "layers", group: true },
    { id: "insights", label: "Git Intelligence", icon: "compare" },
    { id: "repo", label: "Repo browser", icon: "repository" },
    { id: "recovery", label: "Recovery & tools", icon: "activity" },
  ];

  return (
    <aside className={`ux-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Repository navigation">
      <div className="ux-sidebar-top">
        <button className="ux-icon-button" onClick={onToggleCollapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name={collapsed ? "chevronRight" : "chevronLeft"} />
        </button>
        {!collapsed && <span className="ux-sidebar-title">Repositories</span>}
        {!collapsed && <button className="ux-sidebar-add" onClick={onOpen}>Open</button>}
        {!collapsed && <button className="ux-sidebar-add" onClick={onClone}>Clone</button>}
      </div>

      {!collapsed && <div className="ux-repository-list" aria-label="Open repositories">
        {workspaces.map((workspace) => (
          <section key={workspace.id} className="ux-workspace-group" onDragOver={(event) => { if (drag?.workspace === workspace.id && onMove) { event.preventDefault(); if (drop?.index !== workspace.repositories.length) setDrop({ workspace: workspace.id, index: workspace.repositories.length }); } }} onDrop={dropRow}>
            <div className="ux-workspace-head">
              <h2>{workspace.name}</h2>
              {onClear && workspace.repositories.length > 0 && (
                confirmClear === workspace.id
                  ? <button type="button" className="ux-workspace-clear is-confirm" onClick={() => { setConfirmClear(null); onClear(workspace.id); }} title="Removes every entry from this list; the repositories on disk are not touched">Clear list?</button>
                  : <button type="button" className="ux-workspace-clear" onClick={() => setConfirmClear(workspace.id)} title="Remove every repository from this list (nothing on disk changes)">Clear</button>
              )}
            </div>
            {!workspace.repositories.length && <p className="ux-workspace-empty">No repositories yet. Use Open or Clone.</p>}
            {workspace.repositories.map((repository, index) => {
              const name = repository.alias || repository.path.split(/[\\/]/).pop() || repository.path;
              const active = repository.path === activePath;
              const dragging = drag?.path === repository.path && drag.workspace === workspace.id;
              const before = drop?.workspace === workspace.id && drop.index === index && drag && !dragging;
              const after = drop?.workspace === workspace.id && drop.index === workspace.repositories.length && index === workspace.repositories.length - 1 && drag && !dragging;
              return (
                <div
                  key={repository.path}
                  role="button"
                  tabIndex={0}
                  className={`ux-repository-row${active ? " is-active" : ""}${dragging ? " is-dragging" : ""}${before ? " drop-before" : ""}${after ? " drop-after" : ""}`}
                  onClick={() => onSelect(repository.path)}
                  onKeyDown={(event) => rowKeys(event, workspace, repository.path, index)}
                  onContextMenu={(event) => rowMenu(event, workspace, repository.path, name, index)}
                  onAuxClick={(event) => { if (event.button === 1 && onRemove) { event.preventDefault(); onRemove(workspace.id, repository.path); } }}
                  onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                  draggable={Boolean(onMove)}
                  onDragStart={(event) => { event.dataTransfer.setData("application/x-chrono-repo", repository.path); event.dataTransfer.effectAllowed = "move"; setDrag({ workspace: workspace.id, path: repository.path }); }}
                  onDragOver={(event) => overRow(event, workspace.id, index)}
                  onDrop={(event) => { event.stopPropagation(); dropRow(event); }}
                  onDragEnd={endDrag}
                  title={`${repository.path}\nDrag to reorder · right-click for more`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="ux-repo-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
                  <span className="ux-repository-text"><strong>{name}</strong><small>{repository.path}</small></span>
                  {onRemove && (
                    <button
                      type="button"
                      className="ux-repository-remove"
                      draggable={false}
                      title="Remove from list (nothing on disk changes)"
                      aria-label={`Remove ${name} from the list`}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); onRemove(workspace.id, repository.path); }}
                    >×</button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
        {menu.element}
      </div>}

      {!collapsed && <div className="ux-sidebar-separator" />}

      <nav className="ux-repo-navigation" aria-label="Repository views">
        {!collapsed && activePath && (
          <div className="ux-sidebar-repo-context">
            <strong>{summary?.name || "Repository"}</strong>
            <span className={summary?.dirty ? "is-dirty" : ""}>{summary?.branch || "Detached HEAD"}</span>
          </div>
        )}
        {navigation.map((item) => [
          item.group ? <div key={`${item.id}-group`} className="ux-nav-divider" role="separator" /> : null,
          <button
            key={item.id}
            className={`ux-nav-item${activeView === item.id ? " is-active" : ""}${item.critical ? " is-critical" : ""}`}
            disabled={!activePath}
            onClick={() => onView(item.id)}
            title={collapsed ? item.label : undefined}
            aria-current={activeView === item.id ? "page" : undefined}
          >
            <Icon name={item.icon} />
            {!collapsed && <span>{item.label}</span>}
            {!collapsed && Boolean(item.badge) && <span className="ux-nav-badge">{item.badge}</span>}
            {collapsed && Boolean(item.badge) && <i className="ux-nav-dot" aria-label={`${item.badge}`} />}
          </button>,
        ])}
      </nav>

      <div className="ux-sidebar-bottom">
        <button className={`ux-nav-item${activeView === "settings" ? " is-active" : ""}`} disabled={!activePath} onClick={() => onView("settings")} title={collapsed ? "Repository settings" : undefined}>
          <Icon name="settings" />
          {!collapsed && <span>Repository settings</span>}
        </button>
      </div>
    </aside>
  );
}
