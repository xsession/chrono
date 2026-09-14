import { useRef, useState } from "react";
import type { RepositoryOperationState } from "../types";
import { Icon } from "./Icon";

type Props = {
  state: RepositoryOperationState;
  busy: boolean;
  onResolve: () => void;
  onContinue: () => Promise<boolean>;
  onSkip: () => Promise<boolean>;
  onAbort: () => Promise<boolean>;
};

const labels: Record<NonNullable<RepositoryOperationState["operation"]>, string> = {
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Cherry-pick",
  revert: "Revert"
};

export function OperationBanner({ state, busy, onResolve, onContinue, onSkip, onAbort }: Props) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [pending, setPending] = useState<"continue" | "skip" | "abort" | null>(null);
  const abortTriggerRef = useRef<HTMLButtonElement>(null);

  if (!state.operation) return null;

  const label = labels[state.operation];
  const progress = state.step && state.total ? `${state.step} of ${state.total}` : null;

  const closeAbort = () => {
    setConfirmAbort(false);
    window.requestAnimationFrame(() => abortTriggerRef.current?.focus());
  };

  const run = async (kind: "continue" | "skip" | "abort", action: () => Promise<boolean>) => {
    setPending(kind);
    try {
      const succeeded = await action();
      if (kind === "abort" && succeeded && abortTriggerRef.current) closeAbort();
    } finally {
      setPending(null);
    }
  };

  return (
    <section className={`ux-git-operation${state.hasConflicts ? " has-conflicts" : ""}`} aria-label={`${label} in progress`}>
      <div className="ux-operation-status-icon"><Icon name={state.hasConflicts ? "warning" : "activity"} /></div>
      <div className="ux-operation-copy">
        <div className="ux-operation-title-row">
          <strong>{label} in progress</strong>
          {progress && <span className="ux-operation-progress">{progress}</span>}
          {state.currentSubject && <span className="ux-operation-subject" title={state.currentSubject}>{state.currentSubject}</span>}
        </div>
        <span>{state.message}</span>
      </div>
      <div className="ux-operation-actions" role="toolbar" aria-label={`${label} controls`}>
        {state.hasConflicts && (
          <button className="ux-button" disabled={busy || pending !== null} onClick={onResolve}>
            Resolve {state.conflictCount} conflict{state.conflictCount === 1 ? "" : "s"}
          </button>
        )}
        <button
          className="ux-primary-button compact"
          disabled={busy || pending !== null || !state.canContinue}
          onClick={() => void run("continue", onContinue)}
        >
          {pending === "continue" ? "Continuing…" : "Continue"}
        </button>
        {state.canSkip && (
          <button className="ux-button" disabled={busy || pending !== null} onClick={() => void run("skip", onSkip)}>
            {pending === "skip" ? "Skipping…" : "Skip commit"}
          </button>
        )}
        {state.canAbort && <button ref={abortTriggerRef} className="ux-danger-button" disabled={busy || pending !== null} onClick={() => setConfirmAbort(true)}>Abort…</button>}
      </div>

      {confirmAbort && (
        <div className="ux-confirm-backdrop" role="presentation" onMouseDown={closeAbort}>
          <div
            className="ux-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="abort-operation-title"
            aria-describedby="abort-operation-description"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); closeAbort(); return; }
              if (event.key !== "Tab") return;
              const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")] as HTMLButtonElement[];
              if (!buttons.length) return;
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }}
          >
            <div className="ux-confirm-icon"><Icon name="warning" /></div>
            <div>
              <h2 id="abort-operation-title">Abort {label.toLowerCase()}?</h2>
              <p id="abort-operation-description">This asks Git to return the operation to its pre-{label.toLowerCase()} state. Any conflict-resolution edits made as part of this operation may be discarded.</p>
            </div>
            <div className="ux-confirm-actions">
              <button className="ux-button" autoFocus onClick={closeAbort}>Keep working</button>
              <button className="ux-danger-button solid" disabled={pending !== null} onClick={() => void run("abort", onAbort)}>
                {pending === "abort" ? "Aborting…" : `Abort ${label.toLowerCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
