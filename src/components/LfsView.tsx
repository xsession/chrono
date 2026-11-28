import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { withLiveOutput } from "../liveOutput";
import { pushToast } from "../toastBus";
import type { LfsActionRequest, LfsLock, LfsStatus } from "../types";
import { askConfirm } from "./DialogHost";
import { Icon } from "./Icon";

// Git LFS: is it set up, which patterns go through it, which files are stored
// in it (and downloaded or not), and who holds locks (server/src/lfs.ts).

type Props = {
  repositoryPath: string;
  refreshKey: number;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
};

const SUGGESTED = ["*.psd", "*.png", "*.jpg", "*.zip", "*.bin", "*.mp4", "*.pdf", "*.fbx", "*.wav", "*.so", "*.dll"];
const errorText = (error: unknown) => String(error).replace(/^Error: /, "");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function LfsView({ repositoryPath, refreshKey, busy, run }: Props) {
  const [status, setStatus] = useState<LfsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locks, setLocks] = useState<LfsLock[] | null>(null);
  const [locksError, setLocksError] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [lockable, setLockable] = useState(false);
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState<"all" | "missing" | "git">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState(lfsAutoEnabled);

  const load = useCallback(async () => {
    try {
      setStatus(await api.lfsStatus(repositoryPath));
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [repositoryPath]);

  const loadLocks = useCallback(async () => {
    try {
      setLocks(await api.lfsLocks(repositoryPath));
      setLocksError(null);
    } catch (reason) {
      setLocksError(errorText(reason));
    }
  }, [repositoryPath]);

  useEffect(() => { setStatus(null); setLocks(null); setPicked(new Set()); void load(); }, [load, refreshKey]);

  const act = useCallback(async (label: string, request: LfsActionRequest, live = false) => {
    await run(label, () => (live ? withLiveOutput(label, (streamId) => api.lfsAction(repositoryPath, request, streamId)) : api.lfsAction(repositoryPath, request)));
    await load();
    if (locks && (request.action === "lock" || request.action === "unlock")) await loadLocks();
  }, [run, repositoryPath, load, locks, loadLocks]);

  const lockByPath = useMemo(() => new Map((locks ?? []).map((lock) => [lock.path, lock])), [locks]);
  const needle = filter.trim().toLowerCase();
  const files = useMemo(() => (status?.files ?? []).filter((file) =>
    (!needle || file.path.toLowerCase().includes(needle))
    && (only === "all" || (only === "missing" ? Boolean(file.oid) && !file.downloaded : !file.oid))), [status, needle, only]);
  const selection = [...picked].filter((file) => files.some((entry) => entry.path === file));
  const unconverted = (status?.files ?? []).filter((file) => !file.oid).map((file) => file.path);

  const track = async (value: string) => {
    if (!value.trim()) return;
    await act(`Track ${value.trim()} with LFS`, { action: "track", pattern: value.trim(), lockable });
    setPattern("");
  };

  const convert = async (targets: string[]) => {
    if (!targets.length) return;
    if (!(await askConfirm("Store in LFS", `Re-stage ${targets.length} file(s) so they are stored as LFS objects. Commit afterwards; older commits keep their copies in git history.`, { confirm: "Stage as LFS" }))) return;
    await act("Convert to LFS", { action: "convert", files: targets });
  };

  if (error) return <section className="fk-view lfs-view"><p className="fk-error" role="alert">{error}</p></section>;
  if (!status) return <section className="fk-view lfs-view"><div className="ux-empty-state compact"><i className="ux-spinner" />Reading LFS state…</div></section>;

  const totalBytes = status.files.reduce((sum, file) => sum + (file.oid ? file.size : 0), 0);
  const allPicked = files.length > 0 && files.every((file) => picked.has(file.path));

  return (
    <section className="fk-view lfs-view" aria-label="Git LFS">
      <header className="fk-head">
        <div>
          <h2>Git LFS</h2>
          <p>
            {status.installed ? status.version?.split(" ")[0] : "git-lfs not installed"}
            {" · "}{status.patterns.length} pattern{status.patterns.length === 1 ? "" : "s"}
            {" · "}{status.files.length - status.unconverted} LFS file{status.files.length - status.unconverted === 1 ? "" : "s"} ({formatBytes(totalBytes)})
            {status.missing ? ` · ${status.missing} not downloaded` : ""}
            {" · "}local store {formatBytes(status.storeBytes)}
          </p>
        </div>
        <div className="fk-actions">
          <label className="fk-check" title="When a repository that uses LFS is opened or cloned, set up LFS in it and download its LFS files"><input type="checkbox" checked={auto} onChange={(event) => { setAuto(event.target.checked); localStorage.setItem(AUTO_KEY, event.target.checked ? "1" : "0"); }} />Set up &amp; download automatically</label>
          <button type="button" className="ux-button" disabled={busy} onClick={() => void load()}><Icon name="refresh" />Refresh</button>
          <button type="button" className="ux-button" disabled={busy || !status.installed} title="git lfs fetch: download LFS objects for the current branch without touching files" onClick={() => void act("LFS fetch", { action: "fetch" }, true)}>Fetch</button>
          <button type="button" className={status.missing ? "ux-primary-button" : "ux-button"} disabled={busy || !status.installed} title="git lfs pull: download and put the real content in place of pointer files" onClick={() => void act("LFS pull", { action: "pull" }, true)}><Icon name="download" />Pull</button>
          <button type="button" className="ux-button" disabled={busy || !status.installed} title="git lfs push origin HEAD: upload the LFS objects of the current branch (git push does this too once LFS is set up)" onClick={() => void act("LFS push", { action: "push" }, true)}><Icon name="upload" />Push objects</button>
          <button type="button" className="ux-button" disabled={busy || !status.installed} title="git lfs prune: delete old local LFS objects that are already on the server" onClick={() => void act("LFS prune", { action: "prune" }, true)}>Prune</button>
        </div>
      </header>

      {!status.installed && (
        <div className="lfs-banner is-warning" role="alert">
          <Icon name="warning" />
          <div>
            <strong>{status.used ? "This repository uses Git LFS, but git-lfs is not installed." : "git-lfs is not installed."}</strong>
            <span>{status.used ? "Files stored in LFS stay as small pointer files and new ones are committed as plain git blobs. " : ""}Install it, then restart Chrono: <code>sudo apt install git-lfs</code> (Ubuntu/Debian), <code>brew install git-lfs</code> (macOS); Git for Windows includes it.</span>
          </div>
        </div>
      )}
      {status.installed && status.used && !status.hooks && (
        <div className="lfs-banner" role="status">
          <Icon name="info" />
          <div>
            <strong>LFS is not set up in this repository yet.</strong>
            <span>Without its filter and pre-push hook, new files are not stored in LFS and pushes do not upload LFS objects.</span>
          </div>
          <button type="button" className="ux-primary-button" disabled={busy} onClick={() => void act("Set up Git LFS", { action: "install" })}>Set up LFS</button>
        </div>
      )}
      {status.unconverted > 0 && (
        <div className="lfs-banner is-warning" role="status">
          <Icon name="warning" />
          <div>
            <strong>{status.unconverted === 1 ? "1 file matches an LFS pattern but is" : `${status.unconverted} files match an LFS pattern but are`} stored in git.</strong>
            <span>They were committed before the pattern existed, or without git-lfs.</span>
          </div>
          <button type="button" className="ux-button" disabled={busy || !status.installed} onClick={() => void convert(unconverted)}>Convert all</button>
        </div>
      )}

      <div className="lfs-section">
        <h3>Tracked patterns</h3>
        {status.patterns.length === 0 && <p className="fk-note">No file types go through LFS. Track the large, binary ones (images, archives, media, build outputs) so git stores small pointers instead.</p>}
        {status.patterns.length > 0 && (
          <div className="lfs-patterns">
            {status.patterns.map((entry) => (
              <span key={`${entry.source}:${entry.pattern}`} className="lfs-pattern" title={`from ${entry.source}`}>
                <code>{entry.pattern}</code>
                {entry.lockable && <small title="Files open read-only until locked">lockable</small>}
                <button type="button" aria-label={`Stop tracking ${entry.pattern}`} title="Stop tracking (git lfs untrack)" disabled={busy || !status.installed} onClick={() => void act(`Untrack ${entry.pattern}`, { action: "untrack", pattern: entry.pattern })}>✕</button>
              </span>
            ))}
          </div>
        )}
        <form className="lfs-track" onSubmit={(event) => { event.preventDefault(); void track(pattern); }}>
          <input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="*.psd or assets/** " aria-label="Pattern to track with LFS" />
          <label className="fk-check" title="Mark matching files lockable: they are read-only until you lock them"><input type="checkbox" checked={lockable} onChange={(event) => setLockable(event.target.checked)} />Lockable</label>
          <button type="submit" className="ux-button" disabled={busy || !status.installed || !pattern.trim()}>Track</button>
          <span className="lfs-suggest">
            {SUGGESTED.filter((suggestion) => !status.patterns.some((entry) => entry.pattern === suggestion)).slice(0, 7).map((suggestion) => (
              <button key={suggestion} type="button" className="gk-link-button" disabled={busy || !status.installed} onClick={() => void track(suggestion)}>{suggestion}</button>
            ))}
          </span>
        </form>
      </div>

      {status.files.length > 0 && (
        <div className="lfs-section">
          <div className="lfs-files-head">
            <h3>Files</h3>
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" aria-label="Filter LFS files" />
            <select value={only} onChange={(event) => setOnly(event.target.value as typeof only)} aria-label="Show">
              <option value="all">All ({status.files.length})</option>
              <option value="missing">Not downloaded ({status.missing})</option>
              <option value="git">Stored in git ({status.unconverted})</option>
            </select>
            <span className="fk-actions">
              <button type="button" className="ux-button compact" disabled={busy || !status.installed || !selection.length} onClick={() => void act(`Download ${selection.length} LFS file(s)`, { action: "pull", files: selection }, true)}>Download</button>
              <button type="button" className="ux-button compact" disabled={busy || !status.installed || !selection.length} onClick={() => void act("LFS lock", { action: "lock", files: selection })}><Icon name="lock" />Lock</button>
              <button type="button" className="ux-button compact" disabled={busy || !status.installed || !selection.length} onClick={() => void act("LFS unlock", { action: "unlock", files: selection })}>Unlock</button>
              <button type="button" className="ux-button compact" disabled={busy || !status.installed || !selection.some((file) => unconverted.includes(file))} onClick={() => void convert(selection.filter((file) => unconverted.includes(file)))}>Convert to LFS</button>
            </span>
          </div>
          <div className="fk-table lfs-table" role="table" aria-label="LFS files">
            <div className="fk-row lfs-row is-head" role="row">
              <span><input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(files.map((file) => file.path)))} /></span>
              <span>Path</span><span>Size</span><span>State</span><span>Lock</span>
            </div>
            {files.slice(0, 2000).map((file) => {
              const lock = lockByPath.get(file.path);
              const state = !file.oid ? { text: "stored in git", tone: "is-warn", title: "Matches an LFS pattern but is committed as an ordinary git blob" }
                : !file.downloaded ? { text: "not downloaded", tone: "is-warn", title: "Only the pointer is here; Pull or Download fetches the content" }
                : file.pointerInWorktree ? { text: "pointer in folder", tone: "is-warn", title: "Downloaded, but the file in the folder is still the pointer text; Pull puts the content in place" }
                : { text: "downloaded", tone: "is-ok", title: file.oid };
              return (
                <div key={file.path} className="fk-row lfs-row" role="row">
                  <span><input type="checkbox" aria-label={`Select ${file.path}`} checked={picked.has(file.path)} onChange={() => setPicked((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })} /></span>
                  <span className="lfs-path" title={file.path}>{file.path}</span>
                  <span>{formatBytes(file.size)}</span>
                  <span className={`lfs-state ${state.tone}`} title={state.title ?? undefined}>{state.text}</span>
                  <span>{lock ? <small title={lock.lockedAt}><Icon name="lock" /> {lock.owner || "locked"}</small> : locks ? <small>—</small> : null}</span>
                </div>
              );
            })}
            {files.length > 2000 && <div className="fk-row lfs-row"><span /><span className="fk-note">{files.length - 2000} more; filter to narrow the list</span></div>}
            {!files.length && <div className="fk-row lfs-row"><span /><span className="fk-note">No files match</span></div>}
          </div>
        </div>
      )}

      <div className="lfs-section">
        <div className="lfs-files-head">
          <h3>Locks</h3>
          <button type="button" className="ux-button compact" disabled={busy || !status.installed} onClick={() => void loadLocks()}>{locks ? "Reload" : "Load locks from the server"}</button>
        </div>
        {locksError && <p className="fk-error">{locksError}</p>}
        {locks && !locks.length && <p className="fk-note">Nobody holds a lock.</p>}
        {locks && locks.length > 0 && (
          <div className="fk-table lfs-table" role="table" aria-label="LFS locks">
            <div className="fk-row lfs-lock-row is-head" role="row"><span>Path</span><span>Owner</span><span>Since</span><span>Actions</span></div>
            {locks.map((lock) => (
              <div key={lock.id} className="fk-row lfs-lock-row" role="row">
                <span className="lfs-path">{lock.path}</span>
                <span>{lock.owner}</span>
                <span>{lock.lockedAt ? new Date(lock.lockedAt).toLocaleString() : ""}</span>
                <span className="fk-row-actions">
                  <button type="button" className="ux-button compact" disabled={busy} onClick={() => void act(`Unlock ${lock.path}`, { action: "unlock", id: lock.id })}>Unlock</button>
                  <button type="button" className="ux-button compact danger" disabled={busy} title="Remove someone else's lock (needs permission on the server)" onClick={async () => {
                    if (await askConfirm("Force unlock", `Remove ${lock.owner || "the"} lock on ${lock.path}? Their unpushed changes to it may then conflict.`, { confirm: "Force unlock", danger: true })) await act(`Force unlock ${lock.path}`, { action: "unlock", id: lock.id, force: true });
                  }}>Force</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const AUTO_KEY = "chrono.lfs.auto";
/** Set up LFS and download LFS files on their own (default on). */
export const lfsAutoEnabled = () => localStorage.getItem(AUTO_KEY) !== "0";

/** Once per repository and session, when it opens: set up Git LFS if the
 *  repository uses it and download LFS files (when automatic setup is on),
 *  or warn that git-lfs is missing. Calls `onChanged` when files changed. */
export async function lfsOnOpen(repositoryPath: string, seen: Set<string>, onChanged: () => void): Promise<void> {
  if (seen.has(repositoryPath)) return;
  seen.add(repositoryPath);
  try {
    const check = await api.lfsCheck(repositoryPath);
    if (!check.used) return;
    if (!check.installed) {
      pushToast("This repository uses Git LFS, but git-lfs is not installed: large files stay as pointer files. Install git-lfs (Ubuntu: sudo apt install git-lfs) and restart Chrono.", "error", 12000);
      return;
    }
    if (!lfsAutoEnabled()) return;
    const result = await api.lfsAuto(repositoryPath);
    if (result.message) pushToast(result.message, result.message.includes("could not") ? "error" : "success", 6000);
    if (result.setUp || result.downloaded) onChanged();
  } catch {
    // not a repository yet, or git failed: the LFS view shows the details
  }
}
