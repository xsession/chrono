import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import type {
  ConflictFileDetail,
  ConflictFileSummary,
  ConflictResolutionRequest,
  ConflictStage,
  RepositoryOperationKind
} from "../types";
import { api } from "../api";
import { parseConflictBlocks, replaceConflictBlock } from "../conflictMarkers";
import { Icon } from "./Icon";

type Props = {
  repositoryPath: string;
  operation: RepositoryOperationKind | null;
  onRepositoryChanged: () => Promise<void>;
};

const kindLabels: Record<ConflictFileSummary["kind"], string> = {
  content: "Both modified",
  addAdd: "Both added",
  currentDeleted: "Deleted / modified",
  incomingDeleted: "Modified / deleted",
  bothDeleted: "Both deleted",
  complex: "Complex conflict"
};

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function StagePreview({ label, stage }: { label: string; stage: ConflictStage | null }) {
  return (
    <section className="ux-conflict-stage">
      <header>
        <strong>{label}</strong>
        {stage && <span>{stage.kind === "gitlink" ? "submodule" : stage.kind === "symlink" ? "symlink" : formatSize(stage.size)}</span>}
      </header>
      {!stage && <div className="ux-stage-empty"><Icon name="minus" /><span>Deleted on this side</span></div>}
      {stage?.kind === "gitlink" && (
        <div className="ux-stage-special"><span>Gitlink commit</span><code>{stage.oid}</code></div>
      )}
      {stage?.kind === "symlink" && (
        <div className="ux-stage-special"><span>Symbolic link target</span><code>{stage.text || stage.oid}</code></div>
      )}
      {stage?.binary && (
        <div className="ux-stage-special"><span>Binary content</span><code>{stage.oid.slice(0, 12)}</code><small>{formatSize(stage.size)}</small></div>
      )}
      {stage?.truncated && (
        <div className="ux-stage-special"><span>Too large for inline editing</span><code>{stage.oid.slice(0, 12)}</code><small>{formatSize(stage.size)}</small></div>
      )}
      {stage?.kind === "blob" && !stage.binary && !stage.truncated && <pre>{stage.text ?? ""}</pre>}
    </section>
  );
}

export function ConflictCenter({ repositoryPath, operation, onRepositoryChanged }: Props) {
  const [conflicts, setConflicts] = useState<ConflictFileSummary[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConflictFileDetail | null>(null);
  const [mergedText, setMergedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConflicts = useCallback(async (preferred?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.conflicts(repositoryPath);
      setConflicts(next);
      setSelectedPath((current) => {
        if (preferred && next.some((item) => item.path === preferred)) return preferred;
        if (current && next.some((item) => item.path === current)) return current;
        return next[0]?.path ?? null;
      });
      if (!next.length) setDetail(null);
      return next;
    } catch (reason) {
      setError(String(reason));
      return [];
    } finally {
      setLoading(false);
    }
  }, [repositoryPath]);

  useEffect(() => { void loadConflicts(); }, [loadConflicts]);

  useEffect(() => {
    if (!selectedPath) { setDetail(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.conflictDetail(repositoryPath, selectedPath)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setMergedText(next.workingText ?? next.current?.text ?? next.incoming?.text ?? "");
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repositoryPath, selectedPath]);

  const markerBlocks = useMemo(() => parseConflictBlocks(mergedText), [mergedText]);
  const selectedSummary = conflicts.find((item) => item.path === selectedPath) ?? null;
  const textEditable = Boolean(detail)
    && !detail!.workingBinary
    && !detail!.workingTruncated
    && [detail!.base, detail!.current, detail!.incoming].filter(Boolean).every((stage) => stage!.kind === "blob" && !stage!.binary && !stage!.truncated);

  const applyBlock = (index: number, choice: "current" | "incoming" | "bothCurrent" | "bothIncoming") => {
    setMergedText((current) => replaceConflictBlock(current, index, choice));
  };

  const resolve = async (request: ConflictResolutionRequest, label: string) => {
    if (!selectedPath || pending) return;
    setPending(label);
    setError(null);
    try {
      const result = await api.resolveConflict(repositoryPath, request);
      await loadConflicts(result.nextPath);
      await onRepositoryChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(null);
    }
  };

  const selectedCanEdit = textEditable && detail !== null;
  const hasCurrent = Boolean(detail?.current);
  const hasIncoming = Boolean(detail?.incoming);

  if (error && !conflicts.length && !loading) {
    return (
      <div className="ux-conflict-center ux-conflicts-done is-error">
        <Icon name="warning" />
        <h2>Conflict Center unavailable</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!conflicts.length && !loading) {
    return (
      <div className="ux-conflict-center ux-conflicts-done">
        <Icon name="check" />
        <h2>All conflicts resolved</h2>
        <p>The index no longer contains unmerged entries. {operation ? "Use Continue in the operation banner to resume Git." : "You can return to Changes or History."}</p>
      </div>
    );
  }

  return (
    <div className="ux-conflict-center">
      <aside className="ux-conflict-files" aria-label="Unresolved files">
        <header>
          <div><span className="ux-eyebrow">Conflict Center</span><strong>{conflicts.length} unresolved</strong></div>
          <button className="ux-icon-button" onClick={() => void loadConflicts(selectedPath)} title="Refresh conflicts" aria-label="Refresh conflicts"><Icon name="refresh" /></button>
        </header>
        <div className="ux-conflict-file-list">
          {conflicts.map((conflict) => (
            <button
              key={conflict.path}
              className={conflict.path === selectedPath ? "is-active" : ""}
              onClick={() => setSelectedPath(conflict.path)}
              title={conflict.path}
            >
              <Icon name={conflict.special ? "submodule" : conflict.binary ? "file" : "warning"} />
              <span><strong>{conflict.path.split(/[\\/]/).pop()}</strong><small>{conflict.path}</small></span>
              <em>{conflict.special ? "Special" : conflict.binary ? "Binary" : kindLabels[conflict.kind]}</em>
            </button>
          ))}
        </div>
      </aside>

      <main className="ux-conflict-workspace">
        <header className="ux-conflict-toolbar">
          <div>
            <span className="ux-eyebrow">Three-way resolution</span>
            <h2 title={selectedPath || undefined}>{selectedPath || "Select a conflict"}</h2>
            {selectedSummary && <small>{kindLabels[selectedSummary.kind]}{selectedSummary.tooLarge ? " · large file" : ""}</small>}
          </div>
          <div className="ux-conflict-toolbar-actions">
            <button
              className="ux-button"
              disabled={!detail || pending !== null}
              onClick={() => void resolve({ file: detail!.path, strategy: "current" }, hasCurrent ? "current" : "delete-current")}
            >
              {hasCurrent ? `Use ${detail?.labels.current || "current"}` : `Accept deletion (${detail?.labels.current || "current"})`}
            </button>
            <button
              className="ux-button"
              disabled={!detail || pending !== null}
              onClick={() => void resolve({ file: detail!.path, strategy: "incoming" }, hasIncoming ? "incoming" : "delete-incoming")}
            >
              {hasIncoming ? `Use ${detail?.labels.incoming || "incoming"}` : `Accept deletion (${detail?.labels.incoming || "incoming"})`}
            </button>
          </div>
        </header>

        {error && <div className="ux-inline-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}

        {detail ? (
          <>
            <div className="ux-conflict-stages">
              <StagePreview label={detail.labels.base} stage={detail.base} />
              <StagePreview label={detail.labels.current} stage={detail.current} />
              <StagePreview label={detail.labels.incoming} stage={detail.incoming} />
            </div>

            <section className="ux-merge-result">
              <header>
                <div>
                  <strong>Merged result</strong>
                  <span>{selectedCanEdit ? markerBlocks.length ? `${markerBlocks.length} unresolved block${markerBlocks.length === 1 ? "" : "s"}` : "Ready to stage" : "Side selection only for this conflict type"}</span>
                </div>
                <div>
                  {selectedCanEdit && <button className="ux-button" disabled={pending !== null} onClick={() => setMergedText(detail.workingText ?? detail.current?.text ?? detail.incoming?.text ?? "")}>Reset working copy</button>}
                  {selectedCanEdit && (
                    <button
                      className="ux-primary-button compact"
                      disabled={pending !== null || markerBlocks.length > 0}
                      title={markerBlocks.length ? "Resolve all conflict blocks before staging" : "Write this result and stage the file"}
                      onClick={() => void resolve({ file: detail.path, strategy: "merged", content: mergedText }, "merged")}
                    >
                      {pending === "merged" ? "Saving…" : "Save, stage & next"}
                    </button>
                  )}
                </div>
              </header>

              {selectedCanEdit && markerBlocks.length > 0 && (
                <div className="ux-conflict-block-list" aria-label="Conflict blocks">
                  {markerBlocks.map((_, index) => (
                    <div key={`${detail.path}-block-${index}`}>
                      <strong>Conflict {index + 1}</strong>
                      <button onClick={() => applyBlock(index, "current")}>Use {detail.labels.current}</button>
                      <button onClick={() => applyBlock(index, "incoming")}>Use {detail.labels.incoming}</button>
                      <button onClick={() => applyBlock(index, "bothCurrent")}>Both · current first</button>
                      <button onClick={() => applyBlock(index, "bothIncoming")}>Both · incoming first</button>
                    </div>
                  ))}
                </div>
              )}

              {selectedCanEdit ? (
                <textarea
                  aria-label={`Merged result for ${detail.path}`}
                  value={mergedText}
                  spellCheck={false}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setMergedText(event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && markerBlocks.length === 0 && pending === null) {
                      event.preventDefault();
                      void resolve({ file: detail.path, strategy: "merged", content: mergedText }, "merged");
                    }
                  }}
                />
              ) : (
                <div className="ux-merge-special">
                  <Icon name={detail.current?.kind === "gitlink" || detail.incoming?.kind === "gitlink" ? "submodule" : "file"} />
                  <strong>{detail.workingBinary ? "Binary conflict" : detail.workingTruncated ? "Large file conflict" : "Special Git object conflict"}</strong>
                  <span>Inline text editing is intentionally disabled. Choose the correct side above, or stage a working copy you resolved with an external tool.</span>
                  <button className="ux-button" disabled={pending !== null} onClick={() => void resolve({ file: detail.path, strategy: "working" }, "working")}>Stage working copy & next</button>
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="ux-empty-state large"><Icon name="warning" /><strong>{loading ? "Loading conflict…" : "Select a conflict"}</strong></div>
        )}
      </main>
    </div>
  );
}
