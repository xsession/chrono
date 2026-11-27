// GitHub account and SSH keys for one GitHub host (Settings → Hosting
// connections): connect with a token created on a pre-filled GitHub page, see
// who is signed in and which scopes the token has, and add SSH keys.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { GithubAccount as Account, SshKeyInfo } from "../../types";
import { askChoice, askConfirm } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { askToken, forgetToken, getToken } from "../../providerTokens";
import { openUrl, serverRef } from "../../githubContext";

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");
const NEEDED = [["repo", "repositories, pull requests and issues"], ["read:org", "organization repositories"], ["workflow", "re-running Actions"], ["admin:public_key", "adding SSH keys"]] as const;

export function GithubAccountPanel({ host, apiBase, onChanged }: { host: string; apiBase: string; onChanged: () => void }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKeyInfo[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const token = getToken(host);

  const load = useCallback(async () => {
    setError(null);
    if (!getToken(host)) { setAccount(null); setKeys(await api.ghSshKeys(serverRef(host, apiBase)).catch(() => [])); return; }
    try { setAccount(await api.ghAccount(serverRef(host, apiBase))); }
    catch (reason) { setAccount(null); setError(errorText(reason)); }
    setKeys(await api.ghSshKeys(serverRef(host, apiBase)).catch(() => []));
  }, [host, apiBase]);
  useEffect(() => { void load(); }, [load, token]);

  const connect = async () => {
    try {
      openUrl(await api.ghTokenPage(apiBase));
      const result = await askToken(host, "github", `Connect to GitHub (${host})`, {
        remember: true,
        message: "GitHub opened a page for a new personal access token with the scopes Chrono needs (repo, read:org, workflow, admin:public_key). Generate it there and paste it here.",
      });
      if (!result) return;
      const me = await api.ghAccount(serverRef(host, apiBase));
      pushToast(`Connected to GitHub as ${me.login}`, "success");
      onChanged();
      await load();
    } catch (reason) { pushToast(errorText(reason), "error"); }
  };

  const disconnect = async () => {
    if (!await askConfirm(`Disconnect ${host}?`, "Chrono forgets the token. Revoke it on GitHub too if you no longer need it (Settings → Developer settings → Personal access tokens).", { confirm: "Disconnect", danger: true })) return;
    await forgetToken(host);
    onChanged();
    await load();
  };

  const upload = async (key: SshKeyInfo) => {
    setWorking(key.path);
    try { await api.ghSshUpload(serverRef(host, apiBase), key.path); pushToast(`Added ${key.path.split(/[\\/]/).pop()} to GitHub`, "success"); await load(); }
    catch (reason) { pushToast(errorText(reason), "error"); }
    finally { setWorking(null); }
  };

  const generate = async () => {
    const hasDefault = (keys ?? []).some((key) => /[\\/]id_ed25519\.pub$/.test(key.path));
    let writeConfig = false;
    if (hasDefault) {
      const choice = await askChoice("Generate a new SSH key", [
        { value: "config", label: "Create a Chrono key and use it for this host", description: `Creates ~/.ssh/id_ed25519_chrono_…, adds it to GitHub and a "Host ${host}" entry in ~/.ssh/config.` },
        { value: "key", label: "Only create the key and add it to GitHub", description: "You point ssh at it yourself." },
      ], "You already have ~/.ssh/id_ed25519. Adding it to GitHub (below) is usually all you need.");
      if (!choice) return;
      writeConfig = choice === "config";
    } else if (!await askConfirm("Generate an SSH key", "Creates ~/.ssh/id_ed25519 (ed25519, no passphrase) and adds its public key to your GitHub account.", { confirm: "Generate and add" })) return;
    setWorking("generate");
    try { const result = await api.ghSshGenerate(serverRef(host, apiBase), host, writeConfig); pushToast(result.note, result.configured ? "success" : "info"); await load(); }
    catch (reason) { pushToast(errorText(reason), "error"); }
    finally { setWorking(null); }
  };

  const missing = account ? NEEDED.filter(([scope]) => account.scopes.length > 0 && !account.scopes.includes(scope)) : [];
  return (
    <div className="st-github">
      <div className="st-github-account">
        {account ? <>
          {account.avatarUrl && <img src={account.avatarUrl} alt="" width={28} height={28} />}
          <div><strong>Connected as {account.login}</strong>{account.name && <span> · {account.name}</span>}<br /><small>{account.scopes.length ? `Token scopes: ${account.scopes.join(", ")}` : "Fine-grained token (scopes are set per repository on GitHub)"}</small></div>
          <span className="tg-spacer" />
          <button type="button" className="ux-button" onClick={() => openUrl(account.htmlUrl)}>Profile</button>
          <button type="button" className="ux-button" onClick={() => void disconnect()}>Disconnect</button>
        </> : <>
          <div><strong>{token ? "Token set, not verified" : "Not connected"}</strong><br /><small>{error ?? "Connect to see your repositories, fork, review and merge pull requests and work with issues."}</small></div>
          <span className="tg-spacer" />
          <button type="button" className="ux-primary-button" onClick={() => void connect()}>Connect to GitHub…</button>
        </>}
      </div>
      {missing.length > 0 && <p className="st-note">This token is missing {missing.map(([scope, use]) => `${scope} (${use})`).join(", ")}. Connect again to create one with all of them.</p>}
      <div className="st-github-keys">
        <div className="st-github-keys-head"><strong>SSH keys</strong><small>on the computer running Chrono</small><span className="tg-spacer" />
          <button type="button" className="ux-button" disabled={!account || working !== null} title={account ? "" : "Connect first"} onClick={() => void generate()}>{working === "generate" ? "Generating…" : "✨ Generate SSH key and add to GitHub"}</button>
        </div>
        {keys === null ? <p className="st-note">Loading…</p> : keys.length === 0 ? <p className="st-note">No public keys in ~/.ssh yet.</p> : keys.map((key) => (
          <div key={key.path} className="st-github-key">
            <code title={key.path}>{key.path.split(/[\\/]/).pop()}</code>
            <span>{key.type.replace(/^ssh-/, "")}</span>
            <small title={key.fingerprint}>{key.comment || key.fingerprint}</small>
            <span className="tg-spacer" />
            {key.onGithub ? <span className="st-hosting-tag is-ok">On GitHub</span>
              : <button type="button" className="ux-button compact" disabled={!account || working !== null || key.onGithub === null && !account} onClick={() => void upload(key)}>{working === key.path ? "Adding…" : "Add to GitHub"}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
