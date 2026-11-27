// State for the left panel's PULL REQUESTS and ISSUES sections: which GitHub
// remote they show, the lists (refreshed at most once a minute by the live
// watcher, always by hand), the issue filter, and the dialogs they open.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { GithubIssueSummary, GithubPullSummary } from "../../types";
import { githubRemotes, hasGithubToken, refFor, type GithubRemote } from "../../githubContext";
import { IssueView, NewIssueDialog, PullRequestView } from "./GithubDialogs";

type Run = (label: string, action: () => Promise<unknown>) => Promise<void>;

export const ISSUE_FILTERS: Array<[string, string]> = [
  ["Open", "is:open"],
  ["Assigned to me", "is:open assignee:@me"],
  ["Created by me", "is:open author:@me"],
  ["Mentioning me", "is:open mentions:@me"],
  ["Closed", "is:closed"],
];
const MIN_AUTO_RELOAD_MS = 60_000;

export function useGithubPanel(repositoryPath: string, refreshKey: number, run: Run) {
  const [remotes, setRemotes] = useState<GithubRemote[]>([]);
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(`chrono.gh.remote.${repositoryPath}`));
  const [pulls, setPulls] = useState<GithubPullSummary[] | null>(null);
  const [issues, setIssues] = useState<{ total: number; items: GithubIssueSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQueryState] = useState(() => localStorage.getItem("chrono.gh.issueQuery") || "is:open");
  const [issueBranches, setIssueBranches] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<{ kind: "pull" | "issue"; number: number } | { kind: "new-issue" } | null>(null);
  const [connected, setConnected] = useState(false);
  const lastLoad = useRef(0);

  useEffect(() => {
    setChosen(localStorage.getItem(`chrono.gh.remote.${repositoryPath}`));
    setPulls(null); setIssues(null); setError(null); lastLoad.current = 0;
    void githubRemotes(repositoryPath).then(setRemotes);
  }, [repositoryPath]);
  const gh = remotes.find((entry) => entry.remote === chosen) ?? remotes[0] ?? null;

  const load = useCallback(async (force: boolean) => {
    if (!gh) return;
    setConnected(hasGithubToken(gh));
    if (!hasGithubToken(gh)) { setPulls(null); setIssues(null); return; }
    if (!force && Date.now() - lastLoad.current < MIN_AUTO_RELOAD_MS) return;
    lastLoad.current = Date.now();
    try {
      const [pullList, issueList] = await Promise.all([api.ghPulls(repositoryPath, refFor(gh)), api.ghIssues(repositoryPath, refFor(gh), query)]);
      setPulls(pullList); setIssues(issueList); setError(null);
    } catch (reason) { setError(String(reason).replace(/^Error: /, "")); }
  }, [repositoryPath, gh, query]);

  useEffect(() => { void load(true); }, [gh?.remote, gh?.host.host, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.ghIssueBranches(repositoryPath).then(setIssueBranches).catch(() => setIssueBranches({})); }, [repositoryPath, refreshKey]);

  const setQuery = (value: string) => { const next = value.trim() || "is:open"; localStorage.setItem("chrono.gh.issueQuery", next); setQueryState(next); };
  const chooseRemote = (name: string) => { localStorage.setItem(`chrono.gh.remote.${repositoryPath}`, name); setChosen(name); };
  const reload = () => load(true);
  const changed = () => { void load(true); api.ghIssueBranches(repositoryPath).then(setIssueBranches).catch(() => undefined); };

  /** The issue number behind a branch made for an issue of this repository. */
  const issueOf = (branch: string): number | null => {
    const url = issueBranches[branch];
    if (!url || !gh) return null;
    const match = /\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url);
    return match && `${match[1]}/${match[2]}`.toLowerCase() === gh.fullName.toLowerCase() ? Number(match[3]) : null;
  };

  const dialogs = gh && open ? (
    open.kind === "pull" ? <PullRequestView repositoryPath={repositoryPath} gh={gh} number={open.number} run={run} onChanged={changed} onClose={() => setOpen(null)} />
      : open.kind === "issue" ? <IssueView repositoryPath={repositoryPath} gh={gh} number={open.number} run={run} onChanged={changed} issueBranches={issueBranches} onClose={() => setOpen(null)} />
      : <NewIssueDialog repositoryPath={repositoryPath} gh={gh} onClose={() => setOpen(null)} onCreated={(number) => { changed(); setOpen({ kind: "issue", number }); }} />
  ) : null;

  return {
    gh, remotes, chooseRemote, connected, pulls, issues, error, query, setQuery, reload, issueBranches, issueOf, dialogs,
    openPull: (number: number) => setOpen({ kind: "pull", number }),
    openIssue: (number: number) => setOpen({ kind: "issue", number }),
    newIssue: () => setOpen({ kind: "new-issue" }),
    refreshConnection: () => { if (gh) setConnected(hasGithubToken(gh)); void load(true); },
  };
}
