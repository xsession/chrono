import { useEffect, useState } from "react";

type Props = {
  path: string;
  /** Date.now() when opening started. */
  since: number;
  /** Covers the repository that is still shown while another one opens. */
  overlay?: boolean;
  onCancel?: () => void;
};

/** Shown while a repository opens. Large repositories (long history, many
 *  files or submodules) can take a while the first time, so after a moment it
 *  says so and counts the seconds; it appears only after a short delay, so
 *  small repositories open without a flash. */
export function RepositoryOpening({ path, since, overlay = false, onCancel }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = now - since;
  if (elapsed < 300) return null;
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  const seconds = Math.floor(elapsed / 1000);
  return (
    <div className={`ux-opening${overlay ? " is-overlay" : ""}`} role="status" aria-live="polite">
      <div className="ux-opening-card">
        <div className="ux-welcome-mark"><i className="ux-spinner" /></div>
        <h1>Opening {name}…</h1>
        <p className="ux-opening-path" title={path}>{path}</p>
        <div className="ux-opening-bar" aria-hidden="true"><i /></div>
        <p>Reading history, branches and working changes.</p>
        {seconds >= 3 && <p className="ux-opening-slow">Still loading · {seconds} s. Large repositories take longer, especially the first time.</p>}
        {onCancel && <button className="ux-button" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
