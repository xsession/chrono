import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../../api";
import type { BlameResult, CommitDiffHunk, CommitRecord, ExplorerProperties, FileChange, StashRef } from "../../types";
import { DiffHunks } from "../DiffHunks";
import { CommitDiffView } from "../CommitDiffView";
import { Icon } from "../Icon";
import { pushToast } from "../../toastBus";
import { plural } from "../../plural";

export type ExplorerDialog =
  | { kind: "commit"; files: string[] }
  | { kind: "revert"; files: string[] }
  | { kind: "add"; files: string[] }
  | { kind: "modifications"; files: string[] }
  | { kind: "cleanup"; files: string[] }
  | { kind: "properties"; file: string }
  | { kind: "diff"; file: string; mode: "working" | "previous" }
  | { kind: "diff-files"; left: string; right: string }
  | { kind: "log"; file: string }
  | { kind: "blame"; file: string }
  | { kind: "sync" }
  | { kind: "patch"; files: string[] }
  | { kind: "apply-patch"; dir: string }
  | { kind: "stashes" }
  | { kind: "output"; title: string; text: string }
  | { kind: "about" };

type Props = {
  dialog: ExplorerDialog;
  repositoryPath: string;
  branch: string | null;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  onOpenDialog: (dialog: ExplorerDialog) => void;
};

const inSelection = (file: string, roots: string[]) => roots.some((root) => root === "." || root === "" || file === root || file.startsWith(`${root}/`));

function statusLabel(change: FileChange): { text: string; kind: string } {
  if (change.conflicted) return { text: "conflicted", kind: "conflicted" };
  if (change.indexStatus === "?") return { text: "unversioned", kind: "untracked" };
  const code = change.worktreeStatus !== " " ? change.worktreeStatus : change.indexStatus;
  switch (code) {
    case "A": return { text: "added", kind: "added" };
    case "D": return { text: "deleted", kind: "deleted" };
    case "R": return { text: "renamed", kind: "renamed" };
    default: return { text: change.worktreeStatus === " " ? "modified (staged)" : "modified", kind: change.worktreeStatus === " " ? "staged" : "modified" };
  }
}

function Shell({ title, icon, wide, children, footer, onClose }: { title: string; icon?: Parameters<typeof Icon>[0]["name"]; wide?: boolean; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ux-modal-backdrop tg-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`ux-dialog tg-dialog${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="tg-dialog-title">
          {icon && <Icon name={icon} />}
          <h2>{title}</h2>
          <button type="button" className="ux-icon-button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="tg-dialog-body">{children}</div>
        {footer && <footer className="tg-dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** TortoiseGit-style file list with check boxes ("Check for modifications",
 *  Commit, Revert and Add dialogs all share it). */
function ChangeChecklist({ changes, checked, setChecked, onDiff }: { changes: FileChange[]; checked: Set<string>; setChecked: (next: Set<string>) => void; onDiff?: (file: string) => void }) {
  const all = changes.length > 0 && changes.every((change) => checked.has(change.path));
  return (
    <div className="tg-checklist">
      <div className="tg-checklist-head">
        <label><input type="checkbox" checked={all} onChange={() => setChecked(all ? new Set() : new Set(changes.map((change) => change.path)))} />Path</label>
        <span>Status</span>
      </div>
      <div className="tg-checklist-rows">
        {changes.map((change) => {
          const status = statusLabel(change);
          return (
            <div key={change.path} className="tg-checklist-row" onDoubleClick={() => onDiff?.(change.path)} title={onDiff ? "Double-click to diff" : undefined}>
              <label>
                <input type="checkbox" checked={checked.has(change.path)} onChange={() => { const next = new Set(checked); if (next.has(change.path)) next.delete(change.path); else next.add(change.path); setChecked(next); }} />
                <span className={`tg-overlay-dot is-${status.kind}`} />
                <span className="tg-path">{change.path}</span>
              </label>
              <span className={`tg-status-text is-${status.kind}`}>{status.text}</span>
            </div>
          );
        })}
        {changes.length === 0 && <div className="gk-empty">No files to show.</div>}
      </div>
      <div className="tg-checklist-foot">{checked.size} of {changes.length} selected</div>
    </div>
  );
}

function useChanges(repositoryPath: string, roots: string[], filter: (change: FileChange) => boolean, deps: unknown[] = []) {
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.status(repositoryPath).then((all) => { if (!cancelled) setChanges(all.filter((change) => inSelection(change.path, roots) && filter(change))); }).catch(() => { if (!cancelled) setChanges([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryPath, roots.join("\0"), ...deps]);
  return changes;
}

function CommitDialog({ repositoryPath, branch, files, busy, run, onClose, onOpenDialog }: Props & { files: string[] }) {
  const [showUnversioned, setShowUnversioned] = useState(true);
  const changes = useChanges(repositoryPath, files, (change) => showUnversioned || change.indexStatus !== "?", [showUnversioned]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const recent = useMemo(() => { try { return JSON.parse(localStorage.getItem("chrono.tg.recentMessages") ?? "[]") as string[]; } catch { return []; } }, []);
  useEffect(() => { if (changes) setChecked(new Set(changes.filter((change) => change.indexStatus !== "?" && !change.conflicted).map((change) => change.path))); }, [changes]);
  useEffect(() => { if (amend && !message) api.lastCommitMessage(repositoryPath).then(setMessage).catch(() => undefined); }, [amend]); // eslint-disable-line react-hooks/exhaustive-deps
  const conflicts = changes?.filter((change) => change.conflicted).length ?? 0;
  const submit = async () => {
    const list = [...checked];
    localStorage.setItem("chrono.tg.recentMessages", JSON.stringify([message, ...recent.filter((value) => value !== message)].slice(0, 15)));
    await run(amend ? "Amend commit" : "Commit", () => api.explorerAction(repositoryPath, { action: "commit", files: list, message, amend }));
    onClose();
  };
  return (
    <Shell title={`Commit to ${branch ?? "detached HEAD"} — ${repositoryPath}`} icon="commit" wide onClose={onClose} footer={<>
      <label className="tg-inline"><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />Amend last commit</label>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-primary-button" disabled={busy || conflicts > 0 || (!amend && (!message.trim() || checked.size === 0))} onClick={() => void submit()}>Commit</button>
    </>}>
      <div className="tg-message-head">
        <strong>Message:</strong>
        {recent.length > 0 && <select aria-label="Recent messages" value="" onChange={(event) => setMessage(event.target.value)}><option value="">Recent messages…</option>{recent.map((value) => <option key={value} value={value}>{value.split("\n")[0].slice(0, 80)}</option>)}</select>}
        <button type="button" className="ux-button compact" onClick={async () => { try { const draft = await api.draftCommit(repositoryPath, "auto"); setMessage(draft.message); } catch (error) { pushToast(String(error), "error"); } }}>Draft</button>
      </div>
      <textarea className="tg-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={6} placeholder="Describe the change…" autoFocus onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void submit(); }} />
      <div className="tg-message-meta"><span className={message.split("\n")[0].length > 72 ? "is-over" : ""}>Subject: {message.split("\n")[0].length}/72</span>{conflicts > 0 && <span className="is-over">{plural(conflicts, "conflicted file")} must be resolved first</span>}</div>
      <div className="tg-message-head"><strong>Changes made (double-click on file for diff):</strong><label className="tg-inline"><input type="checkbox" checked={showUnversioned} onChange={(event) => setShowUnversioned(event.target.checked)} />Show unversioned files</label></div>
      {changes ? <ChangeChecklist changes={changes} checked={checked} setChecked={setChecked} onDiff={(file) => onOpenDialog({ kind: "diff", file, mode: "working" })} /> : <div className="gk-empty"><i className="ux-spinner" />Scanning…</div>}
    </Shell>
  );
}

function ChecklistActionDialog({ repositoryPath, files, busy, run, onClose, onOpenDialog, title, icon, filter, action, button, note }: Props & { files: string[]; title: string; icon: Parameters<typeof Icon>[0]["name"]; filter: (change: FileChange) => boolean; action: "revert" | "add" | "resolve"; button: string; note: string }) {
  const changes = useChanges(repositoryPath, files, filter);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => { if (changes) setChecked(new Set(changes.map((change) => change.path))); }, [changes]);
  return (
    <Shell title={title} icon={icon} wide onClose={onClose} footer={<>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className={action === "revert" ? "ux-danger-button" : "ux-primary-button"} disabled={busy || checked.size === 0} onClick={async () => { await run(button, () => api.explorerAction(repositoryPath, { action, files: [...checked] })); onClose(); }}>{button}</button>
    </>}>
      <p className="tg-note">{note}</p>
      {changes ? <ChangeChecklist changes={changes} checked={checked} setChecked={setChecked} onDiff={(file) => onOpenDialog({ kind: "diff", file, mode: "working" })} /> : <div className="gk-empty"><i className="ux-spinner" />Scanning…</div>}
    </Shell>
  );
}

function ModificationsDialog({ repositoryPath, files, busy, run, onClose, onOpenDialog }: Props & { files: string[] }) {
  const [tick, setTick] = useState(0);
  const changes = useChanges(repositoryPath, files, () => true, [tick]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const act = async (label: string, action: "add" | "revert" | "unstage") => { await run(label, () => api.explorerAction(repositoryPath, { action, files: [...checked] })); setChecked(new Set()); setTick((value) => value + 1); };
  return (
    <Shell title={`Working Tree Changes — ${files.join(", ") || "/"}`} icon="changes" wide onClose={onClose} footer={<>
      <button type="button" className="ux-button" onClick={() => setTick((value) => value + 1)}>Refresh</button>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" disabled={busy || !checked.size} onClick={() => void act("Stage", "add")}>Stage / Add</button>
      <button type="button" className="ux-button" disabled={busy || !checked.size} onClick={() => void act("Unstage", "unstage")}>Unstage</button>
      <button type="button" className="ux-danger-button" disabled={busy || !checked.size} onClick={() => void act("Revert", "revert")}>Revert</button>
      <button type="button" className="ux-primary-button" onClick={() => onOpenDialog({ kind: "commit", files })}>Commit…</button>
    </>}>
      {changes ? <ChangeChecklist changes={changes} checked={checked} setChecked={setChecked} onDiff={(file) => onOpenDialog({ kind: "diff", file, mode: "working" })} /> : <div className="gk-empty"><i className="ux-spinner" />Scanning…</div>}
    </Shell>
  );
}

function CleanupDialog({ repositoryPath, files, busy, run, onClose }: Props & { files: string[] }) {
  const [mode, setMode] = useState<"untracked" | "ignored" | "all">("untracked");
  const [preview, setPreview] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    api.explorerAction(repositoryPath, { action: "clean", files, cleanMode: mode, dryRun: true })
      .then((result) => { if (!cancelled) setPreview(result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^Would remove /, ""))); })
      .catch((error) => { if (!cancelled) { setPreview([]); pushToast(String(error), "error"); } });
    return () => { cancelled = true; };
  }, [mode, repositoryPath, files]);
  return (
    <Shell title="Clean up" icon="trash" onClose={onClose} footer={<>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-danger-button" disabled={busy || !preview?.length} onClick={async () => { await run("Clean up", () => api.explorerAction(repositoryPath, { action: "clean", files, cleanMode: mode })); onClose(); }}>Delete {preview?.length ?? 0} item(s)</button>
    </>}>
      <fieldset className="tg-radio-group">
        <legend>Remove</legend>
        <label><input type="radio" checked={mode === "untracked"} onChange={() => setMode("untracked")} />Untracked files only (git clean -d)</label>
        <label><input type="radio" checked={mode === "ignored"} onChange={() => setMode("ignored")} />Ignored files only (git clean -X)</label>
        <label><input type="radio" checked={mode === "all"} onChange={() => setMode("all")} />Untracked and ignored files (git clean -x)</label>
      </fieldset>
      <div className="tg-preview">
        <strong>Preview (dry run):</strong>
        {preview === null ? <div className="gk-empty"><i className="ux-spinner" />Scanning…</div> : preview.length === 0 ? <div className="gk-empty">Nothing to clean.</div> : <ul>{preview.map((item) => <li key={item}>{item}</li>)}</ul>}
      </div>
    </Shell>
  );
}

function PropertiesDialog({ repositoryPath, file, onClose, onOpenDialog }: Props & { file: string }) {
  const [props, setProps] = useState<ExplorerProperties | null>(null);
  useEffect(() => { api.explorerProperties(repositoryPath, file).then(setProps).catch((error) => pushToast(String(error), "error")); }, [repositoryPath, file]);
  const fmt = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "—");
  return (
    <Shell title={`${file === "." ? "Repository root" : file.split("/").pop()} Properties`} icon="info" onClose={onClose} footer={<><span className="tg-spacer" /><button type="button" className="ux-primary-button" onClick={onClose}>OK</button></>}>
      {!props ? <div className="gk-empty"><i className="ux-spinner" />Loading…</div> : (
        <div className="tg-props">
          <div className="tg-props-tab">Git</div>
          <dl>
            <dt>Location</dt><dd><code>{props.absolutePath}</code></dd>
            <dt>Type</dt><dd>{props.type}{props.mode ? ` · mode ${props.mode}` : ""}</dd>
            <dt>Size</dt><dd>{props.size === null ? "—" : `${props.size.toLocaleString()} bytes`}</dd>
            <dt>Modified</dt><dd>{fmt(props.modifiedAt)}</dd>
            <dt>Status</dt><dd><span className={`tg-overlay-dot is-${props.status}`} />{props.status}{props.tracked ? "" : " (not versioned)"}</dd>
            {props.blob && <><dt>Blob</dt><dd><code>{props.blob}</code></dd></>}
            <dt>Last commit</dt><dd>{props.lastCommit ? <><code>{props.lastCommit.id.slice(0, 10)}</code> {props.lastCommit.subject}<small>{props.lastCommit.authorName} · {fmt(props.lastCommit.authoredAt)}</small></> : "—"}</dd>
            <dt>Created in</dt><dd>{props.firstCommit ? <><code>{props.firstCommit.id.slice(0, 10)}</code> {props.firstCommit.subject}<small>{fmt(props.firstCommit.authoredAt)}</small></> : "—"}</dd>
            <dt>Commits</dt><dd>{props.commitCount}{props.commitCount > 0 && <button type="button" className="gk-link-button" onClick={() => onOpenDialog({ kind: "log", file })}>Show log</button>}</dd>
            <dt>Flags</dt><dd>{[props.assumeUnchanged && "assume-unchanged", props.skipWorktree && "skip-worktree", props.lfs && "Git LFS"].filter(Boolean).join(", ") || "none"}</dd>
            <dt>Ignored by</dt><dd>{props.ignoredBy ? <code>{props.ignoredBy}</code> : "—"}</dd>
            <dt>Attributes</dt><dd>{props.attributes.length ? props.attributes.map((attr) => <code key={attr.name}>{attr.name}={attr.value}</code>) : "—"}</dd>
          </dl>
        </div>
      )}
    </Shell>
  );
}

function DiffDialog({ repositoryPath, onClose, title, load }: Props & { title: string; load: () => Promise<{ hunks: CommitDiffHunk[]; binary: boolean; additions: number; deletions: number; subtitle?: string }> }) {
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { load().then(setDiff).catch((reason) => setError(String(reason))); }, [repositoryPath, title]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Shell title={title} icon="diff" wide onClose={onClose}>
      {error ? <div className="ux-empty-state compact"><Icon name="warning" />{error}</div>
        : !diff ? <div className="gk-empty"><i className="ux-spinner" />Loading diff…</div>
        : <>
          <div className="tg-diff-meta">{diff.subtitle && <span>{diff.subtitle}</span>}{!diff.binary && <small><b>+{diff.additions}</b> <i>−{diff.deletions}</i></small>}</div>
          {diff.binary ? <div className="gk-empty">Binary files differ.</div> : diff.hunks.length ? <div className="tg-diff-scroll"><DiffHunks hunks={diff.hunks} /></div> : <div className="gk-empty">No differences.</div>}
        </>}
    </Shell>
  );
}

function LogDialog({ repositoryPath, file, onClose, run, busy }: Props & { file: string }) {
  const [commits, setCommits] = useState<CommitRecord[] | null>(null);
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<CommitRecord | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  useEffect(() => {
    setCommits(null);
    api.fileHistory(repositoryPath, { file, followRenames: file !== "." && !file.endsWith("/"), allRefs: all, limit: 500 })
      .then((list) => { setCommits(list); setSelected(list[0] ?? null); })
      .catch(() => api.fileHistory(repositoryPath, { file, followRenames: false, allRefs: all, limit: 500 }).then((list) => { setCommits(list); setSelected(list[0] ?? null); }).catch(() => setCommits([])));
  }, [repositoryPath, file, all]);
  useEffect(() => {
    if (!selected) { setFiles(null); return; }
    api.commitDetails(repositoryPath, selected.id).then((details) => {
      const scoped = details.files.map((entry) => entry.path).filter((path) => file === "." || path === file || path.startsWith(`${file}/`));
      setFiles(scoped.length ? scoped : details.files.map((entry) => entry.path));
      setDiffFile((current) => (current && scoped.includes(current) ? current : scoped[0] ?? null));
    }).catch(() => setFiles([]));
  }, [repositoryPath, selected, file]);
  return (
    <Shell title={`Log Messages — ${file === "." ? "/" : file}`} icon="history" wide onClose={onClose} footer={<>
      <label className="tg-inline"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />All branches</label>
      <span className="tg-spacer" />
      {selected && file !== "." && <button type="button" className="ux-button" disabled={busy} onClick={() => void run(`Revert ${file} to ${selected.id.slice(0, 8)}`, () => api.explorerAction(repositoryPath, { action: "checkout_revision", files: [file], revision: selected.id }))}>Revert to this revision</button>}
      {selected && <button type="button" className="ux-button" onClick={() => void navigator.clipboard?.writeText(selected.id).then(() => pushToast("SHA copied", "success", 2000))}>Copy SHA</button>}
      <button type="button" className="ux-primary-button" onClick={onClose}>OK</button>
    </>}>
      <div className="tg-log">
        <div className="tg-log-list">
          <div className="tg-log-head"><span>Message</span><span>Author</span><span>Date</span><span>SHA</span></div>
          {!commits ? <div className="gk-empty"><i className="ux-spinner" />Loading…</div> : commits.map((commit) => (
            <button key={commit.id} type="button" className={`tg-log-row${selected?.id === commit.id ? " is-selected" : ""}`} onClick={() => setSelected(commit)}>
              <span>{commit.subject}</span><span>{commit.authorName}</span><span>{new Date(commit.authoredAt).toLocaleDateString()}</span><code>{commit.id.slice(0, 8)}</code>
            </button>
          ))}
          {commits?.length === 0 && <div className="gk-empty">No history.</div>}
        </div>
        <div className="tg-log-files">
          {files?.map((path) => <button key={path} type="button" className={`tg-log-file${diffFile === path ? " is-selected" : ""}`} onClick={() => setDiffFile(path)}>{path}</button>)}
        </div>
        <div className="tg-log-diff">
          {selected && diffFile ? <CommitDiffView repositoryPath={repositoryPath} commit={selected.id} file={diffFile} additions={null} deletions={null} binary={false} onClose={() => setDiffFile(null)} /> : <div className="gk-empty">Select a changed file.</div>}
        </div>
      </div>
    </Shell>
  );
}

function BlameDialog({ repositoryPath, file, onClose }: Props & { file: string }) {
  const [blame, setBlame] = useState<BlameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ignoreWs, setIgnoreWs] = useState(false);
  useEffect(() => { setBlame(null); api.blameFile(repositoryPath, file, null, ignoreWs).then(setBlame).catch((reason) => setError(String(reason))); }, [repositoryPath, file, ignoreWs]);
  const colors = useMemo(() => {
    const map = new Map<string, number>();
    blame?.lines.forEach((line) => { if (!map.has(line.commit)) map.set(line.commit, map.size % 6); });
    return map;
  }, [blame]);
  return (
    <Shell title={`TortoiseGitBlame — ${file}`} icon="users" wide onClose={onClose} footer={<><label className="tg-inline"><input type="checkbox" checked={ignoreWs} onChange={(event) => setIgnoreWs(event.target.checked)} />Ignore whitespace</label><span className="tg-spacer" /><button type="button" className="ux-primary-button" onClick={onClose}>Close</button></>}>
      {error ? <div className="ux-empty-state compact">{error}</div> : !blame ? <div className="gk-empty"><i className="ux-spinner" />Blaming…</div> : (
        <div className="tg-blame">
          {blame.lines.map((line, index) => {
            const first = index === 0 || blame.lines[index - 1].commit !== line.commit;
            return (
              <div key={line.lineNumber} className={`tg-blame-line c${colors.get(line.commit)}`} title={`${line.commit.slice(0, 10)} ${line.author}\n${line.summary}`}>
                <span className="tg-blame-meta">{first ? <><code>{line.commit.slice(0, 7)}</code> {line.author}</> : ""}</span>
                <span className="tg-blame-no">{line.lineNumber}</span>
                <code className="tg-blame-text">{line.content}</code>
              </div>
            );
          })}
          {blame.truncated && <div className="gk-empty">Output truncated.</div>}
        </div>
      )}
    </Shell>
  );
}

function SyncDialog({ repositoryPath, branch, busy, onClose }: Props) {
  const [log, setLog] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const exec = async (label: string, action: () => Promise<{ stdout: string; stderr: string }>) => {
    setWorking(true);
    setLog((lines) => [...lines, `> ${label}`]);
    try {
      const result = await action();
      setLog((lines) => [...lines, ...(result.stdout + "\n" + result.stderr).split(/\r?\n/).filter(Boolean), "✓ done"]);
    } catch (error) {
      setLog((lines) => [...lines, `✗ ${String(error)}`]);
    } finally { setWorking(false); }
  };
  return (
    <Shell title={`Git Synchronization — ${branch ?? "detached"}`} icon="refresh" wide onClose={onClose} footer={<><span className="tg-spacer" /><button type="button" className="ux-primary-button" onClick={onClose}>Close</button></>}>
      <div className="tg-sync-actions">
        <button type="button" className="ux-button" disabled={busy || working} onClick={() => void exec("git pull --ff-only", () => api.pull(repositoryPath, "ff-only"))}><Icon name="download" />Pull</button>
        <button type="button" className="ux-button" disabled={busy || working} onClick={() => void exec("git pull --rebase", () => api.pull(repositoryPath, "rebase"))}>Pull (rebase)</button>
        <button type="button" className="ux-button" disabled={busy || working} onClick={() => void exec("git fetch --all --prune", () => api.pull(repositoryPath, "fetch"))}>Fetch</button>
        <button type="button" className="ux-button" disabled={busy || working} onClick={() => void exec("git push", () => api.push(repositoryPath))}><Icon name="upload" />Push</button>
        <button type="button" className="ux-button" disabled={busy || working} onClick={() => void exec("git push --follow-tags", () => api.push(repositoryPath, { tags: true }))}>Push tags</button>
      </div>
      <pre className="tg-output">{log.join("\n") || "Choose an action. Output appears here."}</pre>
    </Shell>
  );
}

function PatchDialog({ repositoryPath, files, onClose }: Props & { files: string[] }) {
  const [patch, setPatch] = useState<{ name: string; text: string } | null>(null);
  useEffect(() => { api.explorerPatch(repositoryPath, files).then(setPatch).catch((error) => pushToast(String(error), "error")); }, [repositoryPath, files]);
  const download = () => {
    if (!patch) return;
    const url = URL.createObjectURL(new Blob([patch.text], { type: "text/x-diff" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = patch.name; anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Shell title={`Create Patch — ${patch?.name ?? "…"}`} icon="patch" wide onClose={onClose} footer={<>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" disabled={!patch?.text} onClick={() => void navigator.clipboard?.writeText(patch?.text ?? "").then(() => pushToast("Patch copied", "success", 2000))}>Copy</button>
      <button type="button" className="ux-primary-button" disabled={!patch?.text} onClick={download}>Save…</button>
    </>}>
      <pre className="tg-output tg-patch">{patch ? patch.text || "No changes in the selection." : "Generating…"}</pre>
    </Shell>
  );
}

function ApplyPatchDialog({ repositoryPath, dir, busy, run, onClose }: Props & { dir: string }) {
  const [text, setText] = useState("");
  return (
    <Shell title="Apply Patch" icon="patch" wide onClose={onClose} footer={<>
      <input type="file" accept=".patch,.diff,text/*" onChange={async (event) => { const file = event.target.files?.[0]; if (file) setText(await file.text()); }} />
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-primary-button" disabled={busy || !text.trim()} onClick={async () => { await run("Apply patch", () => api.applyPatch(repositoryPath, btoa(unescape(encodeURIComponent(text))), dir)); onClose(); }}>Apply</button>
    </>}>
      <p className="tg-note">Paste a unified diff / git format-patch, or choose a file. It is applied relative to <code>{dir || "/"}</code>.</p>
      <textarea className="tg-message tg-patch" rows={16} value={text} onChange={(event) => setText(event.target.value)} placeholder="diff --git a/… b/…" />
    </Shell>
  );
}

function StashListDialog({ repositoryPath, busy, run, onClose }: Props) {
  const [stashes, setStashes] = useState<StashRef[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api.refGroups(repositoryPath).then((groups) => setStashes(groups.stashes)).catch(() => setStashes([])); }, [repositoryPath, tick]);
  const act = async (label: string, operation: string, ref: string) => { await run(label, () => api.workflow(repositoryPath, { operation, args: [ref] })); setTick((value) => value + 1); };
  return (
    <Shell title="Stash List" icon="stash" onClose={onClose} footer={<><span className="tg-spacer" /><button type="button" className="ux-primary-button" onClick={onClose}>Close</button></>}>
      {!stashes ? <div className="gk-empty"><i className="ux-spinner" />Loading…</div> : stashes.length === 0 ? <div className="gk-empty">No stashes.</div> : (
        <div className="tg-stash-list">{stashes.map((stash) => (
          <div key={stash.ref} className="tg-stash-row">
            <code>{stash.ref}</code><span>{stash.message}</span>
            <button type="button" className="ux-button compact" disabled={busy} onClick={() => void act("Apply stash", "stash_apply", stash.ref)}>Apply</button>
            <button type="button" className="ux-button compact" disabled={busy} onClick={() => void act("Pop stash", "stash_pop", stash.ref)}>Pop</button>
            <button type="button" className="ux-danger-button compact" disabled={busy} onClick={() => void act("Drop stash", "stash_drop", stash.ref)}>Drop</button>
          </div>
        ))}</div>
      )}
    </Shell>
  );
}

export function ExplorerDialogView(props: Props) {
  const { dialog, repositoryPath, onClose } = props;
  switch (dialog.kind) {
    case "commit": return <CommitDialog {...props} files={dialog.files} />;
    case "revert": return <ChecklistActionDialog {...props} files={dialog.files} title="Revert" icon="undo" action="revert" button="Revert" filter={(change) => change.indexStatus !== "?"} note="Revert discards local modifications of the checked files (newly added files are only unstaged)." />;
    case "add": return <ChecklistActionDialog {...props} files={dialog.files} title="Add" icon="plus" action="add" button="Add" filter={(change) => change.indexStatus === "?"} note="Choose the unversioned files to add to version control." />;
    case "modifications": return <ModificationsDialog {...props} files={dialog.files} />;
    case "cleanup": return <CleanupDialog {...props} files={dialog.files} />;
    case "properties": return <PropertiesDialog {...props} file={dialog.file} />;
    case "diff":
      return <DiffDialog {...props} title={dialog.mode === "working" ? `Diff — ${dialog.file} (HEAD ↔ working tree)` : `Diff with previous version — ${dialog.file}`} load={async () => {
        if (dialog.mode === "working") { const diff = await api.workingTreeDiff(repositoryPath, dialog.file); return { ...diff, subtitle: `status: ${diff.status || "modified"}` }; }
        const diff = await api.explorerDiffPrevious(repositoryPath, dialog.file);
        return { ...diff, subtitle: `${diff.from.slice(0, 8)} → ${diff.to.slice(0, 8)} · ${diff.subject}` };
      }} />;
    case "diff-files":
      return <DiffDialog {...props} title={`Diff — ${dialog.left} ↔ ${dialog.right}`} load={async () => api.explorerDiffFiles(repositoryPath, dialog.left, dialog.right)} />;
    case "log": return <LogDialog {...props} file={dialog.file} />;
    case "blame": return <BlameDialog {...props} file={dialog.file} />;
    case "sync": return <SyncDialog {...props} />;
    case "patch": return <PatchDialog {...props} files={dialog.files} />;
    case "apply-patch": return <ApplyPatchDialog {...props} dir={dialog.dir} />;
    case "stashes": return <StashListDialog {...props} />;
    case "output":
      return <Shell title={dialog.title} icon="list" wide onClose={onClose} footer={<><span className="tg-spacer" /><button type="button" className="ux-primary-button" onClick={onClose}>OK</button></>}><pre className="tg-output">{dialog.text || "(no output)"}</pre></Shell>;
    case "about":
      return <Shell title="About Chrono — TortoiseGit mode" icon="info" onClose={onClose} footer={<><span className="tg-spacer" /><button type="button" className="ux-primary-button" onClick={onClose}>OK</button></>}>
        <p className="tg-note">The Explorer view reproduces the TortoiseGit shell extension: icon overlays for every working-copy item and the full right-click menu (commit, diff, log, blame, revert, resolve, add, ignore, clean up, stash, LFS, patches…), backed by the native git CLI on the Chrono server.</p>
        <ul className="tg-legend">{(["normal", "modified", "staged", "added", "deleted", "conflicted", "untracked", "ignored"] as const).map((kind) => <li key={kind}><span className={`tg-overlay-dot is-${kind}`} />{kind}</li>)}</ul>
      </Shell>;
    default: return null;
  }
}
