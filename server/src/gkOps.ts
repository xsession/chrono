// GitKraken-parity operations: Undo/Redo journal, Pull/Push modes, amend,
// discard, branch/remote/tag actions and stash details.
//
// Undo/Redo works like GitKraken's: every mutating action performed through
// Chrono snapshots `refs/heads/*` + HEAD before and after. Undo restores the
// "before" snapshot (recreating deleted branches, removing created ones,
// switching back and resetting the moved branch), Redo re-applies "after".
// Commits are undone with a soft reset (changes stay staged); everything
// else uses `reset --keep`, which refuses to throw away local edits.

import fs from "node:fs/promises";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import { workspacesFile } from "./workspaces.ts";
import { commitSubmodules } from "./nestedCommit.ts";
import { finishStream, runGitStreaming } from "./lib/streams.ts";

/** Run with live output when a stream id is supplied; throws like `checked`. */
async function streamed(root: string, args: string[], streamId: string | null | undefined): Promise<CommandResult> {
  if (!streamId) return checked(root, args);
  const out = await runGitStreaming(root, args, streamId);
  finishStream(streamId, out.code);
  if (out.code !== 0) throw new AppError("command", `git ${args.join(" ")}: ${out.stderr.replace(/\s+/g, " ").trim() || `exit code ${out.code}`}`);
  return { stdout: out.stdout, stderr: out.stderr, exitCode: 0 };
}
import {
  parseNumstat,
  checked,
  checkedStdout,
  hasHead,
  repositoryRoot,
  runGit,
  type CommandResult, HISTORY_ALL_REFS } from "./lib/git.ts";

// ---------------------------------------------------------------------------
// Ref snapshots + journal
// ---------------------------------------------------------------------------

interface RefSnapshot {
  heads: Record<string, string>;
  headRef: string | null; // "refs/heads/x" or null when detached
  headSha: string | null;
}

export interface JournalEntry {
  id: number;
  label: string;
  at: string;
  mode: "soft" | "keep";
  before: RefSnapshot;
  after: RefSnapshot;
}

interface Journal {
  undo: JournalEntry[];
  redo: JournalEntry[];
}

const journals = new Map<string, Journal>();
let nextEntryId = 1;
const MAX_JOURNAL = 50;
let loaded: Promise<void> | null = null;
let saveChain: Promise<void> = Promise.resolve();

// The journal survives server restarts: it lives next to workspaces.json.
function journalFile(): string {
  return path.join(path.dirname(workspacesFile()), "undo-journal.json");
}

function ensureLoaded(): Promise<void> {
  loaded ??= (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(journalFile(), "utf8")) as Record<string, Journal>;
      for (const [root, journal] of Object.entries(parsed)) {
        if (!journal || !Array.isArray(journal.undo) || !Array.isArray(journal.redo)) continue;
        journals.set(root, { undo: journal.undo, redo: journal.redo });
        for (const entry of [...journal.undo, ...journal.redo]) nextEntryId = Math.max(nextEntryId, (entry.id ?? 0) + 1);
      }
    } catch {
      // missing or unreadable journal: start empty
    }
  })();
  return loaded;
}

function persist(): Promise<void> {
  saveChain = saveChain.then(async () => {
    const file = journalFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(journals)));
    await fs.rename(temporary, file);
  }).catch(() => undefined);
  return saveChain;
}

async function journalFor(root: string): Promise<Journal> {
  await ensureLoaded();
  let journal = journals.get(root);
  if (!journal) { journal = { undo: [], redo: [] }; journals.set(root, journal); }
  return journal;
}

async function snapshot(root: string): Promise<RefSnapshot> {
  const [refs, symbolic, head] = await Promise.all([
    runGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]),
    runGit(root, ["symbolic-ref", "-q", "HEAD"]),
    runGit(root, ["rev-parse", "-q", "--verify", "HEAD"]),
  ]);
  const heads: Record<string, string> = {};
  for (const line of refs.stdout.split(/\r?\n/)) {
    const [name, sha] = line.split("\0");
    if (name && sha) heads[name] = sha;
  }
  return {
    heads,
    headRef: symbolic.code === 0 ? symbolic.stdout.trim() : null,
    headSha: head.code === 0 ? head.stdout.trim() : null,
  };
}

function sameSnapshot(a: RefSnapshot, b: RefSnapshot): boolean {
  if (a.headRef !== b.headRef || a.headSha !== b.headSha) return false;
  const keys = new Set([...Object.keys(a.heads), ...Object.keys(b.heads)]);
  for (const key of keys) if (a.heads[key] !== b.heads[key]) return false;
  return true;
}

/** Run a mutating operation and journal its ref effect for Undo/Redo. */
export async function journaled<T>(inputPath: string, label: string, mode: "soft" | "keep", run: () => Promise<T>): Promise<T> {
  let root: string;
  try { root = await repositoryRoot(inputPath); } catch { return run(); }
  const before = await snapshot(root);
  const result = await run();
  try {
    const after = await snapshot(root);
    if (!sameSnapshot(before, after)) {
      const journal = await journalFor(root);
      journal.undo.push({ id: nextEntryId++, label, at: new Date().toISOString(), mode, before, after });
      if (journal.undo.length > MAX_JOURNAL) journal.undo.shift();
      journal.redo = [];
      await persist();
    }
  } catch {
    // journaling is best-effort; never fail the operation itself
  }
  return result;
}

const short = (ref: string) => ref.replace(/^refs\/heads\//, "");

async function applySnapshot(root: string, from: RefSnapshot, to: RefSnapshot, mode: "soft" | "keep"): Promise<string[]> {
  const steps: string[] = [];
  const current = await snapshot(root);
  if (!sameSnapshot(current, from)) {
    throw new AppError("invalid", "the repository changed outside Chrono since this action — undo/redo is no longer safe");
  }
  // 1. Recreate branches that exist in the target but not now (except HEAD's, handled below).
  for (const [ref, sha] of Object.entries(to.heads)) {
    if (!(ref in from.heads)) {
      await checked(root, ["update-ref", ref, sha, ""]);
      steps.push(`restored ${short(ref)}`);
    }
  }
  // 2. Move HEAD: switch branch / reset the checked-out branch.
  if (to.headRef !== from.headRef) {
    if (to.headRef) await checked(root, ["switch", short(to.headRef)]);
    else if (to.headSha) await checked(root, ["switch", "--detach", to.headSha]);
    steps.push(`checked out ${to.headRef ? short(to.headRef) : to.headSha?.slice(0, 8)}`);
  }
  const headNow = to.headRef;
  const targetSha = headNow ? to.heads[headNow] : to.headSha;
  const shaNow = (await runGit(root, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
  if (targetSha && shaNow && shaNow !== targetSha) {
    await checked(root, ["reset", mode === "soft" ? "--soft" : "--keep", targetSha]);
    steps.push(`reset ${headNow ? short(headNow) : "HEAD"} to ${targetSha.slice(0, 8)}`);
  }
  // 3. Remove branches created by the action, move other branches back.
  for (const [ref, sha] of Object.entries(from.heads)) {
    if (!(ref in to.heads)) {
      await checked(root, ["update-ref", "-d", ref, sha]);
      steps.push(`removed ${short(ref)}`);
    } else if (to.heads[ref] !== sha && ref !== headNow) {
      await checked(root, ["update-ref", ref, to.heads[ref], sha]);
      steps.push(`moved ${short(ref)} to ${to.heads[ref].slice(0, 8)}`);
    }
  }
  return steps;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  history: Array<{ id: number; label: string; at: string }>;
}

export async function undoState(inputPath: string): Promise<UndoState> {
  const root = await repositoryRoot(inputPath);
  const journal = await journalFor(root);
  const top = journal.undo[journal.undo.length - 1];
  const redoTop = journal.redo[journal.redo.length - 1];
  return {
    canUndo: Boolean(top),
    canRedo: Boolean(redoTop),
    undoLabel: top?.label ?? null,
    redoLabel: redoTop?.label ?? null,
    history: journal.undo.slice().reverse().map(({ id, label, at }) => ({ id, label, at })),
  };
}

export async function undo(inputPath: string): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const journal = await journalFor(root);
  const entry = journal.undo[journal.undo.length - 1];
  if (!entry) throw invalidError("nothing to undo");
  const steps = await applySnapshot(root, entry.after, entry.before, entry.mode);
  journal.undo.pop();
  journal.redo.push(entry);
  await persist();
  return `Undid “${entry.label}”${steps.length ? `: ${steps.join(", ")}` : ""}`;
}

export async function redo(inputPath: string): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const journal = await journalFor(root);
  const entry = journal.redo[journal.redo.length - 1];
  if (!entry) throw invalidError("nothing to redo");
  const steps = await applySnapshot(root, entry.before, entry.after, entry.mode);
  journal.redo.pop();
  journal.undo.push(entry);
  await persist();
  return `Redid “${entry.label}”${steps.length ? `: ${steps.join(", ")}` : ""}`;
}

// ---------------------------------------------------------------------------
// Pull / Push modes (GitKraken toolbar dropdowns)
// ---------------------------------------------------------------------------

export type PullMode = "fetch" | "ff" | "ff-only" | "rebase";

/** Runs git commands one after another on one live-output stream, which is
 *  finished once, after the last step or the first failure. */
async function streamedSteps(root: string, steps: string[][], streamId: string | null | undefined): Promise<CommandResult> {
  if (!streamId) {
    let stdout = "";
    let stderr = "";
    for (const args of steps) { const result = await checked(root, args); stdout += result.stdout; stderr += result.stderr; }
    return { stdout, stderr, exitCode: 0 };
  }
  let stdout = "";
  let stderr = "";
  for (const args of steps) {
    const out = await runGitStreaming(root, args, streamId);
    stdout += out.stdout;
    stderr += out.stderr;
    if (out.code !== 0) {
      finishStream(streamId, out.code);
      throw new AppError("command", `git ${args.join(" ")}: ${out.stderr.replace(/\s+/g, " ").trim() || `exit code ${out.code}`}`);
    }
  }
  finishStream(streamId, 0);
  return { stdout, stderr, exitCode: 0 };
}

/** Pull (or fetch). With `recurseSubmodules`, submodules are fetched too and,
 *  after the merge, every submodule is initialized and checked out at the
 *  commit the superproject now records, all the way down. */
export async function pull(inputPath: string, mode: PullMode, streamId: string | null = null, recurseSubmodules = false): Promise<CommandResult> {
  const progress = streamId ? ["--progress"] : [];
  const recurse = recurseSubmodules ? ["--recurse-submodules"] : [];
  const update = ["submodule", "update", "--init", "--recursive", ...progress];
  let args: string[];
  switch (mode) {
    case "fetch": args = ["fetch", "--all", "--prune", "--tags", ...(recurseSubmodules ? ["--recurse-submodules=yes"] : []), ...progress]; break;
    case "ff": args = ["pull", "--no-rebase", "--ff", ...recurse, ...progress]; break;
    case "ff-only": args = ["pull", "--ff-only", ...recurse, ...progress]; break;
    case "rebase": args = ["pull", "--rebase", "--autostash", ...recurse, ...progress]; break;
    default: throw invalidError("pull mode must be fetch, ff, ff-only or rebase");
  }
  if (!recurseSubmodules || mode === "fetch") return streamed(inputPath, args, streamId);
  return streamedSteps(inputPath, [args, update], streamId);
}

/** Initializes and updates every submodule recursively (`git submodule update
 *  --init --recursive`), or moves each to its tracked branch tip with `remote`. */
export async function updateSubmodules(inputPath: string, options: { remote?: boolean; streamId?: string | null } = {}): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const progress = options.streamId ? ["--progress"] : [];
  return streamedSteps(root, [
    ["submodule", "sync", "--recursive"],
    ["submodule", "update", "--init", "--recursive", ...(options.remote ? ["--remote"] : []), ...progress],
  ], options.streamId);
}

export interface PushOptions {
  remote?: string | null;
  branch?: string | null;
  force?: boolean;
  setUpstream?: boolean;
  tags?: boolean;
  /** Push commits of submodules the pushed commits point to first (on-demand). */
  recurseSubmodules?: boolean;
  streamId?: string | null;
}

function safeName(value: string, what: string): string {
  const name = value.trim();
  if (!name || name.startsWith("-") || name.includes("\0") || /\s/.test(name) || name.includes("..")) throw invalidError(`invalid ${what}`);
  return name;
}

export async function push(inputPath: string, options: PushOptions): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const branch = options.branch ? safeName(options.branch, "branch") : (await checkedStdout(root, ["branch", "--show-current"])).trim();
  if (!branch) throw invalidError("HEAD is detached — choose a branch to push");
  let remote = options.remote ? safeName(options.remote, "remote") : "";
  const upstream = await runGit(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  const hasUpstream = upstream.code === 0;
  if (!remote) {
    if (hasUpstream) remote = upstream.stdout.trim().split("/")[0];
    else {
      const remotes = (await checkedStdout(root, ["remote"])).split(/\r?\n/).filter(Boolean);
      if (!remotes.length) throw invalidError("this repository has no remotes — add one first");
      remote = remotes.includes("origin") ? "origin" : remotes[0];
    }
  }
  const args = ["push"];
  if (options.force) args.push("--force-with-lease");
  if (options.setUpstream || !hasUpstream) args.push("--set-upstream");
  if (options.tags) args.push("--follow-tags");
  if (options.recurseSubmodules) args.push("--recurse-submodules=on-demand");
  if (options.streamId) args.push("--progress");
  args.push(remote, `refs/heads/${branch}:refs/heads/${hasUpstream && !options.remote ? upstream.stdout.trim().slice(remote.length + 1) : branch}`);
  return streamed(root, args, options.streamId);
}

// ---------------------------------------------------------------------------
// Commit (amend / sign-off) and WIP helpers
// ---------------------------------------------------------------------------

export interface CommitOptions {
  message: string;
  amend?: boolean;
  signoff?: boolean;
  allowEmpty?: boolean;
  noVerify?: boolean;
}

export async function commit(inputPath: string, options: CommitOptions): Promise<string> {
  const message = options.message.trim();
  if (!message && !options.amend) throw invalidError("commit message is empty");
  const args = ["commit"];
  if (options.amend) args.push("--amend");
  if (options.signoff) args.push("--signoff");
  if (options.allowEmpty) args.push("--allow-empty");
  if (options.noVerify) args.push("--no-verify");
  if (message) args.push("-m", message); else args.push("--no-edit");
  // Submodules with staged changes are committed first (nestedCommit.ts).
  const root = await repositoryRoot(inputPath);
  await commitSubmodules(root, { message: message || (await checkedStdout(root, ["log", "-1", "--format=%B"])).trim(), signoff: options.signoff, noVerify: options.noVerify });
  await checked(inputPath, args);
  return (await checkedStdout(inputPath, ["rev-parse", "HEAD"])).trim();
}

export async function lastCommitMessage(inputPath: string): Promise<string> {
  const root = await repositoryRoot(inputPath);
  if (!(await hasHead(root))) return "";
  return (await checkedStdout(root, ["log", "-1", "--format=%B"])).replace(/\s+$/, "");
}

/** Discard working-tree changes (GitKraken "Discard changes"): tracked files
 *  are restored from HEAD, untracked files are removed. */
export async function discard(inputPath: string, files: string[] | null): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const headExists = await hasHead(root);
  if (files === null) {
    const results: CommandResult[] = [];
    if (headExists) results.push(await checked(root, ["reset", "--hard", "HEAD"]));
    results.push(await checked(root, ["clean", "-fd"]));
    return { stdout: results.map((r) => r.stdout).join("\n"), stderr: "", exitCode: 0 };
  }
  if (!files.length) throw invalidError("no files to discard");
  for (const file of files) if (!file || file.startsWith("-") || file.includes("\0") || /(^|\/)\.\.(\/|$)/.test(file)) throw invalidError("invalid path");
  const status = await checkedStdout(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files.map((file) => `:(literal)${file}`)]);
  const untracked: string[] = [];
  const added: string[] = [];
  const tracked: string[] = [];
  const entries = status.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const file = entry.slice(3);
    if (entry.startsWith("??")) untracked.push(file);
    else if (entry[0] === "A") added.push(file);
    else tracked.push(file);
    if (entry[0] === "R" || entry[0] === "C") { tracked.push(entries[i + 1]); i += 1; }
  }
  const out: string[] = [];
  if (tracked.length && headExists) out.push((await checked(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked.map((f) => `:(literal)${f}`)])).stdout);
  if (added.length) out.push((await checked(root, ["rm", "-f", "--quiet", "--", ...added.map((f) => `:(literal)${f}`)])).stdout);
  if (untracked.length) out.push((await checked(root, ["clean", "-f", "--", ...untracked.map((f) => `:(literal)${f}`)])).stdout);
  return { stdout: out.join("\n"), stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Branch / tag / remote actions (left-panel context menus + drag & drop)
// ---------------------------------------------------------------------------

export type BranchAction =
  | "rename"
  | "set_upstream"
  | "unset_upstream"
  | "push"
  | "delete_remote"
  | "merge_into_current"
  | "rebase_current_onto"
  | "fast_forward"
  | "force_to_commit"
  | "checkout_and_merge"
  | "pull_branch";

export interface BranchActionRequest {
  action: BranchAction;
  branch: string;
  target?: string | null;
  newName?: string | null;
  remote?: string | null;
}

export async function branchAction(inputPath: string, request: BranchActionRequest): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const branch = safeName(request.branch, "branch");
  const target = request.target ? safeName(request.target, "target") : "";
  const current = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  switch (request.action) {
    case "rename": {
      const name = safeName(request.newName ?? "", "new branch name");
      return checked(root, ["branch", "-m", branch, name]);
    }
    case "set_upstream":
      if (!target) throw invalidError("choose an upstream branch");
      return checked(root, ["branch", `--set-upstream-to=${target}`, branch]);
    case "unset_upstream":
      return checked(root, ["branch", "--unset-upstream", branch]);
    case "push":
      return push(root, { branch, remote: request.remote ?? null, setUpstream: true });
    case "delete_remote": {
      // branch arrives as "origin/feature"
      const slash = branch.indexOf("/");
      if (slash <= 0) throw invalidError("remote branch must look like remote/name");
      return checked(root, ["push", branch.slice(0, slash), "--delete", branch.slice(slash + 1)]);
    }
    case "merge_into_current":
      if (branch === current) throw invalidError("cannot merge a branch into itself");
      return checked(root, ["merge", "--no-edit", branch]);
    case "rebase_current_onto":
      if (branch === current) throw invalidError("cannot rebase a branch onto itself");
      return checked(root, ["rebase", branch]);
    case "fast_forward": {
      // Fast-forward `branch` to `target` (default: its upstream) without checkout.
      const to = target || (await checkedStdout(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`])).trim();
      const base = await runGit(root, ["merge-base", "--is-ancestor", branch, to]);
      if (base.code !== 0) throw invalidError(`${branch} cannot be fast-forwarded to ${to}`);
      if (branch === current) return checked(root, ["merge", "--ff-only", to]);
      const sha = (await checkedStdout(root, ["rev-parse", to])).trim();
      return checked(root, ["update-ref", `refs/heads/${branch}`, sha]);
    }
    case "force_to_commit":
      if (!target) throw invalidError("choose a commit");
      if (branch === current) return checked(root, ["reset", "--keep", target]);
      return checked(root, ["branch", "-f", branch, target]);
    case "checkout_and_merge": {
      // drag `branch` onto `target`: checkout target, merge branch.
      if (!target) throw invalidError("choose the branch to merge into");
      await checked(root, ["switch", target]);
      return checked(root, ["merge", "--no-edit", branch]);
    }
    case "pull_branch":
      if (branch !== current) return branchAction(root, { action: "fast_forward", branch });
      return checked(root, ["pull", "--ff-only"]);
    default:
      throw invalidError(`unknown branch action: ${String(request.action)}`);
  }
}

export type TagAction = "push" | "delete_remote" | "push_all" | "force_push" | "force_push_all" | "fetch_force";

/**
 * Tag pushes and fetches.
 * - force_push replaces the tag on the remote. With `expect` (the object id
 *   the remote had when the user confirmed) it uses --force-with-lease, so a
 *   tag someone moved in the meantime is not overwritten; an empty `expect`
 *   means the remote must not have the tag yet.
 * - force_push_all pushes every local tag, replacing remote tags that differ.
 * - fetch_force fetches tags and moves local tags the remote has changed
 *   (plain fetch refuses with "would clobber existing tag").
 */
export async function tagAction(inputPath: string, action: TagAction, name: string, remote: string | null, options: { expect?: string | null } = {}): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const target = remote ? safeName(remote, "remote") : "origin";
  if (action === "push_all") return checked(root, ["push", target, "--tags"]);
  if (action === "force_push_all") return checked(root, ["push", "--force", target, "--tags"]);
  if (action === "fetch_force") return checked(root, ["fetch", target, "--tags", "--force"]);
  const tag = safeName(name, "tag");
  const ref = `refs/tags/${tag}`;
  if (action === "push") return checked(root, ["push", target, ref]);
  if (action === "delete_remote") return checked(root, ["push", target, "--delete", ref]);
  if (action === "force_push") {
    const expect = options.expect;
    if (expect === undefined || expect === null) return checked(root, ["push", target, `+${ref}:${ref}`]);
    if (expect !== "" && !/^[0-9a-f]{40,64}$/.test(expect)) throw invalidError("invalid expected object id");
    return checked(root, ["push", `--force-with-lease=${ref}:${expect}`, target, `${ref}:${ref}`]);
  }
  throw invalidError("unknown tag action");
}

export interface TagRemoteState {
  remote: string;
  /** Object id of the tag ref on the remote (the tag object for annotated tags), null when absent. */
  remoteId: string | null;
  /** Commit the remote tag points to. */
  remoteCommit: string | null;
  localId: string | null;
  localCommit: string | null;
}

/** The tag on the remote next to the local one, to show before a force push. */
export async function tagRemoteState(inputPath: string, name: string, remote: string | null): Promise<TagRemoteState> {
  const root = await repositoryRoot(inputPath);
  const target = remote ? safeName(remote, "remote") : "origin";
  const tag = safeName(name, "tag");
  const ref = `refs/tags/${tag}`;
  const [listed, localId, localCommit] = await Promise.all([
    checkedStdout(root, ["ls-remote", target, ref, `${ref}^{}`]),
    runGit(root, ["rev-parse", "-q", "--verify", ref]),
    runGit(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]),
  ]);
  let remoteId: string | null = null;
  let peeled: string | null = null;
  for (const line of listed.split("\n")) {
    const [id, refName] = line.trim().split(/\s+/);
    if (refName === ref) remoteId = id;
    if (refName === `${ref}^{}`) peeled = id;
  }
  return {
    remote: target,
    remoteId,
    remoteCommit: peeled ?? remoteId,
    localId: localId.code === 0 ? localId.stdout.trim() : null,
    localCommit: localCommit.code === 0 ? localCommit.stdout.trim() : null,
  };
}

export type RemoteAction = "add" | "remove" | "rename" | "set_url" | "prune" | "fetch";

export async function remoteAction(inputPath: string, action: RemoteAction, name: string, value: string | null): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const remote = safeName(name, "remote name");
  switch (action) {
    case "add":
      if (!value?.trim() || value.trim().startsWith("-")) throw invalidError("remote URL is required");
      return checked(root, ["remote", "add", remote, value.trim()]);
    case "remove": return checked(root, ["remote", "remove", remote]);
    case "rename": return checked(root, ["remote", "rename", remote, safeName(value ?? "", "new remote name")]);
    case "set_url":
      if (!value?.trim() || value.trim().startsWith("-")) throw invalidError("remote URL is required");
      return checked(root, ["remote", "set-url", remote, value.trim()]);
    case "prune": return checked(root, ["remote", "prune", remote]);
    case "fetch": return checked(root, ["fetch", "--prune", remote]);
    default: throw invalidError("unknown remote action");
  }
}

// ---------------------------------------------------------------------------
// Stash details (files of a stash for the right panel)
// ---------------------------------------------------------------------------

export interface StashFile { path: string; additions: number | null; deletions: number | null; untracked: boolean }

export async function stashFiles(inputPath: string, ref: string): Promise<StashFile[]> {
  if (!/^stash@\{\d+\}$/.test(ref)) throw invalidError("invalid stash ref");
  const tracked = await checkedStdout(inputPath, ["stash", "show", "--numstat", ref]);
  const files: StashFile[] = tracked.split(/\r?\n/).filter(Boolean).map((line) => {
    const [add, del, ...rest] = line.split("\t");
    const binary = add === "-";
    return { path: rest.join("\t"), additions: binary ? null : Number(add), deletions: binary ? null : Number(del), untracked: false };
  });
  const untracked = await runGit(inputPath, ["ls-tree", "-r", "--name-only", `${ref}^3`]);
  if (untracked.code === 0) for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean)) files.push({ path: file, additions: null, deletions: null, untracked: true });
  return files;
}

// ---------------------------------------------------------------------------
// Two-commit comparison (GitKraken: Ctrl+click two commits)
// ---------------------------------------------------------------------------

export interface ComparedFile { path: string; additions: number | null; deletions: number | null; binary: boolean }

export async function diffCommitFiles(inputPath: string, from: string, to: string): Promise<ComparedFile[]> {
  for (const rev of [from, to]) if (!rev.trim() || rev.startsWith("-") || rev.includes("\0")) throw invalidError("invalid revision");
  const output = await checkedStdout(inputPath, ["diff", "--numstat", "--no-renames", from.trim(), to.trim()]);
  return parseNumstat(output);
}

// ---------------------------------------------------------------------------
// Position of a commit in the all-refs date-ordered history (the same order
// as repository_history_page), so the UI can jump to commits outside the
// currently loaded history window.
// ---------------------------------------------------------------------------

export async function commitOffset(inputPath: string, revision: string): Promise<number | null> {
  const rev = revision.trim();
  if (!rev || rev.startsWith("-") || rev.includes("\0")) throw invalidError("invalid revision");
  const sha = (await checkedStdout(inputPath, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
  const list = await checkedStdout(inputPath, ["rev-list", ...HISTORY_ALL_REFS, "--date-order"]);
  const index = list.split("\n").indexOf(sha);
  return index >= 0 ? index : null;
}
