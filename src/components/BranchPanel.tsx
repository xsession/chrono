import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { BranchRecord, CommandResult, TagRecord } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

/** Turn a git CommandResult into a short status line for the app status bar. */
function fmt(result: CommandResult): string {
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return text || "Completed.";
}

type Props = {
  branches: BranchRecord[];
  repositoryPath: string;
  headSha?: string;
  onCheckout: (branch: string) => Promise<void>;
  onCreate: (branch: string) => Promise<void>;
  onDelete: (branch: string, force: boolean) => Promise<string>;
  disabled?: boolean;
  onNotify: (message: string) => void;
};

export function BranchPanel({ branches, repositoryPath, headSha, onCheckout, onCreate, onDelete, disabled = false, onNotify }: Props) {
  const [query, setQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [tagName, setTagName] = useState("");
  const [tagRev, setTagRev] = useState("");
  const [tagMessage, setTagMessage] = useState("");
  const [annotated, setAnnotated] = useState(true);
  const [busyTag, setBusyTag] = useState(false);
  const [mergeBranch, setMergeBranch] = useState("");
  const [mergeStrategy, setMergeStrategy] = useState<"no-ff" | "squash" | "ff-only">("no-ff");
  const [busyMerge, setBusyMerge] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; force: boolean } | null>(null);

  const loadTags = useCallback(() => {
    api.listTags(repositoryPath).then(setTags).catch(() => setTags([]));
  }, [repositoryPath]);

  useEffect(() => { loadTags(); }, [loadTags]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? branches.filter((branch) => branch.name.toLowerCase().includes(needle)) : branches;
  }, [branches, query]);

  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);

  const checkout = async (branch: string) => {
    setBusyBranch(branch);
    try { await onCheckout(branch); } finally { setBusyBranch(null); }
  };

  const createTag = async () => {
    if (!tagName.trim()) return;
    setBusyTag(true);
    try {
      const result = await api.createTag(repositoryPath, tagName.trim(), tagRev.trim() || (headSha ?? "HEAD"), annotated ? tagMessage.trim() : "");
      onNotify(fmt(result));
      setTagName(""); setTagRev(""); setTagMessage("");
      loadTags();
    } catch (error) {
      onNotify(String(error));
    } finally {
      setBusyTag(false);
    }
  };

  const removeTag = async (name: string) => {
    setBusyTag(true);
    try {
      onNotify(fmt(await api.deleteTag(repositoryPath, name)));
      loadTags();
    } catch (error) {
      onNotify(String(error));
    } finally {
      setBusyTag(false);
    }
  };

  const runMerge = async () => {
    if (!mergeBranch) return;
    setBusyMerge(true);
    try {
      const result = await api.mergeBranch(repositoryPath, mergeBranch, mergeStrategy);
      onNotify(fmt(result));
    } catch (error) {
      onNotify(String(error));
    } finally {
      setBusyMerge(false);
    }
  };

  return (
    <div className="ux-branch-view">
      <header className="ux-view-toolbar">
        <div><h2>Branches</h2><span>{branches.length} references</span></div>
        <label className="ux-search-field">
          <Icon name="search" />
          <input value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} placeholder="Filter branches" aria-label="Filter branches" />
        </label>
      </header>

      {disabled && <div className="ux-inline-warning"><Icon name="warning" /><span>Branch changes are locked while a merge, rebase, cherry-pick, or revert is in progress.</span></div>}

      <section className="ux-create-branch-card">
        <div><strong>Create branch</strong><span>Creates and checks out a new branch from the current HEAD.</span></div>
        <div className="ux-inline-form">
          <input value={newBranch} onChange={(event: ChangeEvent<HTMLInputElement>) => setNewBranch(event.target.value)} placeholder="feature/my-change" aria-label="New branch name" />
          <button className="ux-primary-button" disabled={disabled || !newBranch.trim() || busyBranch !== null} onClick={async () => {
            const name = newBranch.trim();
            setBusyBranch(name);
            try { await onCreate(name); setNewBranch(""); } finally { setBusyBranch(null); }
          }}>Create</button>
        </div>
      </section>

      <div className="ux-reference-columns">
        <section className="ux-reference-group">
          <header><strong>Local</strong><span>{local.length}</span></header>
          <div>
            {local.map((branch) => (
              confirmDelete?.name === branch.name ? (
                <div key={branch.name} className="ux-reference-row is-danger">
                  <Icon name="warning" />
                  <span className="ux-reference-name"><strong>Delete “{branch.name}”?</strong><small>{confirmDelete.force ? "Force (not merged)" : "Only if fully merged"}</small></span>
                  <span className="ux-inline-form">
                    <button className="ux-button" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    <button className="ux-danger-button" onClick={async () => {
                      const name = branch.name;
                      const force = confirmDelete.force;
                      setConfirmDelete(null);
                      setBusyBranch(name);
                      try { onNotify(await onDelete(name, force)); } finally { setBusyBranch(null); }
                    }}>Delete</button>
                    {!confirmDelete.force && <button className="ux-button" title="Force delete" onClick={() => setConfirmDelete({ name: branch.name, force: true })}>-f</button>}
                  </span>
                </div>
              ) : (
                <div
                  key={branch.name}
                  className={`ux-reference-row${branch.current ? " is-current" : ""}`}
                  role="button"
                  tabIndex={disabled || branch.current || busyBranch !== null ? -1 : 0}
                  aria-disabled={disabled || branch.current || busyBranch !== null}
                  onClick={() => { if (!branch.current && !disabled && busyBranch === null) void checkout(branch.name); }}
                  onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !branch.current && !disabled && busyBranch === null) { event.preventDefault(); void checkout(branch.name); } }}
                >
                  <Icon name="branch" />
                  <span className="ux-reference-name"><strong>{branch.name}</strong><small>{branch.upstream || "No upstream"}</small></span>
                  <span className="ux-reference-actions">
                    {busyBranch === branch.name ? <code>switching</code> : <code>{branch.target.slice(0, 8)}</code>}
                    {!branch.current && <button className="ux-icon-button" disabled={disabled || busyBranch !== null} title={`Delete ${branch.name}`} aria-label={`Delete ${branch.name}`} onClick={(event) => { event.stopPropagation(); setConfirmDelete({ name: branch.name, force: false }); }}>✕</button>}
                  </span>
                </div>
              )
            ))}
            {!local.length && <div className="ux-empty-state">No local branches match this filter.</div>}
          </div>
        </section>

        <div>
          <section className="ux-reference-group">
            <header><strong>Remote</strong><span>{remote.length}</span></header>
            <div>
              {remote.map((branch) => (
                <div key={branch.name} className="ux-reference-row is-readonly">
                  <Icon name="upload" />
                  <span className="ux-reference-name"><strong>{branch.name}</strong><small>{branch.upstream || "Remote tracking reference"}</small></span>
                  <code>{branch.target.slice(0, 8)}</code>
                </div>
              ))}
              {!remote.length && <div className="ux-empty-state">No remote branches match this filter.</div>}
            </div>
          </section>

          <section className="ux-reference-group">
            <header><strong>Tags</strong><span>{tags.length}</span></header>
            <div className="ux-tag-create">
              <div className="ux-inline-form">
                <input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="v1.2.0" aria-label="New tag name" />
                <input value={tagRev} onChange={(event) => setTagRev(event.target.value)} placeholder="HEAD" aria-label="Tag revision" title="Revision to tag (branch, tag, or SHA)" />
                <button className="ux-primary-button" disabled={busyTag || !tagName.trim()} onClick={() => void createTag()}>Tag</button>
              </div>
              {annotated && <input className="grow" value={tagMessage} onChange={(event) => setTagMessage(event.target.value)} placeholder="Tag message (annotated tag)" aria-label="Tag message" />}
              <label className="ux-check-row"><input type="checkbox" checked={annotated} onChange={(event) => setAnnotated(event.target.checked)} /> Annotated tag (with message & author)</label>
            </div>
            <div>
              {tags.map((tag) => (
                <div key={tag.name} className="ux-reference-row">
                  <Icon name="branch" />
                  <span className="ux-reference-name"><strong>{tag.name}{tag.annotated ? " •" : ""}</strong><small>{tag.tagger ? `${tag.tagger} · ${tag.date}` : tag.date}{tag.message ? ` · ${tag.message}` : ""}</small></span>
                  <span className="ux-reference-actions">
                    <code>{tag.target.slice(0, 8)}</code>
                    <button className="ux-icon-button" title={`Delete tag ${tag.name}`} aria-label={`Delete tag ${tag.name}`} disabled={busyTag} onClick={() => void removeTag(tag.name)}>✕</button>
                  </span>
                </div>
              ))}
              {!tags.length && <div className="ux-empty-state">No tags yet.</div>}
            </div>
          </section>

          <section className="ux-reference-group">
            <header><strong>Merge into current</strong><span>TortoiseGit-style merge</span></header>
            <div className="ux-inline-form">
              <input list="mergeable-branches" value={mergeBranch} onChange={(event) => setMergeBranch(event.target.value)} placeholder="Branch to merge" aria-label="Branch to merge" />
              <datalist id="mergeable-branches">{local.filter((branch) => !branch.current).map((branch) => <option key={branch.name} value={branch.name} />)}</datalist>
              <select value={mergeStrategy} onChange={(event) => setMergeStrategy(event.target.value as typeof mergeStrategy)} aria-label="Merge strategy">
                <option value="no-ff">--no-ff (keep merge commit)</option>
                <option value="squash">squash (single commit)</option>
                <option value="ff-only">ff-only (fast-forward only)</option>
              </select>
              <button className="ux-primary-button" disabled={busyMerge || !mergeBranch || disabled} onClick={() => void runMerge()}>Merge</button>
            </div>
            <p className="ux-help-text">Conflicts land in the Conflict Center. Squash stages everything for you to commit.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
