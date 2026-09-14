import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { BranchRecord } from "../types";
import { Icon } from "./Icon";

type Props = {
  branches: BranchRecord[];
  onCheckout: (branch: string) => Promise<void>;
  onCreate: (branch: string) => Promise<void>;
  disabled?: boolean;
};

export function BranchPanel({ branches, onCheckout, onCreate, disabled = false }: Props) {
  const [query, setQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [busyBranch, setBusyBranch] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? branches.filter((branch) => branch.name.toLowerCase().includes(needle)) : branches;
  }, [branches, query]);

  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);

  const checkout = async (branch: string) => {
    setBusyBranch(branch);
    try { await onCheckout(branch); } finally { setBusyBranch(null); }
  };

  return (
    <div className="ux-branch-view">
      <header className="ux-view-toolbar">
        <div><h2>Branches</h2><span>{branches.length} references</span></div>
        <label className="ux-search-field">
          <Icon name="search" />
          <input value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} placeholder="Filter branches" aria-label="Filter branches" />
        </label>
      </header>

      {disabled && <div className="ux-inline-warning"><Icon name="warning" /><span>Branch changes are locked while a merge, rebase, cherry-pick, or revert is in progress.</span></div>}

      <section className="ux-create-branch-card">
        <div><strong>Create branch</strong><span>Creates and checks out a new branch from the current HEAD.</span></div>
        <div className="ux-inline-form">
          <input value={newBranch} onChange={(event: ChangeEvent<HTMLInputElement>) => setNewBranch(event.target.value)} placeholder="feature/my-change" aria-label="New branch name" />
          <button className="ux-primary-button" disabled={disabled || !newBranch.trim() || busyBranch !== null} onClick={async () => {
            const name = newBranch.trim();
            setBusyBranch(name);
            try { await onCreate(name); setNewBranch(""); } finally { setBusyBranch(null); }
          }}>Create</button>
        </div>
      </section>

      <div className="ux-reference-columns">
        <section className="ux-reference-group">
          <header><strong>Local</strong><span>{local.length}</span></header>
          <div>
            {local.map((branch) => (
              <button key={branch.name} className={`ux-reference-row${branch.current ? " is-current" : ""}`} onClick={() => !branch.current && checkout(branch.name)} disabled={disabled || branch.current || busyBranch !== null}>
                <Icon name="branch" />
                <span className="ux-reference-name"><strong>{branch.name}</strong><small>{branch.upstream || "No upstream"}</small></span>
                {branch.current ? <span className="ux-current-pill">Current</span> : <code>{busyBranch === branch.name ? "switching" : branch.target.slice(0, 8)}</code>}
              </button>
            ))}
            {!local.length && <div className="ux-empty-state">No local branches match this filter.</div>}
          </div>
        </section>

        <section className="ux-reference-group">
          <header><strong>Remote</strong><span>{remote.length}</span></header>
          <div>
            {remote.map((branch) => (
              <div key={branch.name} className="ux-reference-row is-readonly">
                <Icon name="upload" />
                <span className="ux-reference-name"><strong>{branch.name}</strong><small>{branch.upstream || "Remote tracking reference"}</small></span>
                <code>{branch.target.slice(0, 8)}</code>
              </div>
            ))}
            {!remote.length && <div className="ux-empty-state">No remote branches match this filter.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
