import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CheckRun, CleanupCandidate, RemoteHost } from "../../types";
import { Icon } from "../Icon";
import { pushToast } from "../../toastBus";
import { ensureToken, forgetToken, getApiBase, getToken, setApiBase as saveApiBase } from "../../providerTokens";
import { notifyIfHidden } from "../../notify";

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");

function Modal({ title, icon, onClose, children, footer, wide }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ux-modal-backdrop tg-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`ux-dialog tg-dialog${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="tg-dialog-title"><Icon name={icon} /><h2>{title}</h2><button type="button" className="ux-icon-button" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="tg-dialog-body">{children}</div>
        {footer && <footer className="tg-dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ PR creation
export function PullRequestDialog({ repositoryPath, head, defaultBase, remotes, onClose, run }: {
  repositoryPath: string;
  head: string;
  defaultBase: string;
  remotes: string[];
  onClose: () => void;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [remote, setRemote] = useState(remotes.includes("origin") ? "origin" : remotes[0] ?? "origin");
  const [host, setHost] = useState<RemoteHost | null | undefined>(undefined);
  const [base, setBase] = useState(defaultBase.replace(/^[^/]+\//, ""));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(false);
  const [preview, setPreview] = useState<{ files: number; additions: number; deletions: number; commits: string[] } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [created, setCreated] = useState<{ number: number; url: string } | null>(null);
  const [apiBase, setApiBase] = useState("");

  useEffect(() => { setHost(undefined); api.remoteHost(repositoryPath, remote).then((value) => { setHost(value); setApiBase(value ? getApiBase(value.host) || value.apiBase : ""); }).catch(() => setHost(null)); }, [repositoryPath, remote]);
  useEffect(() => { api.prTemplate(repositoryPath).then((template) => { if (template) setDescription((current) => current || template); }).catch(() => undefined); }, [repositoryPath]);
  useEffect(() => {
    let cancelled = false;
    const baseRef = `${remote}/${base}`;
    api.compareRefs(repositoryPath, baseRef, head, 50).catch(() => api.compareRefs(repositoryPath, base, head, 50)).then((comparison) => {
      if (cancelled) return;
      const files = comparison.filesFromBaseToRight;
      setPreview({ files: files.length, additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0), commits: comparison.rightOnly.map((commit) => commit.subject) });
      setTitle((current) => current || comparison.rightOnly[comparison.rightOnly.length - 1]?.subject || head);
    }).catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [repositoryPath, base, head, remote]);

  const generate = async () => {
    setGenerating(true);
    try {
      const result = await api.explain(repositoryPath, "pr", head, `${remote}/${base}`).catch(() => api.explain(repositoryPath, "pr", head, base));
      setDescription(result.text);
      if (!title && result.title) setTitle(result.title);
      pushToast(result.source === "ollama" ? "Description drafted with local AI" : "Offline description drafted (Ollama not running)", "info");
    } catch (error) { pushToast(errorText(error), "error"); }
    finally { setGenerating(false); }
  };

  const submit = async () => {
    if (!host) return;
    const token = await ensureToken(host.host, host.provider);
    if (!token) return;
    await run(`Create pull request ${head} → ${base}`, async () => {
      if (apiBase && apiBase !== host.apiBase) saveApiBase(host.host, apiBase); else saveApiBase(host.host, "");
      const result = await api.createPullRequest(repositoryPath, { remote, token, head, base, title, description, draft, apiBase: apiBase || undefined });
      setCreated(result);
      notifyIfHidden("Pull request created", `#${result.number} ${title}`);
    });
  };

  return (
    <Modal title={`Create pull request — ${head}`} icon="compare" wide onClose={onClose} footer={created ? <><span className="tg-spacer" /><a className="ux-primary-button" href={created.url} target="_blank" rel="noreferrer">Open #{created.number}</a><button type="button" className="ux-button" onClick={onClose}>Close</button></> : <>
      <label className="tg-inline"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />Draft</label>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-primary-button" disabled={!host || !title.trim()} onClick={() => void submit()}>Create pull request</button>
    </>}>
      {created ? <p className="tg-note">Created <a href={created.url} target="_blank" rel="noreferrer">#{created.number}</a>.</p> : <>
        <div className="st-grid">
          <label>Remote<select value={remote} onChange={(event) => setRemote(event.target.value)}>{remotes.map((name) => <option key={name}>{name}</option>)}</select></label>
          <label>Into (base)<input value={base} onChange={(event) => setBase(event.target.value)} /></label>
          <label>From (head)<input value={head} readOnly /></label>
          <label>API base<input value={apiBase} onChange={(event) => setApiBase(event.target.value)} placeholder="https://api.github.com" /></label>
        </div>
        <p className="tg-note">{host === undefined ? "Detecting provider…" : host ? <>Provider: <b>{host.provider}</b> · {host.owner}/{host.repository}{getToken(host.host) ? <> · token set <button type="button" className="gk-link-button" onClick={() => { forgetToken(host.host); pushToast("Token forgotten", "info"); }}>forget</button></> : " · you will be asked for a token"}</> : "This remote is not a GitHub, GitLab or Gitea URL."}</p>
        <label className="gk-dialog-field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className="tg-message-head"><strong>Description</strong><button type="button" className="ux-button compact" disabled={generating} onClick={() => void generate()}>{generating ? "Generating…" : "✨ Generate"}</button></div>
        <textarea className="tg-message" rows={10} value={description} onChange={(event) => setDescription(event.target.value)} />
        {preview && (
          <div className="gk-pr-preview">
            <strong>Preview: {preview.commits.length} commit(s) · {preview.files} file(s) · <b>+{preview.additions}</b> <i>−{preview.deletions}</i></strong>
            <ul>{preview.commits.slice(0, 12).map((subject, index) => <li key={index}>{subject}</li>)}</ul>
          </div>
        )}
      </>}
    </Modal>
  );
}

// ----------------------------------------------------------------- CI checks
export function CiChecks({ repositoryPath, sha, remote = "origin" }: { repositoryPath: string; sha: string; remote?: string }) {
  const [host, setHost] = useState<RemoteHost | null | undefined>(undefined);
  const [state, setState] = useState<{ state: string; checks: CheckRun[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setState(null); setError(null); api.remoteHost(repositoryPath, remote).then(setHost).catch(() => setHost(null)); }, [repositoryPath, remote, sha]);
  const load = async (interactive: boolean) => {
    if (!host) return;
    const token = interactive ? await ensureToken(host.host, host.provider) : getToken(host.host);
    if (token === null) return;
    setLoading(true); setError(null);
    try {
      const previous = state?.state;
      const next = await api.ciChecks(repositoryPath, sha, token, remote, getApiBase(host.host) || undefined);
      setState(next);
      if (previous && previous !== next.state && next.state === "failure") notifyIfHidden("CI failed", `${sha.slice(0, 8)} on ${host.owner}/${host.repository}`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (host && getToken(host.host)) void load(false); }, [host]); // eslint-disable-line react-hooks/exhaustive-deps
  if (host === undefined || host === null) return null;
  const icon = (check: CheckRun) => check.status !== "completed" ? "◷" : ["success", "neutral", "skipped"].includes(check.conclusion) ? "✓" : "✕";
  return (
    <section className="ux-inspector-section gk-ci">
      <div className="ux-section-title"><strong>CI checks</strong><span>{state ? <span className={`gk-ci-state is-${state.state}`}>{state.state}</span> : `${host.provider} · ${host.owner}/${host.repository}`}</span></div>
      {!state && !loading && <button type="button" className="ux-button compact" onClick={() => void load(true)}>Load checks</button>}
      {loading && <div className="gk-empty"><i className="ux-spinner" />Loading checks…</div>}
      {error && <div className="gk-empty">{error}</div>}
      {state && (
        <div className="gk-ci-list">
          {state.checks.map((check) => (
            <div key={`${check.id}-${check.name}`} className={`gk-ci-row is-${check.status !== "completed" ? "pending" : check.conclusion}`}>
              <span aria-hidden="true">{icon(check)}</span>
              <a href={check.url || undefined} target="_blank" rel="noreferrer" title={`${check.name}: ${check.conclusion || check.status}`}>{check.name}</a>
              <small>{check.conclusion || check.status}</small>
              {check.rerunnable && <button type="button" className="ux-button compact" onClick={async () => { const token = await ensureToken(host.host, host.provider); if (!token) return; try { pushToast(await api.rerunCheck(repositoryPath, check, token, remote, getApiBase(host.host) || undefined), "success"); void load(false); } catch (reason) { pushToast(errorText(reason), "error"); } }}>Re-run</button>}
            </div>
          ))}
          {!state.checks.length && <div className="gk-empty">No checks reported for this commit.</div>}
          <button type="button" className="gk-link-button" onClick={() => void load(true)}>Refresh</button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ branch cleanup
export function CleanupDialog({ repositoryPath, onClose, run }: { repositoryPath: string; onClose: () => void; run: (label: string, action: () => Promise<unknown>) => Promise<void> }) {
  const [data, setData] = useState<{ target: string; candidates: CleanupCandidate[] } | null>(null);
  const [target, setTarget] = useState("");
  const [days, setDays] = useState(90);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const load = () => { setData(null); api.cleanupCandidates(repositoryPath, target || null, days).then((value) => { setData(value); setTarget(value.target); setChecked(new Set(value.candidates.filter((candidate) => candidate.reasons.some((reason) => reason !== "stale")).map((candidate) => candidate.branch))); }).catch((error) => { pushToast(errorText(error), "error"); setData({ target, candidates: [] }); }); };
  useEffect(load, [repositoryPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (mode: "archive" | "delete") => { await run(`${mode === "archive" ? "Archive" : "Delete"} ${checked.size} branch(es)`, () => api.cleanupBranches(repositoryPath, [...checked], mode)); onClose(); };
  const labels: Record<string, string> = { merged: "merged", "squash-merged": "squash/rebase merged", "upstream-gone": "upstream deleted", stale: `no commits for ${days}+ days` };
  return (
    <Modal title="Clean up branches" icon="trash" wide onClose={onClose} footer={<>
      <span className="tg-note">Archived branches are kept under refs/chrono/archive and can be restored in Settings. Both actions can be undone with Ctrl+Z.</span>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" disabled={!checked.size} onClick={() => void act("archive")}>Archive {checked.size}</button>
      <button type="button" className="ux-danger-button" disabled={!checked.size} onClick={() => void act("delete")}>Delete {checked.size}</button>
    </>}>
      <div className="st-grid">
        <label>Compare with<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="main" /></label>
        <label>Stale after (days)<input type="number" min={1} value={days} onChange={(event) => setDays(Number(event.target.value) || 90)} /></label>
        <button type="button" className="ux-button" onClick={load}>Rescan</button>
      </div>
      {!data ? <div className="gk-empty"><i className="ux-spinner" />Scanning branches (including squash-merge detection)…</div> : (
        <div className="tg-checklist">
          <div className="tg-checklist-head"><label><input type="checkbox" checked={data.candidates.length > 0 && checked.size === data.candidates.length} onChange={() => setChecked(checked.size === data.candidates.length ? new Set() : new Set(data.candidates.map((candidate) => candidate.branch)))} />Branch</label><span>Why</span></div>
          <div className="tg-checklist-rows">
            {data.candidates.map((candidate) => (
              <div key={candidate.branch} className="tg-checklist-row">
                <label><input type="checkbox" checked={checked.has(candidate.branch)} onChange={() => { const next = new Set(checked); if (next.has(candidate.branch)) next.delete(candidate.branch); else next.add(candidate.branch); setChecked(next); }} /><span className="tg-path">{candidate.branch}</span></label>
                <span className="gk-reasons">{candidate.reasons.map((reason) => <em key={reason} className={`is-${reason}`}>{labels[reason]}</em>)}</span>
              </div>
            ))}
            {data.candidates.length === 0 && <div className="gk-empty">Nothing to clean up — every branch has unique, recent work.</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ agent sessions
const AGENT_PRESETS = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex CLI", command: "codex" },
  { id: "gemini", label: "Gemini CLI", command: "gemini" },
  { id: "aider", label: "Aider", command: "aider" },
  { id: "shell", label: "Plain shell", command: "" },
];

export function AgentSessionDialog({ repositoryPath, defaultBase, onClose, onStarted }: { repositoryPath: string; defaultBase: string; onClose: () => void; onStarted: (worktree: string, command: string) => void }) {
  const [name, setName] = useState(`agent/${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`);
  const [base, setBase] = useState(defaultBase);
  const [preset, setPreset] = useState(localStorage.getItem("chrono.agent.preset") ?? "claude");
  const [command, setCommand] = useState(AGENT_PRESETS.find((item) => item.id === (localStorage.getItem("chrono.agent.preset") ?? "claude"))?.command ?? "claude");
  const [setup, setSetup] = useState(localStorage.getItem("chrono.agent.setup") ?? "");
  const [working, setWorking] = useState(false);
  const start = async () => {
    setWorking(true);
    try {
      const created = await api.createAgentWorktree(repositoryPath, name.trim(), base.trim() || "HEAD");
      localStorage.setItem("chrono.agent.preset", preset);
      localStorage.setItem("chrono.agent.setup", setup);
      const line = [setup.trim(), command.trim()].filter(Boolean).join(" && ");
      onStarted(created.path, line);
      pushToast(`Agent worktree ready: ${created.path}`, "success");
      onClose();
    } catch (error) { pushToast(errorText(error), "error"); }
    finally { setWorking(false); }
  };
  return (
    <Modal title="New agent session" icon="terminal" onClose={onClose} footer={<><span className="tg-spacer" /><button type="button" className="ux-button" onClick={onClose}>Cancel</button><button type="button" className="ux-primary-button" disabled={working || !name.trim()} onClick={() => void start()}>{working ? "Creating…" : "Create worktree & start"}</button></>}>
      <p className="tg-note">Creates an isolated worktree on a new branch, opens a terminal there and runs your agent CLI. Its uncommitted work appears as a separate WIP entry above the graph; review it by opening the worktree.</p>
      <div className="st-grid">
        <label>Branch<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Start from<input value={base} onChange={(event) => setBase(event.target.value)} /></label>
        <label>Agent<select value={preset} onChange={(event) => { setPreset(event.target.value); setCommand(AGENT_PRESETS.find((item) => item.id === event.target.value)?.command ?? ""); }}>{AGENT_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Command<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="claude" /></label>
        <label className="st-wide">Setup command (optional, runs first)<input value={setup} onChange={(event) => setSetup(event.target.value)} placeholder="npm ci" /></label>
      </div>
    </Modal>
  );
}
