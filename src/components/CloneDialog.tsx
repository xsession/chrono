import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, MouseEvent } from "react";
import { Icon } from "./Icon";
import { chooseFolder } from "./FolderPicker";
import type { CloneOptions } from "../types";
import { GithubRepoPicker } from "./gk/GithubRepoPicker";

type Props = {
  openDialog: boolean;
  busy: boolean;
  onClose: () => void;
  onClone: (url: string, destination: string, options: CloneOptions) => Promise<void>;
};

export function CloneDialog({ openDialog, busy, onClose, onClone }: Props) {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [depth, setDepth] = useState("");
  const [filter, setFilter] = useState<"" | "blob:none" | "tree:0">("");
  const [sparse, setSparse] = useState(false);
  const [branch, setBranch] = useState("");
  const [singleBranch, setSingleBranch] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [protocol, setProtocol] = useState<"https" | "ssh">(() => (localStorage.getItem("chrono.clone.protocol") === "ssh" ? "ssh" : "https"));
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!openDialog) return;
    setUrl("");
    setDestination("");
    requestAnimationFrame(() => urlRef.current?.focus());
  }, [openDialog]);

  if (!openDialog) return null;

  const browse = async () => {
    const selected = await chooseFolder("Clone into folder", { initial: destination, confirm: "Use" });
    if (selected) setDestination(selected);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextUrl = url.trim();
    const nextDestination = destination.trim();
    if (!nextUrl || !nextDestination || busy) return;
    try {
      await onClone(nextUrl, nextDestination, { depth: depth ? Number(depth) : null, filter: filter || null, sparse, branch: branch.trim() || null, singleBranch });
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
          <button type="button" className="gk-link-button gh-browse-toggle" onClick={() => setBrowsing((value) => !value)} aria-expanded={browsing}>{browsing ? "Hide your GitHub repositories" : "Browse your GitHub repositories…"}</button>
          {browsing && <GithubRepoPicker compact protocol={protocol} onProtocol={(value) => { setProtocol(value); localStorage.setItem("chrono.clone.protocol", value); }} onPick={(repo, picked) => {
            setUrl(picked);
            // Suggest <parent of the current destination>/<repository name>.
            setDestination((current) => { const parent = current.trim().replace(/[\\/][^\\/]*$/, ""); return parent ? `${parent}/${repo.name}` : current; });
            setBrowsing(false);
          }} />}
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
          <button type="button" className="gk-link-button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>{advanced ? "Hide" : "Show"} large-repository options</button>
          {advanced && (
            <div className="st-grid">
              <label>Shallow depth (commits)<input type="number" min={1} value={depth} onChange={(event) => setDepth(event.target.value)} placeholder="full history" /></label>
              <label>Partial clone<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="">Full (all blobs)</option><option value="blob:none">Blobless (--filter=blob:none)</option><option value="tree:0">Treeless (--filter=tree:0)</option></select></label>
              <label>Branch<input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="default branch" /></label>
              <label className="st-check"><input type="checkbox" checked={singleBranch} onChange={(event) => setSingleBranch(event.target.checked)} />Single branch</label>
              <label className="st-check"><input type="checkbox" checked={sparse} onChange={(event) => setSparse(event.target.checked)} />Sparse checkout (root files only; pick folders in Settings)</label>
            </div>
          )}
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
