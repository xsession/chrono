import type { RepositorySummary, Workspace } from "../types";
import { Icon, type IconName } from "./Icon";

export type RepositoryView =
  | "conflicts"
  | "changes"
  | "history"
  | "branches"
  | "rebase"
  | "insights"
  | "repo"
  | "worktrees"
  | "submodules"
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
};

type NavItem = {
  id: RepositoryView;
  label: string;
  icon: IconName;
  badge?: number;
  critical?: boolean;
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
  onToggleCollapsed
}: Props) {
  const navigation: NavItem[] = [
    ...(conflictCount > 0 ? [{ id: "conflicts" as RepositoryView, label: "Conflict Center", icon: "warning" as IconName, badge: conflictCount, critical: true }] : []),
    { id: "changes", label: "Changes", icon: "changes", badge: changeCount },
    { id: "history", label: "History", icon: "history" },
    { id: "branches", label: "Branches", icon: "branch" },
    { id: "rebase", label: "Interactive rebase", icon: "layers" },
    { id: "insights", label: "Git Intelligence", icon: "compare" },
    { id: "repo", label: "Repo browser", icon: "repository" },
    { id: "worktrees", label: "Worktrees", icon: "worktree" },
    { id: "submodules", label: "Submodules", icon: "submodule" },
    { id: "stashes", label: "Stashes", icon: "stash" },
    { id: "recovery", label: "Recovery & tools", icon: "activity" }
  ];

  return (
    <aside className={`ux-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Repository navigation">
      <div className="ux-sidebar-top">
        <button className="ux-icon-button" onClick={onToggleCollapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name={collapsed ? "chevronRight" : "chevronLeft"} />
        </button>
        {!collapsed && <span className="ux-sidebar-title">Repositories</span>}
        {!collapsed && <button className="ux-sidebar-add" onClick={onOpen}>Open</button>}
      </div>

      <div className="ux-repository-list" aria-label="Open repositories">
        {workspaces.map((workspace) => (
          <section key={workspace.id} className="ux-workspace-group">
            {!collapsed && <h2>{workspace.name}</h2>}
            {workspace.repositories.map((repository) => {
              const name = repository.alias || repository.path.split(/[\\/]/).pop() || repository.path;
              const active = repository.path === activePath;
              return (
                <button
                  key={repository.path}
                  className={`ux-repository-row${active ? " is-active" : ""}`}
                  onClick={() => onSelect(repository.path)}
                  title={repository.path}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="ux-repo-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
                  {!collapsed && <span className="ux-repository-text"><strong>{name}</strong><small>{repository.path}</small></span>}
                </button>
              );
            })}
          </section>
        ))}
      </div>

      <div className="ux-sidebar-separator" />

      <nav className="ux-repo-navigation" aria-label="Repository views">
        {!collapsed && activePath && (
          <div className="ux-sidebar-repo-context">
            <strong>{summary?.name || "Repository"}</strong>
            <span className={summary?.dirty ? "is-dirty" : ""}>{summary?.branch || "Detached HEAD"}</span>
          </div>
        )}
        {navigation.map((item) => (
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
          </button>
        ))}
      </nav>

      <div className="ux-sidebar-bottom">
        <button className="ux-nav-item" onClick={onClone} title={collapsed ? "Clone repository" : undefined}>
          <Icon name="download" />
          {!collapsed && <span>Clone repository</span>}
        </button>
        <button className="ux-nav-item" onClick={() => onView("cherry")} title={collapsed ? "UI workbench" : undefined}>
          <Icon name="settings" />
          {!collapsed && <span>UI workbench</span>}
        </button>
      </div>
    </aside>
  );
}
