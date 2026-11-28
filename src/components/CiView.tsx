import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { notifyIfHidden } from "../notify";
import { ensureToken, getApiBase, getProviderOverride, getToken } from "../providerTokens";
import { pushToast } from "../toastBus";
import type { CiCapabilities, CiJob, CiRun, CiRunAction, CiStatus, CiTarget, CiWorkflow, RemoteHost } from "../types";
import { askConfirm } from "./DialogHost";
import { Icon } from "./Icon";
import { Modal } from "./gk/HostingDialogs";

// CI monitoring: runs of GitHub Actions, GitLab pipelines, Gitea Actions,
// Bitbucket Pipelines or Bitbucket Server build statuses, their jobs, steps
// and logs, and the actions each provider allows (server/src/ci.ts).

type Props = {
  repositoryPath: string;
  currentBranch: string | null;
  remotes: string[];
  refreshKey: number;
};

const errorText = (error: unknown) => String(error).replace(/^Error: /, "");
export const ACTIVE: CiStatus[] = ["queued", "running", "waiting"];
const isActive = (status: CiStatus) => ACTIVE.includes(status);

export function ciIcon(status: CiStatus): string {
  switch (status) {
    case "success": return "✓";
    case "failure": return "✕";
    case "cancelled": return "⊘";
    case "skipped": return "↷";
    case "running": return "◐";
    case "queued": return "◷";
    case "waiting": return "⏸";
    case "manual": return "▶";
    default: return "•";
  }
}

export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return "";
  const value = Math.max(0, Math.round(totalSeconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${value % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
}

const elapsed = (run: { startedAt: string | null; durationSeconds: number | null; status: CiStatus }) =>
  run.durationSeconds ?? (isActive(run.status) && run.startedAt ? (Date.now() - Date.parse(run.startedAt)) / 1000 : null);

/** How to reach the CI of a remote: host, overrides, token (session or remembered). */
export async function ciTargetFor(repositoryPath: string, remote: string): Promise<{ host: RemoteHost; target: CiTarget } | null> {
  const host = await api.remoteHost(repositoryPath, remote).catch(() => null);
  if (!host) return null;
  return { host, target: { remote, token: getToken(host.host), apiBase: getApiBase(host.host) || undefined, provider: getProviderOverride(host.host) || undefined } };
}

export function CiView({ repositoryPath, currentBranch, remotes, refreshKey }: Props) {
  const [remote, setRemote] = useState(() => (remotes.includes("origin") ? "origin" : remotes[0] ?? "origin"));
  const [host, setHost] = useState<RemoteHost | null | undefined>(undefined);
  const [target, setTarget] = useState<CiTarget | null>(null);
  const [branchMode, setBranchMode] = useState<"current" | "all">(() => (localStorage.getItem("chrono.ci.branch") === "all" ? "all" : "current"));
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "failure" | "success">("");
  const [runs, setRuns] = useState<CiRun[] | null>(null);
  const [capabilities, setCapabilities] = useState<CiCapabilities | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<CiRun | null>(null);
  const [jobs, setJobs] = useState<CiJob[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [openSteps, setOpenSteps] = useState<Set<string>>(new Set());
  const [logJob, setLogJob] = useState<CiJob | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState("");
  const [workflows, setWorkflows] = useState<CiWorkflow[] | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const previous = useRef(new Map<string, CiStatus>());
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => { if (!remotes.includes(remote) && remotes.length) setRemote(remotes.includes("origin") ? "origin" : remotes[0]); }, [remotes, remote]);

  useEffect(() => {
    setHost(undefined); setTarget(null); setRuns(null); setSelected(null); setJobs(null); setLogJob(null); setWorkflows(null); setError(null);
    previous.current = new Map();
    void ciTargetFor(repositoryPath, remote).then((found) => { setHost(found?.host ?? null); setTarget(found?.target ?? null); });
  }, [repositoryPath, remote]);

  const branch = branchMode === "current" ? currentBranch : null;

  const loadRuns = useCallback(async (quiet = false) => {
    if (!target) return;
    try {
      const result = await api.ciRuns(repositoryPath, target, { branch, workflowId: workflowFilter || null, page: 1, limit: 30 * page });
      // Tell when a run that was going on has finished.
      for (const run of result.runs) {
        const before = previous.current.get(run.id);
        if (before && isActive(before) && !isActive(run.status)) {
          const text = `${run.name} #${run.number ?? run.id} on ${run.branch ?? run.sha.slice(0, 8)}: ${run.status}`;
          pushToast(text, run.status === "failure" ? "error" : "success", 6000);
          notifyIfHidden(`CI ${run.status}`, text);
        }
        previous.current.set(run.id, run.status);
      }
      setRuns(result.runs);
      setCapabilities(result.capabilities);
      setHasMore(result.hasMore);
      setUpdatedAt(Date.now());
      setError(null);
      setSelected((current) => (current ? result.runs.find((run) => run.id === current.id) ?? current : current));
    } catch (reason) {
      if (!quiet || !runs) setError(errorText(reason));
    }
  }, [target, repositoryPath, branch, workflowFilter, page, runs]);

  useEffect(() => { setRuns(null); void loadRuns(); }, [target, branch, workflowFilter, page, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: every 10 s while something runs, else every minute; only when visible.
  const anyActive = (runs ?? []).some((run) => isActive(run.status));
  useEffect(() => {
    if (!target) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadRuns(true); }, anyActive ? 10_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [target, anyActive, loadRuns]);
  useEffect(() => { const timer = window.setInterval(() => setTick((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);

  const loadJobs = useCallback(async (run: CiRun, quiet = false) => {
    if (!target) return;
    try {
      const next = await api.ciJobs(repositoryPath, target, run.id);
      setJobs(next);
      setJobsError(null);
      setLogJob((current) => (current ? next.find((job) => job.id === current.id) ?? current : current));
    } catch (reason) {
      if (!quiet) setJobsError(errorText(reason));
    }
  }, [target, repositoryPath]);

  useEffect(() => { setJobs(null); setLogJob(null); setLog(null); if (selected) void loadJobs(selected); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selected || !(isActive(selected.status) || (jobs ?? []).some((job) => isActive(job.status)))) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadJobs(selected, true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [selected, jobs, loadJobs]);

  const loadLog = useCallback(async (job: CiJob, quiet = false) => {
    if (!target || !selected) return;
    try {
      const text = await api.ciLog(repositoryPath, target, selected.id, job.id);
      const pre = logRef.current;
      const atBottom = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      setLog(text);
      setLogError(null);
      if (atBottom) requestAnimationFrame(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });
    } catch (reason) {
      if (!quiet) { setLog(null); setLogError(errorText(reason)); }
    }
  }, [target, selected, repositoryPath]);

  useEffect(() => { setLog(null); setLogError(null); setLogFilter(""); if (logJob) void loadLog(logJob); }, [logJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!logJob || !isActive(logJob.status)) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadLog(logJob, true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [logJob, loadLog]);

  const connect = async () => {
    if (!host) return;
    const token = await ensureToken(host.host, getProviderOverride(host.host) || host.provider);
    if (!token) return;
    setTarget((current) => (current ? { ...current, token } : current));
  };

  /** Actions need a token: ask for one when none is set. */
  const writeTarget = async (): Promise<CiTarget | null> => {
    if (!host || !target) return null;
    if (target.token) return target;
    const token = await ensureToken(host.host, getProviderOverride(host.host) || host.provider);
    if (!token) return null;
    const next = { ...target, token };
    setTarget(next);
    return next;
  };

  const runAction = async (action: CiRunAction, run: CiRun, job?: CiJob) => {
    if (action === "cancel" && !(await askConfirm("Cancel run", `Cancel ${run.name} #${run.number ?? run.id}?`, { confirm: "Cancel run", danger: true }))) return;
    const using = await writeTarget();
    if (!using) return;
    setWorking(action);
    try {
      pushToast(await api.ciRunAction(repositoryPath, using, action, run.id, job?.id), "success");
      window.setTimeout(() => { void loadRuns(true); if (selected) void loadJobs(selected, true); }, 1500);
    } catch (reason) {
      pushToast(errorText(reason), "error", 9000);
    } finally {
      setWorking(null);
    }
  };

  const openDispatch = async () => {
    if (!target) return;
    setDispatchOpen(true);
    if (!workflows) {
      try { setWorkflows(await api.ciWorkflows(repositoryPath, target)); }
      catch (reason) { pushToast(errorText(reason), "error", 9000); setDispatchOpen(false); }
    }
  };

  useEffect(() => {
    // GitHub's workflow filter needs the workflow list.
    if (target && host?.provider === "github" && !workflows) api.ciWorkflows(repositoryPath, target).then(setWorkflows).catch(() => undefined);
  }, [target, host?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleRuns = useMemo(() => (runs ?? []).filter((run) =>
    !statusFilter || (statusFilter === "active" ? isActive(run.status) || run.status === "manual" : run.status === statusFilter)), [runs, statusFilter]);

  const jobGroups = useMemo(() => {
    const groups = new Map<string, CiJob[]>();
    for (const job of jobs ?? []) { const key = job.stage ?? ""; groups.set(key, [...(groups.get(key) ?? []), job]); }
    return [...groups.entries()];
  }, [jobs]);

  const logLines = useMemo(() => {
    if (log === null) return null;
    const lines = log.split("\n");
    const needle = logFilter.trim().toLowerCase();
    return needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
  }, [log, logFilter]);

  if (host === undefined) return <section className="ci-view"><div className="ux-empty-state compact"><i className="ux-spinner" />Finding the CI of {remote}…</div></section>;
  if (host === null) return (
    <section className="ci-view">
      <div className="ux-empty-state">
        <Icon name="cloud" />
        <strong>No hosting provider detected for “{remote}”</strong>
        <span>CI monitoring works with GitHub, GitLab, Gitea/Forgejo and Bitbucket remotes. For a self-hosted server, set its provider in Settings → Hosting connections.</span>
      </div>
    </section>
  );

  const caps = capabilities;
  const runButtons = (run: CiRun, compact: boolean) => caps && !caps.statusesOnly && (
    <span className="ci-run-actions" onClick={(event) => event.stopPropagation()}>
      {caps.rerunFailed && run.status === "failure" && <button type="button" className="ux-button compact" disabled={working !== null} title="Re-run the failed jobs" onClick={() => void runAction("rerun_failed", run)}>{compact ? "↻ failed" : "Re-run failed"}</button>}
      {caps.rerun && !isActive(run.status) && <button type="button" className="ux-button compact" disabled={working !== null} title={caps.provider === "github" ? "Re-run all jobs" : "Start the same pipeline again"} onClick={() => void runAction("rerun", run)}>{compact ? "↻" : "Re-run"}</button>}
      {caps.cancel && isActive(run.status) && <button type="button" className="ux-button compact danger" disabled={working !== null} onClick={() => void runAction("cancel", run)}>{compact ? "■" : "Cancel"}</button>}
      {run.url && <a className="ux-button compact" href={run.url} target="_blank" rel="noreferrer" title="Open in the browser"><Icon name="external" /></a>}
    </span>
  );

  return (
    <section className="ci-view" aria-label="CI runs">
      <header className="ci-head">
        <div>
          <h2>{caps?.system ?? "CI"}</h2>
          <p>{host.owner}/{host.repository} on {host.host}{updatedAt ? ` · ${anyActive ? "live, " : ""}updated ${Math.max(0, Math.round((Date.now() - updatedAt) / 1000))} s ago` : ""}</p>
        </div>
        <div className="ci-filters">
          {remotes.length > 1 && <select value={remote} onChange={(event) => setRemote(event.target.value)} aria-label="Remote">{remotes.map((name) => <option key={name} value={name}>{name}</option>)}</select>}
          <select value={branchMode} onChange={(event) => { const value = event.target.value as "current" | "all"; setBranchMode(value); localStorage.setItem("chrono.ci.branch", value); setPage(1); }} aria-label="Branch">
            <option value="current">{currentBranch ? `Branch ${currentBranch}` : "Current branch"}</option>
            <option value="all">All branches</option>
          </select>
          {host.provider === "github" && workflows && workflows.length > 0 && (
            <select value={workflowFilter} onChange={(event) => { setWorkflowFilter(event.target.value); setPage(1); }} aria-label="Workflow">
              <option value="">All workflows</option>
              {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
            </select>
          )}
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="Status">
            <option value="">Any status</option>
            <option value="active">Running or waiting</option>
            <option value="failure">Failed</option>
            <option value="success">Succeeded</option>
          </select>
          <button type="button" className="ux-button" onClick={() => void loadRuns()}><Icon name="refresh" />Refresh</button>
          {caps?.dispatch && <button type="button" className="ux-primary-button" onClick={() => void openDispatch()}>{caps.provider === "gitlab" || caps.provider === "bitbucket-cloud" ? "Run pipeline…" : "Run workflow…"}</button>}
          {!target?.token && <button type="button" className="ux-button" onClick={() => void connect()} title="Private repositories, actions and higher rate limits need a token">Set token…</button>}
        </div>
      </header>

      {error && (
        <div className="lfs-banner is-warning" role="alert">
          <Icon name="warning" />
          <div><strong>Could not load runs</strong><span>{error}</span></div>
          {!target?.token && <button type="button" className="ux-button" onClick={() => void connect()}>Set token…</button>}
        </div>
      )}

      <div className={`ci-body${selected ? " has-detail" : ""}`}>
        <div className="ci-runs" role="list" aria-label="Runs">
          {!runs && !error && <div className="ux-empty-state compact"><i className="ux-spinner" />Loading runs…</div>}
          {runs && !visibleRuns.length && <div className="ux-empty-state compact">{caps?.statusesOnly ? "No build statuses on the recent commits of this branch." : "No runs."}</div>}
          {visibleRuns.map((run) => (
            <div key={run.id} role="listitem" tabIndex={0} className={`ci-run is-${run.status}${selected?.id === run.id ? " is-selected" : ""}`} onClick={() => setSelected(run)} onKeyDown={(event) => { if (event.key === "Enter") setSelected(run); }}>
              <span className={`ci-status is-${run.status}`} title={run.status} aria-label={run.status}>{ciIcon(run.status)}</span>
              <span className="ci-run-main">
                <strong title={run.title}>{run.title || run.name}</strong>
                <small>
                  {run.name}{run.number !== null ? ` #${run.number}` : ""}{run.attempt && run.attempt > 1 ? ` (attempt ${run.attempt})` : ""}
                  {run.branch ? ` · ${run.branch}` : ""} · <code>{run.sha.slice(0, 8)}</code>
                  {run.event ? ` · ${run.event}` : ""}{run.actor ? ` · ${run.actor}` : ""}
                </small>
              </span>
              <span className="ci-run-time">
                <small>{ago(run.createdAt)}</small>
                <small>{formatDuration(elapsed(run))}</small>
              </span>
              {runButtons(run, true)}
            </div>
          ))}
          {hasMore && <button type="button" className="gk-link-button ci-more" onClick={() => setPage((value) => value + 1)}>Show more</button>}
        </div>

        {selected && (
          <div className="ci-detail" aria-label="Run detail">
            <div className="ci-detail-head">
              <span className={`ci-status is-${selected.status}`}>{ciIcon(selected.status)}</span>
              <div>
                <strong>{selected.title || selected.name}</strong>
                <small>{selected.name}{selected.number !== null ? ` #${selected.number}` : ""} · {selected.status}{elapsed(selected) !== null ? ` · ${formatDuration(elapsed(selected))}` : ""}</small>
              </div>
              {runButtons(selected, false)}
              <button type="button" className="ux-icon-button" aria-label="Close" onClick={() => setSelected(null)}>✕</button>
            </div>
            {jobsError && <p className="fk-error">{jobsError}</p>}
            {!jobs && !jobsError && <div className="ux-empty-state compact"><i className="ux-spinner" />Loading jobs…</div>}
            {jobs && !jobs.length && <div className="ux-empty-state compact">No jobs yet.</div>}
            <div className="ci-jobs">
              {jobGroups.map(([stage, list]) => (
                <Fragment key={stage || "-"}>
                  {stage && <div className="ci-stage">{stage}</div>}
                  {list.map((job) => (
                    <div key={job.id} className={`ci-job${logJob?.id === job.id ? " is-selected" : ""}`}>
                      <div className="ci-job-row">
                        <button type="button" className="ci-job-toggle" aria-expanded={openSteps.has(job.id)} disabled={!job.steps.length} onClick={() => setOpenSteps((current) => { const next = new Set(current); if (next.has(job.id)) next.delete(job.id); else next.add(job.id); return next; })}>
                          <Icon name={job.steps.length ? (openSteps.has(job.id) ? "chevronDown" : "chevronRight") : "minus"} />
                        </button>
                        <span className={`ci-status is-${job.status}`} title={job.status}>{ciIcon(job.status)}</span>
                        <span className="ci-job-name">{job.name}</span>
                        <small>{formatDuration(job.durationSeconds ?? (isActive(job.status) && job.startedAt ? (Date.now() - Date.parse(job.startedAt)) / 1000 : null))}</small>
                        <span className="ci-run-actions">
                          {caps?.logs && <button type="button" className="ux-button compact" onClick={() => setLogJob(job)}>Log</button>}
                          {caps?.jobPlay && job.status === "manual" && <button type="button" className="ux-button compact" disabled={working !== null} onClick={() => void runAction("play_job", selected, job)}>▶ Run</button>}
                          {caps?.jobRerun && !isActive(job.status) && job.status !== "manual" && <button type="button" className="ux-button compact" disabled={working !== null} title="Re-run this job" onClick={() => void runAction("rerun_job", selected, job)}>↻</button>}
                          {job.url && <a className="ux-button compact" href={job.url} target="_blank" rel="noreferrer" aria-label="Open job"><Icon name="external" /></a>}
                        </span>
                      </div>
                      {openSteps.has(job.id) && (
                        <ol className="ci-steps">
                          {job.steps.map((step) => <li key={step.number}><span className={`ci-status is-${step.status}`}>{ciIcon(step.status)}</span>{step.name}</li>)}
                        </ol>
                      )}
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
            {logJob && (
              <div className="ci-log">
                <div className="ci-log-head">
                  <strong>{logJob.name}</strong>
                  {isActive(logJob.status) && <small>following…</small>}
                  <input value={logFilter} onChange={(event) => setLogFilter(event.target.value)} placeholder="Filter lines" aria-label="Filter log lines" />
                  <button type="button" className="ux-button compact" onClick={() => void loadLog(logJob)}><Icon name="refresh" /></button>
                  <button type="button" className="ux-button compact" disabled={!log} onClick={() => { if (log) void navigator.clipboard?.writeText(log).then(() => pushToast("Log copied", "success")); }}><Icon name="copy" /></button>
                  <button type="button" className="ux-icon-button" aria-label="Close log" onClick={() => setLogJob(null)}>✕</button>
                </div>
                {logError && <p className="fk-error">{logError}</p>}
                {log === null && !logError && <div className="ux-empty-state compact"><i className="ux-spinner" />Loading log…</div>}
                {logLines && (
                  <pre ref={logRef} className="ci-log-text">
                    {logLines.map((line, index) => <span key={index} className={/\b(error|fail(ed|ure)?|fatal)\b/i.test(line) ? "is-error" : /\bwarn(ing)?\b/i.test(line) ? "is-warn" : undefined}>{line}{"\n"}</span>)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {dispatchOpen && caps && (
        <DispatchDialog
          system={caps.system}
          workflows={workflows}
          defaultRef={currentBranch ?? ""}
          onClose={() => setDispatchOpen(false)}
          onRun={async (workflowId, ref, inputs) => {
            const using = await writeTarget();
            if (!using) return false;
            try {
              pushToast(await api.ciDispatch(repositoryPath, using, workflowId, ref, inputs), "success");
              window.setTimeout(() => void loadRuns(true), 2500);
              return true;
            } catch (reason) {
              pushToast(errorText(reason), "error", 9000);
              return false;
            }
          }}
        />
      )}
    </section>
  );
}

function DispatchDialog({ system, workflows, defaultRef, onClose, onRun }: { system: string; workflows: CiWorkflow[] | null; defaultRef: string; onClose: () => void; onRun: (workflowId: string, ref: string, inputs: Record<string, string>) => Promise<boolean> }) {
  const runnable = useMemo(() => (workflows ?? []).filter((workflow) => workflow.dispatchable && workflow.active), [workflows]);
  const [workflowId, setWorkflowId] = useState("");
  const [ref, setRef] = useState(defaultRef);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const workflow = runnable.find((entry) => entry.id === workflowId) ?? runnable[0] ?? null;
  useEffect(() => { if (!workflowId && runnable[0]) setWorkflowId(runnable[0].id); }, [runnable, workflowId]);
  useEffect(() => { setValues(Object.fromEntries((workflow?.inputs ?? []).map((input) => [input.name, input.default]))); }, [workflow?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = (workflow?.inputs ?? []).filter((input) => input.required && !values[input.name]?.trim());

  const submit = async () => {
    if (!workflow || missing.length || !ref.trim()) return;
    setRunning(true);
    const started = await onRun(workflow.id, ref.trim(), values);
    setRunning(false);
    if (started) onClose();
  };

  return (
    <Modal title={`Run in ${system}`} icon="activity" onClose={onClose} footer={<>
      <span className="tg-spacer" />
      <button type="button" className="ux-button" onClick={onClose}>Cancel</button>
      <button type="button" className="ux-primary-button" disabled={running || !workflow || !ref.trim() || missing.length > 0} onClick={() => void submit()}>{running ? "Starting…" : "Run"}</button>
    </>}>
      <form className="ci-dispatch" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {!workflows && <div className="ux-empty-state compact"><i className="ux-spinner" />Reading workflows…</div>}
        {workflows && !runnable.length && <p className="fk-note">No workflow can be started by hand. GitHub and Gitea workflows need <code>on: workflow_dispatch</code>.</p>}
        {runnable.length > 0 && (
          <>
            <label>Workflow
              <select value={workflow?.id ?? ""} onChange={(event) => setWorkflowId(event.target.value)}>
                {runnable.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.path ? ` (${entry.path})` : ""}</option>)}
              </select>
            </label>
            <label>Branch or tag<input value={ref} onChange={(event) => setRef(event.target.value)} required /></label>
            {(workflow?.inputs ?? []).map((input) => (
              <label key={input.name} className={input.type === "boolean" ? "st-check" : undefined} title={input.description}>
                {input.type === "boolean"
                  ? <><input type="checkbox" checked={values[input.name] === "true"} onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.checked ? "true" : "false" }))} />{input.description || input.name}</>
                  : <>
                      <span>{input.description || input.name}{input.required ? " *" : ""}{input.description ? <small> ({input.name})</small> : null}</span>
                      {input.options.length
                        ? <select value={values[input.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))}>{(input.required ? [] : [""]).concat(input.options).map((option) => <option key={option} value={option}>{option || "—"}</option>)}</select>
                        : <input type={input.type === "number" ? "number" : "text"} value={values[input.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))} />}
                    </>}
              </label>
            ))}
            <button type="submit" hidden />
          </>
        )}
      </form>
    </Modal>
  );
}
