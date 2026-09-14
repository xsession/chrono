import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { CommandResult, WorkflowRequest } from "../types";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";

export type WorkflowSection = "worktrees" | "submodules" | "stashes" | "recovery";

type Props = {
  section: WorkflowSection;
  onRun: (request: WorkflowRequest) => Promise<CommandResult>;
  operationLocked?: boolean;
};

type RunOptions = { quiet?: boolean };

type WorktreeInfo = {
  path: string;
  head: string;
  branch: string;
  locked: string;
  prunable: string;
};

function parseWorktrees(output: string): WorktreeInfo[] {
  return output.trim().split(/\n\s*\n/).filter(Boolean).map((block) => {
    const record: WorktreeInfo = { path: "", head: "", branch: "Detached HEAD", locked: "", prunable: "" };
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") record.path = value;
      if (key === "HEAD") record.head = value;
      if (key === "branch") record.branch = value.replace(/^refs\/heads\//, "");
      if (key === "detached") record.branch = "Detached HEAD";
      if (key === "locked") record.locked = value || "Locked";
      if (key === "prunable") record.prunable = value || "Prunable";
    }
    return record;
  }).filter((record) => record.path);
}

function parseStashes(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function WorkflowPanel({ section, onRun, operationLocked = false }: Props) {
  const [output, setOutput] = useState("No command has run yet.");
  const [busy, setBusy] = useState<string | null>(null);
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeRef, setWorktreeRef] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [outputWidth, setOutputWidth] = useState(360);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [stashes, setStashes] = useState<string[]>([]);

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

  const refreshSection = async () => {
    if (section === "worktrees") {
      const result = await run("worktree_list");
      setWorktrees(parseWorktrees(result.stdout));
      return;
    }
    if (section === "stashes") {
      const result = await run("stash_list");
      setStashes(parseStashes(result.stdout));
      return;
    }
    if (section === "recovery") {
      await run("reflog");
      return;
    }
    setOutput("Submodule status is not structured yet. No write operation was run automatically; use Sync only when you explicitly want to update local submodule URLs.");
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
                  const result = await run("worktree_list", [], { quiet: false });
                  setWorktrees(parseWorktrees(result.stdout));
                }}>Create worktree</button>
                <button className="ux-button" disabled={operationLocked || busy !== null} onClick={() => void run("worktree_prune").catch(() => undefined)}>Prune stale metadata</button>
              </div>
            </article>
            <article className="ux-task-card wide">
              <div className="ux-section-title"><strong>Linked worktrees</strong><span>{worktrees.length}</span></div>
              <div className="ux-worktree-table" role="table" aria-label="Linked worktrees">
                <div className="ux-worktree-row is-header" role="row"><span role="columnheader">Branch</span><span role="columnheader">Path</span><span role="columnheader">HEAD</span><span role="columnheader">State</span></div>
                {worktrees.map((worktree) => (
                  <div className="ux-worktree-row" role="row" key={worktree.path}>
                    <strong role="cell">{worktree.branch}</strong><span role="cell" title={worktree.path}>{worktree.path}</span><code role="cell">{worktree.head.slice(0, 8)}</code><span role="cell">{worktree.locked || worktree.prunable || "Ready"}</span>
                  </div>
                ))}
                {!worktrees.length && <div className="ux-empty-state">No worktree records returned.</div>}
              </div>
            </article>
            <article className="ux-task-card wide is-muted">
              <h3>Safety model</h3>
              <p>Removal is intentionally not exposed as a one-click action until the backend returns dirty state and lock metadata suitable for a destructive-action confirmation.</p>
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
            <article className="ux-task-card wide is-muted">
              <h3>Next backend slice</h3>
              <p>Expose structured submodule status (path, expected commit, checked-out commit, branch, initialized/dirty state) so this screen can become a table instead of command output.</p>
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
                  const result = await run("stash_list");
                  setStashes(parseStashes(result.stdout));
                }}>Stash changes</button>
                <button className="ux-button" disabled={operationLocked || busy !== null} onClick={async () => { await run("stash_pop"); const result = await run("stash_list"); setStashes(parseStashes(result.stdout)); }}>Pop latest</button>
              </div>
              <div className="ux-stash-list" aria-label="Stashes">
                {stashes.map((stash) => <code key={stash}>{stash}</code>)}
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
