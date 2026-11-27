// Settings → Hosting connections: one place for every GitHub, GitLab, Gitea,
// Bitbucket Server and Bitbucket Cloud host Chrono talks to. Provider and API
// base are kept in this browser (as the pull request dialog does); TLS options,
// the timeout and remembered tokens are kept by the server, which makes the
// requests (server/src/hosting.ts).
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { HOSTING_DEFAULT_API, HOSTING_PROVIDER_LABELS } from "../../types";
import type { HostingConnection, HostingProvider, RemoteHost } from "../../types";
import { askConfirm } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { askToken, forgetToken, getApiBase, getProviderOverride, getToken, isTokenRemembered, loadRememberedTokens, locallyKnownHosts, setApiBase, setProviderOverride } from "../../providerTokens";

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");
const PROVIDERS = Object.keys(HOSTING_PROVIDER_LABELS) as HostingProvider[];

type Row = {
  host: string;
  /** What the repository's remote URL says, when one of its remotes is on this host. */
  detected: RemoteHost | null;
  /** Remotes of the open repository on this host. */
  remotes: string[];
  server: HostingConnection | null;
};

function apiPlaceholder(provider: HostingProvider | "", host: string): string {
  if (provider === "bitbucket-server") return `https://${host}/rest/api/1.0`;
  if (provider === "gitlab") return `https://${host}/api/v4`;
  if (provider === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (provider) return HOSTING_DEFAULT_API[provider] || `https://${host}/api/v1`;
  return "detected from the remote URL";
}

function ConnectionCard({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const detectedProvider = row.detected?.provider ?? "";
  const [provider, setProvider] = useState<HostingProvider | "">(() => getProviderOverride(row.host) || detectedProvider);
  const [apiBase, setApiBaseValue] = useState(() => getApiBase(row.host));
  const [insecureTls, setInsecureTls] = useState(row.server?.insecureTls ?? false);
  const [caFile, setCaFile] = useState(row.server?.caFile ?? "");
  const [timeout, setTimeoutValue] = useState(String(row.server?.timeoutSeconds ?? 20));
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [, setTick] = useState(0);
  const refreshToken = () => setTick((value) => value + 1);

  const effectiveApi = apiBase.trim() || row.detected?.apiBase || (provider ? HOSTING_DEFAULT_API[provider] : "");
  const token = getToken(row.host);
  const remembered = isTokenRemembered(row.host);
  const dirty = provider !== (getProviderOverride(row.host) || detectedProvider) || apiBase.trim() !== getApiBase(row.host)
    || insecureTls !== (row.server?.insecureTls ?? false) || caFile.trim() !== (row.server?.caFile ?? "") || Number(timeout) !== (row.server?.timeoutSeconds ?? 20);

  const save = async () => {
    try {
      const seconds = Number(timeout);
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) throw new Error("The timeout must be between 5 and 600 seconds");
      if (provider === "bitbucket-server" && !apiBase.trim() && row.detected?.provider !== "bitbucket-server") throw new Error("Bitbucket Server needs its API base, e.g. https://bitbucket.example.com/rest/api/1.0");
      if (apiBase.trim() && !/^https?:\/\//i.test(apiBase.trim())) throw new Error("The API base must start with http:// or https://");
      setProviderOverride(row.host, provider && provider !== detectedProvider ? provider : "");
      setApiBase(row.host, apiBase.trim() && apiBase.trim() !== row.detected?.apiBase ? apiBase.trim() : "");
      await api.hostingConnectionSave(row.host, { insecureTls, caFile: caFile.trim(), timeoutSeconds: seconds });
      pushToast(`Saved ${row.host}`, "success");
      onChanged();
    } catch (error) { pushToast(errorText(error), "error"); }
  };

  const test = async () => {
    if (!provider) { setResult({ ok: false, message: "Pick the provider first." }); return; }
    if (!effectiveApi) { setResult({ ok: false, message: "Set the API base first." }); return; }
    setTesting(true); setResult(null);
    try { setResult(await api.hostingConnectionTest(row.host, provider, effectiveApi, token)); }
    catch (error) { setResult({ ok: false, message: errorText(error) }); }
    finally { setTesting(false); }
  };

  const setToken = async () => {
    if (!provider) { pushToast("Pick the provider first", "info"); return; }
    try { if (await askToken(row.host, provider, `Token for ${row.host}`)) { refreshToken(); onChanged(); } }
    catch (error) { pushToast(errorText(error), "error"); }
  };

  const remove = async () => {
    if (!await askConfirm(`Remove ${row.host}?`, "Forgets its token, provider, API base and connection options. Repositories on this host keep working; Chrono asks again when it needs a token.", { confirm: "Remove", danger: true })) return;
    await forgetToken(row.host);
    setProviderOverride(row.host, "");
    setApiBase(row.host, "");
    await api.hostingConnectionRemove(row.host).catch(() => undefined);
    pushToast(`Removed ${row.host}`, "info");
    onChanged();
  };

  return (
    <div className="st-command st-hosting" data-host={row.host}>
      <div className="st-hosting-head">
        <strong>{row.host}</strong>
        <span className="st-hosting-tag">{provider ? HOSTING_PROVIDER_LABELS[provider] : "Provider unknown"}{provider && provider !== detectedProvider ? " (set by hand)" : ""}</span>
        <span className={`st-hosting-tag ${token ? "is-ok" : ""}`}>{remembered ? "Token remembered" : token ? "Token for this session" : "No token"}</span>
        {insecureTls && <span className="st-hosting-tag is-warn">Any certificate accepted</span>}
        {!insecureTls && row.server?.caFile && <span className="st-hosting-tag">Custom CA</span>}
        {row.remotes.length > 0 && <span className="st-note">remote{row.remotes.length === 1 ? "" : "s"} {row.remotes.join(", ")} in this repository</span>}
      </div>
      <div className="st-grid">
        <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as HostingProvider | "")}>
          {!detectedProvider && <option value="">Choose…</option>}
          {PROVIDERS.map((value) => <option key={value} value={value}>{HOSTING_PROVIDER_LABELS[value]}{value === detectedProvider ? " (detected)" : ""}</option>)}
        </select></label>
        <label>API base<input value={apiBase} onChange={(event) => setApiBaseValue(event.target.value)} placeholder={row.detected?.apiBase && provider === detectedProvider ? row.detected.apiBase : apiPlaceholder(provider, row.host)} /></label>
        <label>Request timeout (seconds)<input type="number" min={5} max={600} value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} /></label>
        <label className="st-wide">CA certificate file (PEM, on the computer running Chrono)<input value={caFile} onChange={(event) => setCaFile(event.target.value)} placeholder="/etc/ssl/certs/company-ca.pem — for servers signed by your own CA" /></label>
        <label className="st-check st-wide"><input type="checkbox" checked={insecureTls} onChange={(event) => setInsecureTls(event.target.checked)} />Accept self-signed and invalid certificates (not safe on untrusted networks)</label>
      </div>
      {result && <p className={`st-hosting-result ${result.ok ? "is-ok" : "is-error"}`} role="status">{result.ok ? "✓ " : "✕ "}{result.message}</p>}
      <div className="st-row-actions wrap">
        <button type="button" className="ux-primary-button" disabled={!dirty} onClick={() => void save()}>Save</button>
        <button type="button" className="ux-button" disabled={testing || dirty} title={dirty ? "Save first" : "Check that the API answers and the token works"} onClick={() => void test()}>{testing ? "Testing…" : "Test connection"}</button>
        <button type="button" className="ux-button" onClick={() => void setToken()}>{token ? "Replace token…" : "Set token…"}</button>
        {token && <button type="button" className="ux-button" onClick={() => { void forgetToken(row.host).then(() => { refreshToken(); onChanged(); pushToast("Token forgotten", "info"); }); }}>Forget token</button>}
        <span className="tg-spacer" />
        <button type="button" className="ux-danger-button" onClick={() => void remove()}>Remove</button>
      </div>
    </div>
  );
}

export function HostingTab({ repositoryPath }: { repositoryPath: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [newHost, setNewHost] = useState("");
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    await loadRememberedTokens(true);
    const [server, remotes] = await Promise.all([
      api.hostingConnections().catch(() => [] as HostingConnection[]),
      repositoryPath ? api.remotes(repositoryPath).catch(() => []) : Promise.resolve([]),
    ]);
    const detected = await Promise.all(remotes.map(async (remote) => [remote.name, await api.remoteHost(repositoryPath, remote.name).catch(() => null)] as const));
    const byHost = new Map<string, Row>();
    const row = (host: string) => {
      const key = host.toLowerCase();
      if (!byHost.has(key)) byHost.set(key, { host: key, detected: null, remotes: [], server: null });
      return byHost.get(key)!;
    };
    for (const [name, host] of detected) if (host) { const entry = row(host.host); entry.detected ??= host; entry.remotes.push(name); }
    for (const connection of server) row(connection.host).server = connection;
    for (const host of locallyKnownHosts()) row(host);
    for (const host of added) row(host);
    setRows([...byHost.values()].sort((a, b) => Number(b.remotes.length > 0) - Number(a.remotes.length > 0) || a.host.localeCompare(b.host)));
  }, [repositoryPath, added]);

  useEffect(() => { void load(); }, [load, version]);

  const addHost = () => {
    const host = newHost.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) { pushToast("Enter a host name, e.g. git.example.com", "error"); return; }
    setAdded((current) => current.includes(host) ? current : [...current, host]);
    setNewHost("");
  };

  return (
    <section className="st-section">
      <header><div><h3>Hosting connections</h3><p>GitHub, GitLab, Gitea / Forgejo, Bitbucket Server and Bitbucket Cloud servers Chrono talks to for pull requests, CI checks and forks. Hosts of this repository's remotes are listed first. Tokens are kept for the session unless you choose to remember them; remembered tokens stay on the computer running Chrono and are never shown again.</p></div></header>
      {rows === null ? <p className="st-note">Loading…</p> : rows.length === 0 ? <p className="st-note">No hosting servers yet. Add one below, or open a repository with a GitHub, GitLab, Gitea or Bitbucket remote.</p> : rows.map((row) => <ConnectionCard key={`${row.host}:${JSON.stringify(row.server)}:${getProviderOverride(row.host)}:${getApiBase(row.host)}:${getToken(row.host) ? 1 : 0}`} row={row} onChanged={() => setVersion((value) => value + 1)} />)}
      <form className="st-inline" onSubmit={(event) => { event.preventDefault(); addHost(); }}>
        <input aria-label="Host name" value={newHost} onChange={(event) => setNewHost(event.target.value)} placeholder="Add a server: git.example.com" />
        <button type="submit" className="ux-button" disabled={!newHost.trim()}>Add server</button>
      </form>
    </section>
  );
}
