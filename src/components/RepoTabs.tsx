// v6 multi-repository tabs — GitKraken RE §Tabs namespace (open/close/select/reopen).
export interface RepoTab { id: string; path: string; name: string; }

interface Props {
  tabs: RepoTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function RepoTabs({ tabs, activeId, onSelect, onClose, onNew }: Props) {
  if (!tabs.length) return null;
  return (
    <div className="ux-repo-tabs" role="tablist" aria-label="Open repositories">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeId}
          className={`ux-repo-tab ${tab.id === activeId ? "is-active" : ""}`}
          title={tab.path}
          onClick={() => onSelect(tab.id)}
        >
          <span>{tab.name}</span>
          <i aria-hidden="true" title="Close tab" onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}>×</i>
        </button>
      ))}
      <button type="button" className="ux-repo-tab-new" title="Open another repository in a new tab" onClick={onNew}>+</button>
    </div>
  );
}
