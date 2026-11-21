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
}

export interface SubmoduleTree {
  root: string;
  nodes: SubmoduleNode[];
  maxDepth: number;
  totals: { all: number; dirty: number; drift: number; uninitialized: number; conflict: number; detached: number };
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
    };
    const parentAbsolute = link.parent ? path.join(root, link.parent) : root;
    const relativeToParent = link.parent ? link.path.slice(link.parent.length + 1) : link.path;
    if (!link.head) {
      const url = await runGit(parentAbsolute, ["config", "-f", ".gitmodules", "--get", `submodule.${relativeToParent}.url`]);
      node.url = url.code === 0 ? url.stdout.trim() || null : null;
      return node;
    }
    const [status, url] = await Promise.all([
      runGit(absolute, ["status", "--porcelain=v2", "--branch", "--ignore-submodules=dirty"]),
      runGit(absolute, ["config", "--get", "remote.origin.url"]),
    ]);
    if (status.code === 0) Object.assign(node, parsePorcelainV2(status.stdout));
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
