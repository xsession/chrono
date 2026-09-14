import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, MouseEvent } from "react";
import { Icon } from "./Icon";

export type Command = {
  id: string;
  title: string;
  run: () => void;
  category?: string;
  shortcut?: string;
  keywords?: string[];
  disabled?: boolean;
};

type Props = { open: boolean; commands: Command[]; onClose: () => void };

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const enabled = commands.filter((command) => !command.disabled);
    if (!needle) return enabled;
    return enabled.filter((command) => [command.title, command.category || "", ...(command.keywords || [])]
      .join(" ").toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => setActiveIndex((index) => Math.min(index, Math.max(0, filtered.length - 1))), [filtered.length]);

  if (!open) return null;

  const execute = (command: Command | undefined) => {
    if (!command || command.disabled) return;
    command.run();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(filtered.length - 1, index + 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); return; }
    if (event.key === "Enter") { event.preventDefault(); execute(filtered[activeIndex]); }
  };

  return (
    <div className="ux-modal-backdrop" onMouseDown={onClose}>
      <div className="ux-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}>
        <label className="ux-palette-search">
          <Icon name="command" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search commands, views, and Git actions…"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-results"
            aria-activedescendant={filtered[activeIndex] ? `command-${filtered[activeIndex].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </label>
        <div id="command-results" className="ux-palette-results" role="listbox">
          {filtered.map((command, index) => (
            <button
              id={`command-${command.id}`}
              key={command.id}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "is-active" : ""}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => execute(command)}
            >
              <span><small>{command.category || "Command"}</small><strong>{command.title}</strong></span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {!filtered.length && <div className="ux-empty-state">No commands match “{query}”.</div>}
        </div>
        <footer><span>↑↓ navigate</span><span>Enter run</span><span>Esc close</span></footer>
      </div>
    </div>
  );
}
