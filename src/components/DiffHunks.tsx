import type { CommitDiffHunk } from "../types";

/** Renders unified-diff hunks with dual line-number gutters. Shared by the
 *  commit-file diff view and the working-tree diff view. */
export function DiffHunks({ hunks }: { hunks: CommitDiffHunk[] }) {
  return (
    <div className="ux-commit-diff-body">
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="ux-diff-hunk">
          <div className="ux-diff-hunk-header">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header ? ` ${hunk.header}` : ""}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`ux-diff-line ux-diff-line--${line.kind}`}>
              <span className="ux-diff-no ux-diff-no--old">{line.kind === "del" || line.kind === "ctx" ? line.number : ""}</span>
              <span className="ux-diff-no ux-diff-no--new">{line.kind === "add" || line.kind === "ctx" ? line.number : ""}</span>
              <span className="ux-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
              <code>{line.text}</code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
