import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, MouseEvent } from "react";
import { Icon } from "./Icon";

// Browser fallback for the native "select a directory" picker: ask for the
// destination path directly (it must exist or be creatable on the server host).
const promptCloneDestination = (initial: string): Promise<string | null> =>
  new Promise((resolve) => {
    const value = window.prompt("Clone destination", initial);
    resolve(value ? value.trim() : null);
  });

type Props = {
  openDialog: boolean;
  busy: boolean;
  onClose: () => void;
  onClone: (url: string, destination: string) => Promise<void>;
};

export function CloneDialog({ openDialog, busy, onClose, onClone }: Props) {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!openDialog) return;
    setUrl("");
    setDestination("");
    requestAnimationFrame(() => urlRef.current?.focus());
  }, [openDialog]);

  if (!openDialog) return null;

  const browse = async () => {
    const selected = await promptCloneDestination(destination);
    if (selected) setDestination(selected);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextUrl = url.trim();
    const nextDestination = destination.trim();
    if (!nextUrl || !nextDestination || busy) return;
    try {
      await onClone(nextUrl, nextDestination);
    } catch {
      // App-level status messaging already surfaces the failure; keep the dialog open for correction.
    }
  };

  return (
    <div className="ux-modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="ux-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-dialog-title"
        onSubmit={submit}
        onMouseDown={(event: MouseEvent<HTMLFormElement>) => event.stopPropagation()}
      >
        <header>
          <span className="ux-dialog-icon"><Icon name="download" /></span>
          <div><h2 id="clone-dialog-title">Clone repository</h2><p>Create a local working copy from a remote Git URL.</p></div>
        </header>
        <div className="ux-dialog-body">
          <label className="ux-field-stack">
            <span>Repository URL</span>
            <input
              ref={urlRef}
              value={url}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/project.git"
              autoComplete="off"
            />
          </label>
          <label className="ux-field-stack">
            <span>Destination</span>
            <div className="ux-path-field">
              <input
                value={destination}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setDestination(event.target.value)}
                placeholder="C:\\Projects\\project"
                autoComplete="off"
              />
              <button type="button" className="ux-button" disabled={busy} onClick={() => void browse()}>Browse…</button>
            </div>
          </label>
          <p className="ux-help-text">Credentials are handled by the configured Git credential flow; they are not stored in this dialog.</p>
        </div>
        <footer>
          <button type="button" className="ux-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="ux-primary-button" disabled={!url.trim() || !destination.trim() || busy}>{busy ? "Cloning…" : "Clone"}</button>
        </footer>
      </form>
    </div>
  );
}
