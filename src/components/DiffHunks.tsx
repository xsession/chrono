import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { CommitDiffHunk } from "../types";

/** Renders unified-diff hunks with dual line-number gutters. Shared by the
 *  commit-file diff view and the working-tree diff view. */
export function DiffHunks({ hunks }: { hunks: CommitDiffHunk[] }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Accessible diff navigation (VS Code style): F7 / Shift+F7 move focus
  // between hunks; each hunk announces its range and change counts.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "F7") return;
    event.preventDefault();
    const items = [...(bodyRef.current?.querySelectorAll<HTMLElement>(".ux-diff-hunk") ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
  };
  return (
    <div className="ux-commit-diff-body" ref={bodyRef} onKeyDown={onKeyDown} role="document" aria-label={`Diff with ${hunks.length} hunk${hunks.length === 1 ? "" : "s"}. Press F7 for the next hunk.`}>
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="ux-diff-hunk" tabIndex={0} aria-label={`Hunk ${hunkIndex + 1} of ${hunks.length}: lines ${hunk.newStart} to ${hunk.newStart + Math.max(0, hunk.newLines - 1)}, ${hunk.lines.filter((line) => line.kind === "add").length} added, ${hunk.lines.filter((line) => line.kind === "del").length} removed`}>
          <div className="ux-diff-hunk-header">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header ? ` ${hunk.header}` : ""}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`ux-diff-line ux-diff-line--${line.kind}`}>
              <span className="ux-diff-no ux-diff-no--old">{line.kind === "del" || line.kind === "ctx" ? line.number : ""}</span>
              <span className="ux-diff-no ux-diff-no--new">{line.kind === "add" || line.kind === "ctx" ? line.number : ""}</span>
              <span className="ux-diff-mark" aria-label={line.kind === "add" ? "added" : line.kind === "del" ? "removed" : undefined}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
              <code>{line.text}</code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
