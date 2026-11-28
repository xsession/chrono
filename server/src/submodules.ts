// Recursive submodule overview ("project map") for superprojects with deep
// submodule hierarchies (e.g. Renode: 15+ submodules, 3–4 levels deep).
//
// One `git submodule status --recursive` lists every node; each initialized
// submodule then gets one `status --porcelain=v2 --branch` (in a bounded
// pool) for branch / upstream / dirty counts. Nested submodules are reported
// as their own nodes, so a parent's change count ignores dirty children
// (`--ignore-submodules=dirty`) but still counts a moved gitlink.

import path from "node:path";
import { AppError } from "./lib/errors.ts";
import { checkedStdout, repositoryRoot, runGit } from "./lib/git.ts";
import { gitProcessEnv } from "./lib/gitCredentials.ts";

export type SubmoduleState = "ok" | "drift" | "uninitialized" | "conflict";

export interface SubmoduleNode {
  /** Path relative to the superproject root that was asked for. */
  path: string;
  /** Last path segment, for compact display. */
  name: string;
  /** Path of the nearest enclosing submodule, or null for top-level ones. */
  parent: string | null;
  depth: number;
  state: SubmoduleState;
  /** Commit checked out in the submodule (or recorded commit if uninitialized). */
  commit: string;
  /** Commit the parent repository records, when it differs from `commit`. */
  recorded: string | null;
  /** How far the checkout is from the recorded commit (ahead = new commits in the submodule). */
  drift: { ahead: number; behind: number } | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Tracked files changed in this submodule (staged or not), excluding nested submodule contents. */
  changes: number;
  untracked: number;
  conflicts: number;
  url: string | null;
  /** Number of direct child submodules. */
  children: number;
  /** Descendant nodes that need attention (dirty, drifted, uninitialized, conflicted). */
  attentionBelow: number;
  /** Branch the submodule follows (.gitmodules `branch`, else origin's default) and
   *  how many commits the checked-out commit is behind its last-fetched tip. */
  tracking: { branch: string; behind: number } | null;
}

export interface SubmoduleTree {
  root: string;
  nodes: SubmoduleNode[];
  maxDepth: number;
  totals: { all: number; dirty: number; drift: number; uninitialized: number; conflict: number; detached: number; outdated: number };
  /** Superprojects enclosing `root`, outermost first (for breadcrumbs). */
  superprojects: Array<{ path: string; name: string }>;
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Parses one line of `git submodule status` output. */
export function parseSubmoduleStatusLine(line: string): { status: string; commit: string; path: string; describe: string } | null {
  if (!line.trim()) return null;
  const status = line.slice(0, 1);
  const rest = line.slice(1);
  const match = /^([0-9a-f]{40,64}) (.+?)(?: \((.*)\))?$/.exec(rest);
  if (!match) return null;
  return { status, commit: match[1], path: match[2], describe: match[3] ?? "" };
}

/** Parses `git status --porcelain=v2 --branch` output into counters. */
export function parsePorcelainV2(text: string) {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice(14).trim();
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) changes += 1;
    else if (line.startsWith("u ")) conflicts += 1;
    else if (line.startsWith("? ")) untracked += 1;
  }
  return { branch, upstream, ahead, behind, changes, untracked, conflicts };
}

/** Walks `--show-superproject-working-tree` upwards, outermost first. */
export async function superprojectChain(root: string): Promise<Array<{ path: string; name: string }>> {
  const chain: Array<{ path: string; name: string }> = [];
  let current = root;
  for (let guard = 0; guard < 16; guard += 1) {
    const output = await runGit(current, ["rev-parse", "--show-superproject-working-tree"]);
    const parent = output.code === 0 ? output.stdout.trim() : "";
    if (!parent || parent === current) break;
    chain.unshift({ path: parent, name: path.basename(parent) });
    current = parent;
  }
  return chain;
}

interface Gitlink { path: string; recorded: string; stage: number; parent: string | null; depth: number }

/** Gitlinks of one repository (mode 160000 index entries), relative to it. */
async function gitlinksOf(repo: string): Promise<Array<{ path: string; sha: string; stage: number }>> {
  const output = await runGit(repo, ["ls-files", "--stage", "-z"]);
  if (output.code !== 0) return [];
  const result: Array<{ path: string; sha: string; stage: number }> = [];
  for (const record of output.stdout.split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const match = /^160000 ([0-9a-f]+) (\d)\t(.+)$/s.exec(record);
    if (match) result.push({ sha: match[1], stage: Number(match[2]), path: match[3] });
  }
  return result;
}

/** True when `dir` is itself the top of a checked-out repository (an
 *  uninitialized submodule is an empty folder inside the parent's work tree,
 *  where `git -C dir` would silently answer for the parent). */
async function checkedOutHead(dir: string): Promise<string | null> {
  const output = await runGit(dir, ["rev-parse", "--show-toplevel", "HEAD"]);
  if (output.code !== 0) return null;
  const [top, head] = output.stdout.trim().split("\n");
  return top && path.resolve(top) === path.resolve(dir) ? head?.trim() ?? null : null;
}

/** Walks gitlinks recursively (parallel per level) without the
 *  per-submodule dirty scan `git submodule status --recursive` performs. */
async function walkGitlinks(root: string): Promise<Array<Gitlink & { head: string | null }>> {
  const all: Array<Gitlink & { head: string | null }> = [];
  const visit = async (repoRelative: string | null, depth: number): Promise<void> => {
    if (depth > 32) return;
    const repoAbsolute = repoRelative ? path.join(root, repoRelative) : root;
    const links = await gitlinksOf(repoAbsolute);
    // Conflicted gitlinks appear once per stage; keep the "ours" (2) entry.
    const unique = new Map<string, { path: string; sha: string; stage: number }>();
    for (const link of links) {
      const existing = unique.get(link.path);
      if (!existing || link.stage === 2) unique.set(link.path, { ...link, stage: existing ? Math.max(existing.stage, link.stage) : link.stage });
    }
    await pool([...unique.values()], 8, async (link) => {
      const relative = repoRelative ? `${repoRelative}/${link.path}` : link.path;
      const head = await checkedOutHead(path.join(root, relative));
      all.push({ path: relative, recorded: link.sha, stage: link.stage, parent: repoRelative, depth, head });
      if (head) await visit(relative, depth + 1);
    });
  };
  await visit(null, 0);
  return all.sort((a, b) => a.path.localeCompare(b.path));
}

export async function submoduleTree(inputPath: string): Promise<SubmoduleTree> {
  const root = await repositoryRoot(inputPath);
  const [links, superprojects] = await Promise.all([walkGitlinks(root), superprojectChain(root)]);

  const modulesCache = new Map<string, Promise<ModulesFile>>();
  const modulesOf = (repo: string) => { let cached = modulesCache.get(repo); if (!cached) { cached = readModulesFile(repo); modulesCache.set(repo, cached); } return cached; };
  const nodes = await pool(links, 8, async (link): Promise<SubmoduleNode> => {
    const absolute = path.join(root, link.path);
    const state: SubmoduleState = link.stage !== 0 ? "conflict" : !link.head ? "uninitialized" : link.head !== link.recorded ? "drift" : "ok";
    const node: SubmoduleNode = {
      path: link.path,
      name: link.path.split("/").pop() ?? link.path,
      parent: link.parent,
      depth: link.depth,
      state,
      commit: link.head ?? link.recorded,
      recorded: null,
      drift: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: 0,
      untracked: 0,
      conflicts: 0,
      url: null,
      children: 0,
      attentionBelow: 0,
      tracking: null,
    };
    const parentAbsolute = link.parent ? path.join(root, link.parent) : root;
    const relativeToParent = link.parent ? link.path.slice(link.parent.length + 1) : link.path;
    const modules = await modulesOf(parentAbsolute);
    if (!link.head) {
      node.url = modules.get(relativeToParent)?.url ?? null;
      return node;
    }
    const [status, url] = await Promise.all([
      runGit(absolute, ["status", "--porcelain=v2", "--branch", "--ignore-submodules=dirty"]),
      runGit(absolute, ["config", "--get", "remote.origin.url"]),
    ]);
    if (status.code === 0) Object.assign(node, parsePorcelainV2(status.stdout));
    const wanted = await trackingBranch(modules, relativeToParent, absolute);
    if (wanted) {
      const behind = await runGit(absolute, ["rev-list", "--count", `HEAD..refs/remotes/origin/${wanted}`]);
      if (behind.code === 0) node.tracking = { branch: wanted, behind: Number(behind.stdout.trim()) || 0 };
    }
    node.url = url.code === 0 ? url.stdout.trim() || null : null;
    if (state === "drift") {
      node.recorded = link.recorded;
      const counts = await runGit(absolute, ["rev-list", "--left-right", "--count", `${link.recorded}...${link.head}`]);
      const match = /^(\d+)\s+(\d+)/.exec(counts.stdout.trim());
      if (counts.code === 0 && match) node.drift = { behind: Number(match[1]), ahead: Number(match[2]) };
    }
    return node;
  });

  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const needsAttention = (node: SubmoduleNode) => node.state !== "ok" || node.changes > 0 || node.untracked > 0 || node.conflicts > 0;
  for (const node of nodes) {
    if (node.parent) byPath.get(node.parent)!.children += 1;
    if (needsAttention(node)) {
      for (let cursor = node.parent; cursor; cursor = byPath.get(cursor)?.parent ?? null) byPath.get(cursor)!.attentionBelow += 1;
    }
  }

  return {
    root,
    nodes,
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth + 1), 0),
    totals: {
      all: nodes.length,
      dirty: nodes.filter((node) => node.changes > 0 || node.untracked > 0).length,
      drift: nodes.filter((node) => node.state === "drift").length,
      uninitialized: nodes.filter((node) => node.state === "uninitialized").length,
      conflict: nodes.filter((node) => node.state === "conflict" || node.conflicts > 0).length,
      detached: nodes.filter((node) => node.state !== "uninitialized" && !node.branch).length,
      outdated: nodes.filter((node) => (node.tracking?.behind ?? 0) > 0).length,
    },
    superprojects,
  };
}

export type SubmoduleAction = "init" | "update" | "update_remote" | "sync" | "fetch" | "deinit";

/** Runs an action on one submodule (relative path, possibly nested) or, with
 *  an empty target, on every submodule recursively. Nested paths are executed
 *  from their enclosing submodule because `git submodule` only accepts paths
 *  of the repository it runs in. */
export async function submoduleAction(inputPath: string, action: SubmoduleAction, target: string) {
  const root = await repositoryRoot(inputPath);
  if (target && (path.isAbsolute(target) || target.split(/[\\/]/).includes(".."))) throw new AppError("invalid", "Submodule path must be relative to the repository");
  let cwd = root;
  let relative = target;
  if (target) {
    const list = (await walkGitlinks(root)).map((entry) => entry.path);
    if (!list.includes(target)) throw new AppError("invalid", `${target} is not a submodule of this repository`);
    const parent = list.filter((candidate) => target.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0];
    if (parent) { cwd = path.join(root, parent); relative = target.slice(parent.length + 1); }
  }
  const scope = relative ? ["--", relative] : [];
  const args: Record<SubmoduleAction, string[]> = {
    init: ["submodule", "update", "--init", "--recursive", ...scope],
    update: ["submodule", "update", "--init", "--recursive", ...scope],
    update_remote: ["submodule", "update", "--init", "--recursive", "--remote", ...scope],
    sync: ["submodule", "sync", "--recursive", ...scope],
    fetch: [],
    deinit: ["submodule", "deinit", ...scope],
  };
  if (action === "deinit" && !relative) throw new AppError("invalid", "Pick one submodule to deinitialize");
  if (action === "fetch") {
    const where = target ? path.join(root, target) : root;
    return checkedStdout(where, target ? ["fetch", "--all", "--prune"] : ["fetch", "--all", "--prune", "--recurse-submodules=yes"]);
  }
  return checkedStdout(cwd, args[action]);
}

// ---------------------------------------------------------------------------
// Bulk management for large multi-repo trees (Renode-style superprojects):
// one action over a chosen set of submodules, a command run in each of them,
// and a manifest of every pinned commit.
// ---------------------------------------------------------------------------

export type SubmoduleBulkAction = "fetch" | "update" | "update_remote" | "pull" | "push" | "attach" | "record";
export const SUBMODULE_BULK_ACTIONS: SubmoduleBulkAction[] = ["fetch", "update", "update_remote", "pull", "push", "attach", "record"];

export interface SubmoduleBulkResult {
  path: string;
  status: "ok" | "skipped" | "failed";
  message: string;
}

/** Validates targets against the live gitlink list and returns them in
 *  depth order, so parents are updated before their nested submodules. */
async function resolveTargets(root: string, targets: string[]) {
  const links = await walkGitlinks(root);
  const byPath = new Map(links.map((link) => [link.path, link]));
  const picked = [...new Set(targets)].map((target) => {
    if (!target || path.isAbsolute(target) || target.split(/[\\/]/).includes("..")) throw new AppError("invalid", `invalid submodule path: ${target}`);
    const link = byPath.get(target);
    if (!link) throw new AppError("invalid", `${target} is not a submodule of this repository`);
    return link;
  });
  return picked.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

const firstLine = (text: string) => text.trim().split("\n").filter(Boolean).pop() ?? "";

/** `.gitmodules` of one repository, keyed by submodule path. */
type ModulesFile = Map<string, { name: string; branch: string | null; url: string | null }>;

async function readModulesFile(repoAbsolute: string): Promise<ModulesFile> {
  const output = await runGit(repoAbsolute, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\."]);
  const byName = new Map<string, { path?: string; branch?: string; url?: string }>();
  for (const line of output.stdout.split("\n")) {
    const match = /^submodule\.(.+)\.(path|branch|url) (.*)$/.exec(line.trim());
    if (!match) continue;
    const entry = byName.get(match[1]) ?? {};
    entry[match[2] as "path" | "branch" | "url"] = match[3];
    byName.set(match[1], entry);
  }
  const result: ModulesFile = new Map();
  for (const [name, entry] of byName) if (entry.path) result.set(entry.path, { name, branch: entry.branch ?? null, url: entry.url ?? null });
  return result;
}

/** Branch a submodule is meant to follow: `.gitmodules` branch, else the remote's default. */
async function trackingBranch(modules: ModulesFile, relative: string, absolute: string): Promise<string | null> {
  const configured = modules.get(relative)?.branch ?? "";
  if (configured && configured !== ".") return configured;
  const head = await runGit(absolute, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : null;
}

/** Puts a detached submodule on a branch without moving it: only switches
 *  when a local or remote branch points exactly at the checked-out commit. */
async function attachToBranch(parentAbsolute: string, relative: string, absolute: string): Promise<SubmoduleBulkResult["status"] | string> {
  const current = await runGit(absolute, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (current.code === 0) return `already on ${current.stdout.trim()}`;
  const head = (await runGit(absolute, ["rev-parse", "HEAD"])).stdout.trim();
  const wanted = await trackingBranch(await readModulesFile(parentAbsolute), relative, absolute);
  if (wanted) {
    const local = await runGit(absolute, ["rev-parse", "-q", "--verify", `refs/heads/${wanted}`]);
    if (local.code === 0 && local.stdout.trim() === head) { await checkedStdout(absolute, ["switch", wanted]); return `ok:switched to ${wanted}`; }
    // A local branch that is merely behind HEAD can be fast-forwarded to it: no commit is lost.
    if (local.code === 0 && (await runGit(absolute, ["merge-base", "--is-ancestor", local.stdout.trim(), head])).code === 0) {
      await checkedStdout(absolute, ["branch", "-f", wanted, head]);
      await checkedStdout(absolute, ["switch", wanted]);
      return `ok:fast-forwarded ${wanted} and switched to it`;
    }
    const remote = await runGit(absolute, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${wanted}`]);
    if (local.code !== 0 && remote.code === 0 && remote.stdout.trim() === head) {
      await checkedStdout(absolute, ["switch", "-c", wanted, "--track", `origin/${wanted}`]);
      return `ok:created ${wanted} tracking origin/${wanted}`;
    }
  }
  const pointing = await runGit(absolute, ["for-each-ref", "--points-at", "HEAD", "--format=%(refname:short)", "refs/heads"]);
  const candidate = pointing.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  if (candidate) { await checkedStdout(absolute, ["switch", candidate]); return `ok:switched to ${candidate}`; }
  return wanted ? `HEAD ${head.slice(0, 8)} is not the tip of ${wanted}; left detached` : "no branch points at HEAD; left detached";
}

export async function submoduleBulk(inputPath: string, action: SubmoduleBulkAction, targets: string[]): Promise<SubmoduleBulkResult[]> {
  if (!SUBMODULE_BULK_ACTIONS.includes(action)) throw new AppError("invalid", `unknown bulk action ${action}`);
  if (!targets.length) throw new AppError("invalid", "select at least one submodule");
  const root = await repositoryRoot(inputPath);
  const picked = await resolveTargets(root, targets);
  const results = new Map<string, SubmoduleBulkResult>();
  // One depth level at a time: initializing a parent makes its children exist.
  // Pushing goes the other way, nested ones first, so a parent never
  // publishes a pointer to a commit its submodule's remote does not have yet.
  const depths = [...new Set(picked.map((link) => link.depth))].sort((a, b) => (action === "push" ? b - a : a - b));
  for (const depth of depths) {
    await pool(picked.filter((link) => link.depth === depth), 6, async (link) => {
      const absolute = path.join(root, link.path);
      const parentAbsolute = link.parent ? path.join(root, link.parent) : root;
      const relative = link.parent ? link.path.slice(link.parent.length + 1) : link.path;
      const head = await checkedOutHead(absolute);
      const done = (status: SubmoduleBulkResult["status"], message: string) => results.set(link.path, { path: link.path, status, message });
      try {
        if (!head && action !== "update" && action !== "update_remote") return done("skipped", "not initialized");
        switch (action) {
          case "fetch": {
            const output = await runGit(absolute, ["fetch", "--all", "--prune"]);
            return output.code === 0 ? done("ok", firstLine(output.stderr) || "up to date") : done("failed", firstLine(output.stderr));
          }
          case "update":
          case "update_remote": {
            // Nested submodules of this one are initialized and updated too.
            const args = ["submodule", "update", "--init", "--recursive", ...(action === "update_remote" ? ["--remote"] : []), "--", relative];
            await checkedStdout(parentAbsolute, args);
            const now = await checkedOutHead(absolute);
            return done("ok", now ? `at ${now.slice(0, 8)}` : "updated");
          }
          case "pull": {
            const branch = await runGit(absolute, ["symbolic-ref", "-q", "--short", "HEAD"]);
            if (branch.code !== 0) return done("skipped", "detached HEAD — attach to a branch first");
            const output = await runGit(absolute, ["pull", "--ff-only"]);
            return output.code === 0 ? done("ok", firstLine(output.stdout) || "pulled") : done("failed", firstLine(output.stderr));
          }
          case "push": {
            const branch = await runGit(absolute, ["symbolic-ref", "-q", "--short", "HEAD"]);
            if (branch.code !== 0) return done("skipped", "detached HEAD — attach to a branch first");
            const name = branch.stdout.trim();
            const upstream = await runGit(absolute, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
            if (upstream.code === 0) {
              const ahead = Number((await runGit(absolute, ["rev-list", "--count", "@{upstream}..HEAD"])).stdout.trim()) || 0;
              if (!ahead) return done("skipped", `nothing to push on ${name}`);
              const output = await runGit(absolute, ["push"]);
              return output.code === 0 ? done("ok", `pushed ${ahead} commit${ahead === 1 ? "" : "s"} to ${upstream.stdout.trim()}`) : done("failed", firstLine(output.stderr));
            }
            const remotes = (await runGit(absolute, ["remote"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
            const remote = remotes.includes("origin") ? "origin" : remotes[0];
            if (!remote) return done("skipped", "no remote");
            const output = await runGit(absolute, ["push", "--set-upstream", remote, `refs/heads/${name}:refs/heads/${name}`]);
            return output.code === 0 ? done("ok", `pushed ${name} to ${remote} and set upstream`) : done("failed", firstLine(output.stderr));
          }
          case "attach": {
            const outcome = await attachToBranch(parentAbsolute, relative, absolute);
            if (outcome.startsWith("ok:")) return done("ok", outcome.slice(3));
            return done("skipped", outcome);
          }
          case "record": {
            if (head === link.recorded) return done("skipped", "already recorded");
            await checkedStdout(parentAbsolute, ["add", "--", relative]);
            return done("ok", `staged ${head!.slice(0, 8)} in ${link.parent ?? "the superproject"}`);
          }
        }
      } catch (error) {
        return done("failed", firstLine(String((error as Error).message ?? error)));
      }
    });
  }
  return picked.map((link) => results.get(link.path)!);
}

export interface ForeachResult {
  path: string;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const FOREACH_TIMEOUT_MS = 120_000;
const FOREACH_OUTPUT = 200_000;

/** Runs a shell command in each selected (initialized) submodule, like
 *  `git submodule foreach` but in parallel and with per-repo results. */
export async function submoduleForeach(inputPath: string, command: string, targets: string[]): Promise<ForeachResult[]> {
  if (!command.trim()) throw new AppError("invalid", "enter a command");
  const root = await repositoryRoot(inputPath);
  const picked = await resolveTargets(root, targets);
  const { execFile } = await import("node:child_process");
  const shell = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] as const : ["/bin/sh", ["-c", command]] as const;
  return pool(picked, 4, async (link) => {
    const absolute = path.join(root, link.path);
    const head = await checkedOutHead(absolute);
    if (!head) return { path: link.path, code: null, stdout: "", stderr: "not initialized — skipped", ms: 0 };
    const started = performance.now();
    return new Promise<ForeachResult>((resolve) => {
      execFile(shell[0], [...shell[1]], {
        cwd: absolute,
        timeout: FOREACH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...gitProcessEnv(root), name: link.path, sm_path: link.path, displaypath: link.path, sha1: head, toplevel: root },
      }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1) : 0;
        const killed = error && (error as { killed?: boolean }).killed;
        resolve({
          path: link.path,
          code,
          stdout: String(stdout ?? "").slice(-FOREACH_OUTPUT),
          stderr: (killed ? `timed out after ${FOREACH_TIMEOUT_MS / 1000}s\n` : "") + String(stderr ?? "").slice(-FOREACH_OUTPUT),
          ms: Math.round(performance.now() - started),
        });
      });
    });
  });
}

export interface SubmoduleManifest {
  root: string;
  head: string | null;
  generatedAt: string;
  submodules: Array<{ path: string; url: string | null; recorded: string; checkedOut: string | null; branch: string | null; state: SubmoduleState }>;
}

/** Every submodule's pinned and checked-out commit: a reproducible snapshot
 *  of a multi-repo tree to share, diff or attach to a bug report. */
export async function submoduleManifest(inputPath: string): Promise<SubmoduleManifest> {
  const tree = await submoduleTree(inputPath);
  const head = await runGit(tree.root, ["rev-parse", "HEAD"]);
  return {
    root: tree.root,
    head: head.code === 0 ? head.stdout.trim() : null,
    generatedAt: new Date().toISOString(),
    submodules: tree.nodes.map((node) => ({
      path: node.path,
      url: node.url,
      recorded: node.recorded ?? node.commit,
      checkedOut: node.state === "uninitialized" ? null : node.commit,
      branch: node.branch,
      state: node.state,
    })),
  };
}
