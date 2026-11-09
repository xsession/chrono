import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { CommandResult, RefGroups, StashRef, SubmoduleRef, WorktreeSummary, WorkflowRequest } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";

export type WorkflowSection = "worktrees" | "submodules" | "stashes" | "recovery";

type Props = {
  section: WorkflowSection;
  repositoryPath: string;
  onRun: (request: WorkflowRequest) => Promise<CommandResult>;
  onOpenWorktree?: (path: string) => void | Promise<void>;
  operationLocked?: boolean;
};

type RunOptions = { quiet?: boolean };

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Unicode-safe base64 (btoa throws on non-ASCII patch content). */
function b64encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function WorkflowPanel({ section, repositoryPath, onRun, onOpenWorktree, operationLocked = false }: Props) {
  const [output, setOutput] = useState("No command has run yet.");
  const [busy, setBusy] = useState<string | null>(null);
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeRef, setWorktreeRef] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [outputWidth, setOutputWidth] = useState(360);
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([]);
  const [stashes, setStashes] = useState<StashRef[]>([]);
  const [submodules, setSubmodules] = useState<SubmoduleRef[]>([]);
  const [patchFrom, setPatchFrom] = useState("HEAD");
  const [patchTo, setPatchTo] = useState("");
  const [patchDest, setPatchDest] = useState("");
  const [applyPatchData, setApplyPatchData] = useState("");
  const [applyPatchDir, setApplyPatchDir] = useState("");
  const [bisectGood, setBisectGood] = useState("");
  const [bisectBad, setBisectBad] = useState("");
  const [bisectRevision, setBisectRevision] = useState("HEAD");

  const run = async (operation: string, args: string[] = [], options: RunOptions = {}) => {
    setBusy(operation);
    try {
      const result = await onRun({ operation, args });
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (!options.quiet || text) setOutput(text || `${operation} completed successfully.`);
      return result;
    } catch (error) {
      setOutput(String(error));
      throw error;
    } finally {
      setBusy(null);
    }
  };

  // Direct repo endpoints (not part of the generic workflow operation set).
  const runDirect = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setOutput(`${label}…`);
    try {
      setOutput(await work());
    } catch (error) {
      setOutput(String(error));
    } finally {
      setBusy(null);
    }
  };

  const refreshRefGroups = async () => {
    setBusy("reference_groups");
    try {
      const result: RefGroups = await api.refGroups(repositoryPath);
      if (section === "stashes") {
        setStashes(result.stashes);
        setOutput(result.stashes.length ? `Found ${result.stashes.length} stash${result.stashes.length === 1 ? "" : "es"}.` : "No stashes.");
      } else {
        setSubmodules(result.submodules);
        setOutput(result.submodules.length ? `Found ${result.submodules.length} submodule${result.submodules.length === 1 ? "" : "s"}.` : "No submodules registered.");
      }
      return result;
    } catch (error) {
      setOutput(String(error));
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const refreshSection = async () => {
    if (section === "worktrees") {
      setBusy("worktree_summaries");
      try {
        const result = await api.worktreeSummaries(repositoryPath);
        setWorktrees(result);
        const dirty = result.filter((worktree) => worktree.dirtyCount > 0).length;
        const conflicts = result.reduce((total, worktree) => total + worktree.conflictCount, 0);
        setOutput(`${result.length} worktree${result.length === 1 ? "" : "s"} · ${dirty} dirty · ${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
      } catch (error) {
        setOutput(String(error));
        throw error;
      } finally {
        setBusy(null);
      }
      return;
    }
    if (section === "stashes") {
      await refreshRefGroups();
      return;
    }
    if (section === "submodules") {
      await refreshRefGroups();
      return;
    }
    if (section === "recovery") {
      await run("reflog");
      return;
    }
    setOutput("No command has run yet.");
  };

  useEffect(() => {
    void refreshSection().catch(() => undefined);
  // Intentional: refresh when changing sections.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  const title = {
    worktrees: "Worktrees",
    submodules: "Submodules",
    stashes: "Stashes",
    recovery: "Recovery & maintenance"
  }[section];

  return (
    <div className="ux-workflow-view" style={{ gridTemplateColumns: `minmax(520px, 1fr) 6px ${outputWidth}px` }}>
      <section className="ux-workflow-main">
        <header className="ux-view-toolbar">
          <div><h2>{title}</h2><span>First-class controls for advanced repository workflows</span></div>
          <button className="ux-button" disabled={busy !== null} onClick={() => void refreshSection().catch(() => undefined)}><Icon name="refresh" />Refresh</button>
        </header>

        {operationLocked && (
          <div className="ux-inline-warning"><Icon name="warning" /><span>Mutating repository tools are locked while the current Git operation is paused. Read-only inspection remains available.</span></div>
        )}

        {section === "worktrees" && (
          <div className="ux-workflow-cards">
            <article className="ux-task-card wide">
              <div className="ux-task-card-heading"><span className="ux-card-icon"><Icon name="worktree" /></span><div><h3>Create worktree</h3><p>Check out a branch or revision into a second working directory without switching this repository.</p></div></div>
              <div className="ux-form-grid two">
                <label><span>Folder</span><input value={worktreePath} onChange={(event: ChangeEvent<HTMLInputElement>) => setWorktreePath(event.target.value)} placeholder="../project-feature" /></label>
                <label><span>Branch / revision</span><input value={worktreeRef} onChange={(event: ChangeEvent<HTMLInputElement>) => setWorktreeRef(event.target.value)} placeholder="feature/ui-v2" /></label>
              </div>
              <div className="ux-card-actions">
                <button className="ux-primary-button" disabled={operationLocked || !worktreePath.trim() || !worktreeRef.trim() || busy !== null} onClick={async () => {
                  await run("worktree_add", [worktreePath.trim(), worktreeRef.trim()]);
                  setWorktreePath("");
                  setWorktreeRef("");
                  await refreshSection();
                }}>Create worktree</button>
                <button className="ux-button" disabled={operationLocked || busy !== null} onClick={() => void run("worktree_prune").catch(() => undefined)}>Prune stale metadata</button>
              </div>
            </article>
            <article className="ux-task-card wide">
              <div className="ux-section-title"><strong>Linked worktrees</strong><span>{worktrees.length} · {worktrees.filter((worktree) => worktree.dirtyCount > 0).length} dirty · {worktrees.reduce((total, worktree) => total + worktree.conflictCount, 0)} conflicts</span></div>
              <div className="ux-worktree-table" role="table" aria-label="Linked worktrees">
                <div className="ux-worktree-row is-header" role="row"><span role="columnheader">Branch</span><span role="columnheader">Path</span><span role="columnheader">HEAD</span><span role="columnheader">State</span><span role="columnheader">Action</span></div>
                {worktrees.map((worktree) => (
                  <div className="ux-worktree-row" role="row" key={worktree.path}>
                    <strong role="cell">{worktree.branch || "Detached HEAD"}</strong><span role="cell" title={worktree.path}>{worktree.path}</span><code role="cell">{worktree.head.slice(0, 8)}</code><span role="cell">{worktree.conflictCount ? `${worktree.conflictCount} conflict${worktree.conflictCount === 1 ? "" : "s"}` : worktree.dirtyCount ? `${worktree.dirtyCount} changed file${worktree.dirtyCount === 1 ? "" : "s"}` : worktree.locked || worktree.prunable || "Clean"}</span>
                    <span role="cell" className="ux-worktree-actions">
                      {onOpenWorktree && <button className="ux-refs-action" disabled={busy !== null} title={`Open ${worktree.path}`} onClick={() => void onOpenWorktree(worktree.path)}>Open</button>}
                      {normalizeFsPath(worktree.path) !== normalizeFsPath(repositoryPath) && <button
                        className="ux-refs-action ux-refs-action--danger"
                        disabled={operationLocked || busy !== null || Boolean(worktree.locked)}
                        title={worktree.locked ? "Unlock this worktree before removing it" : `Remove ${worktree.path}`}
                        onClick={() => {
                          if (worktree.locked || !window.confirm(`Remove worktree ${worktree.path}? This deletes its working directory metadata.`)) return;
                          void run("worktree_remove", [worktree.path]).then(() => refreshSection()).catch(() => undefined);
                        }}
                      >Remove</button>}
                    </span>
                  </div>
                ))}
                {!worktrees.length && <div className="ux-empty-state">No worktree records returned.</div>}
              </div>
            </article>
            <article className="ux-task-card wide is-muted">
              <h3>Safety model</h3>
              <p>Chrono reads each linked checkout independently, so dirty files and conflicts remain visible while another branch is being worked on. The current worktree cannot be removed; other worktrees require confirmation.</p>
            </article>
          </div>
        )}

        {section === "submodules" && (
          <div className="ux-workflow-cards">
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="submodule" /></span>
              <h3>Update recursively</h3>
              <p>Initialize missing submodules and update registered submodules to the commits recorded by the parent repository.</p>
              <button className="ux-primary-button" disabled={operationLocked || busy !== null} onClick={() => void run("submodule_update").catch(() => undefined)}>Initialize & update</button>
            </article>
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="refresh" /></span>
              <h3>Synchronize URLs</h3>
              <p>Apply URL changes from <code>.gitmodules</code> to local submodule configuration, including nested submodules.</p>
              <button className="ux-button" disabled={operationLocked || busy !== null} onClick={() => void run("submodule_sync").catch(() => undefined)}>Sync recursively</button>
            </article>
            <article className="ux-task-card wide">
              <div className="ux-section-title"><strong>Registered submodules</strong><span>{submodules.length}</span></div>
              <div className="ux-worktree-table" role="table" aria-label="Registered submodules">
                <div className="ux-worktree-row is-header" role="row"><span role="columnheader">Path</span><span role="columnheader">Recorded commit</span><span role="columnheader">State</span><span role="columnheader">Action</span></div>
                {submodules.map((submodule) => {
                  const state = submodule.status === " " ? "Synced" : submodule.status === "+" ? "Checked out at another commit" : submodule.status === "-" ? "Not initialized" : "Unmerged";
                  return <div className="ux-worktree-row" role="row" key={submodule.path}>
                    <strong role="cell">{submodule.path}</strong><code role="cell">{submodule.commit.slice(0, 12)}</code><span role="cell" title={submodule.summary}>{state}{submodule.summary ? ` · ${submodule.summary}` : ""}</span>
                    <span role="cell" className="ux-worktree-actions">
                      {submodule.status === "-" && <button className="ux-refs-action" disabled={operationLocked || busy !== null} onClick={() => void run("submodule_init_path", [submodule.path]).then(() => refreshSection()).catch(() => undefined)}>Init</button>}
                      {submodule.status === "+" && <button className="ux-refs-action" disabled={operationLocked || busy !== null} onClick={() => void run("submodule_update_path", [submodule.path]).then(() => refreshSection()).catch(() => undefined)}>Update</button>}
                      {submodule.status === " " && <span className="ux-help-text">Ready</span>}
                    </span>
                  </div>;
                })}
                {!submodules.length && <div className="ux-empty-state">No submodules registered.</div>}
              </div>
            </article>
          </div>
        )}

        {section === "stashes" && (
          <div className="ux-workflow-cards">
            <article className="ux-task-card wide">
              <span className="ux-card-icon"><Icon name="stash" /></span>
              <h3>Create stash</h3>
              <p>Save tracked and untracked working changes so you can safely change context.</p>
              <label className="ux-field-stack"><span>Message</span><input value={stashMessage} onChange={(event: ChangeEvent<HTMLInputElement>) => setStashMessage(event.target.value)} placeholder="WIP: describe the context" /></label>
              <div className="ux-card-actions">
                <button className="ux-primary-button" disabled={operationLocked || busy !== null} onClick={async () => {
                  await run("stash_push", stashMessage.trim() ? [stashMessage.trim()] : []);
                  setStashMessage("");
                  await refreshSection();
                }}>Stash changes</button>
                <button className="ux-button" disabled={operationLocked || busy !== null} onClick={async () => { await run("stash_pop"); await refreshSection(); }}>Pop latest</button>
              </div>
              <div className="ux-stash-list" aria-label="Stashes">
                {stashes.map((stash) => <div className="ux-stash-row" key={stash.ref}>
                  <code title={stash.message}>{stash.ref} · {stash.message}</code>
                  <span className="ux-card-actions wrap">
                    <button className="ux-refs-action" disabled={operationLocked || busy !== null} onClick={() => void run("stash_apply", [stash.ref]).then(() => refreshSection()).catch(() => undefined)}>Apply</button>
                    <button className="ux-refs-action ux-refs-action--danger" disabled={operationLocked || busy !== null} onClick={() => { if (window.confirm(`Drop ${stash.ref}? This cannot be undone.`)) void run("stash_drop", [stash.ref]).then(() => refreshSection()).catch(() => undefined); }}>Drop</button>
                  </span>
                </div>)}
                {!stashes.length && <span className="ux-help-text">No stashes.</span>}
              </div>
            </article>
          </div>
        )}

        {section === "recovery" && (
          <div className="ux-workflow-cards">
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="history" /></span>
              <h3>Reflog</h3>
              <p>Inspect recent HEAD movements when a branch or commit appears to be lost.</p>
              <button className="ux-button" disabled={busy !== null} onClick={() => void run("reflog").catch(() => undefined)}>Refresh reflog</button>
            </article>
            <article className="ux-task-card wide">
              <span className="ux-card-icon"><Icon name="compare" /></span>
              <h3>Bisect a regression</h3>
              <p>Binary-search history for the first bad commit. Start with known good and bad revisions, then mark each checked commit good or bad as Git moves through the search.</p>
              <div className="ux-form-grid two">
                <label><span>Known good revision</span><input value={bisectGood} onChange={(event) => setBisectGood(event.target.value)} placeholder="HEAD~20" /></label>
                <label><span>Known bad revision</span><input value={bisectBad} onChange={(event) => setBisectBad(event.target.value)} placeholder="HEAD" /></label>
              </div>
              <div className="ux-card-actions wrap">
                <button className="ux-primary-button" disabled={operationLocked || busy !== null || !bisectGood.trim() || !bisectBad.trim()} onClick={() => void run("bisect_start", [bisectBad.trim(), bisectGood.trim()]).catch(() => undefined)}>Start bisect</button>
                <label className="ux-inline-field"><span>Current revision</span><input value={bisectRevision} onChange={(event) => setBisectRevision(event.target.value)} placeholder="HEAD" /></label>
                <button className="ux-button" disabled={operationLocked || busy !== null || !bisectRevision.trim()} onClick={() => void run("bisect_good", [bisectRevision.trim()]).catch(() => undefined)}>Mark good</button>
                <button className="ux-button" disabled={operationLocked || busy !== null || !bisectRevision.trim()} onClick={() => void run("bisect_bad", [bisectRevision.trim()]).catch(() => undefined)}>Mark bad</button>
                <button className="ux-danger-button" disabled={operationLocked || busy !== null} onClick={() => { if (window.confirm("Reset the current bisect session?")) void run("bisect_reset").catch(() => undefined); }}>Reset bisect</button>
              </div>
            </article>
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="changes" /></span>
              <h3>Clean untracked</h3>
              <p>TortoiseGit "Clean up": preview or delete untracked files. The dry run lists what would be removed without touching anything.</p>
              <div className="ux-card-actions wrap">
                <button className="ux-button" disabled={busy !== null} onClick={() => void runDirect("Dry-run clean", async () => (await api.cleanUntracked(repositoryPath, true)).stdout || "Nothing to clean.")}>Dry run (list only)</button>
                <button className="ux-danger-button" disabled={operationLocked || busy !== null} onClick={() => { if (window.confirm("Delete all untracked files in this repository? This cannot be undone.")) void runDirect("Clean untracked", async () => (await api.cleanUntracked(repositoryPath, false)).stdout || "Untracked files removed."); }}>Clean (delete)</button>
              </div>
            </article>
            <article className="ux-task-card wide">
              <span className="ux-card-icon"><Icon name="compare" /></span>
              <h3>Create patch</h3>
              <p>TortoiseGit "Create patch": write the diff of a revision or range to a file. Leave "to" empty to diff one revision against its parent.</p>
              <div className="ux-form-grid three">
                <label><span>From</span><input value={patchFrom} onChange={(event: ChangeEvent<HTMLInputElement>) => setPatchFrom(event.target.value)} placeholder="HEAD" /></label>
                <label><span>To (optional)</span><input value={patchTo} onChange={(event: ChangeEvent<HTMLInputElement>) => setPatchTo(event.target.value)} placeholder="main" /></label>
                <label><span>Destination file</span><input value={patchDest} onChange={(event: ChangeEvent<HTMLInputElement>) => setPatchDest(event.target.value)} placeholder="C:/exports/change.patch" /></label>
              </div>
              <div className="ux-card-actions">
                <button className="ux-primary-button" disabled={operationLocked || busy !== null || !patchDest.trim()} onClick={() => void runDirect("Create patch", async () => api.savePatch(repositoryPath, patchFrom.trim(), patchTo.trim(), patchDest.trim()))}>Save patch file</button>
              </div>
            </article>
            <article className="ux-task-card wide">
              <span className="ux-card-icon"><Icon name="upload" /></span>
              <h3>Apply patch</h3>
              <p>Apply a .patch/.diff to the working tree (falls back to a 3-way apply; conflicts are staged for the Conflict Center).</p>
              <div className="ux-form-grid two">
                <label><span>Patch contents</span><textarea rows={4} value={applyPatchData} onChange={(event) => setApplyPatchData(event.target.value)} placeholder="Paste the patch file contents here" /></label>
                <label><span>Destination dir (optional)</span><input value={applyPatchDir} onChange={(event) => setApplyPatchDir(event.target.value)} placeholder="repository root" /></label>
              </div>
              <div className="ux-card-actions">
                <button className="ux-primary-button" disabled={operationLocked || busy !== null || !applyPatchData.trim()} onClick={() => void runDirect("Apply patch", async () => (await api.applyPatch(repositoryPath, b64encode(applyPatchData), applyPatchDir.trim())).stdout || "Patch applied.")}>Apply to working tree</button>
              </div>
            </article>
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="activity" /></span>
              <h3>Verify objects</h3>
              <p>Run a full repository consistency check. This can be expensive on large repositories.</p>
              <button className="ux-button" disabled={busy !== null} onClick={() => void run("fsck").catch(() => undefined)}>Run fsck</button>
            </article>
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="settings" /></span>
              <h3>Maintenance</h3>
              <p>Run Git's configured maintenance tasks for repository housekeeping.</p>
              <button className="ux-button" disabled={operationLocked || busy !== null} onClick={() => void run("maintenance").catch(() => undefined)}>Run maintenance</button>
            </article>
            <article className="ux-task-card">
              <span className="ux-card-icon"><Icon name="layers" /></span>
              <h3>Git LFS</h3>
              <p>Inspect active LFS locks or update/prune local LFS objects.</p>
              <div className="ux-card-actions wrap">
                <button className="ux-button" disabled={busy !== null} onClick={() => void run("lfs_locks").catch(() => undefined)}>Locks</button>
                <button className="ux-button" disabled={operationLocked || busy !== null} onClick={() => void run("lfs_pull").catch(() => undefined)}>Pull</button>
                <button className="ux-button" disabled={operationLocked || busy !== null} onClick={() => void run("lfs_prune").catch(() => undefined)}>Prune</button>
              </div>
            </article>
          </div>
        )}
      </section>

      <SplitHandle
        label="Resize command output"
        onDelta={(delta) => setOutputWidth((width) => Math.min(720, Math.max(280, width - delta)))}
      />

      <aside className="ux-command-output" aria-label="Git command output">
        <header><strong>Command output</strong><span>{busy ? `Running ${busy}…` : "Idle"}</span></header>
        <pre>{output}</pre>
      </aside>
    </div>
  );
}
