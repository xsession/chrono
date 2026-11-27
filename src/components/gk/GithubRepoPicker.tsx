// Your GitHub repositories, searchable: used by Clone and Add remote. Lists
// the servers that are GitHub (github.com and any host set to GitHub in
// Settings → Hosting connections).
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { GithubRepo } from "../../types";
import { getApiBase, getProviderOverride, getToken, locallyKnownHosts, loadRememberedTokens } from "../../providerTokens";
import { ago, serverRef } from "../../githubContext";

export type GithubServer = { host: string; apiBase: string };

export function githubServers(): GithubServer[] {
  const hosts = new Set(["github.com", ...locallyKnownHosts().filter((host) => getProviderOverride(host) === "github")]);
  return [...hosts].map((host) => ({ host, apiBase: getApiBase(host) || (host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`) }));
}

export function GithubRepoPicker({ onPick, protocol, onProtocol, onOpenSettings, compact }: {
  onPick: (repo: GithubRepo, url: string) => void;
  protocol: "https" | "ssh";
  onProtocol: (value: "https" | "ssh") => void;
  onOpenSettings?: () => void;
  compact?: boolean;
}) {
  const servers = useMemo(githubServers, []);
  const [server, setServer] = useState(servers[0]);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => { void loadRememberedTokens().then(() => setReady(true)); }, []);
  const token = ready ? getToken(server.host) : "";
  useEffect(() => {
    if (!ready) return;
    setRepos(null); setError(null);
    if (!getToken(server.host)) return;
    let cancelled = false;
    api.ghRepos(serverRef(server.host, server.apiBase)).then((list) => { if (!cancelled) setRepos(list); }).catch((reason) => { if (!cancelled) setError(String(reason).replace(/^Error: /, "")); });
    return () => { cancelled = true; };
  }, [server, ready, token]);

  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter((repo) => !needle || `${repo.fullName} ${repo.description}`.toLowerCase().includes(needle)).slice(0, 200);
  return (
    <div className={`gh-picker${compact ? " is-compact" : ""}`}>
      <div className="gh-picker-bar">
        {servers.length > 1 && <select value={server.host} onChange={(event) => setServer(servers.find((entry) => entry.host === event.target.value) ?? servers[0])} aria-label="GitHub server">{servers.map((entry) => <option key={entry.host}>{entry.host}</option>)}</select>}
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={repos ? `Search ${repos.length} repositories on ${server.host}` : `Repositories on ${server.host}`} aria-label="Search repositories" disabled={!repos} />
        <div className="gh-protocol" role="radiogroup" aria-label="Clone URL">
          {(["https", "ssh"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={protocol === value} className={protocol === value ? "is-active" : ""} onClick={() => onProtocol(value)}>{value.toUpperCase()}</button>)}
        </div>
      </div>
      <div className="gh-picker-list" role="listbox" aria-label="GitHub repositories">
        {!ready ? <p className="tg-note">Loading…</p>
          : !token ? <p className="tg-note">Not connected to {server.host}. {onOpenSettings ? <button type="button" className="gk-link-button" onClick={onOpenSettings}>Connect in Settings → Hosting connections</button> : "Connect in Settings → Hosting connections."}</p>
          : error ? <p className="tg-note gh-error">{error}</p>
          : !repos ? <p className="tg-note"><i className="ux-spinner" /> Loading your repositories…</p>
          : shown.length === 0 ? <p className="tg-note">No repository matches.</p>
          : shown.map((repo) => (
            <button key={repo.fullName} type="button" role="option" aria-selected="false" className="gh-picker-row" onClick={() => onPick(repo, protocol === "ssh" ? repo.sshUrl : repo.cloneUrl)} title={repo.description}>
              <strong>{repo.fullName}</strong>
              {repo.private && <span className="gh-badge">private</span>}
              {repo.fork && <span className="gh-badge">fork</span>}
              <small>{repo.description}</small>
              <em>{repo.updatedAt ? ago(repo.updatedAt) : ""}</em>
            </button>
          ))}
      </div>
    </div>
  );
}
