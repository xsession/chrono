import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ForkStatus, ForkSyncResult } from "../types";
import { askConfirm, askText } from "./DialogHost";
import { Icon } from "./Icon";
import { pushToast } from "../toastBus";

// Forks & upstreams: the repository and every submodule in one table, with how
// far each fork is behind the repository it was forked from, and the actions
// to keep it current (server/src/forks.ts).

type Props = {
  repositoryPath: string;
  refreshKey: number;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onOpenRepository: (path: string) => void;
};

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");
const label = (remote: ForkStatus["origin"]) => (remote ? (remote.owner && remote.repository ? `${remote.owner}/${remote.repository}` : remote.url) : "—");
function ago(iso: string | null): string {
  if (!iso) return "never fetched";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return minutes < 2 ? "fetched just now" : minutes < 90 ? `fetched ${minutes} min ago` : minutes < 48 * 60 ? `fetched ${Math.round(minutes / 60)} h ago` : `fetched ${Math.round(minutes / 1440)} days ago`;
}

/** One-line summary used by badges elsewhere (toolbar, submodule list). */
export function forkBadge(status: ForkStatus | undefined): { text: string; title: string; stale: boolean } | null {
  if (!status || status.kind !== "fork" || !status.upstream) return null;
  const behind = status.behind ?? status.branchBehind ?? 0;
  const text = behind ? `fork ↓${behind}` : "fork ✓";
  const title = `Fork of ${label(status.upstream)}${status.defaultBranch ? ` (${status.defaultBranch})` : ""}: ${behind ? `${behind} commit(s) behind upstream` : "up to date with upstream"} · ${ago(status.fetchedAt)}`;
  return { text, title, stale: behind > 0 };
}

export function ForksView({ repositoryPath, refreshKey, busy, run, onOpenRepository }: Props) {
  const [tree, setTree] = useState<ForkStatus[] | null>(null);
  const [push, setPush] = useState(() => localStorage.getItem("chrono.forks.push") === "1");
  const [results, setResults] = useState<ForkSyncResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTree(await api.forkTree(repositoryPath)); setError(null); } catch (failure) { setError(errorText(failure)); }
  }, [repositoryPath]);
  // A new repository starts empty; a refresh (after an action) keeps the last results.
  useEffect(() => { setTree(null); setResults(null); }, [repositoryPath]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const choosePush = (value: boolean) => { setPush(value); localStorage.setItem("chrono.forks.push", value ? "1" : "0"); };
  const forks = tree?.filter((entry) => entry.kind === "fork") ?? [];
  const where = (entry: ForkStatus) => entry.path || "this repository";

  const addUpstream = async (entry: ForkStatus) => {
    let suggestion = "";
    try { suggestion = (await api.forkDetectParent(repositoryPath, entry.path))?.url ?? ""; } catch { suggestion = ""; }
    const url = await askText(
      `Upstream for ${where(entry)}`,
      suggestion ? "The repository this was forked from (found on the server)" : "URL of the repository this was forked from",
      suggestion,
      { placeholder: "https://github.com/original-owner/repository.git", confirm: "Add upstream" },
    );
    if (url?.trim()) await run(`Add upstream to ${where(entry)}`, async () => { await api.forkAddUpstream(repositoryPath, entry.path, url.trim()); await load(); });
  };
  const sync = (entry: ForkStatus, withPush: boolean) => run(`Sync ${where(entry)} with upstream`, async () => {
    const result = await api.forkSync(repositoryPath, entry.path, withPush);
    pushToast(`${where(entry)}: ${result.message}`, result.ok ? "success" : "error", result.ok ? 5000 : 12000);
    await load();
  });
  const syncAll = () => run("Sync all forks", async () => {
    const all = await api.forkSyncAll(repositoryPath, push);
    setResults(all);
    await load();
  });
  const merge = async (entry: ForkStatus) => {
    if (!(await askConfirm(`Merge upstream into ${entry.currentBranch}`, `Merge ${entry.upstream?.name}/${entry.defaultBranch} into ${entry.currentBranch} in ${where(entry)}? Conflicts open in the Conflict Center; Undo reverts the merge.`, { confirm: "Merge" }))) return;
    await run(`Merge upstream in ${where(entry)}`, async () => { await api.forkMergeUpstream(repositoryPath, entry.path); await load(); });
  };

  return (
    <section className="fk-view" aria-label="Forks and upstreams">
      <header className="fk-head">
        <div>
          <h2>Forks &amp; upstreams</h2>
          <p>{tree ? `${tree.length} repositor${tree.length === 1 ? "y" : "ies"} (with submodules) · ${forks.length} fork${forks.length === 1 ? "" : "s"}` : "Reading remotes…"}</p>
        </div>
        <div className="fk-actions">
          <label className="fk-check" title="After fast-forwarding the default branch, push it to your fork (origin)"><input type="checkbox" checked={push} onChange={(event) => choosePush(event.target.checked)} />Also push to my forks</label>
          <button type="button" className="ux-button" disabled={busy} onClick={() => void load()}><Icon name="refresh" />Refresh</button>
          <button type="button" className="ux-primary-button" disabled={busy || !forks.length} onClick={() => void syncAll()} title="Fetch every upstream and fast-forward each fork's default branch">Sync all forks</button>
        </div>
      </header>
      {error && <p className="fk-error" role="alert">{error}</p>}
      {results && (
        <div className="fk-results" role="status">
          {results.map((result) => <div key={result.path} className={result.ok ? "is-ok" : "is-error"}><strong>{result.path || "this repository"}</strong> {result.message}</div>)}
          {!results.length && <div>No forks to sync.</div>}
          <button type="button" className="gk-link-button" onClick={() => setResults(null)}>Dismiss</button>
        </div>
      )}
      <div className="fk-table" role="table" aria-label="Repositories and their upstreams">
        <div className="fk-row is-head" role="row"><span>Repository</span><span>Your copy (origin)</span><span>Upstream</span><span>Default branch</span><span>Actions</span></div>
        {(tree ?? []).map((entry) => {
          const fork = entry.kind === "fork";
          return (
            <div key={entry.path || "."} className={`fk-row is-${entry.kind}`} role="row">
              <span className="fk-name" style={{ paddingLeft: entry.depth * 16 }}>
                <Icon name={entry.depth ? "submodule" : "repository"} />
                <span><strong>{entry.name}</strong><small>{entry.path || "this repository"}{entry.currentBranch ? ` · on ${entry.currentBranch}` : " · detached"}</small></span>
              </span>
              <span>{entry.origin ? (entry.origin.web ? <a href={entry.origin.web} target="_blank" rel="noreferrer">{label(entry.origin)}</a> : label(entry.origin)) : <em>no remote</em>}</span>
              <span>
                {entry.upstream ? (entry.upstream.web ? <a href={entry.upstream.web} target="_blank" rel="noreferrer">{label(entry.upstream)}</a> : label(entry.upstream)) : entry.origin ? <button type="button" className="gk-link-button" disabled={busy} onClick={() => void addUpstream(entry)}>Find / add upstream…</button> : "—"}
                {entry.upstream && <small>{entry.upstream.name} · {ago(entry.fetchedAt)}</small>}
              </span>
              <span className="fk-counts">
                {fork && entry.defaultBranch ? (
                  <>
                    <b className={entry.behind ? "is-behind" : ""}>{entry.defaultBranch}: {entry.behind === null ? "no local branch" : entry.behind ? `↓${entry.behind} behind` : "up to date"}{entry.ahead ? ` · ↑${entry.ahead} own` : ""}</b>
                    {entry.originBehind ? <small>your fork on the server is {entry.originBehind} behind</small> : null}
                    {entry.branchBehind ? <small>{entry.currentBranch} is {entry.branchBehind} behind upstream</small> : null}
                  </>
                ) : fork ? <small>fetch to see upstream's branches</small> : <small>{entry.kind === "plain" ? "not a known fork" : "local only"}</small>}
              </span>
              <span className="fk-row-actions">
                {fork && <button type="button" className="ux-button compact" disabled={busy || Boolean(entry.ahead)} title={entry.ahead ? "The default branch has its own commits; merge or rebase instead" : "Fetch upstream and fast-forward the default branch"} onClick={() => void sync(entry, false)}>Sync</button>}
                {fork && entry.origin && <button type="button" className="ux-button compact" disabled={busy || Boolean(entry.ahead)} title={`Sync, then push ${entry.defaultBranch} to ${label(entry.origin)}`} onClick={() => void sync(entry, true)}>Sync &amp; push</button>}
                {fork && entry.branchBehind ? <button type="button" className="ux-button compact" disabled={busy} onClick={() => void merge(entry)}>Merge upstream</button> : null}
                {entry.compareUrl && entry.currentBranch !== entry.defaultBranch && <a className="ux-button compact" href={entry.compareUrl} target="_blank" rel="noreferrer" title="Open a pull/merge request from this branch to upstream">PR to upstream</a>}
                {entry.path && <button type="button" className="ux-button compact" onClick={() => onOpenRepository(entry.absolute)}>Open</button>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="fk-note">A fork has your copy as <code>origin</code> and the original as <code>upstream</code>. Sync only fast-forwards: a default branch with its own commits is left alone. Submodules are listed under their parent; syncing one updates its branch, not the commit its parent records.</p>
    </section>
  );
}
