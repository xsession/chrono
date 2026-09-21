import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { RefGroups, TagRecord } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

/**
 * GitKraken-style consolidated References browser: one collapsible tree for
 * LOCAL branches, REMOTE tracking refs (grouped by remote, then by top-level
 * directory), WORKTREES, STASHES, TAGS and SUBMODULES — with ahead/behind
 * badges, a Ctrl+Alt+F filter, and a "Viewing N/M" counter.
 */
type Props = {
  repositoryPath: string;
  headSha?: string;
  onCheckout: (branch: string) => Promise<void>;
  onCheckoutRemote: (remoteBranch: string) => Promise<void>;
  onCheckoutTag: (tag: string) => Promise<void>;
  onOpenWorktree?: (path: string) => void | Promise<void>;
  onNotify: (message: string) => void;
  onRefresh: () => Promise<void>;
};

type SectionId = "local" | "remote" | "worktrees" | "stashes" | "tags" | "submodules";

const SECTION_IDS: SectionId[] = ["local", "remote", "worktrees", "stashes", "tags", "submodules"];

function fmt(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "Completed.";
}

/** "29 ↓" / "99+ ↑" style ahead/behind badges, like GitKraken. */
function behindLabel(count: number): string {
  return count > 99 ? "99+ ↓" : `${count} ↓`;
}
function aheadLabel(count: number): string {
  return count > 99 ? "99+ ↑" : `${count} ↑`;
}

function isMatch(needle: string, ...haystack: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return haystack.some((value) => value && value.toLowerCase().includes(n));
}

export function RefsBrowser({ repositoryPath, headSha, onCheckout, onCheckoutRemote, onCheckoutTag, onOpenWorktree, onNotify, onRefresh }: Props) {
  const [groups, setGroups] = useState<RefGroups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<SectionId>>(() => {
    try {
      const raw = localStorage.getItem("chrono.refs.collapsed");
      return raw ? new Set(JSON.parse(raw) as SectionId[]) : new Set<SectionId>();
    } catch {
      return new Set<SectionId>();
    }
  });
  const [openRemotes, setOpenRemotes] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("chrono.refs.remotes");
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* fall through to default */ }
    // GitKraken shows the first remote expanded by default.
    return new Set(["origin"]);
  });
  const [busy, setBusy] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const value = await api.refGroups(repositoryPath);
      setGroups(value);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [repositoryPath]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSection = (id: SectionId) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem("chrono.refs.collapsed", JSON.stringify([...next]));
      return next;
    });
  };

  const toggleRemote = (remote: string) => {
    setOpenRemotes((previous) => {
      const next = new Set(previous);
      if (next.has(remote)) next.delete(remote); else next.add(remote);
      localStorage.setItem("chrono.refs.remotes", JSON.stringify([...next]));
      return next;
    });
  };

  const needle = query.trim();

  const localBranches = useMemo(() => (groups?.branches ?? []).filter((branch) => !branch.remote), [groups]);
  const remoteBranches = useMemo(() => (groups?.branches ?? []).filter((branch) => branch.remote), [groups]);
  const allRemotes = useMemo(() => [...new Set(remoteBranches.map((branch) => branch.remote ?? "origin"))], [remoteBranches]);

  const expandAll = () => {
    setCollapsed(new Set());
    setOpenRemotes(new Set(allRemotes));
  };
  const collapseAll = () => {
    setCollapsed(new Set(SECTION_IDS));
    setOpenRemotes(new Set());
  };

  // Remote refs grouped by remote, then by first path segment (e.g.
  // origin/bugfix/ED-1587 → bugfix). Top-level entries have no group.
  const remoteGroups = useMemo(() => {
    const byRemote = new Map<string, Map<string, typeof remoteBranches>>();
    for (const branch of remoteBranches) {
      const remote = branch.remote ?? "origin";
      const slash = branch.name.indexOf("/");
      const dir = slash >= 0 ? branch.name.slice(0, slash) : "";
      if (!byRemote.has(remote)) byRemote.set(remote, new Map());
      const dirs = byRemote.get(remote)!;
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push(branch);
    }
    return byRemote;
  }, [remoteBranches]);

  const localMatches = localBranches.filter((branch) => isMatch(needle, branch.name, branch.upstream));
  const worktrees = (groups?.worktrees ?? []).filter((wt) => isMatch(needle, wt.branch, wt.path));
  const stashes = (groups?.stashes ?? []).filter((stash) => isMatch(needle, stash.ref, stash.message));
  const tags = (groups?.tags ?? []).filter((tag) => isMatch(needle, tag.name, tag.message));
  const submodules = (groups?.submodules ?? []).filter((sub) => isMatch(needle, sub.path, sub.summary));

  const remoteMatched = remoteBranches.filter((branch) => isMatch(needle, branch.name, branch.remote));
  const remoteMatchedRemotes = new Set(remoteMatched.map((branch) => branch.remote ?? "origin"));

  // Apply the filter inside each remote group as well as to the remote list.
  // Otherwise a match on one branch expands the remote and incorrectly shows
  // every sibling branch while the "Viewing N/M" count claims they are hidden.
  const visibleRemoteGroups = useMemo(() => {
    if (!needle) return remoteGroups;
    const result = new Map<string, Map<string, typeof remoteBranches>>();
    for (const [remote, dirs] of remoteGroups) {
      const visibleDirs = new Map<string, typeof remoteBranches>();
      for (const [dir, branches] of dirs) {
        const matches = branches.filter((branch) => isMatch(needle, branch.name, remote));
        if (matches.length > 0) visibleDirs.set(dir, matches);
      }
      if (visibleDirs.size > 0) result.set(remote, visibleDirs);
    }
    return result;
  }, [needle, remoteGroups, remoteBranches]);

  const visibleCounts = {
    local: localMatches.length,
    remote: remoteMatched.length,
    worktrees: worktrees.length,
    stashes: stashes.length,
    tags: tags.length,
    submodules: submodules.length,
  };
  const visibleTotal = Object.values(visibleCounts).reduce((sum, count) => sum + count, 0);
  const grandTotal = (groups ? groups.branches.length + groups.worktrees.length + groups.stashes.length + groups.tags.length + groups.submodules.length : 0);

  const checkout = async (branch: string) => {
    setBusy(branchBusyKey(branch));
    try {
      await onCheckout(branch);
      await load();
    } catch (err) {
      onNotify(String(err));
    } finally {
      setBusy(null);
    }
  };

  const normalizePath = (value: string): string => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    return /^[A-Z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const currentWorktreePath = normalizePath(repositoryPath);
  const branchBusyKey = (branch: string) => `branch:${branch}`;

  const trackCheckout = async (remoteBranch: string) => {
    setBusy(`remote:${remoteBranch}`);
    try {
      await onCheckoutRemote(remoteBranch);
      await load();
    } catch (err) {
      onNotify(String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ux-refs-view" aria-label="References browser">
      <header className="ux-refs-header">
        <div className="ux-refs-header-row">
          <h2>References</h2>
          <div className="ux-refs-header-actions">
            <button className="ux-refs-link" onClick={expandAll} title="Expand all groups">Show All</button>
            <button className="ux-refs-link" onClick={collapseAll} title="Collapse all groups">Collapse All</button>
          </div>
        </div>
        <div className="ux-refs-header-row">
          <span className="ux-refs-viewing" aria-live="polite">
            {groups === null ? "Loading…" : <>Viewing <strong>{needle ? `${visibleTotal}/${grandTotal}` : grandTotal}</strong></>}
          </span>
          <label className="ux-refs-filter">
            <input
              ref={filterRef}
              value={query}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
              placeholder="Filter"
              aria-label="Filter references"
            />
            {query && <button className="ux-refs-filter-clear" onClick={() => setQuery("")} aria-label="Clear filter">×</button>}
            <Icon name="search" />
          </label>
        </div>
      </header>

      <div className="ux-refs-tree" role="tree">
        {error && <div className="ux-inline-warning"><Icon name="warning" /><span>{error}</span></div>}
        {/* LOCAL ----------------------------------------------------------- */}
        <SectionHeader label="Local" icon="branch" count={needle ? `${visibleCounts.local}/${localBranches.length}` : localBranches.length}
          collapsed={collapsed.has("local")} onToggle={() => toggleSection("local")} />
        {!collapsed.has("local") && (
          <div className="ux-refs-children" role="group">
            {localMatches.map((branch) => (
              <button
                key={branch.name}
                role="treeitem"
                aria-selected={branch.current}
                className={`ux-refs-row ux-refs-row--branch${branch.current ? " is-current" : ""}${busy === branchBusyKey(branch.name) ? " is-busy" : ""}`}
                onClick={() => !branch.current && void checkout(branch.name)}
                disabled={branch.current || busy !== null}
                title={`${branch.name} → ${branch.target.slice(0, 12)}${branch.upstream ? ` (tracks ${branch.upstream})` : ""}`}
              >
                <Icon name="branch" />
                <span className="ux-refs-name">
                  <strong>{branch.name}</strong>
                  {branch.upstream && <small>{branch.upstream}</small>}
                </span>
                <span className="ux-refs-badges">
                  {branch.current && <span className="ux-refs-badge ux-refs-badge--current">current</span>}
                  {busy === branchBusyKey(branch.name) && <span className="ux-refs-badge">switching…</span>}
                  {!branch.current && branch.behind > 0 && <span className="ux-refs-badge ux-refs-badge--behind" title={`behind ${branch.upstream ?? "upstream"} by ${branch.behind}`}>{behindLabel(branch.behind)}</span>}
                  {!branch.current && branch.ahead > 0 && <span className="ux-refs-badge ux-refs-badge--ahead" title={`ahead ${branch.upstream ?? "upstream"} by ${branch.ahead}`}>{aheadLabel(branch.ahead)}</span>}
                </span>
              </button>
            ))}
            {!localMatches.length && <div className="ux-refs-empty">No local branches{needle ? " match" : ""}.</div>}
          </div>
        )}

        {/* REMOTE ----------------------------------------------------------- */}
        <SectionHeader label="Remote" icon="upload" count={needle ? `${visibleCounts.remote}/${remoteBranches.length}` : remoteBranches.length}
          collapsed={collapsed.has("remote")} onToggle={() => toggleSection("remote")}
          />
        {!collapsed.has("remote") && (
          <div className="ux-refs-children" role="group">
            {allRemotes.filter((remote) => !needle || remoteMatchedRemotes.has(remote)).map((remote) => {
              const remoteOpen = openRemotes.has(remote) || needle.length > 0;
              const groupsForRemote = visibleRemoteGroups.get(remote);
              const branches = groupsForRemote?.get("") ?? [];
              const subGroups = [...(groupsForRemote?.entries() ?? [])].filter(([dir]) => dir !== "");
              return (
                <div key={remote} className="ux-refs-remote">
                  <button role="treeitem" aria-expanded={remoteOpen} className={`ux-refs-row ux-refs-row--group${remoteOpen ? " is-open" : ""}`} onClick={() => toggleRemote(remote)}>
                    <Icon name={remoteOpen ? "chevronRight" : "chevronRight"} className={remoteOpen ? "is-rotated" : ""} />
                    <Icon name="repository" />
                    <span className="ux-refs-name"><strong>{remote}</strong></span>
                  </button>
                  {remoteOpen && (
                    <div className="ux-refs-children" role="group">
                      {branches.map((branch) => (
                        <RemoteBranchRow key={`${remote}/${branch.name}`} branch={branch} remote={remote} onCheckout={(name) => void trackCheckout(name)} busy={busy} />
                      ))}
                      {subGroups.map(([dir, dirBranches]) => (
                        <RemoteDirGroup key={`${remote}/${dir}`} dir={dir} remote={remote} branches={dirBranches} onCheckout={(name) => void trackCheckout(name)} busy={busy} />
                      ))}
                      {!branches.length && !subGroups.length && <div className="ux-refs-empty">No remote branches under {remote}.</div>}
                    </div>
                  )}
                </div>
              );
            })}
            {!allRemotes.length && <div className="ux-refs-empty">No remote configured.</div>}
            {needle && !remoteMatched.length && allRemotes.length > 0 && <div className="ux-refs-empty">No remote branches match.</div>}
          </div>
        )}

        {/* WORKTREES -------------------------------------------------------- */}
        <SectionHeader label="Worktrees" icon="worktree" count={needle ? `${visibleCounts.worktrees}/${groups?.worktrees.length ?? 0}` : groups?.worktrees.length ?? 0}
          collapsed={collapsed.has("worktrees")} onToggle={() => toggleSection("worktrees")} />
        {!collapsed.has("worktrees") && (
          <div className="ux-refs-children" role="group">
            {worktrees.map((wt) => {
              const inThisWorktree = normalizePath(wt.path) === currentWorktreePath;
              const worktreeBusy = `worktree:${wt.path}`;
              return (
                <button
                  type="button"
                  key={wt.path}
                  role="treeitem"
                  aria-current={inThisWorktree ? "page" : undefined}
                  className={`ux-refs-row ux-refs-row--worktree${inThisWorktree ? " is-current" : ""}`}
                  disabled={!onOpenWorktree || busy !== null}
                  title={onOpenWorktree ? `Open worktree ${wt.path}` : wt.path}
                  onClick={async () => {
                    if (!onOpenWorktree) return;
                    setBusy(worktreeBusy);
                    try { await onOpenWorktree(wt.path); }
                    catch (err) { onNotify(String(err)); }
                    finally { setBusy(null); }
                  }}
                >
                  <Icon name={wt.locked ? "warning" : wt.isMain ? "repository" : "worktree"} />
                  <span className="ux-refs-name">
                    <strong>{wt.branch ?? `Detached ${wt.head.slice(0, 8)}`}</strong>
                    <small>{wt.path}{inThisWorktree ? " · current" : ""}</small>
                  </span>
                  <span className="ux-refs-badges">
                    {busy === worktreeBusy ? <span className="ux-refs-badge">opening…</span> : inThisWorktree && <span className="ux-refs-badge ux-refs-badge--current">here</span>}
                    {wt.conflictCount > 0 && <span className="ux-refs-badge ux-refs-badge--behind">{wt.conflictCount} conflicts</span>}
                    {wt.dirtyCount > 0 && <span className="ux-refs-badge">{wt.dirtyCount} changed</span>}
                    {wt.dirtyCount === 0 && wt.conflictCount === 0 && <span className="ux-refs-dot" title="clean worktree" aria-hidden="true" />}
                  </span>
                </button>
              );
            })}
            {!worktrees.length && <div className="ux-refs-empty">No worktrees{needle ? " match" : ""}.</div>}
          </div>
        )}

        {/* STASHES ------------------------------------------------------------ */}
        <SectionHeader label="Stashes" icon="stash" count={needle ? `${visibleCounts.stashes}/${groups?.stashes.length ?? 0}` : groups?.stashes.length ?? 0}
          collapsed={collapsed.has("stashes")} onToggle={() => toggleSection("stashes")} />
        {!collapsed.has("stashes") && (
          <div className="ux-refs-children" role="group">
            {stashes.map((stash) => {
              const busyKey = `stash:${stash.ref}`;
              const stashAction = async (operation: "stash_pop" | "stash_apply" | "stash_drop") => {
                if (operation === "stash_drop" && !window.confirm(`Drop ${stash.ref}? This cannot be undone.`)) return;
                setBusy(busyKey);
                try {
                  const result = await api.workflow(repositoryPath, { operation, args: [stash.ref] });
                  onNotify(fmt(result));
                  await onRefresh();
                  await load();
                } catch (err) { onNotify(String(err)); }
                finally { setBusy(null); }
              };
              return (
              <div key={stash.ref} role="treeitem" className={`ux-refs-row ux-refs-row--stash${busy === busyKey ? " is-busy" : ""}`}>
                <Icon name="stash" />
                <span className="ux-refs-name">
                  <strong>{stash.message || stash.ref.slice(-8)}</strong>
                  <small>{stash.ref}</small>
                </span>
                <span className="ux-refs-badges">
                  {busy === busyKey ? <span className="ux-refs-badge">working…</span> : <>
                    <button className="ux-refs-action" title="Pop (apply + drop)" disabled={busy !== null} onClick={() => void stashAction("stash_pop")}>pop</button>
                    <button className="ux-refs-action" title="Apply (keep stash)" disabled={busy !== null} onClick={() => void stashAction("stash_apply")}>apply</button>
                    <button className="ux-refs-action ux-refs-action--danger" title="Drop (delete)" disabled={busy !== null} onClick={() => void stashAction("stash_drop")}>drop</button>
                  </>}
                </span>
              </div>
              );
            })}
            {!stashes.length && <div className="ux-refs-empty">No stashes{needle ? " match" : ""}.</div>}
          </div>
        )}

        {/* TAGS --------------------------------------------------------------- */}
        <SectionHeader label="Tags" icon="branch" count={needle ? `${visibleCounts.tags}/${groups?.tags.length ?? 0}` : groups?.tags.length ?? 0}
          collapsed={collapsed.has("tags")} onToggle={() => toggleSection("tags")} />
        {!collapsed.has("tags") && (
          <div className="ux-refs-children" role="group">
            {tags.map((tag: TagRecord) => {
              const busyKey = `tag:${tag.name}`;
              return (
              <div key={tag.name} role="treeitem" className={`ux-refs-row ux-refs-row--tag${busy === busyKey ? " is-busy" : ""}`} title={tag.message || undefined}>
                <Icon name="branch" />
                <span className="ux-refs-name">
                  <strong>{tag.name}{tag.annotated ? " •" : ""}</strong>
                  <small>{tag.date}{tag.tagger ? ` · ${tag.tagger}` : ""}</small>
                </span>
                <span className="ux-refs-badges">
                  {busy === busyKey ? <span className="ux-refs-badge">checking out…</span> : (
                    <button className="ux-refs-action" title={`Check out ${tag.name} (detached HEAD)`} disabled={busy !== null}
                      onClick={async () => {
                        setBusy(busyKey);
                        try {
                          await onCheckoutTag(tag.name);
                          await load();
                        } catch (err) { onNotify(String(err)); }
                        finally { setBusy(null); }
                      }}>checkout</button>
                  )}
                </span>
              </div>
              );
            })}
            {!tags.length && <div className="ux-refs-empty">No tags{needle ? " match" : ""}.</div>}
          </div>
        )}

        {/* SUBMODULES --------------------------------------------------------- */}
        <SectionHeader label="Submodules" icon="submodule" count={needle ? `${visibleCounts.submodules}/${groups?.submodules.length ?? 0}` : groups?.submodules.length ?? 0}
          collapsed={collapsed.has("submodules")} onToggle={() => toggleSection("submodules")} />
        {!collapsed.has("submodules") && (
          <div className="ux-refs-children" role="group">
            {submodules.map((sub) => {
              const busyKey = `sub:${sub.path}`;
              const subAction = async (operation: "submodule_init_path" | "submodule_update_path") => {
                setBusy(busyKey);
                try {
                  const result = await api.workflow(repositoryPath, { operation, args: [sub.path] });
                  onNotify(fmt(result));
                  await onRefresh();
                  await load();
                } catch (err) { onNotify(String(err)); }
                finally { setBusy(null); }
              };
              return (
              <div key={sub.path} role="treeitem" className={`ux-refs-row ux-refs-row--submodule${sub.status === " " ? " is-clean" : ""}${busy === busyKey ? " is-busy" : ""}`}
                title={`status: ${sub.status === " " ? "in sync" : sub.status === "+" ? "checked out at different commit" : sub.status === "-" ? "not initialized" : "unmerged"}`}>
                <Icon name={sub.status === " " ? "check" : "submodule"} />
                <span className="ux-refs-name">
                  <strong>{sub.path}</strong>
                  <small>{sub.commit.slice(0, 12)}{sub.summary ? ` · ${sub.summary}` : ""}</small>
                </span>
                <span className="ux-refs-badges">
                  {busy === busyKey ? <span className="ux-refs-badge">working…</span> : (
                    <>
                      {sub.status === " " && <span className="ux-refs-badge ux-refs-badge--ok">synced</span>}
                      {sub.status === "+" && <span className="ux-refs-badge ux-refs-badge--behind">out of sync</span>}
                      {sub.status === "-" && <span className="ux-refs-badge">not initialized</span>}
                      {sub.status === "U" && <span className="ux-refs-badge ux-refs-badge--behind">unmerged</span>}
                      {sub.status === "-" && <button className="ux-refs-action" disabled={busy !== null} onClick={() => void subAction("submodule_init_path")}>init</button>}
                      {sub.status === "+" && <button className="ux-refs-action" disabled={busy !== null} onClick={() => void subAction("submodule_update_path")}>update</button>}
                    </>
                  )}
                </span>
              </div>
              );
            })}
            {!submodules.length && <div className="ux-refs-empty">No submodules{needle ? " match" : ""}.</div>}
          </div>
        )}
      </div>

      <footer className="ux-refs-footer">
        <span>Click a local branch to switch · ahead/behind is relative to its upstream · {headSha ? `HEAD ${headSha.slice(0, 8)}` : "no HEAD"}</span>
        <button className="ux-icon-button" title="Refresh references" aria-label="Refresh references" onClick={() => { load(); void onRefresh(); }}><Icon name="refresh" /></button>
      </footer>
    </div>
  );
}

function SectionHeader({ label, icon, count, collapsed, onToggle }: {
  label: string;
  icon: "branch" | "upload" | "worktree" | "stash" | "submodule";
  count: string | number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button role="treeitem" aria-expanded={!collapsed} className={`ux-refs-section${collapsed ? " is-collapsed" : ""}`} onClick={onToggle}>
      <Icon name={collapsed ? "chevronRight" : "chevronRight"} className={collapsed ? "" : "is-rotated"} />
      <Icon name={icon} />
      <span className="ux-refs-section-label">{label}</span>
      <span className="ux-refs-count">{count}</span>
    </button>
  );
}

function RemoteBranchRow({ branch, remote, onCheckout, busy }: {
  branch: { name: string; target: string };
  remote: string;
  onCheckout: (name: string) => void;
  busy: string | null;
}) {
  const isBusy = busy === `remote:${remote}/${branch.name}`;
  return (
    <div role="treeitem" className="ux-refs-row ux-refs-row--remote" title={`${remote}/${branch.name} → ${branch.target.slice(0, 12)} (double-click to check out)`}
      onDoubleClick={() => onCheckout(`${remote}/${branch.name}`)}>
      <Icon name="branch" />
      <span className="ux-refs-name">
        <strong>{branch.name}</strong>
        <small>{remote}</small>
      </span>
      <span className="ux-refs-badges">
        <code>{branch.target.slice(0, 8)}</code>
        {isBusy
          ? <span className="ux-refs-badge">checking out…</span>
          : <button className="ux-icon-button" title={`Checkout ${remote}/${branch.name} (creates a tracking branch)`} disabled={busy !== null} onClick={() => onCheckout(`${remote}/${branch.name}`)} onDoubleClick={(event) => event.stopPropagation()}>⤓</button>}
      </span>
    </div>
  );
}

function RemoteDirGroup({ dir, remote, branches, onCheckout, busy }: {
  dir: string;
  remote: string;
  branches: { name: string; target: string }[];
  onCheckout: (name: string) => void;
  busy: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="ux-refs-dir">
      <button role="treeitem" aria-expanded={open} className={`ux-refs-row ux-refs-row--group${open ? " is-open" : ""}`} onClick={() => setOpen(!open)}>
        <Icon name="chevronRight" className={open ? "is-rotated" : ""} />
        <Icon name="repository" />
        <span className="ux-refs-name"><strong>{dir}</strong><small>{remote}</small></span>
        <span className="ux-refs-badges"><span className="ux-refs-count-inline">{branches.length}</span></span>
      </button>
      {open && (
        <div className="ux-refs-children" role="group">
          {branches.map((branch) => (
            <RemoteBranchRow key={`${remote}/${branch.name}`} branch={branch} remote={remote} onCheckout={onCheckout} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}
