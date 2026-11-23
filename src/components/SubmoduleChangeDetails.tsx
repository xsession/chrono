import { useState } from "react";
import { api } from "../api";
import type { FileChange, SubmoduleChange } from "../types";

// What changed inside a submodule, shown under its row in the WIP panel and in
// the Changes view: commits on top of the recorded one, then the changed files
// inside it (nested submodules expand the same way). Files open their diff and
// stage or unstage in the submodule's own index.

export type DiffGroup = "unstaged" | "staged";

type Props = {
  info: SubmoduleChange;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  /** Open `file` (relative to `repository`) in the diff view. */
  onOpenDiff: (file: string, group: DiffGroup, repository: string) => void;
  /** `${repository}\u0000${file}` of the diff being shown, to highlight it. */
  openDiffKey?: string | null;
  onOpenRepository?: (repository: string) => void;
  depth?: number;
};

const isStaged = (change: FileChange) => !change.conflicted && change.indexStatus !== " " && change.indexStatus !== "?";
const isUnstaged = (change: FileChange) => change.conflicted || change.worktreeStatus !== " " || change.indexStatus === "?";

function badge(change: FileChange): { mark: string; kind: string; label: string } {
  if (change.conflicted) return { mark: "!", kind: "conflicted", label: "Conflicted" };
  if (change.submodule) return { mark: "S", kind: "submodule", label: "Submodule changed" };
  const code = change.indexStatus === "?" ? "?" : change.worktreeStatus !== " " ? change.worktreeStatus : change.indexStatus;
  switch (code) {
    case "?": return { mark: "+", kind: "untracked", label: "Untracked" };
    case "A": return { mark: "+", kind: "added", label: "Added" };
    case "D": return { mark: "−", kind: "deleted", label: "Deleted" };
    case "R": return { mark: "→", kind: "renamed", label: "Renamed" };
    default: return { mark: "✎", kind: "modified", label: "Modified" };
  }
}

/** One-line summary, e.g. "2 new commits · 3 changed files". */
export function submoduleSummary(info: SubmoduleChange): string {
  const parts: string[] = [];
  if (info.newCommits) {
    if (info.movedBack) parts.push("checked out a different commit");
    else parts.push(`${info.commits.length}${info.moreCommits ? "+" : ""} new commit${info.commits.length === 1 && !info.moreCommits ? "" : "s"}`);
  }
  if (info.changes.length) parts.push(`${info.changes.length} changed file${info.changes.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "changed";
}

export function SubmoduleChangeDetails({ info, busy, run, onOpenDiff, openDiffKey, onOpenRepository, depth = 0 }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = [...info.changes].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <div className="gk-sub-details" style={{ marginLeft: depth ? 14 : 0 }}>
      {info.newCommits && (
        <div className="gk-sub-commits" aria-label="New commits in the submodule">
          {info.movedBack ? (
            <div className="gk-sub-note">Checked out {info.head?.slice(0, 8) ?? "?"}; the superproject records {info.recorded?.slice(0, 8) ?? "?"}.</div>
          ) : info.commits.map((commit) => (
            <div key={commit.sha} className="gk-sub-commit" title={commit.sha}><code>{commit.sha.slice(0, 7)}</code><span>{commit.subject}</span></div>
          ))}
          {info.moreCommits && <div className="gk-sub-note">…and more</div>}
        </div>
      )}
      {rows.map((change) => {
        const meta = badge(change);
        const unstaged = isUnstaged(change);
        const group: DiffGroup = unstaged ? "unstaged" : "staged";
        const key = `${info.root}\u0000${change.path}`;
        const open = !collapsed.has(change.path);
        const toggle = () => setCollapsed((current) => { const next = new Set(current); if (next.has(change.path)) next.delete(change.path); else next.add(change.path); return next; });
        return (
          <div key={change.path}>
            <div
              className={`gk-wip-file gk-sub-file${openDiffKey === key ? " is-open" : ""}`}
              role="button"
              tabIndex={0}
              title={`${meta.label}: ${change.path}${isStaged(change) && unstaged ? " (partly staged)" : isStaged(change) ? " (staged in the submodule)" : ""}`}
              onClick={() => (change.submodule ? toggle() : onOpenDiff(change.path, group, info.root))}
              onKeyDown={(event) => { if (event.key === "Enter") { if (change.submodule) toggle(); else onOpenDiff(change.path, group, info.root); } }}
            >
              <span className={`gk-file-badge is-${meta.kind}`} aria-label={meta.label}>{meta.mark}</span>
              <span className="gk-wip-path">
                <span>{change.path}</span>
                {change.submodule && <small className="gk-sub-summary"> {open ? "▾" : "▸"} {submoduleSummary(change.submodule)}</small>}
                {!change.submodule && isStaged(change) && <small className="gk-sub-staged"> staged</small>}
              </span>
              {!change.conflicted && (
                <button
                  type="button"
                  className={`gk-wip-file-action${unstaged ? "" : " is-unstage"}`}
                  disabled={busy}
                  title={`${unstaged ? "Stage" : "Unstage"} in ${info.root.split(/[\\/]/).pop()}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void run(unstaged ? "Stage in submodule" : "Unstage in submodule", () => (unstaged ? api.stage(info.root, [change.path]) : api.unstage(info.root, [change.path])));
                  }}
                >{unstaged ? "Stage" : "Unstage"}</button>
              )}
            </div>
            {change.submodule && open && (
              <SubmoduleChangeDetails info={change.submodule} busy={busy} run={run} onOpenDiff={onOpenDiff} openDiffKey={openDiffKey} onOpenRepository={onOpenRepository} depth={depth + 1} />
            )}
          </div>
        );
      })}
      {onOpenRepository && depth === 0 && (
        <button type="button" className="gk-link-button gk-sub-open" onClick={() => onOpenRepository(info.root)}>Open {info.root.split(/[\\/]/).pop()} in a tab</button>
      )}
    </div>
  );
}
