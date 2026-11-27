// Which remotes of a repository are on GitHub (github.com or GitHub
// Enterprise), and the request details the GitHub routes need for them.
import { api } from "./api";
import { ensureToken, getApiBase, getProviderOverride, getToken, loadRememberedTokens } from "./providerTokens";
import type { GithubRemoteRef, GithubServerRef, RemoteHost } from "./types";

export type GithubRemote = { remote: string; host: RemoteHost; fullName: string; webUrl: string };

/** The API base for a GitHub host: the override from Settings, else the
 *  detected one; an Enterprise host picked as "GitHub" by hand gets /api/v3. */
export function githubApiBase(host: RemoteHost): string {
  const override = getApiBase(host.host);
  if (override) return override;
  if (host.provider === "github") return host.apiBase;
  return host.host === "github.com" ? "https://api.github.com" : `https://${host.host}/api/v3`;
}

/** GitHub remotes, upstream first (a fork's pull requests and issues live
 *  there), then origin, then the rest. */
export async function githubRemotes(path: string): Promise<GithubRemote[]> {
  await loadRememberedTokens();
  const remotes = await api.remotes(path).catch(() => []);
  const hosts = await Promise.all(remotes.map((remote) => api.remoteHost(path, remote.name).catch(() => null)));
  const out: GithubRemote[] = [];
  remotes.forEach((remote, index) => {
    const host = hosts[index];
    if (!host || (getProviderOverride(host.host) || host.provider) !== "github") return;
    const apiBase = githubApiBase(host);
    out.push({ remote: remote.name, host: { ...host, provider: "github", apiBase }, fullName: `${host.owner}/${host.repository}`, webUrl: host.webBase });
  });
  const rank = (name: string) => (name === "upstream" ? 0 : name === "origin" ? 1 : 2);
  return out.sort((a, b) => rank(a.remote) - rank(b.remote) || a.remote.localeCompare(b.remote));
}

/** Request details for a remote, with whatever token is at hand ("" lets the
 *  server use a remembered one). */
export function refFor(entry: GithubRemote): GithubRemoteRef {
  const override = getApiBase(entry.host.host);
  return { remote: entry.remote, apiBase: override || (entry.host.apiBase !== "https://api.github.com" ? entry.host.apiBase : undefined), provider: "github", token: getToken(entry.host.host) };
}

/** Like refFor, but asks for a token when there is none. */
export async function refAsking(entry: GithubRemote): Promise<GithubRemoteRef | null> {
  const token = await ensureToken(entry.host.host, "github");
  return token ? { ...refFor(entry), token } : null;
}

export const hasGithubToken = (entry: GithubRemote) => Boolean(getToken(entry.host.host));

export function serverRef(host: string, apiBase: string): GithubServerRef {
  return { host, apiBase, token: getToken(host) };
}

export function openUrl(url: string): void {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

/** "3 h ago" style age for list rows. */
export function ago(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 43200) return `${Math.floor(minutes / 1440)}d`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
