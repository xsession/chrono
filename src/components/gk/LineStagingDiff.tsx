import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { api } from "../../api";
import type { DiffSide, LineMode, SideDiff } from "../../types";
import { askConfirm } from "../DialogHost";
import { ImageDiff, isImagePath } from "../ImageDiff";
import { pushToast } from "../../toastBus";

type Props = {
  repositoryPath: string;
  file: string;
  initialSide: DiffSide;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
};

const key = (hunk: number, line: number) => `${hunk}:${line}`;

/** Diff with line-level staging: click (or drag / shift-click) changed lines,
 *  then stage, unstage or discard exactly those lines — or a whole hunk. */
export function LineStagingDiff({ repositoryPath, file, initialSide, onChanged, onClose }: Props) {
  const [side, setSide] = useState<DiffSide>(initialSide);
  const [diffs, setDiffs] = useState<Record<DiffSide, SideDiff | null>>({ unstaged: null, staged: null });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<{ hunk: number; line: number } | null>(null);
  const [working, setWorking] = useState(false);
  const dragging = useRef<null | "add" | "remove">(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [unstaged, staged] = await Promise.all([
        api.fileDiffSide(repositoryPath, file, "unstaged"),
        api.fileDiffSide(repositoryPath, file, "staged"),
      ]);
      setDiffs({ unstaged, staged });
      setSide((current) => (current === "staged" && !staged.hunks.length && unstaged.hunks.length ? "unstaged" : current === "unstaged" && !unstaged.hunks.length && staged.hunks.length ? "staged" : current));
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    }
  }, [repositoryPath, file]);

  useEffect(() => { setSelected(new Set()); setAnchor(null); void load(); }, [load]);
  useEffect(() => { setSide(initialSide); }, [initialSide, file]);
  useEffect(() => { setSelected(new Set()); setAnchor(null); }, [side]);
  useEffect(() => {
    const stop = () => { dragging.current = null; };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const diff = diffs[side];
  const changeKeys = useMemo(() => {
    const all: string[] = [];
    diff?.hunks.forEach((hunk, h) => hunk.lines.forEach((line, i) => { if (line.kind !== "ctx") all.push(key(h, i)); }));
    return all;
  }, [diff]);

  const toggle = (hunk: number, line: number, event: ReactMouseEvent) => {
    const id = key(hunk, line);
    if (event.shiftKey && anchor) {
      const from = changeKeys.indexOf(key(anchor.hunk, anchor.line));
      const to = changeKeys.indexOf(id);
      if (from >= 0 && to >= 0) {
        const range = changeKeys.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected((current) => new Set([...current, ...range]));
        return;
      }
    }
    const adding = !selected.has(id);
    dragging.current = adding ? "add" : "remove";
    setSelected((current) => { const next = new Set(current); if (adding) next.add(id); else next.delete(id); return next; });
    setAnchor({ hunk, line });
  };

  const dragOver = (hunk: number, line: number) => {
    if (!dragging.current) return;
    const id = key(hunk, line);
    setSelected((current) => {
      const next = new Set(current);
      if (dragging.current === "add") next.add(id); else next.delete(id);
      return next;
    });
  };

  const apply = async (mode: LineMode, keys: string[]) => {
    if (!diff || !keys.length) return;
    if (mode === "discard" && !(await askConfirm("Discard lines", `Discard ${keys.length} changed line${keys.length === 1 ? "" : "s"} from ${file} in the working tree? This cannot be undone.`, { confirm: "Discard", danger: true }))) return;
    const byHunk = new Map<number, number[]>();
    for (const item of keys) {
      const [h, i] = item.split(":").map(Number);
      byHunk.set(h, [...(byHunk.get(h) ?? []), i]);
    }
    setWorking(true);
    try {
      await api.applyLines(repositoryPath, file, mode, [...byHunk.entries()].map(([hunk, lines]) => ({ hunk, lines })), diff.fingerprint);
      setSelected(new Set());
      await load();
      await onChanged();
    } catch (reason) {
      pushToast(String(reason).replace(/^Error: /, ""), "error", 8000);
      await load();
    } finally {
      setWorking(false);
    }
  };

  const hunkKeys = (h: number) => (diff?.hunks[h].lines ?? []).flatMap((line, i) => (line.kind !== "ctx" ? [key(h, i)] : []));
  const selectedKeys = [...selected];
  const primary: LineMode = side === "unstaged" ? "stage" : "unstage";

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === "BUTTON" && event.key === "Enter") return;
    if (event.key === "Escape") { event.preventDefault(); if (selected.size) setSelected(new Set()); else onClose(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(new Set(changeKeys)); }
    else if (event.key === "s" && side === "unstaged" && selected.size) { event.preventDefault(); void apply("stage", selectedKeys); }
    else if (event.key === "u" && side === "staged" && selected.size) { event.preventDefault(); void apply("unstage", selectedKeys); }
  };

  const counts = (value: SideDiff | null) => (value ? value.additions + value.deletions : 0);

  return (
    <section className="ls-diff" aria-label={`Line staging for ${file}`} onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="ls-head">
        <span className="ls-path" title={file}>{file}</span>
        <div className="gk-seg" role="tablist" aria-label="Diff side">
          <button type="button" role="tab" aria-selected={side === "unstaged"} className={side === "unstaged" ? "is-active" : ""} onClick={() => setSide("unstaged")}>Unstaged{diffs.unstaged ? ` (${counts(diffs.unstaged)})` : ""}</button>
          <button type="button" role="tab" aria-selected={side === "staged"} className={side === "staged" ? "is-active" : ""} onClick={() => setSide("staged")}>Staged{diffs.staged ? ` (${counts(diffs.staged)})` : ""}</button>
        </div>
        <span className="ls-actions">
          {selected.size > 0 && <span className="ls-count">{selected.size} line{selected.size === 1 ? "" : "s"}</span>}
          <button type="button" className="ux-button compact" disabled={working || !selected.size} onClick={() => void apply(primary, selectedKeys)} title={side === "unstaged" ? "Stage selected lines (S)" : "Unstage selected lines (U)"}>{side === "unstaged" ? "Stage lines" : "Unstage lines"}</button>
          {side === "unstaged" && <button type="button" className="ux-danger-button compact" disabled={working || !selected.size} onClick={() => void apply("discard", selectedKeys)}>Discard lines</button>}
          <button type="button" className="ux-button compact" disabled={!changeKeys.length} onClick={() => setSelected(selected.size === changeKeys.length ? new Set() : new Set(changeKeys))}>{selected.size === changeKeys.length && changeKeys.length ? "Clear" : "Select all"}</button>
          <button type="button" className="ux-icon-button" onClick={onClose} aria-label="Close diff">✕</button>
        </span>
      </header>
      <p className="ls-hint">Click lines to select them · drag or Shift+click for a range · S stages, U unstages, Esc clears · Ctrl+A selects all</p>
      <div className="ls-body" ref={bodyRef}>
        {isImagePath(file) ? <ImageDiff repositoryPath={repositoryPath} file={file} before={side === "staged" ? "HEAD" : diffs.unstaged?.untracked ? null : "INDEX"} after={side === "staged" ? "INDEX" : "WORKTREE"} />
          : error ? <div className="ux-empty-state compact">{error}</div>
          : !diff ? <div className="ux-empty-state compact"><i className="ux-spinner" />Loading diff…</div>
          : diff.binary ? <div className="ux-empty-state compact">Binary file — stage or discard it as a whole from the file list.</div>
          : !diff.hunks.length ? <div className="ux-empty-state compact">No {side} changes in this file.</div>
          : diff.hunks.map((hunk, h) => (
            <div key={h} className="ls-hunk">
              <div className="ls-hunk-head">
                <code>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.header}</code>
                <span>
                  <button type="button" className="ux-button compact" disabled={working} onClick={() => void apply(primary, hunkKeys(h))}>{side === "unstaged" ? "Stage hunk" : "Unstage hunk"}</button>
                  {side === "unstaged" && <button type="button" className="ux-danger-button compact" disabled={working} onClick={() => void apply("discard", hunkKeys(h))}>Discard hunk</button>}
                </span>
              </div>
              {hunk.lines.map((line, i) => {
                const id = key(h, i);
                const changed = line.kind !== "ctx";
                const isSelected = selected.has(id);
                return (
                  <div
                    key={i}
                    className={`ux-diff-line ux-diff-line--${line.kind} ls-line${changed ? " is-changeable" : ""}${isSelected ? " is-selected" : ""}`}
                    onMouseDown={changed ? (event) => { event.preventDefault(); toggle(h, i, event); } : undefined}
                    onMouseEnter={changed ? () => dragOver(h, i) : undefined}
                    role={changed ? "checkbox" : undefined}
                    aria-checked={changed ? isSelected : undefined}
                    aria-label={changed ? `${line.kind === "add" ? "Added" : "Removed"} line ${line.number ?? ""}: ${line.text}` : undefined}
                  >
                    <span className="ls-check" aria-hidden="true">{changed ? (isSelected ? "■" : "□") : ""}</span>
                    <span className="ux-diff-no ux-diff-no--old">{line.kind === "del" || line.kind === "ctx" ? line.number : ""}</span>
                    <span className="ux-diff-no ux-diff-no--new">{line.kind === "add" || line.kind === "ctx" ? line.number : ""}</span>
                    <span className="ux-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                    <code>{line.text}</code>
                  </div>
                );
              })}
            </div>
          ))}
      </div>
    </section>
  );
}
