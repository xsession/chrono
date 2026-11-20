import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, type IconName } from "./Icon";

/** One entry of a (cascading) context menu. Shared by the GitKraken left
 *  panel, the WIP file list and the TortoiseGit explorer shell menu. */
export type MenuItem =
  | { kind?: "item"; id: string; label: string; icon?: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; checked?: boolean; bold?: boolean; hint?: string; onSelect?: () => void | Promise<void>; submenu?: MenuItem[] }
  | { kind: "separator"; id: string }
  | { kind: "header"; id: string; label: string };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  title?: string;
  onClose: () => void;
  ariaLabel?: string;
};

/** Fixed-position submenu anchored to its parent row, so it never gets
 *  clipped by the scrolling parent list and stays inside the viewport. */
function Submenu({ anchor, items, onClose, depth }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void; depth: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<{ left: number; top: number; visibility?: "hidden" }>({ left: 0, top: 0, visibility: "hidden" });
  useLayoutEffect(() => {
    const row = anchor.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    const width = box?.width ?? 240;
    const height = box?.height ?? 200;
    const left = row.right + width + 4 <= window.innerWidth ? row.right + 2 : Math.max(4, row.left - width - 2);
    const top = Math.max(4, Math.min(row.top - 5, window.innerHeight - height - 4));
    setStyle({ left, top });
  }, [anchor, items]);
  return (
    <div ref={ref} className="gk-submenu" style={style}>
      <MenuList items={items} onClose={onClose} depth={depth} autoFocus={false} />
    </div>
  );
}

function MenuList({ items, onClose, depth, autoFocus }: { items: MenuItem[]; onClose: () => void; depth: number; autoFocus: boolean }) {
  const [openSub, setOpenSub] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!autoFocus) return;
    const first = listRef.current?.querySelector<HTMLButtonElement>("button[role=menuitem]:not(:disabled)");
    first?.focus();
  }, [autoFocus]);

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(":scope > .gk-menu-row > button[role=menuitem]:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); buttons[(at + 1) % buttons.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); buttons[(at - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (event.key === "ArrowLeft" && depth > 0) { event.preventDefault(); event.stopPropagation(); (listRef.current?.parentElement?.querySelector("button[role=menuitem]") as HTMLButtonElement | null)?.focus(); }
  };

  return (
    <div ref={listRef} className="gk-menu-list" role="menu" onKeyDown={onKey}>
      {items.map((item) => {
        if (item.kind === "separator") return <div key={item.id} className="gk-menu-separator" role="separator" />;
        if (item.kind === "header") return <div key={item.id} className="gk-menu-header">{item.label}</div>;
        const hasSub = Boolean(item.submenu && item.submenu.length);
        return (
          <div key={item.id} className={`gk-menu-row${openSub === item.id ? " is-open" : ""}`} onMouseEnter={() => setOpenSub(hasSub ? item.id : null)} ref={(element) => { if (element) rowRefs.current.set(item.id, element); else rowRefs.current.delete(item.id); }}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? openSub === item.id : undefined}
              title={item.hint}
              className={`gk-menu-item${item.danger ? " is-danger" : ""}${item.bold ? " is-bold" : ""}`}
              disabled={item.disabled}
              onKeyDown={(event) => { if (hasSub && (event.key === "ArrowRight" || event.key === "Enter")) { event.preventDefault(); event.stopPropagation(); setOpenSub(item.id); } }}
              onClick={() => {
                if (hasSub) { setOpenSub(openSub === item.id ? null : item.id); return; }
                onClose();
                void item.onSelect?.();
              }}
            >
              <span className="gk-menu-icon">{item.checked ? <Icon name="check" /> : item.icon ? <Icon name={item.icon} /> : null}</span>
              <span className="gk-menu-label">{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
              {hasSub && <Icon name="chevronRight" className="gk-menu-caret" />}
            </button>
            {hasSub && openSub === item.id && rowRefs.current.get(item.id) && (
              <Submenu anchor={rowRefs.current.get(item.id)!} items={item.submenu!} onClose={onClose} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu({ x, y, items, title, onClose, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const flipSubmenus = position.left > window.innerWidth / 2;

  return (
    <>
      <div className="gk-menu-backdrop" onMouseDown={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div ref={ref} className={`gk-menu${flipSubmenus ? " flip-left" : ""}`} style={position} aria-label={ariaLabel ?? title}>
        {title && <div className="gk-menu-title" title={title}>{title}</div>}
        <MenuList items={items} onClose={onClose} depth={0} autoFocus />
      </div>
    </>
  );
}

/** Small helper hook: `open(event, items, title)` + `<menu.element />`. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[]; title?: string } | null>(null);
  return {
    open: (event: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[], title?: string) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      setState({ x: event.clientX, y: event.clientY, items, title });
    },
    close: () => setState(null),
    element: state ? <ContextMenu x={state.x} y={state.y} items={state.items} title={state.title} onClose={() => setState(null)} /> : null,
  };
}
