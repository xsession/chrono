import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { api } from "../../api";
import type { SubmoduleAction, SubmoduleBulkAction, SubmoduleBulkResult, SubmoduleForeachResult, SubmoduleNode, SubmoduleTree } from "../../types";
import { SubmoduleMindMap } from "./SubmoduleMindMap";
import { Icon } from "../Icon";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { askConfirm, askText } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { plural } from "../../plural";
import type { ForkStatus } from "../../types";
import { forkBadge } from "../ForksView";

type Filter = "all" | "attention" | "dirty" | "drift" | "uninitialized" | "outdated";
type Mode = "list" | "mindmap";
type Results =
  | { kind: "bulk"; label: string; items: SubmoduleBulkResult[] }
  | { kind: "foreach"; label: string; items: SubmoduleForeachResult[] };

const BULK: Array<{ action: SubmoduleBulkAction; label: string; title: string }> = [
  { action: "fetch", label: "Fetch", title: "git fetch --all --prune in each" },
  { action: "update", label: "Update", title: "Check out the commit each parent records (initializes missing ones)" },
  { action: "update_remote", label: "Update to remote", title: "git submodule update --remote: move each to its tracked branch tip" },
  { action: "pull", label: "Pull", title: "Fast-forward pull, only for submodules on a branch" },
  { action: "attach", label: "Attach to branch", title: "Switch detached submodules to a branch that points at the same commit (never moves code)" },
  { action: "record", label: "Record pointer", title: "Stage moved submodules' current commits in their parent repositories" },
];
const MODE_KEY = "chrono.submodules.mode";

type Props = {
  repositoryPath: string;
  /** Fork status of every submodule (forks.ts), by path. */
  forks?: ForkStatus[];
  refreshKey: number;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onOpenRepository: (path: string) => void;
  onOpenTerminal?: (absolutePath: string) => void;
};

export const needsAttention = (node: SubmoduleNode) => node.state !== "ok" || node.changes > 0 || node.untracked > 0 || node.conflicts > 0;

const join = (root: string, relative: string) => `${root.replace(/[\\/]$/, "")}/${relative}`;

/** Short, human status for one submodule; `tone` drives the colour. */
export function submoduleStatus(node: SubmoduleNode): { label: string; tone: "ok" | "dirty" | "drift" | "off" | "bad"; title: string } {
  if (node.state === "conflict" || node.conflicts > 0) return { label: "conflict", tone: "bad", title: "Merge conflict in or on this submodule" };
  if (node.state === "uninitialized") return { label: "not initialized", tone: "off", title: "Not checked out — use Initialize to clone it" };
  const dirty = node.changes + node.untracked;
  if (node.state === "drift") {
    const drift = node.drift ? [node.drift.ahead ? `${node.drift.ahead} ahead` : "", node.drift.behind ? `${node.drift.behind} behind` : ""].filter(Boolean).join(", ") : "";
    return { label: `moved${drift ? ` · ${drift}` : ""}${dirty ? ` · ${dirty} changed` : ""}`, tone: "drift", title: `Checked out ${node.commit.slice(0, 8)} but the parent records ${node.recorded?.slice(0, 8) ?? "another commit"}` };
  }
  if (dirty) return { label: `${dirty} changed`, tone: "dirty", title: `${node.changes} modified, ${node.untracked} untracked` };
  return { label: "clean", tone: "ok", title: "At the recorded commit, no local changes" };
}

/** Project map: the whole (nested) submodule hierarchy of a superproject
 *  at a glance — status per node, problems bubbled up to collapsed parents,
 *  filters for "what needs my attention", and per-node actions. */
export function SubmoduleMap({ repositoryPath, forks, refreshKey, busy, run, onOpenRepository, onOpenTerminal }: Props) {
  const forkByPath = new Map((forks ?? []).map((entry) => [entry.path, entry]));
  const [tree, setTree] = useState<SubmoduleTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) === "list" ? "list" : "mindmap"));
  const [results, setResults] = useState<Results | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [manifest, setManifest] = useState<string | null>(null);
  const menu = useContextMenu();
  const switchMode = (next: Mode) => { setMode(next); localStorage.setItem(MODE_KEY, next); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.submoduleTree(repositoryPath);
      setTree(next);
      setError(null);
      // First load: open only the branches that contain something to look at.
      setOpen((current) => current ?? new Set(next.nodes.filter((node) => node.attentionBelow > 0).map((node) => node.path)));
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setLoading(false);
    }
  }, [repositoryPath]);

  useEffect(() => { setOpen(null); setSelected(null); setPicked(new Set()); setResults(null); }, [repositoryPath]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const children = useMemo(() => {
    const map = new Map<string | null, SubmoduleNode[]>();
    for (const node of tree?.nodes ?? []) map.set(node.parent, [...(map.get(node.parent) ?? []), node]);
    return map;
  }, [tree]);

  const needle = query.trim().toLowerCase();
  const passes = useCallback((node: SubmoduleNode) => {
    if (needle && !`${node.path} ${node.branch ?? ""} ${node.url ?? ""}`.toLowerCase().includes(needle)) return false;
    switch (filter) {
      case "attention": return needsAttention(node);
      case "dirty": return node.changes + node.untracked > 0;
      case "drift": return node.state === "drift";
      case "uninitialized": return node.state === "uninitialized";
      case "outdated": return (node.tracking?.behind ?? 0) > 0;
      default: return true;
    }
  }, [filter, needle]);

  /** Rows to show: with a filter, matching nodes plus their ancestors (so
   *  the hierarchy stays readable); without one, the expanded tree. */
  const rows = useMemo(() => {
    if (!tree) return [];
    const filtering = filter !== "all" || needle !== "";
    const keep = new Set<string>();
    if (filtering) {
      const byPath = new Map(tree.nodes.map((node) => [node.path, node]));
      for (const node of tree.nodes) {
        if (!passes(node)) continue;
        for (let cursor: string | null = node.path; cursor; cursor = byPath.get(cursor)?.parent ?? null) keep.add(cursor);
      }
    }
    const out: SubmoduleNode[] = [];
    const walk = (parent: string | null) => {
      for (const node of children.get(parent) ?? []) {
        if (filtering && !keep.has(node.path)) continue;
        out.push(node);
        if (filtering || open?.has(node.path)) walk(node.path);
      }
    };
    walk(null);
    return out;
  }, [tree, children, open, filter, needle, passes]);

  const toggle = (path: string) => setOpen((current) => {
    const next = new Set(current ?? []);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const act = (label: string, action: SubmoduleAction, target: string) =>
    run(label, () => api.submoduleAction(repositoryPath, action, target)).then(() => load());

  /** A node plus everything nested below it. */
  const subtree = useCallback((path: string) => (tree?.nodes ?? []).filter((node) => node.path === path || node.path.startsWith(`${path}/`)).map((node) => node.path), [tree]);

  const bulk = async (action: SubmoduleBulkAction, targets: string[], label: string) => {
    if (!targets.length) return;
    setWorking(label);
    try {
      const items = await api.submoduleBulk(repositoryPath, action, targets);
      setResults({ kind: "bulk", label, items });
      const failed = items.filter((item) => item.status === "failed").length;
      pushToast(`${label}: ${items.filter((item) => item.status === "ok").length} done${failed ? `, ${failed} failed` : ""}`, failed ? "error" : "success", 4000);
    } catch (reason) {
      pushToast(String(reason).replace(/^Error: /, ""), "error", 8000);
    } finally {
      setWorking(null);
      await load();
    }
  };

  const foreach = async (targets: string[]) => {
    if (!targets.length) return;
    const command = await askText("Run command in submodules", `Runs in each of the ${targets.length} selected submodule folder(s), 4 at a time. $sm_path, $sha1 and $toplevel are set like git submodule foreach.`, localStorage.getItem("chrono.submodules.foreach") ?? "git status -sb", { confirm: "Run", placeholder: "git log -1 --oneline" });
    if (!command?.trim()) return;
    localStorage.setItem("chrono.submodules.foreach", command);
    setWorking(`Running ${command}`);
    try {
      const items = await api.submoduleForeach(repositoryPath, command, targets);
      setResults({ kind: "foreach", label: command, items });
    } catch (reason) {
      pushToast(String(reason).replace(/^Error: /, ""), "error", 8000);
    } finally {
      setWorking(null);
      await load();
    }
  };

  const showManifest = async () => {
    try {
      setManifest(JSON.stringify(await api.submoduleManifest(repositoryPath), null, 2));
    } catch (reason) {
      pushToast(String(reason).replace(/^Error: /, ""), "error", 8000);
    }
  };

  const pick = (path: string | null, additive: boolean) => {
    if (!path) { if (!additive) setSelected(null); return; }
    setSelected(path);
    if (additive) setPicked((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  };

  const nodeMenu = (event: ReactMouseEvent, node: SubmoduleNode) => {
    const absolute = join(tree?.root ?? repositoryPath, node.path);
    const initialized = node.state !== "uninitialized";
    const items: MenuItem[] = [
      { id: "open", label: "Open in new tab", icon: "external", disabled: !initialized, onSelect: () => onOpenRepository(absolute) },
      { id: "terminal", label: "Open terminal here", icon: "terminal", disabled: !initialized || !onOpenTerminal, onSelect: () => onOpenTerminal?.(absolute) },
      { kind: "separator", id: "s1" },
      initialized
        ? { id: "update", label: "Check out the recorded commit", icon: "download", disabled: busy, onSelect: () => act(`Update ${node.path}`, "update", node.path) }
        : { id: "init", label: "Initialize (clone recursively)", icon: "download", disabled: busy, onSelect: () => act(`Initialize ${node.path}`, "init", node.path) },
      { id: "remote", label: "Update to latest remote commit", icon: "cloud", disabled: busy, onSelect: () => act(`Update ${node.path} from remote`, "update_remote", node.path) },
      { id: "fetch", label: "Fetch", icon: "refresh", disabled: busy || !initialized, onSelect: () => act(`Fetch ${node.path}`, "fetch", node.path) },
      { id: "sync", label: "Sync URL from .gitmodules", disabled: busy, onSelect: () => act(`Sync ${node.path}`, "sync", node.path) },
      { kind: "separator", id: "s-tree" },
      { id: "pick-tree", label: node.children ? `Select with ${subtree(node.path).length - 1} nested` : "Select", onSelect: () => setPicked((current) => new Set([...current, ...subtree(node.path)])) },
      { id: "fetch-tree", label: "Fetch with nested", icon: "refresh", disabled: busy || !initialized || !node.children, onSelect: () => void bulk("fetch", subtree(node.path), `Fetch ${node.name} and nested`) },
      { id: "update-tree", label: "Update with nested", icon: "download", disabled: busy || !node.children, onSelect: () => void bulk("update", subtree(node.path), `Update ${node.name} and nested`) },
      { id: "run-tree", label: "Run command here and nested…", icon: "terminal", disabled: busy || !initialized, onSelect: () => void foreach(subtree(node.path)) },
      { kind: "separator", id: "s2" },
      { id: "copy", label: "Copy path", icon: "copy", onSelect: () => { void navigator.clipboard?.writeText(node.path); pushToast(`Copied ${node.path}`, "success", 2000); } },
      { id: "copy-url", label: "Copy URL", icon: "copy", disabled: !node.url, onSelect: () => { void navigator.clipboard?.writeText(node.url ?? ""); } },
      { id: "copy-sha", label: "Copy commit", icon: "copy", onSelect: () => { void navigator.clipboard?.writeText(node.commit); } },
      { kind: "separator", id: "s3" },
      { id: "deinit", label: "Deinitialize…", icon: "trash", danger: true, disabled: busy || !initialized, onSelect: async () => {
        if (await askConfirm("Deinitialize submodule", `Remove the checked-out files of ${node.path}? Its repository data stays in .git/modules and it can be initialized again. Local changes block this.`, { confirm: "Deinitialize", danger: true })) await act(`Deinit ${node.path}`, "deinit", node.path);
      } },
    ];
    menu.open(event, items, node.path);
  };

  const totals = tree?.totals;
  const chip = (id: Filter, label: string, count: number | undefined, tone: string) => (
    <button type="button" className={`sm-chip sm-tone-${tone}${filter === id ? " is-active" : ""}`} aria-pressed={filter === id} onClick={() => setFilter(filter === id ? "all" : id)} disabled={id !== "all" && !count}>
      <b>{count ?? 0}</b>{label}
    </button>
  );
  const attention = tree ? tree.nodes.filter(needsAttention).length : 0;

  return (
    <section className="sm-view" aria-label="Submodules">
      <header className="sm-head">
        <div className="sm-title">
          <h2>Submodules</h2>
          <span>{tree ? `${totals?.all ?? 0} submodule${totals?.all === 1 ? "" : "s"} · ${tree.maxDepth} level${tree.maxDepth === 1 ? "" : "s"} deep` : "Loading…"}</span>
        </div>
        <div className="sm-actions">
          <div className="sm-mode" role="group" aria-label="Layout">
            <button type="button" className={mode === "list" ? "is-active" : ""} aria-pressed={mode === "list"} onClick={() => switchMode("list")}>List</button>
            <button type="button" className={mode === "mindmap" ? "is-active" : ""} aria-pressed={mode === "mindmap"} onClick={() => switchMode("mindmap")}>Mind map</button>
          </div>
          <button type="button" className="ux-button compact" disabled={!tree?.nodes.length} onClick={() => void showManifest()} title="Every submodule's URL, pinned and checked-out commit as JSON">Manifest</button>
          <button type="button" className="ux-button compact" disabled={busy || !tree?.nodes.length} onClick={() => void act("Update all submodules", "update", "")} title="git submodule update --init --recursive">Update all</button>
          <button type="button" className="ux-button compact" disabled={busy || !tree?.nodes.length} onClick={() => void act("Fetch all submodules", "fetch", "")}>Fetch all</button>
          <button type="button" className="ux-icon-button" disabled={loading} onClick={() => void load()} title="Refresh" aria-label="Refresh"><Icon name="refresh" /></button>
        </div>
      </header>

      {tree && tree.nodes.length > 0 && (
        <div className="sm-filters">
          <div className="sm-chips" role="group" aria-label="Show">
            {chip("all", "all", totals?.all, "all")}
            {chip("attention", "need attention", attention, "attention")}
            {chip("dirty", "changed", totals?.dirty, "dirty")}
            {chip("drift", "moved", totals?.drift, "drift")}
            {chip("uninitialized", "not initialized", totals?.uninitialized, "off")}
            {chip("outdated", "behind branch", totals?.outdated, "drift")}
          </div>
          <label className="sm-search">
            <Icon name="search" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find submodule, branch or URL" aria-label="Find submodule" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear">✕</button>}
          </label>
          {mode === "list" && <span className="sm-expand">
            <button type="button" className="gk-link-button" onClick={() => setOpen(new Set(tree.nodes.filter((node) => node.children > 0).map((node) => node.path)))}>Expand all</button>
            <button type="button" className="gk-link-button" onClick={() => setOpen(new Set())}>Collapse all</button>
          </span>}
        </div>
      )}

      {tree && tree.nodes.length > 0 && (
        <div className={`sm-bulk${picked.size ? " has-picked" : ""}`} role="toolbar" aria-label="Bulk actions">
          {picked.size ? <strong>{picked.size} selected</strong> : <span className="sm-bulk-hint">Select submodules (checkboxes, Ctrl/Shift+click, or right-click › Select with nested) to act on many at once</span>}
          <span className="sm-bulk-pickers">
            <button type="button" className="gk-link-button" onClick={() => setPicked(new Set((tree.nodes).filter(passes).map((node) => node.path)))}>Select {filter === "all" && !needle ? "all" : "shown"}</button>
            <button type="button" className="gk-link-button" disabled={!attention} onClick={() => setPicked(new Set(tree.nodes.filter(needsAttention).map((node) => node.path)))}>Select needing attention</button>
            {picked.size > 0 && <button type="button" className="gk-link-button" onClick={() => setPicked(new Set())}>Clear</button>}
          </span>
          {picked.size > 0 && (
            <span className="sm-bulk-actions">
              {BULK.map((entry) => (
                <button key={entry.action} type="button" className="ux-button compact" disabled={busy || working !== null} title={entry.title} onClick={() => void bulk(entry.action, [...picked], `${entry.label} (${picked.size})`)}>{entry.label}</button>
              ))}
              <button type="button" className="ux-button compact" disabled={busy || working !== null} onClick={() => void foreach([...picked])} title="Run a shell command in every selected submodule">Run command…</button>
            </span>
          )}
          {working && <span className="sm-working"><i className="ux-spinner" />{working}…</span>}
        </div>
      )}

      <div className="sm-body">
        {error ? <div className="ux-empty-state compact">{error}</div>
          : !tree ? <div className="ux-empty-state compact"><i className="ux-spinner" />Scanning submodules…</div>
          : !tree.nodes.length ? <div className="ux-empty-state">This repository has no submodules.</div>
          : mode === "mindmap" ? (
            <SubmoduleMindMap
              tree={tree}
              rootName={tree.root.split(/[\\/]/).filter(Boolean).pop() ?? tree.root}
              selected={selected}
              picked={picked}
              passes={passes}
              filtering={filter !== "all" || needle !== ""}
              onSelect={pick}
              onOpen={(node) => node.state !== "uninitialized" && onOpenRepository(join(tree.root, node.path))}
              onContextMenu={nodeMenu}
              forks={forkByPath}
            />
          )
          : (
            <div className="sm-table" role="treegrid" aria-label="Submodule tree">
              <div className="sm-row sm-header" role="row"><span>Submodule</span><span>Status</span><span>Checked out</span><span>Remote</span></div>
              {rows.map((node) => {
                const status = submoduleStatus(node);
                const isOpen = open?.has(node.path) || filter !== "all" || needle !== "";
                return (
                  <div
                    key={node.path}
                    role="row"
                    aria-level={node.depth + 1}
                    aria-expanded={node.children ? isOpen : undefined}
                    tabIndex={0}
                    className={`sm-row${selected === node.path ? " is-selected" : ""}${passes(node) ? "" : " is-context"}`}
                    onClick={(event) => pick(node.path, event.ctrlKey || event.metaKey || event.shiftKey)}
                    onDoubleClick={() => node.state !== "uninitialized" && onOpenRepository(join(tree.root, node.path))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && node.state !== "uninitialized") onOpenRepository(join(tree.root, node.path));
                      if ((event.key === "ArrowRight" && !isOpen) || (event.key === "ArrowLeft" && isOpen)) { if (node.children) toggle(node.path); }
                    }}
                    onContextMenu={(event) => { setSelected(node.path); nodeMenu(event, node); }}
                    title={node.path}
                  >
                    <span className="sm-name" style={{ paddingLeft: 6 }}>
                      <input type="checkbox" className="sm-check" checked={picked.has(node.path)} aria-label={`Select ${node.path}`} onClick={(event) => event.stopPropagation()} onChange={() => pick(node.path, true)} />
                      <span aria-hidden="true" style={{ flex: "none", width: node.depth * 18 }} />
                      {node.children ? (
                        <button type="button" className="sm-twisty" onClick={(event) => { event.stopPropagation(); toggle(node.path); }} aria-label={isOpen ? "Collapse" : "Expand"}>
                          <Icon name={isOpen ? "chevronDown" : "chevronRight"} />
                        </button>
                      ) : <span className="sm-twisty" />}
                      <i className={`sm-dot sm-tone-${status.tone}`} aria-hidden="true" />
                      {node.path !== node.name && <small>{node.parent ? node.path.slice(node.parent.length + 1, -node.name.length) : node.path.slice(0, -node.name.length)}</small>}
                      <strong>{node.name}</strong>
                      {node.children > 0 && !isOpen && (
                        <em className={node.attentionBelow ? "has-attention" : ""} title={node.attentionBelow ? `${node.attentionBelow} nested submodule(s) need attention` : `${node.children} nested submodule(s)`}>
                          {node.attentionBelow ? `${node.attentionBelow} below` : `+${node.children}`}
                        </em>
                      )}
                    </span>
                    <span className={`sm-status sm-tone-${status.tone}`} title={status.title}>{status.label}</span>
                    <span className="sm-commit">
                      {node.state === "uninitialized" ? <small>—</small> : <>
                        {node.branch ? <><Icon name="branch" />{node.branch}</> : <code>{node.commit.slice(0, 8)}</code>}
                        {(node.ahead > 0 || node.behind > 0) && <small className="sm-ab">{node.ahead ? `↑${node.ahead}` : ""}{node.behind ? `↓${node.behind}` : ""}</small>}
                        {(() => { const badge = forkBadge(forkByPath.get(node.path)); return badge ? <small className={`sm-fork${badge.stale ? " is-behind" : ""}`} title={badge.title}>⑂ {badge.text.replace(/^fork /, "")}</small> : null; })()}
                        {(node.tracking?.behind ?? 0) > 0 && <small className="sm-outdated" title={`The checked-out commit is ${plural(node.tracking!.behind, "commit")} behind origin/${node.tracking!.branch} (as of the last fetch). Update to remote moves it there.`}>{node.tracking!.behind} behind {node.tracking!.branch}</small>}
                      </>}
                    </span>
                    <span className="sm-url" title={node.url ?? undefined}>{node.url ? node.url.replace(/^(https?:\/\/|git@|file:\/\/)/, "").replace(/\.git$/, "") : ""}</span>
                  </div>
                );
              })}
              {!rows.length && <div className="ux-empty-state compact">No submodule matches.</div>}
            </div>
          )}
      </div>
      {mode === "mindmap" && tree && selected && (() => {
        const node = tree.nodes.find((entry) => entry.path === selected);
        if (!node) return null;
        const status = submoduleStatus(node);
        return (
          <aside className="sm-detail" aria-label={`Details of ${node.path}`}>
            <header><i className={`sm-dot sm-tone-${status.tone}`} /><strong>{node.path}</strong><button type="button" className="ux-icon-button" aria-label="Close details" onClick={() => setSelected(null)}>✕</button></header>
            <dl>
              <dt>Status</dt><dd className={`sm-tone-${status.tone}`}>{status.label}</dd>
              <dt>Checked out</dt><dd>{node.state === "uninitialized" ? "—" : <>{node.branch ?? "detached"} <code>{node.commit.slice(0, 10)}</code>{(node.ahead || node.behind) ? ` ↑${node.ahead} ↓${node.behind}` : ""}</>}</dd>
              {node.tracking && <><dt>Tracks</dt><dd>origin/{node.tracking.branch}{node.tracking.behind ? <span className="sm-outdated"> · {node.tracking.behind} commits behind</span> : " · up to date"}</dd></>}
              {node.recorded && <><dt>Parent records</dt><dd><code>{node.recorded.slice(0, 10)}</code></dd></>}
              {node.children > 0 && <><dt>Nested</dt><dd>{node.children} direct{node.attentionBelow ? `, ${node.attentionBelow} need attention` : ""}</dd></>}
              {node.url && <><dt>Remote</dt><dd className="sm-detail-url">{node.url}</dd></>}
              {forkByPath.get(node.path)?.kind === "fork" && <><dt>Fork of</dt><dd>{forkByPath.get(node.path)!.upstream?.url}{(() => { const badge = forkBadge(forkByPath.get(node.path)); return badge ? ` · ${badge.text.replace(/^fork /, "")}` : ""; })()}</dd></>}
            </dl>
            <footer>
              <button type="button" className="ux-primary-button" disabled={node.state === "uninitialized"} onClick={() => onOpenRepository(join(tree.root, node.path))}>Open</button>
              <button type="button" className="ux-button" onClick={(event) => nodeMenu(event, node)}>Actions…</button>
              <button type="button" className="ux-button" onClick={() => setPicked((current) => new Set([...current, ...subtree(node.path)]))}>Select{node.children ? " with nested" : ""}</button>
            </footer>
          </aside>
        );
      })()}

      {results && (
        <section className="sm-results" aria-label="Results">
          <header>
            <strong>{results.kind === "foreach" ? <>Ran <code>{results.label}</code></> : results.label}</strong>
            <span>{summarize(results)}</span>
            {results.kind === "bulk" && results.items.some((item) => item.status !== "ok") && (
              <button type="button" className="gk-link-button" onClick={() => setPicked(new Set(results.items.filter((item) => item.status !== "ok").map((item) => item.path)))}>Select the ones not done</button>
            )}
            {results.kind === "foreach" && results.items.some((item) => item.code !== 0) && (
              <button type="button" className="gk-link-button" onClick={() => setPicked(new Set(results.items.filter((item) => item.code !== 0).map((item) => item.path)))}>Select failures</button>
            )}
            <button type="button" className="ux-icon-button" aria-label="Close results" onClick={() => setResults(null)}>✕</button>
          </header>
          <div className="sm-results-body">
            {results.kind === "bulk" ? results.items.map((item) => (
              <div key={item.path} className={`sm-result is-${item.status}`}><b>{item.status === "ok" ? "✓" : item.status === "skipped" ? "–" : "✕"}</b><span>{item.path}</span><small>{item.message}</small></div>
            )) : results.items.map((item) => (
              <details key={item.path} className={`sm-result-run${item.code === 0 ? "" : " is-failed"}`} open={results.items.length <= 4 || item.code !== 0}>
                <summary><b>{item.code === 0 ? "✓" : item.code === null ? "–" : `exit ${item.code}`}</b><span>{item.path}</span><small>{item.ms ? `${item.ms} ms` : ""}{!item.stdout.trim() && !item.stderr.trim() ? " · no output" : ""}</small></summary>
                {(item.stdout || item.stderr) && <pre>{item.stdout}{item.stderr && <span className="sm-stderr">{item.stderr}</span>}</pre>}
              </details>
            ))}
          </div>
        </section>
      )}

      {manifest && (
        <div className="ux-modal-backdrop gk-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setManifest(null); }} onKeyDown={(event) => { if (event.key === "Escape") setManifest(null); }}>
          <div className="ux-dialog gk-dialog sm-manifest" role="dialog" aria-modal="true" aria-label="Submodule manifest">
            <header><h2>Submodule manifest</h2></header>
            <div className="ux-dialog-body gk-dialog-body">
              <p className="gk-dialog-message">URL, pinned commit and checked-out commit of every submodule. Share it, attach it to a bug report, or diff it against another checkout.</p>
              <textarea readOnly value={manifest} rows={16} spellCheck={false} />
            </div>
            <footer>
              <button type="button" className="ux-button" onClick={() => setManifest(null)}>Close</button>
              <button type="button" className="ux-button" onClick={() => { const blob = new Blob([manifest], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${(tree?.root ?? "repo").split(/[\\/]/).pop()}-submodules.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }}>Download</button>
              <button type="button" className="ux-primary-button" autoFocus onClick={() => { void navigator.clipboard?.writeText(manifest); pushToast("Manifest copied", "success", 2000); }}>Copy</button>
            </footer>
          </div>
        </div>
      )}
      {menu.element}
    </section>
  );
}

function summarize(results: Results): string {
  if (results.kind === "bulk") {
    const count = (status: SubmoduleBulkResult["status"]) => results.items.filter((item) => item.status === status).length;
    return [`${count("ok")} done`, count("skipped") ? `${count("skipped")} skipped` : "", count("failed") ? `${count("failed")} failed` : ""].filter(Boolean).join(" · ");
  }
  const failed = results.items.filter((item) => item.code !== 0).length;
  return `${results.items.length - failed} succeeded${failed ? ` · ${failed} failed or skipped` : ""}`;
}
