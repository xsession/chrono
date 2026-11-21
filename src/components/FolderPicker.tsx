import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../api";
import type { FolderListing } from "../types";
import { Icon } from "./Icon";

// In-app folder picker. It lists folders through the Chrono server, so it works
// in the browser build (no native dialog) and in the desktop app when the
// system dialog fails — e.g. Linux sessions that ran out of inotify instances,
// where GTK/portal pickers silently return nothing.

type Request = {
  title: string;
  initial: string;
  confirm: string;
  resolve: (value: string | null) => void;
};

let enqueue: ((request: Request) => void) | null = null;
const LAST_KEY = "chrono.folderPicker.last";

export function chooseFolder(title: string, options: { initial?: string; confirm?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const initial = options.initial || localStorage.getItem(LAST_KEY) || "";
    if (!enqueue) {
      const value = window.prompt(title, initial);
      resolve(value ? value.trim() : null);
      return;
    }
    enqueue({ title, initial, confirm: options.confirm ?? "Select folder", resolve });
  });
}

export function FolderPickerHost() {
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    enqueue = (next) => setRequest((current) => { current?.resolve(null); return next; });
    return () => { enqueue = null; };
  }, []);
  if (!request) return null;
  const done = (value: string | null) => {
    if (value) localStorage.setItem(LAST_KEY, value);
    request.resolve(value);
    setRequest(null);
  };
  return <FolderPicker key={request.title + request.initial} request={request} onDone={done} />;
}

function FolderPicker({ request, onDone }: { request: Request; onDone: (value: string | null) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState(request.initial);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const desktop = typeof window !== "undefined" ? window.chronoDesktop : undefined;

  const load = useCallback(async (target: string | null, hidden = showHidden) => {
    setLoading(true);
    try {
      const next = await api.listFolders(target, hidden);
      setListing(next);
      setTyped(next.path);
      setFilter("");
      setSelected(null);
      setError(null);
      requestAnimationFrame(() => listRef.current?.focus());
    } catch (failure) {
      setError(String(failure).replace(/^Error: /, ""));
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => { void load(request.initial || null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (listing?.entries ?? []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
  }, [listing, filter]);

  const target = selected ?? listing?.path ?? null;
  const targetName = target ? target.split(/[\\/]/).filter(Boolean).pop() || target : "";

  const systemDialog = async () => {
    if (!desktop?.pickDirectory) return;
    const picked = await desktop.pickDirectory();
    if (picked) onDone(picked);
  };

  const onListKey = (event: KeyboardEvent) => {
    if (!visible.length) return;
    const index = visible.findIndex((entry) => entry.path === selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(visible.length - 1, index + 1) : Math.max(0, index - 1);
      setSelected(visible[next].path);
      listRef.current?.querySelectorAll<HTMLElement>("[role=option]")[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      void load(selected);
    } else if (event.key === "Backspace" && listing?.parent && !filter) {
      event.preventDefault();
      void load(listing.parent);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setFilter((value) => value + event.key);
    }
  };

  return (
    <div className="ux-modal-backdrop gk-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onDone(null); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (filter) setFilter(""); else onDone(null); } }}>
      <div className="ux-dialog gk-dialog fp-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <header><h2>{request.title}</h2></header>
        <form className="fp-pathbar" onSubmit={(event) => { event.preventDefault(); void load(typed); }}>
          <button type="button" className="ux-icon-button" title="Parent folder" aria-label="Parent folder" disabled={!listing?.parent || loading} onClick={() => listing?.parent && void load(listing.parent)}><span aria-hidden="true">↑</span></button>
          <input aria-label="Folder path" value={typed} spellCheck={false} onChange={(event) => setTyped(event.target.value)} placeholder="/path/to/folder" />
          <button type="submit" className="ux-button compact" disabled={loading}>Go</button>
        </form>
        <div className="fp-body">
          <nav className="fp-places" aria-label="Places">
            {listing?.places.map((place) => (
              <button key={place.path} type="button" className={listing.path === place.path ? "is-active" : ""} title={place.path} onClick={() => void load(place.path)}>
                <Icon name="folder" /><span>{place.name}</span>
              </button>
            ))}
          </nav>
          <div className="fp-list" ref={listRef} role="listbox" tabIndex={0} aria-label="Folders" aria-activedescendant={selected ?? undefined} onKeyDown={onListKey}>
            {filter && <div className="fp-filter">Filter: <strong>{filter}</strong> <button type="button" className="ux-link-button" onClick={() => setFilter("")}>clear</button></div>}
            {error && <div className="fp-error" role="alert">{error}</div>}
            {!error && listing && visible.length === 0 && <div className="fp-empty">{filter ? "No folder matches." : "No subfolders."}</div>}
            {visible.map((entry) => (
              <div key={entry.path} id={entry.path} role="option" aria-selected={entry.path === selected}
                className={`fp-row${entry.path === selected ? " is-selected" : ""}${entry.hidden ? " is-hidden" : ""}`}
                onClick={() => setSelected(entry.path)} onDoubleClick={() => void load(entry.path)} title={entry.path}>
                <Icon name={entry.repo ? "repository" : "folder"} />
                <span className="fp-name">{entry.name}</span>
                {entry.repo && <span className="fp-badge">git</span>}
              </div>
            ))}
            {listing?.truncated && <div className="fp-empty">Showing the first 3000 folders — type a path to go deeper.</div>}
          </div>
        </div>
        <footer className="fp-footer">
          <label className="fp-hidden"><input type="checkbox" checked={showHidden} onChange={(event) => { setShowHidden(event.target.checked); void load(listing?.path ?? null, event.target.checked); }} /> Hidden folders</label>
          {desktop?.pickDirectory && <button type="button" className="ux-button" onClick={() => void systemDialog()}>System dialog…</button>}
          <span className="fp-spacer" />
          {listing?.repo && !selected && <span className="fp-hint">This folder is a Git repository</span>}
          <button type="button" className="ux-button" onClick={() => onDone(null)}>Cancel</button>
          <button type="button" className="ux-primary-button" disabled={!target || loading} title={target ?? undefined} onClick={() => target && onDone(target)}>
            {request.confirm}{targetName ? ` “${targetName}”` : ""}
          </button>
        </footer>
      </div>
    </div>
  );
}
