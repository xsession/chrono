import { useEffect, useState } from "react";
import { api } from "../api";
import type { GitLogEntry } from "../types";

// v6 git executor log viewer (GitKraken RE §6: GIT_EXECUTOR_COMMAND_ID correlation).
export function GitLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.gitLog(200)
      .then((rows) => { if (!cancelled) setEntries(rows); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ux-modal-backdrop" onClick={onClose}>
      <div className="ux-dialog ux-gitlog-dialog" role="dialog" aria-label="Git executor log" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Git executor log</h2>
          <button type="button" className="ux-button compact" onClick={onClose}>Close</button>
        </header>
        <div className="ux-dialog-body">
          {error && <p className="ux-help-text">{error}</p>}
          {!entries.length && !error && <p className="ux-help-text">No git commands recorded yet — run any repository action.</p>}
          {entries.map((entry) => (
            <div key={entry.id} className={`ux-gitlog-entry ${entry.exitCode === 0 ? "is-ok" : "is-err"}`}>
              <div className="ux-gitlog-head">
                <code>{entry.commandId}</code>
                <span>git {entry.args.join(" ")}</span>
                <em>{entry.exitCode} · {Math.round(entry.durationMs)} ms</em>
              </div>
              {(entry.stdoutTail || entry.stderrTail) && (
                <pre>{[entry.stdoutTail, entry.stderrTail].filter(Boolean).join("\n")}</pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
