import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { BlameResult, BranchRecord, CommitRecord, ContributorRecord, RefComparison } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";

type Tab = "search" | "compare" | "file" | "blame" | "contributors";

type Props = {
  repositoryPath: string;
  branches: BranchRecord[];
  onOpenCommit?: (commit: CommitRecord) => void;
};

function formatDate(value: string | number) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function CommitList({ commits, empty, onOpenCommit }: { commits: CommitRecord[]; empty: string; onOpenCommit?: (commit: CommitRecord) => void }) {
  if (!commits.length) return <div className="ux-empty-state">{empty}</div>;
  return <div className="ux-intel-commit-list">{commits.map((commit) => (
    <button key={commit.id} onClick={() => onOpenCommit?.(commit)}>
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

  const [filePath, setFilePath] = useState("");
  const [followRenames, setFollowRenames] = useState(true);
  const [allRefs, setAllRefs] = useState(false);
  const [fileHistory, setFileHistory] = useState<CommitRecord[]>([]);
  const [lineStart, setLineStart] = useState("1");
  const [lineEnd, setLineEnd] = useState("1");
  const [lineHistory, setLineHistory] = useState<CommitRecord[]>([]);

  const [blamePath, setBlamePath] = useState("");
  const [blameRevision, setBlameRevision] = useState("");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [blame, setBlame] = useState<BlameResult | null>(null);

  const [contributors, setContributors] = useState<ContributorRecord[]>([]);

  useEffect(() => {
    setLeft(current);
    setRight(likelyBase);
    setComparison(null);
    setSearchResults([]);
    setFileHistory([]);
    setLineHistory([]);
    setBlame(null);
    setContributors([]);
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

  const loadFileHistory = () => run("Loading file history", async () => {
    const result = await api.fileHistory(repositoryPath, { file: filePath.trim(), followRenames, allRefs, limit: 300 });
    setFileHistory(result);
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

  const pinQuery = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    const next = [normalized, ...pins.filter((item) => item !== normalized)].slice(0, 12);
    setPins(next);
    localStorage.setItem("chrono.searchPins", JSON.stringify(next));
  };

  const tabs: Array<{ id: Tab; label: string; icon: "search" | "compare" | "file" | "eye" | "users" }> = [
    { id: "search", label: "Search", icon: "search" },
    { id: "compare", label: "Compare", icon: "compare" },
    { id: "file", label: "File & line history", icon: "file" },
    { id: "blame", label: "Blame", icon: "eye" },
    { id: "contributors", label: "Contributors", icon: "users" }
  ];

  const contributorMax = useMemo(() => Math.max(1, ...contributors.map((item) => item.commits)), [contributors]);

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
          <div className="ux-file-history-columns"><section><h3>File history <span>{fileHistory.length}</span></h3><CommitList commits={fileHistory} empty="Load a file to trace its revisions." onOpenCommit={onOpenCommit} /></section><section><h3>Line history <span>{lineHistory.length}</span></h3><CommitList commits={lineHistory} empty="Choose a line range to trace when those lines changed." onOpenCommit={onOpenCommit} /></section></div>
        </>}

        {tab === "blame" && <>
          <div className="ux-file-history-controls">
            <label className="grow"><span>Repository-relative file</span><input value={blamePath} onChange={(event) => setBlamePath(event.target.value)} placeholder="src/App.tsx" /></label>
            <label><span>Revision</span><input value={blameRevision} onChange={(event) => setBlameRevision(event.target.value)} placeholder="working tree" /></label>
            <label className="ux-check-row"><input type="checkbox" checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} />Ignore whitespace</label>
            <button className="ux-primary-button" disabled={busy || !blamePath.trim()} onClick={() => void loadBlame()}>Blame</button>
          </div>
          {blame ? <div className="ux-blame-table" role="table" aria-label={`Blame for ${blame.file}`}>
            <div className="ux-blame-row is-header" role="row"><span>Line</span><span>Commit</span><span>Author</span><span>Date</span><span>Content</span></div>
            {blame.lines.map((line) => <div className="ux-blame-row" role="row" key={`${line.lineNumber}-${line.commit}`} title={line.summary}><code>{line.lineNumber}</code><code>{line.commit.slice(0, 8)}</code><span>{line.author}</span><span>{formatDate(line.authoredAt)}</span><pre>{line.content}</pre></div>)}
            {blame.truncated && <div className="ux-inline-warning is-info"><Icon name="activity" /><span>Blame output is truncated for UI performance.</span></div>}
          </div> : <div className="ux-empty-state">Load blame to see the commit, author and age of every line. This is repository data only; it does not annotate an external code editor.</div>}
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
