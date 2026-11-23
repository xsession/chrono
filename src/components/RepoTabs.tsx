import { useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { useContextMenu } from "./ContextMenu";

// v6 multi-repository tabs — GitKraken RE §Tabs namespace (open/close/select/reopen).
// Tabs can be dragged into a new order (or moved with Ctrl+Shift+←/→) and
// closed with their × button, a middle click, Delete or the right-click menu.
export interface RepoTab { id: string; path: string; name: string; }

interface Props {
  tabs: RepoTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers?: (id: string) => void;
  /** Move tab `id` so it lands before the tab now at `index` (tabs.length = end). */
  onMove?: (id: string, index: number) => void;
  onNew: () => void;
}

const DRAG_TYPE = "application/x-chrono-tab";

export function RepoTabs({ tabs, activeId, onSelect, onClose, onCloseOthers, onMove, onNew }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const menu = useContextMenu();
  if (!tabs.length) return null;

  const endDrag = () => { setDragId(null); setDropIndex(null); };
  const dropAt = (event: DragEvent<HTMLElement>, index: number) => {
    if (!dragId || !onMove) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropIndex !== index) setDropIndex(index);
  };
  const overTab = (event: DragEvent<HTMLDivElement>, index: number) => {
    const box = event.currentTarget.getBoundingClientRect();
    dropAt(event, event.clientX < box.left + box.width / 2 ? index : index + 1);
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (dragId && dropIndex !== null && onMove) onMove(dragId, dropIndex);
    endDrag();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>, tab: RepoTab, index: number) => {
    if (event.ctrlKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight") && onMove) {
      event.preventDefault();
      onMove(tab.id, event.key === "ArrowLeft" ? Math.max(0, index - 1) : Math.min(tabs.length, index + 2));
    } else if (event.key === "Delete") {
      event.preventDefault();
      onClose(tab.id);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(tab.id);
    }
  };
  const openMenu = (event: MouseEvent<HTMLDivElement>, tab: RepoTab, index: number) => {
    menu.open(event, [
      { id: "close", label: "Close tab", shortcut: "Middle-click", onSelect: () => onClose(tab.id) },
      { id: "close-others", label: "Close other tabs", disabled: tabs.length < 2 || !onCloseOthers, onSelect: () => onCloseOthers?.(tab.id) },
      { kind: "separator", id: "s1" },
      { id: "left", label: "Move left", shortcut: "Ctrl+Shift+←", disabled: index === 0 || !onMove, onSelect: () => onMove?.(tab.id, index - 1) },
      { id: "right", label: "Move right", shortcut: "Ctrl+Shift+→", disabled: index === tabs.length - 1 || !onMove, onSelect: () => onMove?.(tab.id, index + 2) },
      { kind: "separator", id: "s2" },
      { id: "copy", label: "Copy path", onSelect: () => void navigator.clipboard?.writeText(tab.path) },
    ], tab.name);
  };

  return (
    <div className="ux-repo-tabs" role="tablist" aria-label="Open repositories" onDragOver={(event) => dropAt(event, tabs.length)} onDrop={drop}>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tab"
          tabIndex={0}
          aria-selected={tab.id === activeId}
          className={`ux-repo-tab${tab.id === activeId ? " is-active" : ""}${dragId === tab.id ? " is-dragging" : ""}${dropIndex === index && dragId ? " drop-before" : ""}${dropIndex === tabs.length && index === tabs.length - 1 && dragId ? " drop-after" : ""}`}
          title={`${tab.path}\nDrag to reorder · middle-click to close`}
          draggable={Boolean(onMove)}
          onDragStart={(event) => { event.dataTransfer.setData(DRAG_TYPE, tab.id); event.dataTransfer.effectAllowed = "move"; setDragId(tab.id); }}
          onDragOver={(event) => { event.stopPropagation(); overTab(event, index); }}
          onDrop={(event) => { event.stopPropagation(); drop(event); }}
          onDragEnd={endDrag}
          onClick={() => onSelect(tab.id)}
          onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onContextMenu={(event) => openMenu(event, tab, index)}
          onKeyDown={(event) => keys(event, tab, index)}
        >
          <span>{tab.name}</span>
          <button
            type="button"
            className="ux-repo-tab-close"
            title="Close tab"
            aria-label={`Close ${tab.name}`}
            draggable={false}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
          >×</button>
        </div>
      ))}
      <button type="button" className="ux-repo-tab-new" title="Open another repository in a new tab" onClick={onNew}>+</button>
      {menu.element}
    </div>
  );
}
