import { useEffect, useState } from "react";
import type { FileAtRevision, TreeEntry } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";

type Props = {
  repositoryPath: string;
  branches: string[];
  onExport: (revision: string, destination: string) => Promise<string>;
};

function formatBytes(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** TortoiseGit "Repo-browser": the file tree of any revision with file
 *  content viewing, plus revision export (TortoiseGit "Export"). */
export function RepoBrowser({ repositoryPath, branches, onExport }: Props) {
  const [revision, setRevision] = useState("HEAD");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [dir, setDir] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [file, setFile] = useState<FileAtRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Pick a revision to browse its file tree.");
  const [exportDest, setExportDest] = useState("");
  const [contentWidth, setContentWidth] = useState(520);
  const [tagNames, setTagNames] = useState<string[]>([]);

  useEffect(() => {
    api.listTags(repositoryPath).then((rows) => setTagNames(rows.map((tag) => tag.name))).catch(() => setTagNames([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryPath]);

  const loadTree = async (rev: string, targetDir: string) => {
    const rows = await api.listTree(repositoryPath, rev, targetDir);
    setEntries(rows);
    setDir(targetDir);
  };

  const resolve = async () => {
    const rev = revision.trim();
    if (!rev) return;
    setBusy(true);
    setMessage(`Loading ${rev}…`);
    try {
      await loadTree(rev, "");
      setOpen(new Set([""]));
      setFile(null);
      setMessage(`Browsing ${rev}.`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleDir = async (entry: TreeEntry) => {
    if (entry.type !== "tree") {
      setBusy(true);
      setMessage(`Reading ${entry.path}…`);
      try {
        setFile(await api.fileAtRevision(repositoryPath, revision.trim(), entry.path));
      } catch (error) {
        setMessage(String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    const next = new Set(open);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.add(entry.path);
    setOpen(next);
    if (!next.has(entry.path)) return;
    setBusy(true);
    try {
      await loadTree(revision.trim(), entry.path);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const jumpTo = (targetDir: string) => {
    if (!revision.trim()) return;
    void (async () => {
      setBusy(true);
      try {
        await loadTree(revision.trim(), targetDir);
        const parts = targetDir.split("/").filter(Boolean);
        const openPath: string[] = [""];
        for (let i = 0; i < parts.length; i += 1) openPath.push(parts.slice(0, i + 1).join("/"));
        setOpen(new Set(openPath));
      } catch (error) {
        setMessage(String(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const crumbs = dir ? dir.split("/").filter(Boolean) : [];

  return (
    <div className="ux-repo-browser" style={{ gridTemplateColumns: `minmax(340px, 1fr) 6px ${contentWidth}px` }}>
      <section className="ux-repo-browser-tree" aria-label="Revision file tree">
        <header className="ux-view-toolbar">
          <div><h2>Repo browser</h2><span>Inspect and export the file tree of any revision</span></div>
          <button className="ux-button" disabled={busy || !revision.trim()} onClick={() => void resolve()}><Icon name="refresh" />Load</button>
        </header>
        <div className="ux-repo-browser-controls">
          <label className="grow"><span>Revision</span>
            <input list="browser-refs" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="HEAD, branch, tag, SHA" />
          </label>
          <datalist id="browser-refs">
            <option value="HEAD" />
            {branches.map((branch) => <option key={`b-${branch}`} value={branch} />)}
            {tagNames.map((tag) => <option key={`t-${tag}`} value={tag} />)}
          </datalist>
          <label className="grow"><span>Export destination</span>
            <input value={exportDest} onChange={(event) => setExportDest(event.target.value)} placeholder="C:/exports/feature-v1" aria-label="Export destination folder" />
          </label>
          <button
            className="ux-primary-button"
            disabled={busy || !revision.trim() || !exportDest.trim()}
            onClick={async () => {
              const message2 = await onExport(revision.trim(), exportDest.trim());
              setMessage(message2);
            }}
          >Export revision</button>
        </div>
        <div className="ux-tree-crumbs" aria-label="Current directory">
          <button onClick={() => jumpTo("")} disabled={busy}>/</button>
          {crumbs.map((part, index) => (
            <span key={`${part}-${index}`}>
              <button onClick={() => jumpTo(crumbs.slice(0, index + 1).join("/"))} disabled={busy}>{part}</button>
            </span>
          ))}
          <span className="ux-help-text">· {entries.length} entries in “{dir || "/"}”</span>
        </div>
        <div className="ux-tree-list" role="tree" aria-label="Files at revision">
          <button className={`ux-tree-row is-breadcrumb${dir ? "" : " is-active"}`} onClick={() => jumpTo("")} disabled={busy || !dir}>
            <Icon name="repository" /><span>/ (root)</span>
          </button>
          {entries.map((entry) => (
            <button
              key={entry.path}
              className="ux-tree-row"
              style={{ paddingLeft: 10 }}
              onClick={() => void toggleDir(entry)}
              title={entry.path}
            >
              <Icon name={entry.type === "tree" ? "chevronRight" : "file"} />
              <span>{entry.name}</span>
              <small>{entry.type === "tree" ? "folder" : formatBytes(entry.size)}</small>
            </button>
          ))}
          {!entries.length && <div className="ux-empty-state">{busy ? "Loading tree…" : "Load a revision to see its files."}</div>}
        </div>
      </section>

      <SplitHandle label="Resize file content" onDelta={(delta) => setContentWidth((width) => Math.min(820, Math.max(300, width - delta)))} />

      <aside className="ux-file-content-pane" aria-label="File content at revision">
        <header>
          <span className="ux-eyebrow">File at {revision || "revision"}</span>
          <h2>{file ? file.path : "No file selected"}</h2>
        </header>
        {file ? <>
          <div className="ux-file-content-meta">
            <span>{formatBytes(file.size)}</span>
            {file.truncated && <span className="ux-inline-warning is-info"><Icon name="warning" />Content truncated for display (1 MB cap).</span>}
          </div>
          {file.binary
            ? <div className="ux-empty-state"><Icon name="file" />Binary file — content is not displayed.</div>
            : <pre className="ux-file-content-code">{file.content}</pre>}
        </> : <div className="ux-empty-state">Select a file in the tree to view its content at this revision.</div>}
      </aside>
    </div>
  );
}
