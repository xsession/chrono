import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { ActivityDay, BlameResult, BranchRecord, CommitRecord, ContributorRecord, PullRequestRecord, RangeDiffEntry, RangeDiffResult, RefComparison, RemoteRecord, RepositoryHealth } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { RevisionDiffView } from "./RevisionDiffView";

type Tab = "search" | "compare" | "review" | "health" | "file" | "blame" | "contributors" | "stats" | "pulls";

type PullRequestConfig = {
  provider: "github" | "gitlab" | "gitea" | "forgejo";
  baseUrl: string;
  owner: string;
  repository: string;
};

const emptyPullRequestConfig: PullRequestConfig = {
  provider: "github",
  baseUrl: "https://api.github.com",
  owner: "",
  repository: "",
};

function detectPullRequestConfig(remote: RemoteRecord): PullRequestConfig | null {
  const raw = remote.fetchUrl || remote.pushUrl;
  if (!raw) return null;
  const ssh = raw.match(/^git@([^:]+):(.+)$/);
  const http = ssh ? `https://${ssh[1]}/${ssh[2]}` : raw;
  let parsed: URL;
  try { parsed = new URL(http); } catch { return null; }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const host = parsed.hostname.toLowerCase();
  const provider: PullRequestConfig["provider"] = host.includes("github") ? "github" : host.includes("gitlab") ? "gitlab" : host.includes("forgejo") ? "forgejo" : "gitea";
  return {
    provider,
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    owner: parts.slice(0, -1).join("/"),
    repository: parts[parts.length - 1],
  };
}

type Props = {
  repositoryPath: string;
  branches: BranchRecord[];
  onOpenCommit?: (commit: CommitRecord) => void;
};

function formatDate(value: string | number) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** GitLens-style blame age heat: green (fresh) → yellow → purple (old) over
 *  ~3 years. authoredAt is unix seconds. */
function heatColor(authoredAt: number): string {
  const ageDays = (Date.now() / 1000 - authoredAt) / 86400;
  const t = Math.min(1, Math.max(0, ageDays / (365 * 3)));
  // 0 -> #16a34a (green) 0.5 -> #d97706 (amber) 1 -> #7c3aed (purple)
  const stops: [number, number, number][] = [[22, 163, 74], [217, 119, 6], [124, 58, 237]];
  const [a, b] = t < 0.5 ? [0, 1] : [1, 2];
  const f = (t < 0.5 ? t * 2 : (t - 0.5) * 2);
  const rgb = stops[a].map((v, i) => Math.round(v + (stops[b][i] - v) * f));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.22)`;
}

function CommitList({ commits, empty, onOpenCommit, onSelect, selectedIndex }: { commits: CommitRecord[]; empty: string; onOpenCommit?: (commit: CommitRecord) => void; onSelect?: (commit: CommitRecord, index: number) => void; selectedIndex?: number | null }) {
  if (!commits.length) return <div className="ux-empty-state">{empty}</div>;
  return <div className="ux-intel-commit-list">{commits.map((commit, index) => (
    <button key={commit.id} className={onSelect ? `ux-selectable-commit${selectedIndex === index ? " is-selected" : ""}` : undefined} onClick={() => { onSelect?.(commit, index); if (!onSelect) onOpenCommit?.(commit); }}>
      <code>{commit.id.slice(0, 8)}</code><span><strong>{commit.subject}</strong><small>{commit.authorName} · {formatDate(commit.authoredAt)}</small></span>
    </button>
  ))}</div>;
}

function FileDeltaList({ files }: { files: RefComparison["filesFromBaseToLeft"] }) {
  if (!files.length) return <div className="ux-empty-state compact">No file changes.</div>;
  return <div className="ux-intel-file-list">{files.map((file, index) => (
    <div key={`${file.path}-${index}`}><span title={file.path}>{file.path}</span>{file.binary ? <small>binary</small> : <small><b>+{file.additions ?? 0}</b> <i>−{file.deletions ?? 0}</i></small>}</div>
  ))}</div>;
}

function RangeDiffList({ result }: { result: RangeDiffResult }) {
  if (!result.entries.length) return <div className="ux-empty-state">The two patch series are empty or produced no comparable commits.</div>;
  const label = (entry: RangeDiffEntry) => entry.status === "same" ? "same" : entry.status === "changed" ? "changed" : entry.status;
  return <div className="ux-range-diff-list">
    {result.entries.map((entry, index) => <article key={`${entry.oldCommit ?? "old"}-${entry.newCommit ?? "new"}-${index}`} className={`ux-range-diff-row is-${entry.status}`}>
      <div className="ux-range-diff-badge" title={label(entry)}>{entry.status === "same" ? "=" : entry.status === "changed" ? "!" : entry.status === "added" ? ">" : "<"}</div>
      <div className="ux-range-diff-positions"><code>{entry.oldPosition ?? "—"}</code><span>→</span><code>{entry.newPosition ?? "—"}</code></div>
      <div className="ux-range-diff-main"><strong>{entry.subject || "(no subject)"}</strong><small>{entry.oldCommit ? `old ${entry.oldCommit.slice(0, 8)}` : "old —"} · {entry.newCommit ? `new ${entry.newCommit.slice(0, 8)}` : "new —"}</small>{entry.details.length > 0 && <pre>{entry.details.join("\n")}</pre>}</div>
    </article>)}
  </div>;
}

function HealthMetric({ label, value, tone = "neutral", detail }: { label: string; value: string | number; tone?: "neutral" | "good" | "warn" | "bad"; detail?: string }) {
  return <article className={`ux-health-metric is-${tone}`}><strong>{value}</strong><span>{label}</span>{detail && <small>{detail}</small>}</article>;
}

function HealthPanel({ health, onScan, busy }: { health: RepositoryHealth | null; onScan: (deep: boolean) => void; busy: boolean }) {
  if (!health) return <div className="ux-empty-state">{busy ? "Loading repository health…" : "Refresh repository health to inspect objects, worktrees, submodules and maintenance state."}</div>;
  const clean = health.dirtyFiles === 0 && health.conflictFiles === 0 && health.changedSubmoduleCount === 0;
  const objectState = health.fsck.scanned ? (health.fsck.unreachableObjects || health.fsck.danglingCommits ? "warn" : "good") : "neutral";
  return <div className="ux-health-panel">
    <div className="ux-health-toolbar"><div><strong>{health.branch || "Detached HEAD"}</strong><span>{health.head ? health.head.slice(0, 12) : "No commit yet"}</span></div><button className="ux-button" disabled={busy} onClick={() => onScan(false)}>Refresh</button><button className="ux-primary-button" disabled={busy} onClick={() => onScan(true)}>Run object scan</button></div>
    <div className="ux-health-grid">
      <HealthMetric label="Working-tree files" value={health.dirtyFiles} tone={health.dirtyFiles ? "warn" : "good"} detail={health.conflictFiles ? `${health.conflictFiles} conflicts` : "clean index/worktree"} />
      <HealthMetric label="Worktrees" value={health.worktreeCount} tone={health.dirtyWorktreeCount ? "warn" : "good"} detail={health.dirtyWorktreeCount ? `${health.dirtyWorktreeCount} dirty` : "all clean"} />
      <HealthMetric label="Submodules" value={health.submoduleCount} tone={health.changedSubmoduleCount ? "warn" : "neutral"} detail={health.changedSubmoduleCount ? `${health.changedSubmoduleCount} changed` : "in recorded state"} />
      <HealthMetric label="Loose objects" value={health.objectCount} tone={objectState} detail={`${health.packedObjectCount} packed`} />
      <HealthMetric label="Reflog entries" value={health.reflogEntries} detail={health.reflogEntries ? "recovery points available" : "no reflog entries"} />
      <HealthMetric label="Packfiles" value={health.packCount} detail={`${health.packSizeKb} KiB packed`} />
    </div>
    <div className="ux-health-notices">
      <span className={clean ? "is-good" : "is-warn"}>{clean ? "Working tree is clean" : "Review working-tree or submodule changes"}</span>
      <span className={health.maintenanceConfigured ? "is-good" : "is-neutral"}>{health.maintenanceConfigured ? "Maintenance configured" : "Maintenance not configured"}</span>
      <span className={health.lfsAvailable ? "is-good" : "is-neutral"}>{health.lfsAvailable ? `${health.lfsTrackedFiles} LFS files detected` : "Git LFS unavailable"}</span>
    </div>
    {health.fsck.scanned && <div className={`ux-health-scan ${health.fsck.warnings.length ? "has-warnings" : "is-clean"}`}><strong>{health.fsck.warnings.length ? `${health.fsck.warnings.length} fsck findings` : "Object scan passed"}</strong>{health.fsck.warnings.length > 0 && <pre>{health.fsck.warnings.join("\n")}</pre>}</div>}
  </div>;
}

export function GitIntelligencePanel({ repositoryPath, branches, onOpenCommit }: Props) {
  const [tab, setTab] = useState<Tab>("search");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Search history, compare refs, inspect file evolution, blame lines, and find repository experts.");

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CommitRecord[]>([]);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem("chrono.searchPins") || "[]");
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
    } catch { return []; }
  });

  const current = branches.find((branch) => branch.current)?.name || "HEAD";
  const likelyBase = branches.find((branch) => !branch.remote && !branch.current && ["main", "master", "develop"].includes(branch.name))?.name || "main";
  const [left, setLeft] = useState(current);
  const [right, setRight] = useState(likelyBase);
  const [comparison, setComparison] = useState<RefComparison | null>(null);
  const [compareTab, setCompareTab] = useState<"left" | "right" | "filesLeft" | "filesRight">("right");
  const [rangeBase, setRangeBase] = useState(likelyBase);
  const [rangeBefore, setRangeBefore] = useState(current);
  const [rangeAfter, setRangeAfter] = useState(current);
  const [rangeDiff, setRangeDiff] = useState<RangeDiffResult | null>(null);
  const [health, setHealth] = useState<RepositoryHealth | null>(null);

  const [filePath, setFilePath] = useState("");
  const [followRenames, setFollowRenames] = useState(true);
  const [allRefs, setAllRefs] = useState(false);
  const [fileHistory, setFileHistory] = useState<CommitRecord[]>([]);
  const [selectedRevisionIndex, setSelectedRevisionIndex] = useState<number | null>(null);
  const [lineStart, setLineStart] = useState("1");
  const [lineEnd, setLineEnd] = useState("1");
  const [lineHistory, setLineHistory] = useState<CommitRecord[]>([]);

  const [blamePath, setBlamePath] = useState("");
  const [blameRevision, setBlameRevision] = useState("");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [heatmap, setHeatmap] = useState(true);
  const [blame, setBlame] = useState<BlameResult | null>(null);

  const [contributors, setContributors] = useState<ContributorRecord[]>([]);
  const [activity, setActivity] = useState<ActivityDay[]>([]);
  const [activityDays, setActivityDays] = useState(365);
  const [pullRequests, setPullRequests] = useState<PullRequestRecord[]>([]);
  const [pullRequestConfig, setPullRequestConfig] = useState<PullRequestConfig>(emptyPullRequestConfig);
  const [pullRequestToken, setPullRequestToken] = useState("");
  const [pullRequestFilter, setPullRequestFilter] = useState<"open" | "closed" | "all">("open");
  const [pullRequestQuery, setPullRequestQuery] = useState("");
  const [remotes, setRemotes] = useState<RemoteRecord[]>([]);
  const [remotesLoaded, setRemotesLoaded] = useState(false);

  useEffect(() => {
    setLeft(current);
    setRight(likelyBase);
    setComparison(null);
    setRangeBase(likelyBase);
    setRangeBefore(current);
    setRangeAfter(current);
    setRangeDiff(null);
    setHealth(null);
    setSearchResults([]);
    setFileHistory([]);
    setSelectedRevisionIndex(null);
    setLineHistory([]);
    setBlame(null);
    setContributors([]);
    setActivity([]);
    setPullRequests([]);
    setPullRequestConfig(emptyPullRequestConfig);
    setPullRequestToken("");
    setRemotes([]);
    setRemotesLoaded(false);
    setMessage("Search history, compare refs, inspect file evolution, blame lines, and find repository experts.");
  }, [repositoryPath, current, likelyBase]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(true);
    setMessage(`${label}…`);
    try { await work(); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };

  const search = () => run("Searching history", async () => {
    const result = await api.searchCommits(repositoryPath, query.trim(), 250);
    setSearchResults(result.commits);
    setMessage(`${result.commits.length} commit${result.commits.length === 1 ? "" : "s"} matched.`);
  });

  const compare = () => run("Comparing references", async () => {
    const result = await api.compareRefs(repositoryPath, left.trim(), right.trim(), 150);
    setComparison(result);
    setMessage(`${result.leftOnlyCount} only on ${result.left}; ${result.rightOnlyCount} only on ${result.right}.`);
  });

  const reviewRange = () => run("Comparing patch series", async () => {
    const result = await api.rangeDiff(repositoryPath, rangeBase.trim(), rangeBefore.trim(), rangeAfter.trim());
    setRangeDiff(result);
    setMessage(`${result.entries.length} patch-series entries compared${result.truncated ? " (output truncated)" : ""}.`);
  });

  const refreshHealth = (scanObjects: boolean) => run(scanObjects ? "Scanning repository objects" : "Loading repository health", async () => {
    const result = await api.repositoryHealth(repositoryPath, scanObjects);
    setHealth(result);
    setMessage(scanObjects ? `Object scan completed with ${result.fsck.warnings.length} finding${result.fsck.warnings.length === 1 ? "" : "s"}.` : "Repository health refreshed.");
  });

  const loadFileHistory = () => run("Loading file history", async () => {
    const result = await api.fileHistory(repositoryPath, { file: filePath.trim(), followRenames, allRefs, limit: 300 });
    setFileHistory(result);
    setSelectedRevisionIndex(result.length ? 0 : null);
    setMessage(`${result.length} revisions touched ${filePath.trim()}.`);
  });

  const loadLineHistory = () => run("Loading line history", async () => {
    const start = Math.max(1, Number(lineStart) || 1);
    const end = Math.max(start, Number(lineEnd) || start);
    const result = await api.lineHistory(repositoryPath, filePath.trim(), start, end, 150);
    setLineHistory(result);
    setMessage(`${result.length} commits affected lines ${start}–${end}.`);
  });

  const loadBlame = () => run("Blaming file", async () => {
    const result = await api.blameFile(repositoryPath, blamePath.trim(), blameRevision.trim() || null, ignoreWhitespace, 5000);
    setBlame(result);
    setMessage(`${result.lines.length} lines attributed${result.truncated ? " (truncated)" : ""}.`);
  });

  useEffect(() => {
    if (tab !== "contributors" || contributors.length) return;
    void run("Loading contributors", async () => {
      const result = await api.contributors(repositoryPath, 30000);
      setContributors(result);
      setMessage(`${result.length} contributors found.`);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, repositoryPath]);

  useEffect(() => {
    if (tab !== "stats" || activity.length) return;
    void run("Loading activity", async () => {
      const result = await api.commitActivity(repositoryPath, activityDays);
      setActivity(result);
      setMessage(`${result.reduce((total, day) => total + day.count, 0)} commits across the last ${activityDays} days.`);
    });
  }, [tab, repositoryPath, activityDays]);

  useEffect(() => {
    if (tab !== "health" || health) return;
    void refreshHealth(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, repositoryPath]);

  useEffect(() => {
    if (tab !== "pulls" || remotesLoaded) return;
    void api.remotes(repositoryPath).then((result) => {
      setRemotes(result);
      const detected = result.map(detectPullRequestConfig).find((value): value is PullRequestConfig => value !== null);
      if (detected) setPullRequestConfig(detected);
      setMessage(detected ? `Detected ${detected.provider} repository context from the Git remote.` : "Enter provider details to load pull requests.");
    }).catch((error) => setMessage(String(error))).finally(() => setRemotesLoaded(true));
  }, [repositoryPath, remotesLoaded, tab]);

  const reloadActivity = () => run("Loading activity", async () => {
    const result = await api.commitActivity(repositoryPath, activityDays);
    setActivity(result);
    setMessage(`${result.reduce((total, day) => total + day.count, 0)} commits across the last ${activityDays} days.`);
  });

  const loadPullRequests = () => run("Loading pull requests", async () => {
    const config = pullRequestConfig;
    if (!config.owner.trim() || !config.repository.trim()) throw new Error("Owner/group and repository are required");
    const result = await api.pullRequests(config.provider, config.baseUrl.trim(), config.owner.trim(), config.repository.trim(), pullRequestToken.trim());
    setPullRequests(result);
    localStorage.setItem("chrono.pullRequestConfig", JSON.stringify(config));
    setMessage(`${result.length} pull request${result.length === 1 ? "" : "s"} loaded.`);
  });

  const pinQuery = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    const next = [normalized, ...pins.filter((item) => item !== normalized)].slice(0, 12);
    setPins(next);
    localStorage.setItem("chrono.searchPins", JSON.stringify(next));
  };

  const tabs: Array<{ id: Tab; label: string; icon: "search" | "compare" | "file" | "eye" | "users" | "activity" | "list" | "settings" }> = [
    { id: "search", label: "Search", icon: "search" },
    { id: "compare", label: "Compare", icon: "compare" },
    { id: "review", label: "Range review", icon: "compare" },
    { id: "health", label: "Health", icon: "settings" },
    { id: "file", label: "File & line history", icon: "file" },
    { id: "blame", label: "Blame", icon: "eye" },
    { id: "contributors", label: "Contributors", icon: "users" },
    { id: "stats", label: "Activity", icon: "activity" },
    { id: "pulls", label: "Pull requests", icon: "list" }
  ];

  const contributorMax = useMemo(() => Math.max(1, ...contributors.map((item) => item.commits)), [contributors]);
  const activityTotal = useMemo(() => activity.reduce((total, day) => total + day.count, 0), [activity]);
  const activityPeak = useMemo(() => Math.max(1, ...activity.map((day) => day.count)), [activity]);
  const visiblePullRequests = useMemo(() => pullRequests.filter((item) => {
    const state = item.state.toLowerCase();
    const stateMatch = pullRequestFilter === "all" || (pullRequestFilter === "open" ? state === "open" : state !== "open");
    const needle = pullRequestQuery.trim().toLowerCase();
    const queryMatch = !needle || [item.title, item.author, item.sourceBranch, item.targetBranch, String(item.number)].some((value) => value.toLowerCase().includes(needle));
    return stateMatch && queryMatch;
  }), [pullRequests, pullRequestFilter, pullRequestQuery]);

  return (
    <div className="ux-intelligence-view">
      <header className="ux-view-toolbar">
        <div><h2>Git Intelligence</h2><span>Search, compare and trace repository history without leaving the workbench</span></div>
        <span className="ux-help-text">GitLens-inspired clean-room workflow</span>
      </header>

      <nav className="ux-intel-tabs" aria-label="Git intelligence tools">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} />{item.label}</button>)}
      </nav>

      <section className="ux-intel-content">
        {tab === "search" && <>
          <div className="ux-intel-querybar">
            <label className="ux-search-field wide"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder={'message:"fix crash" author:alice file:src change:timeout ref:main..feature'} /></label>
            <button className="ux-primary-button" disabled={busy || !query.trim()} onClick={() => void search()}>Search</button>
            <button className="ux-button" disabled={!query.trim()} onClick={() => pinQuery(query)}>Pin</button>
          </div>
          <div className="ux-search-hints"><code>message:</code><code>author:</code><code>file:</code><code>change:</code><code>ref:</code><code>commit:</code><code>@me</code></div>
          {pins.length > 0 && <div className="ux-pinned-searches"><span>Pinned</span>{pins.map((item) => <button key={item} onClick={() => setQuery(item)}>{item}</button>)}</div>}
          <CommitList commits={searchResults} empty="Run a search to find commits by message, author, file, SHA, patch content, or revision range." onOpenCommit={onOpenCommit} />
        </>}

        {tab === "compare" && <>
          <div className="ux-compare-controls">
            <label><span>Left</span><input list="intel-refs" value={left} onChange={(event) => setLeft(event.target.value)} /></label>
            <button className="ux-icon-button" onClick={() => { setLeft(right); setRight(left); }} title="Swap references" aria-label="Swap references">⇄</button>
            <label><span>Right</span><input list="intel-refs" value={right} onChange={(event) => setRight(event.target.value)} /></label>
            <datalist id="intel-refs">{branches.map((branch) => <option key={`${branch.remote}-${branch.name}`} value={branch.name} />)}</datalist>
            <button className="ux-primary-button" disabled={busy || !left.trim() || !right.trim()} onClick={() => void compare()}>Compare</button>
          </div>
          {comparison ? <>
            <div className="ux-comparison-summary">
              <article><strong>{comparison.leftOnlyCount}</strong><span>only on {comparison.left}</span></article>
              <article><strong>{comparison.rightOnlyCount}</strong><span>only on {comparison.right}</span></article>
              <article><code>{comparison.mergeBase.slice(0, 10)}</code><span>common base</span></article>
            </div>
            <div className="ux-intel-subtabs">
              <button className={compareTab === "left" ? "is-active" : ""} onClick={() => setCompareTab("left")}>Ahead: {comparison.left}</button>
              <button className={compareTab === "right" ? "is-active" : ""} onClick={() => setCompareTab("right")}>Ahead: {comparison.right}</button>
              <button className={compareTab === "filesLeft" ? "is-active" : ""} onClick={() => setCompareTab("filesLeft")}>Files → {comparison.left}</button>
              <button className={compareTab === "filesRight" ? "is-active" : ""} onClick={() => setCompareTab("filesRight")}>Files → {comparison.right}</button>
            </div>
            {compareTab === "left" && <CommitList commits={comparison.leftOnly} empty="No commits unique to the left reference." onOpenCommit={onOpenCommit} />}
            {compareTab === "right" && <CommitList commits={comparison.rightOnly} empty="No commits unique to the right reference." onOpenCommit={onOpenCommit} />}
            {compareTab === "filesLeft" && <FileDeltaList files={comparison.filesFromBaseToLeft} />}
            {compareTab === "filesRight" && <FileDeltaList files={comparison.filesFromBaseToRight} />}
          </> : <div className="ux-empty-state">Compare two branches, tags or commits. The common base is calculated so you can review what each side would contribute to a merge.</div>}
        </>}

        {tab === "review" && <>
          <div className="ux-range-review-intro"><div><strong>Review a rebased or amended patch series</strong><span>Compare commits introduced from the same base, even when their SHA-1 values changed.</span></div><span className="ux-help-text">git range-diff</span></div>
          <div className="ux-range-review-controls">
            <label><span>Base</span><input list="intel-refs-review" value={rangeBase} onChange={(event) => setRangeBase(event.target.value)} placeholder="main" /></label>
            <label><span>Before</span><input list="intel-refs-review" value={rangeBefore} onChange={(event) => setRangeBefore(event.target.value)} placeholder="feature-before" /></label>
            <label><span>After</span><input list="intel-refs-review" value={rangeAfter} onChange={(event) => setRangeAfter(event.target.value)} placeholder="feature-after" /></label>
            <datalist id="intel-refs-review">{branches.map((branch) => <option key={`${branch.remote}-${branch.name}`} value={branch.name} />)}</datalist>
            <button className="ux-primary-button" disabled={busy || !rangeBase.trim() || !rangeBefore.trim() || !rangeAfter.trim()} onClick={() => void reviewRange()}>Review series</button>
          </div>
          {rangeDiff ? <>
            <div className="ux-range-review-summary"><article><strong>{rangeDiff.entries.filter((entry) => entry.status === "same").length}</strong><span>unchanged patches</span></article><article><strong>{rangeDiff.entries.filter((entry) => entry.status === "changed").length}</strong><span>changed patches</span></article><article><strong>{rangeDiff.entries.filter((entry) => entry.status === "added" || entry.status === "deleted").length}</strong><span>added / removed</span></article></div>
            <RangeDiffList result={rangeDiff} />
            {rangeDiff.truncated && <div className="ux-inline-warning is-info"><Icon name="activity" /><span>The range-diff output is truncated for UI performance.</span></div>}
          </> : <div className="ux-empty-state">Choose a common base and two versions of the branch to see which patches were preserved, rewritten, added or dropped.</div>}
        </>}

        {tab === "health" && <HealthPanel health={health} onScan={refreshHealth} busy={busy} />}

        {tab === "file" && <>
          <div className="ux-file-history-controls">
            <label className="grow"><span>Repository-relative file</span><input value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="src/App.tsx" /></label>
            <label className="ux-check-row"><input type="checkbox" checked={followRenames} onChange={(event) => setFollowRenames(event.target.checked)} />Follow renames</label>
            <label className="ux-check-row"><input type="checkbox" checked={allRefs} onChange={(event) => setAllRefs(event.target.checked)} />All refs</label>
            <button className="ux-primary-button" disabled={busy || !filePath.trim()} onClick={() => void loadFileHistory()}>File history</button>
          </div>
          <div className="ux-line-history-controls">
            <span>Selected lines</span><input type="number" min="1" value={lineStart} onChange={(event) => setLineStart(event.target.value)} /><span>to</span><input type="number" min="1" value={lineEnd} onChange={(event) => setLineEnd(event.target.value)} /><button className="ux-button" disabled={busy || !filePath.trim()} onClick={() => void loadLineHistory()}>Line history</button>
          </div>
          <div className="ux-file-history-columns"><section><h3>File history <span>{fileHistory.length}</span></h3><CommitList commits={fileHistory} empty="Load a file to trace its revisions." selectedIndex={selectedRevisionIndex} onSelect={(_commit, index) => setSelectedRevisionIndex(index)} /></section><section><h3>Line history <span>{lineHistory.length}</span></h3><CommitList commits={lineHistory} empty="Choose a line range to trace when those lines changed." onOpenCommit={onOpenCommit} /></section></div>
          <RevisionDiffView repositoryPath={repositoryPath} file={filePath} history={fileHistory} selectedIndex={selectedRevisionIndex} onSelectIndex={setSelectedRevisionIndex} onOpenCommit={onOpenCommit} />
        </>}

        {tab === "blame" && <>
          <div className="ux-file-history-controls">
            <label className="grow"><span>Repository-relative file</span><input value={blamePath} onChange={(event) => setBlamePath(event.target.value)} placeholder="src/App.tsx" /></label>
            <label><span>Revision</span><input value={blameRevision} onChange={(event) => setBlameRevision(event.target.value)} placeholder="working tree" /></label>
            <label className="ux-check-row"><input type="checkbox" checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} />Ignore whitespace</label>
            <label className="ux-check-row"><input type="checkbox" checked={heatmap} onChange={(event) => setHeatmap(event.target.checked)} />Age heatmap (green=new → purple=old)</label>
            <button className="ux-primary-button" disabled={busy || !blamePath.trim()} onClick={() => void loadBlame()}>Blame</button>
          </div>
          {blame ? <div className={`ux-blame-table${heatmap ? " is-heatmap" : ""}`} role="table" aria-label={`Blame for ${blame.file}`}>
            <div className="ux-blame-row is-header" role="row"><span>Line</span><span>Commit</span><span>Author</span><span>Date</span><span>Content</span></div>
            {blame.lines.map((line) => <div className="ux-blame-row" role="row" key={`${line.lineNumber}-${line.commit}`} style={heatmap ? { backgroundColor: heatColor(line.authoredAt) } : undefined} title={line.summary}><code>{line.lineNumber}</code><code>{line.commit.slice(0, 8)}</code><span>{line.author}</span><span>{formatDate(line.authoredAt)}</span><pre>{line.content}</pre></div>)}
            {blame.truncated && <div className="ux-inline-warning is-info"><Icon name="activity" /><span>Blame output is truncated for UI performance.</span></div>}
          </div> : <div className="ux-empty-state">Load blame to see the commit, author and age of every line. This is repository data only; it does not annotate an external code editor.</div>}
        </>}

        {tab === "stats" && <>
          <div className="ux-activity-controls">
            <div><strong>Commit activity</strong><span>All refs · authored commit dates</span></div>
            <label><span>Window</span><select value={activityDays} onChange={(event) => { setActivityDays(Number(event.target.value)); setActivity([]); }}><option value={90}>90 days</option><option value={365}>1 year</option><option value={730}>2 years</option></select></label>
            <button className="ux-button" disabled={busy} onClick={() => void reloadActivity()}>Refresh activity</button>
          </div>
          <div className="ux-activity-summary">
            <article><strong>{activityTotal}</strong><span>commits</span></article>
            <article><strong>{activity.filter((day) => day.count > 0).length}</strong><span>active days</span></article>
            <article><strong>{activityPeak}</strong><span>peak in one day</span></article>
          </div>
          <div className="ux-activity-panel">
            {activity.length ? <div className="ux-activity-grid" role="img" aria-label={`Commit activity for the last ${activityDays} days`}>
              {activity.map((day) => <span key={day.date} className={day.count ? "has-commits" : ""} style={{ opacity: day.count ? 0.32 + (day.count / activityPeak) * 0.68 : 0.18 }} title={`${day.date}: ${day.count} commit${day.count === 1 ? "" : "s"}`} />)}
            </div> : <div className="ux-empty-state">{busy ? "Loading activity…" : "No activity loaded."}</div>}
            <div className="ux-activity-legend"><span>Less</span><i /><i /><i /><i /><span>More</span></div>
          </div>
          <p className="ux-help-text">Use this view to spot quiet periods, release bursts and regression windows before drilling into History or Search.</p>
        </>}

        {tab === "pulls" && <>
          <div className="ux-pr-toolbar">
            <div><strong>Pull request triage</strong><span>Provider-neutral read-only review launchpad</span></div>
            <button className="ux-button" disabled={busy} onClick={() => { setRemotesLoaded(false); setPullRequests([]); }}>Detect remote</button>
          </div>
          {remotes.length > 0 && <div className="ux-pr-remotes"><span>Git remotes</span>{remotes.map((remote) => <button key={remote.name} className={remote.name === "origin" ? "is-active" : ""} onClick={() => { const detected = detectPullRequestConfig(remote); if (detected) setPullRequestConfig(detected); }}>{remote.name}</button>)}</div>}
          <div className="ux-pr-config">
            <label><span>Provider</span><select value={pullRequestConfig.provider} onChange={(event) => setPullRequestConfig((current) => ({ ...current, provider: event.target.value as PullRequestConfig["provider"] }))}><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="gitea">Gitea</option><option value="forgejo">Forgejo</option></select></label>
            <label className="wide"><span>API base URL</span><input value={pullRequestConfig.baseUrl} onChange={(event) => setPullRequestConfig((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.github.com" /></label>
            <label><span>Owner / group</span><input value={pullRequestConfig.owner} onChange={(event) => setPullRequestConfig((current) => ({ ...current, owner: event.target.value }))} placeholder="owner or group/path" /></label>
            <label><span>Repository</span><input value={pullRequestConfig.repository} onChange={(event) => setPullRequestConfig((current) => ({ ...current, repository: event.target.value }))} placeholder="repository" /></label>
            <label><span>Token (optional)</span><input type="password" value={pullRequestToken} onChange={(event) => setPullRequestToken(event.target.value)} placeholder="not stored" /></label>
            <button className="ux-primary-button" disabled={busy || !pullRequestConfig.owner.trim() || !pullRequestConfig.repository.trim()} onClick={() => void loadPullRequests()}>Load PRs</button>
          </div>
          <div className="ux-pr-list-toolbar">
            <label className="ux-search-field"><Icon name="search" /><input value={pullRequestQuery} onChange={(event) => setPullRequestQuery(event.target.value)} placeholder="Filter title, branch, author or number" /></label>
            <select value={pullRequestFilter} onChange={(event) => setPullRequestFilter(event.target.value as "open" | "closed" | "all")} aria-label="Pull request state"><option value="open">Open</option><option value="closed">Closed / merged</option><option value="all">All states</option></select>
            <span className="ux-help-text">{visiblePullRequests.length} shown · {pullRequests.length} loaded</span>
          </div>
          {visiblePullRequests.length ? <div className="ux-pr-list">{visiblePullRequests.map((item) => <article key={item.id || `${item.number}-${item.title}`} className="ux-pr-card">
            <div className="ux-pr-card-main"><strong>#{item.number} {item.title}</strong><span>{item.author || "Unknown author"} · {item.state}</span><small>{item.sourceBranch || "?"} → {item.targetBranch || "?"}{item.updatedAt ? ` · updated ${formatDate(item.updatedAt)}` : ""}</small></div>
            <button className="ux-button" disabled={!item.webUrl} onClick={() => { if (item.webUrl) window.open(item.webUrl, "_blank", "noopener,noreferrer"); }}>Open review</button>
          </article>)}</div> : <div className="ux-empty-state">{busy ? "Loading pull requests…" : pullRequests.length ? "No pull requests match this filter." : "Detect a remote, verify the provider details, then load pull requests."}</div>}
        </>}

        {tab === "contributors" && <div className="ux-contributor-list">
          {contributors.map((person) => <article key={`${person.email}-${person.name}`}><span className="ux-contributor-avatar">{person.name.slice(0, 2).toUpperCase()}</span><div><strong>{person.name}</strong><small>{person.email}</small><span>{formatDate(person.firstCommit)} → {formatDate(person.lastCommit)}</span></div><div className="ux-contributor-count"><b>{person.commits}</b><small>commits</small><i style={{ width: `${Math.max(4, person.commits / contributorMax * 100)}%` }} /></div></article>)}
          {!contributors.length && <div className="ux-empty-state">{busy ? "Loading contributors…" : "No contributor data loaded."}</div>}
        </div>}
      </section>

      <footer className="ux-intel-status"><span>{message}</span><span>{busy ? <><i className="ux-spinner" />Working…</> : "Ready"}</span></footer>
    </div>
  );
}
