// GitHub dialogs: add a remote from GitHub (with forking), the pull request
// view (edit, reviewers, assignees, labels, comment, review, merge, check
// out, build status) and the issue view (edit, comment, close, branch).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../../api";
import type { CheckRun, GithubForks, GithubIssueDetail, GithubLabel, GithubPullDetail, GithubRepoOptions, GithubTimelineItem, RemoteRecord } from "../../types";
import { Modal } from "./HostingDialogs";
import { GithubRepoPicker } from "./GithubRepoPicker";
import { askConfirm, askText } from "../DialogHost";
import { pushToast } from "../../toastBus";
import { ago, githubRemotes, openUrl, refAsking, refFor, type GithubRemote } from "../../githubContext";

type Run = (label: string, action: () => Promise<unknown>) => Promise<void>;
const errorText = (error: unknown) => String(error).replace(/^Error: /, "");

// ------------------------------------------------------------------ shared pieces

/** Text color that reads on a label's background. */
function labelStyle(color: string) {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : "888888";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { background: `#${hex}`, color: (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#1b1f24" : "#ffffff" };
}
export const LabelChip = ({ label }: { label: GithubLabel }) => <span className="gh-label" style={labelStyle(label.color)}>{label.name}</span>;
const Avatar = ({ url, login, size = 20 }: { url?: string; login: string; size?: number }) => url ? <img className="gh-avatar" src={`${url}${url.includes("?") ? "&" : "?"}s=${size * 2}`} alt="" width={size} height={size} title={login} /> : <span className="gh-avatar is-empty" style={{ width: size, height: size }}>{login.slice(0, 1).toUpperCase()}</span>;

/** A checklist that pops open under a sidebar heading. */
function Picker({ title, options, selected, onApply, single }: { title: string; options: Array<{ value: string; label: ReactNode; search: string }>; selected: string[]; onApply: (values: string[]) => Promise<void> | void; single?: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) { setDraft(new Set(selected)); setQuery(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // What is already set stays pickable even when the repository no longer offers it.
  const all = [...options, ...selected.filter((value) => !options.some((option) => option.value === value)).map((value) => ({ value, label: <span>{value}</span> as ReactNode, search: value }))];
  const shown = all.filter((option) => !query || option.search.toLowerCase().includes(query.toLowerCase()));
  return (
    <span className="gh-picker-pop">
      <button type="button" className="gk-link-button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "Cancel" : "Edit"}</button>
      {open && (
        <div className="gh-picker-menu" role="dialog" aria-label={title}>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${title.toLowerCase()}`} />
          <div className="gh-picker-options">
            {shown.length === 0 && <small>Nothing to pick.</small>}
            {shown.map((option) => (
              <label key={option.value}>
                <input type={single ? "radio" : "checkbox"} checked={draft.has(option.value)} onChange={() => setDraft((current) => {
                  const next = new Set(single ? [] : current);
                  if (current.has(option.value) && !single) next.delete(option.value); else next.add(option.value);
                  return next;
                })} />{option.label}
              </label>
            ))}
          </div>
          <div className="gh-picker-actions">
            {single && <button type="button" className="ux-button compact" onClick={async () => { await onApply([]); setOpen(false); }}>Clear</button>}
            <button type="button" className="ux-primary-button compact" onClick={async () => { await onApply([...draft]); setOpen(false); }}>Apply</button>
          </div>
        </div>
      )}
    </span>
  );
}

const REVIEW_TEXT: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "review dismissed", PENDING: "review requested" };

function Timeline({ items }: { items: GithubTimelineItem[] }) {
  if (!items.length) return <p className="tg-note">No comments yet.</p>;
  return (
    <ol className="gh-timeline">
      {items.map((item, index) => (
        <li key={`${item.createdAt}-${index}`} className={item.state ? `is-${item.state.toLowerCase()}` : ""}>
          <header><Avatar url={item.avatarUrl} login={item.author} /><strong>{item.author}</strong>{item.kind === "review" && <span className="gh-review-state">{REVIEW_TEXT[item.state ?? ""] ?? item.state}</span>}<a href={item.htmlUrl} target="_blank" rel="noreferrer">{ago(item.createdAt)}</a></header>
          {item.body && <div className="gh-body">{item.body}</div>}
        </li>
      ))}
    </ol>
  );
}

function Checks({ checks }: { checks: { state: string; checks: CheckRun[] } }) {
  if (!checks.checks.length) return <small className="gh-muted">No checks reported.</small>;
  return (
    <div className="gk-ci-list">
      <span className={`gk-ci-state is-${checks.state}`}>{checks.state}</span>
      {checks.checks.map((check) => (
        <div key={`${check.id}-${check.name}`} className={`gk-ci-row is-${check.status !== "completed" ? "pending" : check.conclusion}`}>
          <span aria-hidden="true">{check.status !== "completed" ? "◷" : ["success", "neutral", "skipped"].includes(check.conclusion) ? "✓" : "✕"}</span>
          <a href={check.url || undefined} target="_blank" rel="noreferrer" title={`${check.name}: ${check.conclusion || check.status}`}>{check.name}</a>
          <small>{check.conclusion || check.status}</small>
        </div>
      ))}
    </div>
  );
}

/** Title and description, editable in place. */
function EditableHead({ number, title, body, editable, onSave, badges }: { number: number; title: string; body: string; editable: boolean; onSave: (patch: { title?: string; body?: string }) => Promise<void>; badges: ReactNode }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [bodyDraft, setBodyDraft] = useState(body);
  useEffect(() => { setTitleDraft(title); setBodyDraft(body); }, [title, body]);
  return <>
    <div className="gh-title-row">
      {editingTitle
        ? <form className="gh-title-edit" onSubmit={async (event) => { event.preventDefault(); await onSave({ title: titleDraft }); setEditingTitle(false); }}><input autoFocus value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} /><button type="submit" className="ux-primary-button compact">Save</button><button type="button" className="ux-button compact" onClick={() => setEditingTitle(false)}>Cancel</button></form>
        : <h3>{title} <span className="gh-number">#{number}</span>{editable && <button type="button" className="gk-link-button" onClick={() => setEditingTitle(true)}>Edit</button>}</h3>}
    </div>
    <div className="gh-badges">{badges}</div>
    <div className="gh-description">
      <div className="gh-section-head"><strong>Description</strong>{editable && !editingBody && <button type="button" className="gk-link-button" onClick={() => setEditingBody(true)}>Edit</button>}</div>
      {editingBody
        ? <><textarea className="tg-message" rows={8} value={bodyDraft} onChange={(event) => setBodyDraft(event.target.value)} /><div className="gh-row-actions"><button type="button" className="ux-primary-button compact" onClick={async () => { await onSave({ body: bodyDraft }); setEditingBody(false); }}>Save</button><button type="button" className="ux-button compact" onClick={() => { setBodyDraft(body); setEditingBody(false); }}>Cancel</button></div></>
        : body.trim() ? <div className="gh-body">{body}</div> : <small className="gh-muted">No description.</small>}
    </div>
  </>;
}

/** Repository people, labels and milestones, loaded once per dialog. */
function useOptions(repositoryPath: string, gh: GithubRemote) {
  const [options, setOptions] = useState<GithubRepoOptions | null>(null);
  useEffect(() => { api.ghRepoOptions(repositoryPath, refFor(gh)).then(setOptions).catch(() => setOptions({ assignees: [], labels: [], milestones: [] })); }, [repositoryPath, gh]);
  return options;
}

function Sidebar({ options, assignees, labels, milestone, onPatch, reviewers, onReviewers, author }: {
  options: GithubRepoOptions | null; assignees: string[]; labels: GithubLabel[]; milestone: { number: number; title: string } | null;
  onPatch: (patch: { assignees?: string[]; labels?: string[]; milestone?: number | null }) => Promise<void>;
  reviewers?: Array<{ login: string; avatarUrl: string; state: string }>; onReviewers?: (add: string[], remove: string[]) => Promise<void>; author?: string;
}) {
  const people = (options?.assignees ?? []).map((login) => ({ value: login, label: <span>{login}</span>, search: login }));
  return (
    <aside className="gh-sidebar">
      {reviewers && onReviewers && (
        <section>
          <div className="gh-section-head"><strong>Reviewers</strong><Picker title="Reviewers" options={people.filter((person) => person.value !== author)} selected={reviewers.filter((entry) => entry.state === "PENDING").map((entry) => entry.login)} onApply={(values) => {
            const pending = reviewers.filter((entry) => entry.state === "PENDING").map((entry) => entry.login);
            return onReviewers(values.filter((login) => !pending.includes(login)), pending.filter((login) => !values.includes(login)));
          }} /></div>
          {reviewers.length ? reviewers.map((entry) => <div key={entry.login} className={`gh-person is-${entry.state.toLowerCase()}`}><Avatar url={entry.avatarUrl} login={entry.login} /><span>{entry.login}</span><small>{REVIEW_TEXT[entry.state] ?? entry.state}</small></div>) : <small className="gh-muted">No reviewers.</small>}
        </section>
      )}
      <section>
        <div className="gh-section-head"><strong>Assignees</strong><Picker title="Assignees" options={people} selected={assignees} onApply={(values) => onPatch({ assignees: values })} /></div>
        {assignees.length ? assignees.map((login) => <div key={login} className="gh-person"><span>{login}</span></div>) : <small className="gh-muted">No one assigned.</small>}
      </section>
      <section>
        <div className="gh-section-head"><strong>Labels</strong><Picker title="Labels" options={[...(options?.labels ?? []), ...labels.filter((entry) => !(options?.labels ?? []).some((option) => option.name === entry.name))].map((entry) => ({ value: entry.name, label: <LabelChip label={entry} />, search: entry.name }))} selected={labels.map((entry) => entry.name)} onApply={(values) => onPatch({ labels: values })} /></div>
        {labels.length ? <div className="gh-labels">{labels.map((entry) => <LabelChip key={entry.name} label={entry} />)}</div> : <small className="gh-muted">None yet.</small>}
      </section>
      <section>
        <div className="gh-section-head"><strong>Milestone</strong><Picker single title="Milestone" options={(options?.milestones ?? []).map((entry) => ({ value: String(entry.number), label: <span>{entry.title}</span>, search: entry.title }))} selected={milestone ? [String(milestone.number)] : []} onApply={(values) => onPatch({ milestone: values[0] ? Number(values[0]) : null })} /></div>
        {milestone ? <span>{milestone.title}</span> : <small className="gh-muted">No milestone.</small>}
      </section>
    </aside>
  );
}

// ------------------------------------------------------------------ add remote

export function AddRemoteDialog({ repositoryPath, remotes, run, onClose, onOpenSettings }: { repositoryPath: string; remotes: RemoteRecord[]; run: Run; onClose: () => void; onOpenSettings?: () => void }) {
  const [tab, setTab] = useState<"github" | "url">("github");
  const [protocol, setProtocol] = useState<"https" | "ssh">(() => (localStorage.getItem("chrono.clone.protocol") === "ssh" ? "ssh" : "https"));
  const [gh, setGh] = useState<GithubRemote | null | undefined>(undefined);
  const [forks, setForks] = useState<GithubForks | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [name, setName] = useState(remotes.length ? "" : "origin");
  const [url, setUrl] = useState("");

  useEffect(() => { void githubRemotes(repositoryPath).then((list) => setGh(list.find((entry) => entry.remote === "origin") ?? list[0] ?? null)); }, [repositoryPath]);
  useEffect(() => {
    if (!gh) return;
    if (!refFor(gh).token) { setForkError("connect"); return; }
    api.ghForks(repositoryPath, refFor(gh)).then(setForks).catch((reason) => setForkError(errorText(reason)));
  }, [repositoryPath, gh]);

  const existing = new Set(remotes.map((remote) => remote.name));
  const urls = new Set(remotes.flatMap((remote) => [remote.fetchUrl, remote.pushUrl]).map((value) => value.replace(/\.git$/, "").toLowerCase()));
  const hasUrl = (value: string) => urls.has(value.replace(/\.git$/, "").toLowerCase());
  const pickUrl = (repo: { cloneUrl: string; sshUrl: string }) => (protocol === "ssh" ? repo.sshUrl : repo.cloneUrl);

  const add = async (suggested: string, remoteUrl: string) => {
    let remoteName = suggested;
    if (!remoteName || existing.has(remoteName)) {
      const chosen = await askText("Remote name", `"${suggested}" is taken. Name for ${remoteUrl}`, suggested ? `${suggested}-2` : "");
      if (!chosen?.trim()) return;
      remoteName = chosen.trim();
    }
    await run(`Add remote ${remoteName}`, async () => {
      await api.remoteAction(repositoryPath, "add", remoteName, remoteUrl);
      await api.remoteAction(repositoryPath, "fetch", remoteName).catch(() => undefined);
    });
    onClose();
  };

  const fork = async () => {
    if (!gh || !forks) return;
    if (!await askConfirm(`Fork ${forks.parent.fullName}?`, `Creates ${forks.me}/${forks.parent.name} on GitHub and adds it as the remote "${forks.me}".`, { confirm: "Fork and add remote" })) return;
    await run(`Fork ${forks.parent.fullName}`, async () => {
      const ref = await refAsking(gh);
      if (!ref) return;
      const created = await api.ghForkCreate(repositoryPath, ref);
      await api.remoteAction(repositoryPath, "add", existing.has(forks.me) ? `${forks.me}-fork` : forks.me, pickUrl(created));
      // GitHub copies the repository in the background: the first fetch can come too early.
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await api.remoteAction(repositoryPath, "fetch", existing.has(forks.me) ? `${forks.me}-fork` : forks.me); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 2500)); }
      }
      pushToast(`Forked to ${created.fullName}`, "success");
    });
    onClose();
  };

  return (
    <Modal title="Add remote" icon="cloud" wide onClose={onClose} footer={tab === "url" ? <>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-primary-button" disabled={!name.trim() || !url.trim()} onClick={() => void add(name.trim(), url.trim())}>Add remote</button>
    </> : undefined}>
      <div className="gh-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "github"} className={tab === "github" ? "is-active" : ""} onClick={() => setTab("github")}>GitHub</button>
        <button type="button" role="tab" aria-selected={tab === "url"} className={tab === "url" ? "is-active" : ""} onClick={() => setTab("url")}>URL</button>
      </div>
      {tab === "url" ? (
        <div className="st-grid">
          <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="st-wide">URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" /></label>
        </div>
      ) : <>
        {gh && (
          <section className="gh-forks">
            <div className="gh-section-head"><strong>Forks of {forks?.parent.fullName ?? gh.fullName}</strong></div>
            {forkError === "connect" ? <p className="tg-note">Connect to GitHub to fork and find forks. {onOpenSettings && <button type="button" className="gk-link-button" onClick={onOpenSettings}>Settings → Hosting connections</button>}</p>
              : forkError ? <p className="tg-note gh-error">{forkError}</p>
              : !forks ? <p className="tg-note"><i className="ux-spinner" /> Looking for forks…</p>
              : <>
                {forks.mine ? (
                  <div className="gh-fork-row is-mine"><strong>{forks.mine.fullName}</strong><span className="gh-badge">your fork</span><span className="tg-spacer" />
                    {hasUrl(forks.mine.cloneUrl) || hasUrl(forks.mine.sshUrl) ? <small className="gh-muted">already a remote</small> : <button type="button" className="ux-primary-button compact" onClick={() => void add(forks.me, pickUrl(forks.mine!))}>Add this remote</button>}
                  </div>
                ) : forks.parent.owner.toLowerCase() !== forks.me.toLowerCase() ? (
                  <div className="gh-fork-row is-mine"><span>You have no fork of {forks.parent.fullName} yet.</span><span className="tg-spacer" /><button type="button" className="ux-primary-button compact" onClick={() => void fork()}>Fork and add remote</button></div>
                ) : <p className="tg-note">This is your repository.</p>}
                {!hasUrl(forks.parent.cloneUrl) && !hasUrl(forks.parent.sshUrl) && (
                  <div className="gh-fork-row"><strong>{forks.parent.fullName}</strong><span className="gh-badge">original</span><span className="tg-spacer" /><button type="button" className="ux-button compact" onClick={() => void add(existing.has("upstream") ? forks.parent.owner : "upstream", pickUrl(forks.parent))}>Add as {existing.has("upstream") ? forks.parent.owner : "upstream"}</button></div>
                )}
                {forks.others.length > 0 && <details className="gh-other-forks"><summary>{forks.others.length} other fork{forks.others.length === 1 ? "" : "s"}</summary>
                  {forks.others.map((entry) => <div key={entry.fullName} className="gh-fork-row"><span>{entry.fullName}</span><small className="gh-muted">{entry.updatedAt ? `pushed ${ago(entry.updatedAt)}` : ""}</small><span className="tg-spacer" />{hasUrl(entry.cloneUrl) ? <small className="gh-muted">added</small> : <button type="button" className="ux-button compact" onClick={() => void add(entry.owner, pickUrl(entry))}>Add</button>}</div>)}
                </details>}
              </>}
          </section>
        )}
        <section>
          <div className="gh-section-head"><strong>Your repositories</strong></div>
          <GithubRepoPicker compact protocol={protocol} onProtocol={(value) => { setProtocol(value); localStorage.setItem("chrono.clone.protocol", value); }} onOpenSettings={onOpenSettings} onPick={(repo, picked) => void add(existing.size ? repo.owner : "origin", picked)} />
        </section>
      </>}
    </Modal>
  );
}

// ------------------------------------------------------------------ pull request view

export function PullRequestView({ repositoryPath, gh, number, onClose, run, onChanged }: { repositoryPath: string; gh: GithubRemote; number: number; onClose: () => void; run: Run; onChanged: () => void }) {
  const [pull, setPull] = useState<GithubPullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">(() => (localStorage.getItem("chrono.gh.mergeMethod") as "merge" | "squash" | "rebase") || "merge");
  const [sending, setSending] = useState(false);
  const options = useOptions(repositoryPath, gh);

  const load = useCallback(async () => {
    try { setPull(await api.ghPull(repositoryPath, refFor(gh), number)); setError(null); }
    catch (reason) { setError(errorText(reason)); }
  }, [repositoryPath, gh, number]);
  useEffect(() => { void load(); }, [load]);

  const act = async (what: string, action: (ref: NonNullable<Awaited<ReturnType<typeof refAsking>>>) => Promise<unknown>) => {
    const ref = await refAsking(gh);
    if (!ref) return;
    setSending(true);
    try { await action(ref); await load(); onChanged(); }
    catch (reason) { pushToast(`${what}: ${errorText(reason)}`, "error"); }
    finally { setSending(false); }
  };
  const patch = (value: Parameters<typeof api.ghPullUpdate>[3]) => act("Update", (ref) => api.ghPullUpdate(repositoryPath, ref, number, value));

  const merge = async () => {
    if (!pull) return;
    if (!await askConfirm(`Merge #${pull.number}?`, `${method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge"} ${pull.head.ref} into ${pull.base.ref} on GitHub.`, { confirm: method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge pull request" })) return;
    localStorage.setItem("chrono.gh.mergeMethod", method);
    await act("Merge", async (ref) => {
      pushToast(await api.ghMerge(repositoryPath, ref, number, method), "success");
      await run(`Fetch ${gh.remote}`, () => api.remoteAction(repositoryPath, "fetch", gh.remote));
    });
  };

  const send = async (kind: "comment" | "APPROVE" | "REQUEST_CHANGES") => {
    await act(kind === "comment" ? "Comment" : "Review", (ref) => (kind === "comment" ? api.ghComment(repositoryPath, ref, number, comment) : api.ghReview(repositoryPath, ref, number, kind, comment)));
    setComment("");
  };

  const mine = pull ? pull.viewer && pull.author?.login === pull.viewer : false;
  return (
    <Modal title={`Pull request #${number} · ${gh.fullName}`} icon="compare" wide onClose={onClose} footer={pull ? <>
      <button type="button" className="ux-button" onClick={() => openUrl(pull.htmlUrl)}>Open on GitHub</button>
      <button type="button" className="ux-button" disabled={sending} onClick={() => void run(`Check out #${pull.number}`, () => api.ghPullCheckout(repositoryPath, gh.remote, pull.number, pull.head.ref, pull.head.sameRepo)).then(onClose)}>Check out {pull.head.sameRepo ? pull.head.ref : `pr/${pull.number}`}</button>
      {pull.state !== "merged" && <button type="button" className="ux-button" disabled={sending} onClick={() => void patch({ state: pull.state === "open" ? "closed" : "open" })}>{pull.state === "open" ? "Close" : "Reopen"}</button>}
      <span className="tg-spacer" />
      {pull.state === "open" && <>
        <select value={method} onChange={(event) => setMethod(event.target.value as typeof method)} aria-label="Merge method"><option value="merge">Create a merge commit</option><option value="squash">Squash and merge</option><option value="rebase">Rebase and merge</option></select>
        <button type="button" className="ux-primary-button" disabled={sending || !pull.canMerge} title={pull.draft ? "Draft pull requests cannot be merged" : pull.mergeable === false ? "GitHub reports conflicts with the base branch" : ""} onClick={() => void merge()}>Merge</button>
      </>}
    </> : undefined}>
      {error && <p className="tg-note gh-error">{error}</p>}
      {!pull && !error && <div className="gk-empty"><i className="ux-spinner" />Loading pull request…</div>}
      {pull && (
        <div className="gh-detail">
          <div className="gh-main">
            <EditableHead number={pull.number} title={pull.title} body={pull.body} editable={pull.state !== "merged"} onSave={(value) => patch(value)} badges={<>
              <span className={`gh-state is-${pull.draft && pull.state === "open" ? "draft" : pull.state}`}>{pull.draft && pull.state === "open" ? "Draft" : pull.state === "open" ? "Open" : pull.state === "merged" ? "Merged" : "Closed"}</span>
              <span>{pull.author && <><Avatar url={pull.author.avatarUrl} login={pull.author.login} /> <strong>{pull.author.login}</strong></>} wants to merge {pull.commits} commit{pull.commits === 1 ? "" : "s"} into <code>{pull.base.ref}</code> from <code>{pull.head.sameRepo ? pull.head.ref : `${pull.head.repo ?? "?"}:${pull.head.ref}`}</code></span>
              <span className="gh-muted">{pull.changedFiles} files · <b className="gh-add">+{pull.additions}</b> <b className="gh-del">−{pull.deletions}</b></span>
              {pull.state === "open" && pull.mergeable === false && <span className="gh-warn">Conflicts with {pull.base.ref}</span>}
            </>} />
            <div className="gh-section-head"><strong>Conversation</strong></div>
            <Timeline items={pull.timeline} />
            <div className="gh-compose">
              <textarea className="tg-message" rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Leave a comment or review" />
              <div className="gh-row-actions">
                <button type="button" className="ux-button compact" disabled={sending || !comment.trim()} onClick={() => void send("comment")}>Comment</button>
                <span className="tg-spacer" />
                {!mine && pull.state === "open" && <>
                  <button type="button" className="ux-button compact" disabled={sending || !comment.trim()} onClick={() => void send("REQUEST_CHANGES")}>Request changes</button>
                  <button type="button" className="ux-primary-button compact" disabled={sending} onClick={() => void send("APPROVE")}>Approve</button>
                </>}
              </div>
            </div>
          </div>
          <div className="gh-side-col">
            <Sidebar options={options} assignees={pull.assignees} labels={pull.labels} milestone={pull.milestone} author={pull.author?.login}
              reviewers={pull.reviewers} onReviewers={(add, remove) => patch({ addReviewers: add, removeReviewers: remove })} onPatch={(value) => patch(value)} />
            <section className="gh-sidebar"><div className="gh-section-head"><strong>Build status</strong></div><Checks checks={pull.checks} /></section>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ issues

export function IssueView({ repositoryPath, gh, number, onClose, run, onChanged, issueBranches }: { repositoryPath: string; gh: GithubRemote; number: number; onClose: () => void; run: Run; onChanged: () => void; issueBranches: Record<string, string> }) {
  const [issue, setIssue] = useState<GithubIssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const options = useOptions(repositoryPath, gh);
  const load = useCallback(async () => {
    try { setIssue(await api.ghIssue(repositoryPath, refFor(gh), number)); setError(null); } catch (reason) { setError(errorText(reason)); }
  }, [repositoryPath, gh, number]);
  useEffect(() => { void load(); }, [load]);
  const act = async (what: string, action: (ref: NonNullable<Awaited<ReturnType<typeof refAsking>>>) => Promise<unknown>) => {
    const ref = await refAsking(gh);
    if (!ref) return;
    setSending(true);
    try { await action(ref); await load(); onChanged(); } catch (reason) { pushToast(`${what}: ${errorText(reason)}`, "error"); } finally { setSending(false); }
  };
  const patch = (value: Parameters<typeof api.ghIssueUpdate>[3]) => act("Update", (ref) => api.ghIssueUpdate(repositoryPath, ref, number, value));
  const linked = useMemo(() => Object.entries(issueBranches).filter(([, url]) => issue && url === issue.htmlUrl).map(([branch]) => branch), [issueBranches, issue]);

  return (
    <Modal title={`Issue #${number} · ${gh.fullName}`} icon="flag" wide onClose={onClose} footer={issue ? <>
      <button type="button" className="ux-button" onClick={() => openUrl(issue.htmlUrl)}>Open on GitHub</button>
      <button type="button" className="ux-button" disabled={sending} onClick={() => void patch({ state: issue.state === "open" ? "closed" : "open" })}>{issue.state === "open" ? "Close issue" : "Reopen issue"}</button>
      <span className="tg-spacer" />
      {linked.length > 0 && <small className="gh-muted">Branch: {linked.join(", ")}</small>}
      <button type="button" className="ux-primary-button" onClick={() => void createIssueBranch(repositoryPath, issue, run).then((done) => { if (done) onClose(); })}>Create a branch for this issue</button>
    </> : undefined}>
      {error && <p className="tg-note gh-error">{error}</p>}
      {!issue && !error && <div className="gk-empty"><i className="ux-spinner" />Loading issue…</div>}
      {issue && (
        <div className="gh-detail">
          <div className="gh-main">
            <EditableHead number={issue.number} title={issue.title} body={issue.body} editable onSave={(value) => patch(value)} badges={<>
              <span className={`gh-state is-${issue.state}`}>{issue.state === "open" ? "Open" : "Closed"}</span>
              <span><Avatar url={issue.avatarUrl} login={issue.author} /> <strong>{issue.author}</strong> opened this {ago(issue.createdAt)} ago · {issue.comments} comment{issue.comments === 1 ? "" : "s"}</span>
            </>} />
            <div className="gh-section-head"><strong>Comments</strong></div>
            <Timeline items={issue.timeline} />
            <div className="gh-compose">
              <textarea className="tg-message" rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Leave a comment" />
              <div className="gh-row-actions"><span className="tg-spacer" /><button type="button" className="ux-primary-button compact" disabled={sending || !comment.trim()} onClick={() => void act("Comment", (ref) => api.ghComment(repositoryPath, ref, number, comment)).then(() => setComment(""))}>Comment</button></div>
            </div>
          </div>
          <div className="gh-side-col">
            <Sidebar options={options} assignees={issue.assignees} labels={issue.labels} milestone={issue.milestone} onPatch={(value) => patch(value)} />
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Ask for the branch name (prefilled from the issue) and create it. */
export async function createIssueBranch(repositoryPath: string, issue: { number: number; title: string; htmlUrl: string }, run: Run): Promise<boolean> {
  const suggested = `${issue.number}-${issue.title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "")}`.replace(/-$/, "");
  const name = await askText(`Branch for #${issue.number}`, "Branch name (created at HEAD and checked out)", suggested);
  if (!name?.trim()) return false;
  await run(`Create branch ${name.trim()} for #${issue.number}`, () => api.ghIssueBranch(repositoryPath, name.trim(), "HEAD", issue.htmlUrl));
  return true;
}

export function NewIssueDialog({ repositoryPath, gh, onClose, onCreated }: { repositoryPath: string; gh: GithubRemote; onClose: () => void; onCreated: (number: number) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const options = useOptions(repositoryPath, gh);
  const create = async () => {
    const ref = await refAsking(gh);
    if (!ref) return;
    setSending(true);
    try { const created = await api.ghIssueCreate(repositoryPath, ref, { title, body, labels, assignees }); pushToast(`Created issue #${created.number}`, "success"); onCreated(created.number); }
    catch (reason) { pushToast(errorText(reason), "error"); }
    finally { setSending(false); }
  };
  return (
    <Modal title={`New issue · ${gh.fullName}`} icon="flag" wide onClose={onClose} footer={<>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-primary-button" disabled={sending || !title.trim()} onClick={() => void create()}>Create issue</button>
    </>}>
      <label className="gk-dialog-field"><span>Title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="gk-dialog-field"><span>Description</span><textarea className="tg-message" rows={8} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <div className="gh-new-fields">
        <div><div className="gh-section-head"><strong>Labels</strong><Picker title="Labels" options={(options?.labels ?? []).map((entry) => ({ value: entry.name, label: <LabelChip label={entry} />, search: entry.name }))} selected={labels} onApply={setLabels} /></div>
          {labels.length ? <div className="gh-labels">{labels.map((name) => <LabelChip key={name} label={options?.labels.find((entry) => entry.name === name) ?? { name, color: "888888" }} />)}</div> : <small className="gh-muted">None</small>}</div>
        <div><div className="gh-section-head"><strong>Assignees</strong><Picker title="Assignees" options={(options?.assignees ?? []).map((login) => ({ value: login, label: <span>{login}</span>, search: login }))} selected={assignees} onApply={setAssignees} /></div>
          {assignees.length ? <span>{assignees.join(", ")}</span> : <small className="gh-muted">No one</small>}</div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ new pull request extras

export type PrExtras = { reviewers: string[]; assignees: string[]; labels: string[] };

/** Reviewers, assignees and labels for a pull request being created on GitHub. */
export function GithubPrExtras({ repositoryPath, remote, value, onChange }: { repositoryPath: string; remote: string; value: PrExtras; onChange: (value: PrExtras) => void }) {
  const [gh, setGh] = useState<GithubRemote | null>(null);
  const [options, setOptions] = useState<GithubRepoOptions | null>(null);
  useEffect(() => { void githubRemotes(repositoryPath).then((list) => setGh(list.find((entry) => entry.remote === remote) ?? null)); }, [repositoryPath, remote]);
  useEffect(() => { if (gh && refFor(gh).token) api.ghRepoOptions(repositoryPath, refFor(gh)).then(setOptions).catch(() => setOptions(null)); }, [repositoryPath, gh]);
  if (!gh || !options) return null;
  const people = options.assignees.map((login) => ({ value: login, label: <span>{login}</span>, search: login }));
  return (
    <div className="gh-new-fields gh-pr-extras">
      <div><div className="gh-section-head"><strong>Reviewers</strong><Picker title="Reviewers" options={people} selected={value.reviewers} onApply={(reviewers) => onChange({ ...value, reviewers })} /></div>{value.reviewers.length ? <span>{value.reviewers.join(", ")}</span> : <small className="gh-muted">None</small>}</div>
      <div><div className="gh-section-head"><strong>Assignees</strong><Picker title="Assignees" options={people} selected={value.assignees} onApply={(assignees) => onChange({ ...value, assignees })} /></div>{value.assignees.length ? <span>{value.assignees.join(", ")}</span> : <small className="gh-muted">None</small>}</div>
      <div><div className="gh-section-head"><strong>Labels</strong><Picker title="Labels" options={options.labels.map((entry) => ({ value: entry.name, label: <LabelChip label={entry} />, search: entry.name }))} selected={value.labels} onApply={(labels) => onChange({ ...value, labels })} /></div>{value.labels.length ? <div className="gh-labels">{value.labels.map((name) => <LabelChip key={name} label={options.labels.find((entry) => entry.name === name) ?? { name, color: "888888" }} />)}</div> : <small className="gh-muted">None</small>}</div>
    </div>
  );
}

/** Apply reviewers, assignees and labels to a pull request just created. */
export async function applyPrExtras(repositoryPath: string, remote: string, number: number, extras: PrExtras): Promise<void> {
  if (!extras.reviewers.length && !extras.assignees.length && !extras.labels.length) return;
  const gh = (await githubRemotes(repositoryPath)).find((entry) => entry.remote === remote);
  if (!gh) return;
  await api.ghPullUpdate(repositoryPath, refFor(gh), number, {
    ...(extras.reviewers.length ? { addReviewers: extras.reviewers } : {}),
    ...(extras.assignees.length ? { assignees: extras.assignees } : {}),
    ...(extras.labels.length ? { labels: extras.labels } : {}),
  });
}
