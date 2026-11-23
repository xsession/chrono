import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, getDiffOptions, setDiffOptions } from "../../api";
import type { AiSettings, AiSettingsUpdate, AutolinkRule, CommitTemplate, CustomCommand, CustomCommandParam, DiffOptions, GitflowConfig, HookInfo, IdentityProfile, PerfAction, PerfStatus, SigningConfig } from "../../types";
import { Icon, type IconName } from "../Icon";
import { askConfirm } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { invalidateAutolinks } from "../../autolinks";
import { getDisplayPrefs, setDisplayPrefs, type DisplayPrefs } from "../../displayPrefs";
import { notificationsEnabled, setNotificationsEnabled } from "../../notify";
import { chooseFolder } from "../FolderPicker";
import { NetworkAiFields, SelfHostedAi } from "./LocalLlmSettings";

type Props = {
  repositoryPath: string;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  initialTab?: SettingsTab;
};

export type SettingsTab = "identity" | "ai" | "performance" | "hooks" | "links" | "templates" | "commands" | "gitflow" | "sparse" | "archive" | "display" | "shell";

const TABS: Array<{ id: SettingsTab; label: string; icon: IconName }> = [
  { id: "identity", label: "Identity & signing", icon: "users" },
  { id: "ai", label: "AI assistant", icon: "command" },
  { id: "performance", label: "Performance", icon: "activity" },
  { id: "hooks", label: "Git hooks", icon: "commit" },
  { id: "links", label: "Issue links", icon: "external" },
  { id: "templates", label: "Commit templates", icon: "file" },
  { id: "commands", label: "Custom commands", icon: "terminal" },
  { id: "gitflow", label: "Git-flow", icon: "branch" },
  { id: "sparse", label: "Sparse checkout", icon: "filter" },
  { id: "archive", label: "Archived branches", icon: "stash" },
  { id: "display", label: "Display & accessibility", icon: "eye" },
  { id: "shell", label: "File manager menu", icon: "folder" },
];

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");

function Section({ title, hint, children, actions }: { title: string; hint?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="st-section">
      <header><div><h3>{title}</h3>{hint && <p>{hint}</p>}</div>{actions && <div className="st-actions">{actions}</div>}</header>
      {children}
    </section>
  );
}

function Status({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return <div className={`st-status ${ok === null ? "is-na" : ok ? "is-ok" : "is-off"}`}><i aria-hidden="true">{ok === null ? "–" : ok ? "✓" : "✕"}</i><span>{label}</span>{detail && <small>{detail}</small>}</div>;
}

// ---------------------------------------------------------------- identity
function IdentityTab({ repositoryPath, busy, run }: Props) {
  const [config, setConfig] = useState<SigningConfig | null>(null);
  const [profiles, setProfiles] = useState<IdentityProfile[]>([]);
  const [effective, setEffective] = useState<{ name: string; email: string; origin: string } | null>(null);
  const [scope, setScope] = useState<"local" | "global">("local");
  const [form, setForm] = useState({ format: "openpgp", signingKey: "", commitSign: false, tagSign: false, allowedSignersFile: "" });
  const [profileForm, setProfileForm] = useState({ name: "", userName: "", userEmail: "", signingKey: "", gpgFormat: "" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api.signingConfig(repositoryPath).then((value) => { setConfig(value); setForm({ format: value.format, signingKey: value.signingKey, commitSign: value.commitSign, tagSign: value.tagSign, allowedSignersFile: value.allowedSignersFile }); }).catch((error) => pushToast(errorText(error), "error"));
    api.profiles(repositoryPath).then((value) => { setProfiles(value.profiles); setEffective(value.effective); }).catch(() => undefined);
  }, [repositoryPath, tick]);
  const refresh = () => setTick((value) => value + 1);
  const keyChoices = form.format === "ssh" ? config?.sshKeys ?? [] : config?.gpgKeys.map((key) => key.id) ?? [];

  return (
    <>
      <Section title="Current identity" hint="What git will write as author and committer in this repository.">
        <div className="st-kv">
          <span>Name</span><strong>{config ? config.userName || "not set" : "Loading…"}</strong>
          <span>Email</span><strong>{config ? config.userEmail || "not set" : "Loading…"}</strong>
          <span>Defined in</span><code>{effective?.origin || config?.identityOrigin || (config ? "—" : "…")}</code>
        </div>
      </Section>

      <Section title="Commit & tag signing" hint="GPG, SSH or X.509 (gpgsm). The graph shows a badge for every signed commit." actions={
        <div className="gk-seg" role="group" aria-label="Scope"><button type="button" className={scope === "local" ? "is-active" : ""} onClick={() => setScope("local")}>This repo</button><button type="button" className={scope === "global" ? "is-active" : ""} onClick={() => setScope("global")}>All repos (global)</button></div>
      }>
        <div className="st-grid">
          <label>Signing format<select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })}><option value="openpgp">OpenPGP (gpg)</option><option value="ssh">SSH key</option><option value="x509">X.509 (gpgsm)</option></select></label>
          <label>Signing key
            <input list="st-key-choices" value={form.signingKey} onChange={(event) => setForm({ ...form, signingKey: event.target.value })} placeholder={form.format === "ssh" ? "~/.ssh/id_ed25519.pub or key::ssh-ed25519 …" : "key ID or fingerprint"} />
            <datalist id="st-key-choices">{keyChoices.map((key) => <option key={key} value={key} />)}</datalist>
          </label>
          {form.format === "ssh" && <label>Allowed signers file (for verification)<input value={form.allowedSignersFile} onChange={(event) => setForm({ ...form, allowedSignersFile: event.target.value })} placeholder="~/.config/git/allowed_signers" /></label>}
          <label className="st-check"><input type="checkbox" checked={form.commitSign} onChange={(event) => setForm({ ...form, commitSign: event.target.checked })} />Sign every commit (commit.gpgSign)</label>
          <label className="st-check"><input type="checkbox" checked={form.tagSign} onChange={(event) => setForm({ ...form, tagSign: event.target.checked })} />Sign every annotated tag (tag.gpgSign)</label>
        </div>
        {config && config.gpgKeys.length === 0 && form.format === "openpgp" && <p className="st-note">No secret GPG keys were found on the server host.</p>}
        <div className="st-row-actions">
          <button type="button" className="ux-primary-button" disabled={busy} onClick={() => void run("Save signing settings", () => api.setSigningConfig(repositoryPath, scope, form)).then(refresh)}>Save signing settings</button>
        </div>
      </Section>

      <Section title="Identity profiles" hint="Reusable name / email / signing key sets. Applying one adds an include — your existing repo config is never rewritten.">
        <div className="st-table">
          {profiles.map((profile) => (
            <div key={profile.name} className="st-table-row">
              <strong>{profile.name}</strong>
              <span>{profile.userName} &lt;{profile.userEmail}&gt;{profile.signingKey ? ` · key ${profile.signingKey.slice(0, 16)}` : ""}</span>
              <small>{[...profile.repos.map(() => "this repo"), ...profile.folders.map((folder) => `folder ${folder}`)].join(", ") || "not applied"}</small>
              <div>
                {profile.repos.length
                  ? <button type="button" className="ux-button compact" onClick={() => void run(`Detach ${profile.name}`, () => api.detachProfile(repositoryPath, profile.name)).then(refresh)}>Detach</button>
                  : <button type="button" className="ux-button compact" onClick={() => void run(`Apply ${profile.name}`, () => api.applyProfile(repositoryPath, profile.name, "repo")).then(refresh)}>Use here</button>}
                <button type="button" className="ux-button compact" onClick={async () => { const folder = await chooseFolder(`Apply ${profile.name} to every repository under…`, { initial: repositoryPath.replace(/\/[^/]+\/?$/, ""), confirm: "Apply to" }); if (folder) await run(`Apply ${profile.name} to folder`, () => api.applyProfile(repositoryPath, profile.name, "folder", folder)); refresh(); }}>Apply to folder…</button>
                <button type="button" className="ux-danger-button compact" onClick={async () => { if (await askConfirm("Delete profile", `Delete profile ${profile.name} and its includes?`, { confirm: "Delete", danger: true })) { await run("Delete profile", () => api.deleteProfile(profile.name)); refresh(); } }}>Delete</button>
              </div>
            </div>
          ))}
          {!profiles.length && <div className="gk-empty">No profiles yet.</div>}
        </div>
        <div className="st-grid st-inline-form">
          <label>Profile name<input value={profileForm.name} onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })} placeholder="work" /></label>
          <label>user.name<input value={profileForm.userName} onChange={(event) => setProfileForm({ ...profileForm, userName: event.target.value })} /></label>
          <label>user.email<input value={profileForm.userEmail} onChange={(event) => setProfileForm({ ...profileForm, userEmail: event.target.value })} /></label>
          <label>Signing key (optional)<input value={profileForm.signingKey} onChange={(event) => setProfileForm({ ...profileForm, signingKey: event.target.value })} /></label>
          <label>Format<select value={profileForm.gpgFormat} onChange={(event) => setProfileForm({ ...profileForm, gpgFormat: event.target.value })}><option value="">(inherit)</option><option value="openpgp">openpgp</option><option value="ssh">ssh</option><option value="x509">x509</option></select></label>
          <button type="button" className="ux-button" disabled={busy || !profileForm.name || !profileForm.userEmail} onClick={async () => { await run(`Save profile ${profileForm.name}`, () => api.saveProfile(profileForm)); setProfileForm({ name: "", userName: "", userEmail: "", signingKey: "", gpgFormat: "" }); refresh(); }}>Save profile</button>
        </div>
      </Section>
    </>
  );
}

// ------------------------------------------------------------- performance
function PerformanceTab({ repositoryPath, busy, run }: Props) {
  const [status, setStatus] = useState<PerfStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { setStatus(null); api.perfStatus(repositoryPath).then(setStatus).catch((error) => pushToast(errorText(error), "error")); }, [repositoryPath, tick]);
  const act = (label: string, action: PerfAction) => run(label, async () => { const message = await api.perfApply(repositoryPath, action); pushToast(message, "success", 7000); }).then(() => setTick((value) => value + 1));
  return (
    <>
      <Section title="Large-repository preset" hint="Scalar-style settings: commit-graph with changed-path filters, multi-pack index, untracked cache, index v4 and background maintenance." actions={<button type="button" className="ux-primary-button" disabled={busy} onClick={() => void act("Apply large-repo preset", "preset")}>Apply preset</button>}>
        {!status ? <div className="gk-empty"><i className="ux-spinner" />Inspecting…</div> : (
          <div className="st-status-grid">
            <Status ok={status.commitGraph} label="Commit-graph file" detail={status.commitGraph ? "fast log --graph / ahead-behind" : "missing — history queries walk every commit"} />
            <Status ok={status.changedPaths} label="Changed-path Bloom filters" detail="speeds up file history" />
            <Status ok={status.maintenanceRegistered} label="Background maintenance" detail="git maintenance register" />
            <Status ok={status.untrackedCache === "true"} label="Untracked cache" />
            <Status ok={status.fsmonitorDaemon === "unsupported" ? null : status.fsmonitorDaemon === "running"} label="File-system monitor" detail={status.fsmonitorDaemon === "unsupported" ? `not available in git ${status.gitVersion} on this platform` : status.fsmonitorDaemon} />
            <Status ok={status.indexVersion === "4"} label="Index v4 (path compression)" />
            <Status ok={status.presetApplied.length >= 7} label={`Preset keys ${status.presetApplied.length}/9`} />
            <Status ok={status.looseObjects < 5000} label={`${status.looseObjects.toLocaleString()} loose objects`} detail={`${status.packs} pack(s), ${(status.sizePackKb / 1024).toFixed(1)} MB`} />
          </div>
        )}
        {status && <p className="st-note">{status.commitCount.toLocaleString()} commits · git {status.gitVersion}{status.inotifyWatches !== null ? ` · inotify watch limit ${status.inotifyWatches.toLocaleString()}` : ""}{status.inotifyWatches !== null && status.inotifyWatches < 100000 ? " — raise fs.inotify.max_user_watches for big working trees" : ""}</p>}
      </Section>
      <Section title="Individual actions">
        <div className="st-row-actions wrap">
          <button type="button" className="ux-button" disabled={busy} onClick={() => void act("Write commit-graph", "commit_graph")}>Write commit-graph</button>
          <button type="button" className="ux-button" disabled={busy} onClick={() => void act("Run maintenance", "maintenance_run")}>Run maintenance now</button>
          <button type="button" className="ux-button" disabled={busy} onClick={() => void act(status?.maintenanceRegistered ? "Unregister maintenance" : "Register maintenance", status?.maintenanceRegistered ? "maintenance_unregister" : "maintenance_register")}>{status?.maintenanceRegistered ? "Stop background maintenance" : "Register background maintenance"}</button>
          <button type="button" className="ux-button" disabled={busy} onClick={() => void act("Enable untracked cache", "untracked_cache")}>Enable untracked cache</button>
          <button type="button" className="ux-button" disabled={busy || status?.fsmonitorDaemon === "unsupported"} onClick={() => void act(status?.fsmonitorDaemon === "running" ? "Disable fsmonitor" : "Enable fsmonitor", status?.fsmonitorDaemon === "running" ? "fsmonitor_off" : "fsmonitor_on")}>{status?.fsmonitorDaemon === "running" ? "Disable fsmonitor" : "Enable fsmonitor"}</button>
          <button type="button" className="ux-button" disabled={busy} onClick={() => void act("git gc --auto", "gc")}>git gc --auto</button>
        </div>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------- hooks
function HooksTab({ repositoryPath, busy, run }: Props) {
  const [data, setData] = useState<{ dir: string; hooksPath: string; hooks: HookInfo[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api.hooks(repositoryPath).then(setData).catch((error) => pushToast(errorText(error), "error")); }, [repositoryPath, tick]);
  return (
    <Section title="Git hooks" hint="Hooks run on commit, push, merge… When pre-commit or commit-msg fails, Chrono shows the hook output and lets you retry with --no-verify explicitly.">
      {data && <p className="st-note">Directory: <code>{data.dir}</code>{data.hooksPath ? <> (core.hooksPath = <code>{data.hooksPath}</code>)</> : null}</p>}
      <div className="st-table">
        {data?.hooks.map((hook) => (
          <div key={hook.name} className={`st-table-row${hook.exists ? "" : " is-dim"}`}>
            <strong>{hook.name}</strong>
            <span>{hook.exists ? `${hook.size} bytes` : "not installed"}</span>
            <small>{hook.exists ? (hook.executable ? "enabled" : "disabled (not executable)") : ""}</small>
            <div>
              {hook.exists && <button type="button" className="ux-button compact" onClick={() => setOpen(open === hook.name ? null : hook.name)}>{open === hook.name ? "Hide" : "View"}</button>}
              {hook.exists && <button type="button" className="ux-button compact" disabled={busy} onClick={() => void run(`${hook.executable ? "Disable" : "Enable"} ${hook.name}`, () => api.setHookEnabled(repositoryPath, hook.name, !hook.executable)).then(() => setTick((value) => value + 1))}>{hook.executable ? "Disable" : "Enable"}</button>}
            </div>
            {open === hook.name && <pre className="st-pre">{hook.preview}</pre>}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------- links
function LinksTab({ repositoryPath, busy, run }: Props) {
  const [rules, setRules] = useState<AutolinkRule[]>([]);
  const [suggested, setSuggested] = useState<AutolinkRule[]>([]);
  const [sample, setSample] = useState("Fix login crash (#123, PROJ-42)");
  useEffect(() => { api.autolinks(repositoryPath).then((value) => { setRules(value.rules); setSuggested(value.suggested); }).catch(() => undefined); }, [repositoryPath]);
  const save = () => run("Save issue links", async () => { await api.setAutolinks(repositoryPath, rules.filter((rule) => rule.pattern && rule.url)); invalidateAutolinks(repositoryPath); });
  const preview = (() => {
    const parts: string[] = [];
    for (const rule of rules) { try { for (const match of sample.matchAll(new RegExp(rule.pattern, "g"))) parts.push(`${match[0]} → ${rule.url.replace(/\$(\d)/g, (_, g: string) => match[Number(g)] ?? "")}`); } catch { parts.push(`invalid pattern ${rule.pattern}`); } }
    return parts;
  })();
  return (
    <Section title="Issue tracker links" hint="Turn issue IDs in commit messages into links (like TortoiseGit bugtraq). Stored in this repository's .git/config (chrono.autolink). Use $1 for the first capture group." actions={<button type="button" className="ux-primary-button" disabled={busy} onClick={() => void save()}>Save</button>}>
      <div className="st-table">
        {rules.map((rule, index) => (
          <div key={index} className="st-table-row st-rule">
            <input aria-label="Pattern" value={rule.pattern} onChange={(event) => setRules(rules.map((r, i) => (i === index ? { ...r, pattern: event.target.value } : r)))} placeholder="#(\d+)" />
            <input aria-label="URL" value={rule.url} onChange={(event) => setRules(rules.map((r, i) => (i === index ? { ...r, url: event.target.value } : r)))} placeholder="https://tracker/issues/$1" />
            <button type="button" className="ux-icon-button" aria-label="Remove rule" onClick={() => setRules(rules.filter((_, i) => i !== index))}><Icon name="trash" /></button>
          </div>
        ))}
      </div>
      <div className="st-row-actions wrap">
        <button type="button" className="ux-button" onClick={() => setRules([...rules, { pattern: "", url: "" }])}><Icon name="plus" />Add rule</button>
        {suggested.map((rule) => <button key={rule.pattern} type="button" className="ux-button" onClick={() => setRules([...rules, rule])}>Add {rule.pattern} → {new URL(rule.url).host}</button>)}
      </div>
      <label className="st-sample">Test message<input value={sample} onChange={(event) => setSample(event.target.value)} /></label>
      <ul className="st-preview">{preview.map((line, index) => <li key={index}>{line}</li>)}{!preview.length && <li>No matches.</li>}</ul>
    </Section>
  );
}

// --------------------------------------------------------------- templates
function TemplatesTab({ repositoryPath, busy, run }: Props) {
  const [templates, setTemplates] = useState<CommitTemplate[]>([]);
  useEffect(() => { api.commitTemplates(repositoryPath).then(setTemplates).catch(() => undefined); }, [repositoryPath]);
  const own = templates.filter((template) => template.source === "chrono");
  const save = (next: CommitTemplate[]) => run("Save templates", async () => { await api.saveCommitTemplates(next); setTemplates(await api.commitTemplates(repositoryPath)); });
  return (
    <Section title="Commit templates" hint="Insert with the template menu in the commit panel, or type t: in the summary. git's commit.template is included automatically." actions={<button type="button" className="ux-primary-button" disabled={busy} onClick={() => void save(own)}>Save</button>}>
      {templates.filter((template) => template.source === "git").map((template) => <div key={template.id} className="st-template is-git"><strong>{template.name}</strong><pre>{template.text}</pre></div>)}
      {own.map((template, index) => (
        <div key={template.id || index} className="st-template">
          <input aria-label="Template name" value={template.name} onChange={(event) => setTemplates(templates.map((t) => (t === template ? { ...t, name: event.target.value } : t)))} />
          <textarea aria-label="Template text" rows={4} value={template.text} onChange={(event) => setTemplates(templates.map((t) => (t === template ? { ...t, text: event.target.value } : t)))} />
          <button type="button" className="ux-icon-button" aria-label="Remove template" onClick={() => setTemplates(templates.filter((t) => t !== template))}><Icon name="trash" /></button>
        </div>
      ))}
      <button type="button" className="ux-button" onClick={() => setTemplates([...templates, { id: "", name: "New template", text: "feat: \n\nWhy:\n\nHow tested:\n", source: "chrono" }])}><Icon name="plus" />Add template</button>
    </Section>
  );
}

// ---------------------------------------------------------------- AI assistant
function AiTab({ busy, run }: Pick<Props, "busy" | "run">) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [form, setFormState] = useState<AiSettingsUpdate>({});
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const load = useCallback((next: AiSettings) => {
    setSettings(next);
    const { claudeModels: _models, claudeKeySaved: _a, claudeEnvCredentials: _b, netKeySaved: _c, lanKeySaved: _d, ...editable } = next;
    setFormState(editable);
  }, []);
  useEffect(() => { api.aiSettings().then(load).catch((error) => pushToast(errorText(error), "error")); }, [load]);
  if (!settings) return <Section title="AI assistant"><p className="st-note">Loading…</p></Section>;
  const setForm = (update: AiSettingsUpdate) => setFormState((current) => ({ ...current, ...update }));
  const saveNow = async (extra: AiSettingsUpdate = {}) => {
    load(await api.saveAiSettings({ ...form, ...extra }));
    setTest(null);
  };
  const save = (extra: AiSettingsUpdate = {}) => run("Save AI settings", async () => { await saveNow(extra); setKey(""); });
  const credentials = settings.claudeKeySaved ? "an API key saved here" : settings.claudeEnvCredentials ? "ANTHROPIC_API_KEY from the server's environment" : "none found yet (an `ant auth login` profile also works)";
  const provider = form.provider ?? settings.provider;
  return (
    <Section title="AI assistant" hint="Drafts commit messages (✨ Draft message) and explains commits and working changes. Without a provider, Chrono uses offline rules." actions={
      <>
        <button type="button" className="ux-button" disabled={busy || testing} title="Saves, then asks the provider for a one-word answer" onClick={async () => { setTesting(true); try { await saveNow(); setTest(await api.testAi()); } catch (error) { setTest({ ok: false, message: errorText(error) }); } finally { setTesting(false); } }}>{testing ? "Testing…" : "Save & test"}</button>
        <button type="button" className="ux-primary-button" disabled={busy} onClick={() => void save()}>Save</button>
      </>
    }>
      <div className="st-ai-providers" role="radiogroup" aria-label="AI provider">
        {([
          ["llamacpp", "Self-hosted (llama.cpp)", "Chrono downloads llama.cpp and a model and runs them here. Nothing leaves the machine."],
          ["network", "Server on the network", "llama-server, LM Studio, vLLM… on another machine in your network."],
          ["ollama", "Ollama", "An Ollama server, on this machine or another one."],
          ["claude", "Claude (Anthropic API)", "Staged diffs and commit contents are sent to Anthropic."],
          ["off", "Off", "Offline rules only."],
        ] as const).map(([value, label, note]) => (
          <label key={value} className={`st-ai-provider${provider === value ? " is-active" : ""}`}>
            <input type="radio" name="ai-provider" checked={provider === value} onChange={() => setForm({ provider: value })} />
            <span><strong>{label}</strong><small>{note}</small></span>
          </label>
        ))}
      </div>
      {provider === "ollama" && (
        <div className="st-grid">
          <label>Ollama address<input value={form.ollamaUrl ?? ""} onChange={(event) => setForm({ ollamaUrl: event.target.value })} placeholder="http://127.0.0.1:11434" /></label>
          <label>Model<input value={form.ollamaModel ?? ""} onChange={(event) => setForm({ ollamaModel: event.target.value })} placeholder="qwen2.5:3b" /></label>
        </div>
      )}
      {provider === "network" && <NetworkAiFields settings={settings} form={form} setForm={setForm} busy={busy} save={saveNow} />}
      {provider === "llamacpp" && <SelfHostedAi settings={settings} form={form} setForm={setForm} busy={busy} save={saveNow} />}
      {provider === "claude" && (
        <>
          <div className="st-grid">
            <label>Model<select value={form.claudeModel ?? ""} onChange={(event) => setForm({ claudeModel: event.target.value })}>
              {settings.claudeModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.id === "claude-opus-5-5" ? " (default)" : ""}</option>)}
              {!settings.claudeModels.some((model) => model.id === form.claudeModel) && <option value={form.claudeModel}>{form.claudeModel}</option>}
            </select></label>
            <label>API key{settings.claudeKeySaved ? " (saved; type to replace)" : ""}
              <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.claudeKeySaved ? "••••••••" : "sk-ant-…"} />
            </label>
          </div>
          <p className="st-note">Credentials in use: {credentials}. A saved key is stored only on the server (owner-only file) and is never shown again.</p>
          <div className="st-row-actions">
            <button type="button" className="ux-button" disabled={busy || !key.trim()} onClick={() => void save({ claudeKey: key.trim() })}>Save key</button>
            {settings.claudeKeySaved && <button type="button" className="ux-button" disabled={busy} onClick={() => void save({ claudeKey: null })}>Remove saved key</button>}
          </div>
          <p className="st-note">If Claude declines a request, the API retries it on a fallback model it chooses. Short tasks run at low effort.</p>
        </>
      )}
      {test && <p className={`st-note ${test.ok ? "is-ok" : "is-warning"}`} role="status">{test.message}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- commands
function CommandsTab({ busy, run }: Props) {
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  useEffect(() => { api.customCommands().then(setCommands).catch(() => undefined); }, []);
  const update = (index: number, patch: Partial<CustomCommand>) => setCommands(commands.map((command, i) => (i === index ? { ...command, ...patch } : command)));
  return (
    <Section title="Custom commands" hint="Your own git (or tool) commands, shown in the command palette and on commit / branch / file menus. Each argument is a separate argv element — values are substituted per argument and never passed through a shell. Variables: $REPO $BRANCH $SHA $FILES $PARAM_<name>." actions={<button type="button" className="ux-primary-button" disabled={busy} onClick={() => void run("Save custom commands", () => api.saveCustomCommands(commands))}>Save</button>}>
      {commands.map((command, index) => (
        <div key={command.id || index} className="st-command">
          <div className="st-grid">
            <label>Name<input value={command.name} onChange={(event) => update(index, { name: event.target.value })} /></label>
            <label>Shown on<select value={command.scope} onChange={(event) => update(index, { scope: event.target.value as CustomCommand["scope"] })}><option value="repository">Repository (palette)</option><option value="commit">Commit menu</option><option value="branch">Branch menu</option><option value="files">File menu</option></select></label>
            <label className="st-wide">Arguments (one per line)<textarea rows={3} value={command.argv.join("\n")} onChange={(event) => update(index, { argv: event.target.value.split("\n") })} placeholder={"git\nlog\n--oneline\n$BRANCH"} /></label>
            <label className="st-wide">Parameters (name:label:type per line, type = text | branch | checkbox)<textarea rows={2} value={command.params.map((param) => `${param.name}:${param.label}:${param.type}`).join("\n")} onChange={(event) => update(index, { params: event.target.value.split("\n").filter(Boolean).map((line): CustomCommandParam => { const [name, label, type] = line.split(":"); return { name: name.trim(), label: (label ?? name).trim(), type: type?.trim() === "branch" || type?.trim() === "checkbox" ? type.trim() as CustomCommandParam["type"] : "text" }; }) })} /></label>
            <label className="st-check"><input type="checkbox" checked={command.confirm} onChange={(event) => update(index, { confirm: event.target.checked })} />Ask before running</label>
            <label className="st-check"><input type="checkbox" checked={command.refresh} onChange={(event) => update(index, { refresh: event.target.checked })} />Refresh afterwards</label>
          </div>
          <button type="button" className="ux-danger-button compact" onClick={() => setCommands(commands.filter((_, i) => i !== index))}>Remove</button>
        </div>
      ))}
      <button type="button" className="ux-button" onClick={() => setCommands([...commands, { id: "", name: "New command", argv: ["git", "status", "--short"], scope: "repository", confirm: false, refresh: true, params: [] }])}><Icon name="plus" />Add command</button>
    </Section>
  );
}

// ----------------------------------------------------------------- gitflow
function GitflowTab({ repositoryPath, busy, run }: Props) {
  const [config, setConfig] = useState<GitflowConfig | null>(null);
  useEffect(() => { api.gitflowConfig(repositoryPath).then(setConfig).catch(() => undefined); }, [repositoryPath]);
  if (!config) return <div className="gk-empty"><i className="ux-spinner" />Loading…</div>;
  const field = (key: keyof GitflowConfig, label: string) => <label>{label}<input value={String(config[key])} onChange={(event) => setConfig({ ...config, [key]: event.target.value })} /></label>;
  return (
    <Section title="Git-flow" hint={config.initialized ? "Git-flow is initialised. Start and finish feature / release / hotfix branches from the LOCAL section's menu or the command palette." : "Configure branch names and prefixes, then initialise (creates the develop branch if needed)."} actions={<button type="button" className="ux-primary-button" disabled={busy} onClick={() => void run("Initialise git-flow", () => api.gitflowInit(repositoryPath, config)).then(() => api.gitflowConfig(repositoryPath).then(setConfig))}>{config.initialized ? "Save" : "Initialise git-flow"}</button>}>
      <div className="st-grid">
        {field("master", "Production branch")}{field("develop", "Development branch")}{field("feature", "Feature prefix")}{field("release", "Release prefix")}{field("hotfix", "Hotfix prefix")}{field("support", "Support prefix")}{field("versionTag", "Version tag prefix")}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ sparse
function SparseTab({ repositoryPath, busy, run }: Props) {
  const [status, setStatus] = useState<{ enabled: boolean; cone: boolean; patterns: string[] } | null>(null);
  const [text, setText] = useState("");
  const load = useCallback(() => api.sparseStatus(repositoryPath).then((value) => { setStatus(value); setText(value.patterns.join("\n")); }).catch(() => undefined), [repositoryPath]);
  useEffect(() => { void load(); }, [load]);
  const patterns = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (
    <Section title="Sparse checkout" hint="Check out only the folders you work on (cone mode). Useful for monorepos; combine with a partial clone (--filter=blob:none) from the clone dialog.">
      <Status ok={status?.enabled ?? false} label={status?.enabled ? `Enabled (${status.cone ? "cone" : "non-cone"} mode)` : "Disabled — full working tree"} />
      <label className="st-wide">Folders (one per line)<textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} placeholder={"src/app\ndocs"} /></label>
      <div className="st-row-actions wrap">
        <button type="button" className="ux-primary-button" disabled={busy || !patterns.length} onClick={() => void run("Set sparse checkout", () => api.sparseAction(repositoryPath, "set", patterns)).then(load)}>Set folders</button>
        <button type="button" className="ux-button" disabled={busy || !patterns.length || !status?.enabled} onClick={() => void run("Add sparse folders", () => api.sparseAction(repositoryPath, "add", patterns)).then(load)}>Add folders</button>
        <button type="button" className="ux-button" disabled={busy || !status?.enabled} onClick={() => void run("Reapply sparse checkout", () => api.sparseAction(repositoryPath, "reapply")).then(load)}>Reapply</button>
        <button type="button" className="ux-danger-button" disabled={busy || !status?.enabled} onClick={() => void run("Disable sparse checkout", () => api.sparseAction(repositoryPath, "disable")).then(load)}>Disable</button>
      </div>
    </Section>
  );
}

// ----------------------------------------------------------------- archive
function ArchiveTab({ repositoryPath, busy, run }: Props) {
  const [items, setItems] = useState<Array<{ branch: string; sha: string; date: string }>>([]);
  const load = useCallback(() => api.archivedBranches(repositoryPath).then(setItems).catch(() => undefined), [repositoryPath]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Section title="Archived branches" hint="Branches archived by “Clean up branches” are kept under refs/chrono/archive and can be restored at any time.">
      <div className="st-table">
        {items.map((item) => (
          <div key={item.branch} className="st-table-row">
            <strong>{item.branch}</strong><code>{item.sha.slice(0, 10)}</code><small>{new Date(item.date).toLocaleDateString()}</small>
            <div><button type="button" className="ux-button compact" disabled={busy} onClick={() => void run(`Restore ${item.branch}`, () => api.restoreArchived(repositoryPath, item.branch)).then(load)}>Restore</button></div>
          </div>
        ))}
        {!items.length && <div className="gk-empty">Nothing archived.</div>}
      </div>
    </Section>
  );
}

// ----------------------------------------------------------------- display
function DisplayTab() {
  const [diff, setDiff] = useState<DiffOptions>(getDiffOptions);
  const [prefs, setPrefs] = useState<DisplayPrefs>(getDisplayPrefs);
  const [notify, setNotify] = useState(notificationsEnabled());
  const updatePrefs = (patch: Partial<DisplayPrefs>) => { const next = { ...prefs, ...patch }; setPrefs(next); setDisplayPrefs(next); };
  const updateDiff = (patch: Partial<DiffOptions>) => { const next = { ...diff, ...patch }; setDiff(next); setDiffOptions(next); };
  return (
    <>
      <Section title="Diffs" hint="Applied to every diff viewer (working tree, commits, comparisons, explorer).">
        <div className="st-grid">
          <label>Whitespace<select value={diff.whitespace ?? "none"} onChange={(event) => updateDiff({ whitespace: event.target.value as DiffOptions["whitespace"] })}><option value="none">Show all changes</option><option value="eol">Ignore at end of line</option><option value="change">Ignore amount of whitespace</option><option value="all">Ignore all whitespace</option></select></label>
          <label>Algorithm<select value={diff.algorithm ?? "myers"} onChange={(event) => updateDiff({ algorithm: event.target.value as DiffOptions["algorithm"] })}><option value="myers">Myers (default)</option><option value="histogram">Histogram</option><option value="patience">Patience</option><option value="minimal">Minimal</option></select></label>
          <label className="st-check"><input type="checkbox" checked={prefs.wrapDiffs} onChange={(event) => updatePrefs({ wrapDiffs: event.target.checked })} />Wrap long lines</label>
        </div>
      </Section>
      <Section title="Accessibility" hint="Non-colour cues and palettes. F7 / Shift+F7 jump between diff hunks; status changes are announced to screen readers.">
        <div className="st-grid">
          <label>Graph palette<select value={prefs.palette} onChange={(event) => updatePrefs({ palette: event.target.value as DisplayPrefs["palette"] })}><option value="default">Default</option><option value="colorblind">Colour-blind safe (Okabe–Ito)</option></select></label>
          <label className="st-check"><input type="checkbox" checked={prefs.laneGlyphs} onChange={(event) => updatePrefs({ laneGlyphs: event.target.checked })} />Distinct node shapes per lane</label>
          <label className="st-check"><input type="checkbox" checked={prefs.highContrast} onChange={(event) => updatePrefs({ highContrast: event.target.checked })} />High contrast</label>
          <label className="st-check"><input type="checkbox" checked={prefs.reduceMotion} onChange={(event) => updatePrefs({ reduceMotion: event.target.checked })} />Reduce motion</label>
        </div>
      </Section>
      <Section title="Notifications" hint="Desktop notification when a fetch, pull, push, rebase or clone finishes while Chrono is in the background.">
        <label className="st-check"><input type="checkbox" checked={notify} onChange={async (event) => setNotify(await setNotificationsEnabled(event.target.checked))} />Notify me when long operations finish</label>
      </Section>
    </>
  );
}

// ------------------------------------------------------------- shell menu
const SHELL_ACTION_LABELS: Array<[string, string]> = [
  ["commit", "Git Commit…"], ["log", "Show log"], ["diff", "Diff"], ["diffprev", "Diff with previous version"], ["blame", "Blame"],
  ["modifications", "Check for modifications"], ["revert", "Revert…"], ["add", "Add…"], ["resolve", "Resolve"], ["cleanup", "Clean up…"],
  ["stash", "Stash save…"], ["patch", "Create patch…"], ["sync", "Git Sync…"], ["properties", "Properties"], ["explore", "Open in Chrono Explorer"],
  ["graph", "Show in Chrono graph"], ["terminal", "Open Git terminal here"],
];

function ShellTab({ repositoryPath }: Props) {
  const [action, setAction] = useState("commit");
  const [target, setTarget] = useState(repositoryPath);
  const desktop = typeof window !== "undefined" && Boolean(window.chronoDesktop);
  const protocolLink = `chrono://tgit?${new URLSearchParams({ action, path: target }).toString()}`;
  const webLink = `${window.location.origin}/?chrono=tgit&${new URLSearchParams({ action, path: target }).toString()}`;
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => pushToast("Copied", "success", 2000)); };
  return (
    <>
      <Section title="Right-click menu in your file manager" hint="Adds a TortoiseGit-style “Chrono” submenu to Windows Explorer, GNOME Files (Nautilus), Caja, Nemo, Dolphin or Finder. Each entry opens Chrono on the clicked files and runs the action — commit, log, diff, blame, revert, clean up…">
        <div className="st-shell">
          <h4>Windows Explorer</h4>
          <p className="st-note">Per-user, no administrator rights. Run from the <code>shell-integration</code> folder (inside the Chrono install's <code>resources</code> folder or the source tree):</p>
          <pre className="st-pre">powershell -ExecutionPolicy Bypass -File windows\install-context-menu.ps1{"\n"}# uninstall: add -Uninstall · custom install path: -ExePath "D:\Apps\Chrono\Chrono.exe"</pre>
          <h4>Linux (Nautilus, Caja, Nemo, Dolphin)</h4>
          <pre className="st-pre">sh shell-integration/linux/install.sh{"\n"}# uninstall: sh shell-integration/linux/install.sh --uninstall</pre>
          <p className="st-note">The menu calls <code>~/.local/bin/chrono-open</code>. It starts the desktop app (<code>$CHRONO_BIN</code> or <code>chrono</code> on PATH), or opens the web build when <code>CHRONO_WEB_URL</code> is set (for this server: <code>{window.location.origin}</code>).</p>
          <h4>macOS Finder</h4>
          <p className="st-note">Create Automator Quick Actions that run <code>chrono-open &lt;action&gt; "$@"</code> — see <code>shell-integration/macos/README.md</code>.</p>
        </div>
      </Section>
      <Section title="Try a link" hint={desktop ? "The desktop app handles chrono:// links directly." : "In the web build, use the http link (or set CHRONO_WEB_URL for chrono-open)."}>
        <div className="st-grid">
          <label>Action<select value={action} onChange={(event) => setAction(event.target.value)}>{SHELL_ACTION_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="st-wide">Absolute path<input value={target} onChange={(event) => setTarget(event.target.value)} /></label>
        </div>
        <div className="st-table">
          <div className="st-table-row"><strong>Protocol</strong><code>{protocolLink}</code><small /><div><button type="button" className="ux-button compact" onClick={() => copy(protocolLink)}>Copy</button></div></div>
          <div className="st-table-row"><strong>Web</strong><code>{webLink}</code><small /><div><button type="button" className="ux-button compact" onClick={() => copy(webLink)}>Copy</button><button type="button" className="ux-button compact" onClick={() => window.dispatchEvent(new CustomEvent("chrono:deep-link", { detail: protocolLink }))}>Run now</button></div></div>
        </div>
      </Section>
    </>
  );
}

/** Repository settings: everything from the feature-gap roadmap that is
 *  configuration rather than a daily action lives here. */
export function RepoSettings(props: Props) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? "identity");
  useEffect(() => { if (props.initialTab) setTab(props.initialTab); }, [props.initialTab]);
  return (
    <div className="st-layout">
      <nav className="st-nav" aria-label="Settings sections">
        <h2>Repository settings</h2>
        {TABS.map((item) => (
          <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} />{item.label}</button>
        ))}
      </nav>
      <div className="st-body">
        {tab === "identity" && <IdentityTab {...props} />}
        {tab === "ai" && <AiTab busy={props.busy} run={props.run} />}
        {tab === "performance" && <PerformanceTab {...props} />}
        {tab === "hooks" && <HooksTab {...props} />}
        {tab === "links" && <LinksTab {...props} />}
        {tab === "templates" && <TemplatesTab {...props} />}
        {tab === "commands" && <CommandsTab {...props} />}
        {tab === "gitflow" && <GitflowTab {...props} />}
        {tab === "sparse" && <SparseTab {...props} />}
        {tab === "archive" && <ArchiveTab {...props} />}
        {tab === "display" && <DisplayTab />}
        {tab === "shell" && <ShellTab {...props} />}
      </div>
    </div>
  );
}
