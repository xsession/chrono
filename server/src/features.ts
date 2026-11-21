// Roadmap features from the "Git client feature gap analysis" report:
//
// Tier 1 — signature badges + signing setup, large-repo performance preset,
//          typed search operators, hook-aware commits, issue autolinks,
//          commit templates, fork point.
// Tier 2 — conflict prediction (merge-tree), merged/stale branch cleanup,
//          stacked branches (parent model + restack), identity profiles,
//          custom commands, blobs for image diff.
// Tier 3 — agent worktrees, git-flow, local-first AI explanations,
//          sparse-checkout helpers, git notes.
//
// Every git call passes an argv array (no shell), so user-supplied names and
// custom-command parameters can never be interpreted by a shell.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import {
  checked,
  checkedStdout,
  COMMIT_FORMAT,
  hasHead,
  literalPathspec,
  parseCommits,
  repositoryRoot,
  runGit,
  runGitRaw,
  type CommandResult,
  type CommitRecord, HISTORY_ALL_REFS } from "./lib/git.ts";
import { workspacesFile } from "./workspaces.ts";
import { finishStream, runGitStreaming } from "./lib/streams.ts";

const configDir = () => path.dirname(workspacesFile());

function safeRev(value: string, what = "revision"): string {
  const rev = (value ?? "").trim();
  if (!rev || rev.startsWith("-") || rev.includes("\0") || /\s/.test(rev)) throw invalidError(`invalid ${what}`);
  return rev;
}

async function validBranchName(root: string, name: string): Promise<string> {
  const trimmed = (name ?? "").trim();
  if (!trimmed || trimmed.startsWith("-")) throw invalidError("invalid branch name");
  const check = await runGit(root, ["check-ref-format", "--branch", trimmed]);
  if (check.code !== 0) throw invalidError(`invalid branch name: ${trimmed}`);
  return trimmed;
}

async function gitVersion(): Promise<[number, number]> {
  const out = await runGit(null, ["version"]);
  const match = /(\d+)\.(\d+)/.exec(out.stdout);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

const atLeast = (version: [number, number], major: number, minor: number) => version[0] > major || (version[0] === major && version[1] >= minor);

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return fallback; }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

// ===========================================================================
// Tier 1
// ===========================================================================

// --- Signatures --------------------------------------------------------------

export interface SignatureInfo {
  commit: string;
  /** git %G? letter: G good, B bad, U good/unknown validity, X expired sig, Y expired key, R revoked, E cannot check, N none */
  status: string;
  signer: string;
  key: string;
}

/** Signature status for an explicit (visible) set of commits only — each signed
 *  commit spawns gpg/ssh-keygen, so callers must not ask for whole histories. */
export async function signatures(inputPath: string, commits: string[]): Promise<SignatureInfo[]> {
  const root = await repositoryRoot(inputPath);
  const list = commits.filter((sha) => /^[0-9a-f]{7,64}$/i.test(sha)).slice(0, 200);
  if (!list.length) return [];
  const output = await runGit(root, ["show", "-s", "--no-notes", "--format=%H%x1f%G?%x1f%GS%x1f%GK%x1e", ...list]);
  return output.stdout.split("\u001e").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [commit, status, signer, key] = chunk.split("\u001f");
    return { commit, status: status || "N", signer: signer ?? "", key: key ?? "" };
  });
}

export interface SigningConfig {
  format: string;
  signingKey: string;
  commitSign: boolean;
  tagSign: boolean;
  allowedSignersFile: string;
  scopeOfKey: string;
  sshKeys: string[];
  gpgKeys: Array<{ id: string; uid: string }>;
  userName: string;
  userEmail: string;
  identityOrigin: string;
}

async function configGet(root: string, key: string, scope?: "local" | "global"): Promise<string> {
  const args = ["config"];
  if (scope) args.push(`--${scope}`);
  args.push("--get", key);
  const out = await runGit(root, args);
  return out.code === 0 ? out.stdout.trim() : "";
}

export async function signingConfig(inputPath: string): Promise<SigningConfig> {
  const root = await repositoryRoot(inputPath);
  const [format, key, commitSign, tagSign, allowed, userName, userEmail, origin] = await Promise.all([
    configGet(root, "gpg.format"), configGet(root, "user.signingkey"), configGet(root, "commit.gpgsign"),
    configGet(root, "tag.gpgsign"), configGet(root, "gpg.ssh.allowedsignersfile"),
    configGet(root, "user.name"), configGet(root, "user.email"),
    runGit(root, ["config", "--show-origin", "--show-scope", "--get", "user.email"]),
  ]);
  const keyScope = (await runGit(root, ["config", "--show-scope", "--get", "user.signingkey"])).stdout.split(/\s/)[0] ?? "";
  let sshKeys: string[] = [];
  try {
    const dir = path.join(os.homedir(), ".ssh");
    sshKeys = (await fs.readdir(dir)).filter((name) => name.endsWith(".pub")).map((name) => path.join(dir, name));
  } catch { sshKeys = []; }
  const gpgKeys: Array<{ id: string; uid: string }> = [];
  await new Promise<void>((resolve) => {
    execFile("gpg", ["--list-secret-keys", "--with-colons"], { timeout: 4000 }, (error, stdout) => {
      if (!error) {
        let current = "";
        for (const line of String(stdout).split(/\r?\n/)) {
          const parts = line.split(":");
          if (parts[0] === "sec") current = parts[4];
          if (parts[0] === "uid" && current) { gpgKeys.push({ id: current, uid: parts[9] }); current = ""; }
        }
      }
      resolve();
    });
  });
  return {
    format: format || "openpgp",
    signingKey: key,
    commitSign: commitSign === "true",
    tagSign: tagSign === "true",
    allowedSignersFile: allowed,
    scopeOfKey: keyScope,
    sshKeys,
    gpgKeys,
    userName,
    userEmail,
    identityOrigin: origin.stdout.trim().replace(/\t.*$/, ""),
  };
}

export async function setSigningConfig(inputPath: string, scope: "local" | "global", values: { format?: string; signingKey?: string; commitSign?: boolean; tagSign?: boolean; allowedSignersFile?: string }): Promise<void> {
  const root = await repositoryRoot(inputPath);
  const flag = scope === "global" ? "--global" : "--local";
  const set = async (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") await runGit(root, ["config", flag, "--unset", key]);
    else await checked(root, ["config", flag, key, value]);
  };
  if (values.format !== undefined && !["openpgp", "ssh", "x509", ""].includes(values.format)) throw invalidError("gpg.format must be openpgp, ssh or x509");
  if (values.signingKey && values.signingKey.startsWith("-")) throw invalidError("invalid signing key");
  await set("gpg.format", values.format);
  await set("user.signingkey", values.signingKey);
  await set("commit.gpgsign", values.commitSign === undefined ? undefined : String(values.commitSign));
  await set("tag.gpgsign", values.tagSign === undefined ? undefined : String(values.tagSign));
  await set("gpg.ssh.allowedSignersFile", values.allowedSignersFile);
}

// --- Large-repo performance preset ------------------------------------------

export interface PerfStatus {
  commitGraph: boolean;
  changedPaths: boolean;
  maintenanceRegistered: boolean;
  fsmonitorConfigured: string;
  fsmonitorDaemon: "running" | "stopped" | "unsupported";
  untrackedCache: string;
  indexVersion: string;
  looseObjects: number;
  packs: number;
  sizePackKb: number;
  commitCount: number;
  inotifyWatches: number | null;
  gitVersion: string;
  presetApplied: string[];
}

const PRESET: Array<[string, string]> = [
  ["core.multiPackIndex", "true"],
  ["core.preloadIndex", "true"],
  ["core.untrackedCache", "true"],
  ["index.threads", "true"],
  ["index.version", "4"],
  ["pack.useSparse", "true"],
  ["fetch.writeCommitGraph", "true"],
  ["commitGraph.changedPaths", "true"],
  ["log.excludeDecoration", "refs/prefetch/*"],
];

export async function perfStatus(inputPath: string): Promise<PerfStatus> {
  const root = await repositoryRoot(inputPath);
  const commonDir = path.resolve(root, (await checkedStdout(root, ["rev-parse", "--git-common-dir"])).trim());
  const exists = async (file: string) => { try { await fs.stat(file); return true; } catch { return false; } };
  const graphFile = await exists(path.join(commonDir, "objects/info/commit-graph")) || await exists(path.join(commonDir, "objects/info/commit-graphs"));
  const [registered, fsm, daemon, untracked, indexVersion, counts, total, version, ...preset] = await Promise.all([
    runGit(root, ["config", "--global", "--get-all", "maintenance.repo"]),
    configGet(root, "core.fsmonitor"),
    runGit(root, ["fsmonitor--daemon", "status"]),
    configGet(root, "core.untrackedcache"),
    configGet(root, "index.version"),
    runGit(root, ["count-objects", "-v"]),
    runGit(root, ["rev-list", "--all", "--count"]),
    runGit(null, ["version"]),
    ...PRESET.map(([key]) => configGet(root, key)),
  ]);
  const countMap = Object.fromEntries(counts.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [k, v] = line.split(": "); return [k, Number(v) || 0]; }));
  let inotify: number | null = null;
  if (os.platform() === "linux") {
    try { inotify = Number((await fs.readFile("/proc/sys/fs/inotify/max_user_watches", "utf8")).trim()) || null; } catch { inotify = null; }
  }
  const daemonState: PerfStatus["fsmonitorDaemon"] = daemon.code === 0 ? "running" : /not supported|unknown|usage|is not a git command/i.test(daemon.stderr + daemon.stdout) ? "unsupported" : "stopped";
  return {
    commitGraph: graphFile,
    changedPaths: (preset[PRESET.findIndex(([key]) => key === "commitGraph.changedPaths")] as string) === "true",
    maintenanceRegistered: registered.stdout.split(/\r?\n/).some((line) => path.resolve(line.trim()) === root),
    fsmonitorConfigured: fsm,
    fsmonitorDaemon: daemonState,
    untrackedCache: untracked,
    indexVersion,
    looseObjects: countMap["count"] ?? 0,
    packs: countMap["packs"] ?? 0,
    sizePackKb: countMap["size-pack"] ?? 0,
    commitCount: Number(total.stdout.trim()) || 0,
    inotifyWatches: inotify,
    gitVersion: version.stdout.trim().replace(/^git version /, ""),
    presetApplied: PRESET.filter((_, index) => preset[index] === PRESET[index][1]).map(([key]) => key),
  };
}

export type PerfAction = "commit_graph" | "maintenance_register" | "maintenance_unregister" | "maintenance_run" | "fsmonitor_on" | "fsmonitor_off" | "untracked_cache" | "preset" | "gc";

export async function perfApply(inputPath: string, action: PerfAction): Promise<string> {
  const root = await repositoryRoot(inputPath);
  switch (action) {
    case "commit_graph":
      await checked(root, ["commit-graph", "write", "--reachable", "--changed-paths"]);
      return "Commit-graph written with changed-path Bloom filters.";
    case "maintenance_register":
      await checked(root, ["maintenance", "register"]);
      return "Repository registered for background maintenance (runs when `git maintenance start` scheduling is active).";
    case "maintenance_unregister":
      await checked(root, ["maintenance", "unregister"]);
      return "Repository removed from background maintenance.";
    case "maintenance_run":
      await checked(root, ["maintenance", "run", "--task=commit-graph", "--task=loose-objects", "--task=incremental-repack", "--task=pack-refs"]);
      return "Maintenance tasks completed: commit-graph, loose-objects, incremental-repack, pack-refs.";
    case "fsmonitor_on": {
      const start = await runGit(root, ["fsmonitor--daemon", "start"]);
      if (start.code !== 0 && !/already running/i.test(start.stderr)) {
        throw new AppError("unsupported", `the built-in fsmonitor daemon is not available here: ${start.stderr.trim() || "unsupported platform or git version"}`);
      }
      await checked(root, ["config", "core.fsmonitor", "true"]);
      return "File-system monitor enabled.";
    }
    case "fsmonitor_off":
      await runGit(root, ["fsmonitor--daemon", "stop"]);
      await runGit(root, ["config", "--unset", "core.fsmonitor"]);
      return "File-system monitor disabled.";
    case "untracked_cache":
      await checked(root, ["config", "core.untrackedCache", "true"]);
      await checked(root, ["update-index", "--untracked-cache"]);
      return "Untracked cache enabled.";
    case "gc":
      await checked(root, ["gc", "--auto"]);
      return "git gc --auto finished.";
    case "preset": {
      const applied: string[] = [];
      for (const [key, value] of PRESET) { await checked(root, ["config", key, value]); applied.push(`${key}=${value}`); }
      await runGit(root, ["update-index", "--untracked-cache"]);
      await checked(root, ["commit-graph", "write", "--reachable", "--changed-paths"]);
      const registered = await runGit(root, ["maintenance", "register"]);
      return `Large-repo preset applied (${applied.join(", ")}); commit-graph written${registered.code === 0 ? "; registered for background maintenance" : ""}.`;
    }
    default:
      throw invalidError("unknown performance action");
  }
}

// --- Typed search operators -------------------------------------------------

export interface SearchToken { key: string; value: string; negated: boolean }

export function parseSearchQuery(query: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  const pattern = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  for (const match of query.matchAll(pattern)) {
    const negated = match[1] === "-";
    const key = (match[2] ?? "").toLowerCase();
    const value = match[3] ?? match[4] ?? "";
    if (!value && !key) continue;
    tokens.push({ key, value, negated });
  }
  return tokens;
}

const KEY_ALIASES: Record<string, string> = {
  author: "author", by: "author", committer: "committer", message: "message", msg: "message", m: "message",
  path: "path", file: "path", f: "path", contents: "contents", content: "contents", code: "contents", c: "contents",
  since: "since", after: "since", until: "until", before: "until", type: "type", is: "type",
  sha: "sha", commit: "sha", ref: "ref", branch: "ref", in: "ref",
};

export const SEARCH_KEYS = Object.keys(KEY_ALIASES);

export async function advancedSearch(inputPath: string, query: string, limit: number): Promise<{ commits: CommitRecord[]; description: string }> {
  const root = await repositoryRoot(inputPath);
  if (!(await hasHead(root))) return { commits: [], description: "empty repository" };
  const tokens = parseSearchQuery(query);
  const args = ["log", "--date=iso-strict", `--pretty=format:${COMMIT_FORMAT}`, "-n", String(Math.min(Math.max(limit, 1), 2000)), "-i", "--regexp-ignore-case"];
  const paths: string[] = [];
  const greps: string[] = [];
  const negativeGreps: string[] = [];
  const description: string[] = [];
  let ref: string | null = null;
  let sha: string | null = null;
  for (const token of tokens) {
    const key = token.key ? KEY_ALIASES[token.key] : "message";
    const value = token.value;
    if (token.key && !key) { greps.push(`${token.key}:${value}`); continue; }
    switch (key) {
      case "author": args.push(`--author=${value}`); description.push(`author ~ ${value}`); break;
      case "committer": args.push(`--committer=${value}`); description.push(`committer ~ ${value}`); break;
      case "message": (token.negated ? negativeGreps : greps).push(value); description.push(`${token.negated ? "message !~" : "message ~"} ${value}`); break;
      case "path": paths.push(value.includes("*") ? `:(glob)${value.includes("/") ? value : `**/${value}`}` : literalPathspec(value)); description.push(`path ${value}`); break;
      case "contents": args.push(`-G${value}`); description.push(`diff contains /${value}/`); break;
      case "since": args.push(`--since=${value}`); description.push(`since ${value}`); break;
      case "until": args.push(`--until=${value}`); description.push(`until ${value}`); break;
      case "type":
        if (/^merges?$/i.test(value)) { args.push("--merges"); description.push("merges only"); }
        else if (/^(no-?merges?|commits?|regular)$/i.test(value)) { args.push("--no-merges"); description.push("no merges"); }
        else if (/^signed$/i.test(value)) description.push("signed (checked client-side)");
        else throw invalidError(`unknown type: ${value} (use merge or nomerge)`);
        break;
      case "sha": sha = safeRev(value, "sha"); description.push(`sha ${value}`); break;
      case "ref": ref = safeRev(value, "ref"); description.push(`in ${value}`); break;
    }
  }
  for (const grep of greps) args.push(`--grep=${grep}`);
  if (greps.length > 1) args.push("--all-match");
  if (sha) {
    const out = await runGit(root, ["log", "-1", "--date=iso-strict", `--pretty=format:${COMMIT_FORMAT}`, sha]);
    return { commits: out.code === 0 ? parseCommits(out.stdout) : [], description: description.join(" · ") };
  }
  args.push(...(ref ? [ref] : HISTORY_ALL_REFS));
  if (paths.length) args.push("--", ...paths);
  let commits = parseCommits((await runGit(root, args)).stdout);
  if (negativeGreps.length) {
    const negArgs = ["log", "--format=%H", "-i", ...negativeGreps.map((grep) => `--grep=${grep}`), ...(ref ? [ref] : HISTORY_ALL_REFS)];
    const excluded = new Set((await runGit(root, negArgs)).stdout.split(/\r?\n/).filter(Boolean));
    commits = commits.filter((commit) => !excluded.has(commit.id));
  }
  return { commits, description: description.join(" · ") || "all commits" };
}

// --- Hooks + hook-aware commit ----------------------------------------------

const HOOK_NAMES = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push", "pre-rebase", "post-checkout", "post-merge", "pre-merge-commit", "post-rewrite", "pre-auto-gc", "reference-transaction"];

export interface HookInfo { name: string; path: string; exists: boolean; executable: boolean; size: number; preview: string }

async function hooksDir(root: string): Promise<string> {
  return path.resolve(root, (await checkedStdout(root, ["rev-parse", "--git-path", "hooks"])).trim());
}

export async function listHooks(inputPath: string): Promise<{ dir: string; hooksPath: string; hooks: HookInfo[] }> {
  const root = await repositoryRoot(inputPath);
  const dir = await hooksDir(root);
  const hooks: HookInfo[] = [];
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    try {
      const info = await fs.stat(file);
      const preview = (await fs.readFile(file, "utf8")).slice(0, 2000);
      hooks.push({ name, path: file, exists: true, executable: (info.mode & 0o111) !== 0, size: info.size, preview });
    } catch {
      hooks.push({ name, path: file, exists: false, executable: false, size: 0, preview: "" });
    }
  }
  return { dir, hooksPath: await configGet(root, "core.hooksPath"), hooks };
}

export async function setHookEnabled(inputPath: string, name: string, enabled: boolean): Promise<void> {
  if (!HOOK_NAMES.includes(name)) throw invalidError("unknown hook");
  const root = await repositoryRoot(inputPath);
  const file = path.join(await hooksDir(root), name);
  const info = await fs.stat(file).catch(() => null);
  if (!info) throw invalidError(`${name} hook does not exist`);
  await fs.chmod(file, enabled ? info.mode | 0o755 : info.mode & ~0o111);
}

export interface HookCommitResult {
  ok: boolean;
  commit: string | null;
  output: string;
  exitCode: number;
  hookFailed: string | null;
  activeHooks: string[];
}

/** Commit capturing the full hook output (pre-commit / commit-msg). On failure
 *  the UI shows the output and can retry with --no-verify explicitly. */
export async function commitWithHooks(inputPath: string, options: { message: string; amend?: boolean; signoff?: boolean; noVerify?: boolean; streamId?: string | null }): Promise<HookCommitResult> {
  const root = await repositoryRoot(inputPath);
  const message = options.message.trim();
  if (!message && !options.amend) throw invalidError("commit message is empty");
  const { hooks } = await listHooks(root);
  const activeHooks = hooks.filter((hook) => hook.exists && hook.executable && ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-merge-commit"].includes(hook.name)).map((hook) => hook.name);
  const args = ["commit"];
  if (options.amend) args.push("--amend");
  if (options.signoff) args.push("--signoff");
  if (options.noVerify) args.push("--no-verify");
  if (message) args.push("-m", message); else args.push("--no-edit");
  const out = options.streamId
    ? await runGitStreaming(root, args, options.streamId, { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" })
    : await runGit(root, args, { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" });
  if (options.streamId) finishStream(options.streamId, out.code);
  const output = [out.stdout, out.stderr].filter(Boolean).join("\n");
  if (out.code === 0) {
    const sha = (await checkedStdout(root, ["rev-parse", "HEAD"])).trim();
    return { ok: true, commit: sha, output, exitCode: 0, hookFailed: null, activeHooks };
  }
  const nothing = /nothing to commit|no changes added/i.test(output);
  const hookFailed = nothing || options.noVerify ? null : activeHooks.find((hook) => hook === "pre-commit" || hook === "commit-msg" || hook === "pre-merge-commit") ?? null;
  return { ok: false, commit: null, output, exitCode: out.code, hookFailed, activeHooks };
}

// --- Issue autolinks (stored in repo-local git config) ----------------------

export interface AutolinkRule { pattern: string; url: string }

export async function getAutolinks(inputPath: string): Promise<{ rules: AutolinkRule[]; suggested: AutolinkRule[] }> {
  const root = await repositoryRoot(inputPath);
  const out = await runGit(root, ["config", "--local", "--get-all", "chrono.autolink"]);
  const rules = out.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { pattern: line.slice(0, tab), url: line.slice(tab + 1) };
  }).filter((rule) => rule.pattern && rule.url);
  const suggested: AutolinkRule[] = [];
  const remote = (await runGit(root, ["remote", "get-url", "origin"])).stdout.trim();
  const host = parseRemote(remote);
  if (host) {
    const issues = host.provider === "gitlab" ? `${host.webBase}/-/issues/$1` : `${host.webBase}/issues/$1`;
    suggested.push({ pattern: "#(\\d+)", url: issues });
  }
  suggested.push({ pattern: "\\b([A-Z][A-Z0-9]+-\\d+)\\b", url: "https://your-company.atlassian.net/browse/$1" });
  return { rules, suggested };
}

export async function setAutolinks(inputPath: string, rules: AutolinkRule[]): Promise<void> {
  const root = await repositoryRoot(inputPath);
  for (const rule of rules) {
    try { new RegExp(rule.pattern); } catch { throw invalidError(`invalid regular expression: ${rule.pattern}`); }
    if (!/^https?:\/\//i.test(rule.url)) throw invalidError("link URLs must start with http:// or https://");
    if (rule.pattern.includes("\t") || rule.pattern.includes("\n") || rule.url.includes("\n")) throw invalidError("invalid rule");
  }
  await runGit(root, ["config", "--local", "--unset-all", "chrono.autolink"]);
  for (const rule of rules) await checked(root, ["config", "--local", "--add", "chrono.autolink", `${rule.pattern}\t${rule.url}`]);
}

// --- Commit templates -------------------------------------------------------

export interface CommitTemplate { id: string; name: string; text: string; source: "git" | "chrono" }

export async function commitTemplates(inputPath: string): Promise<CommitTemplate[]> {
  const root = await repositoryRoot(inputPath);
  const templates: CommitTemplate[] = [];
  const gitTemplate = await configGet(root, "commit.template");
  if (gitTemplate) {
    const file = gitTemplate.startsWith("~") ? path.join(os.homedir(), gitTemplate.slice(1)) : path.resolve(root, gitTemplate);
    try {
      const text = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter((line) => !line.startsWith("#")).join("\n").trim();
      templates.push({ id: "git", name: `commit.template (${path.basename(file)})`, text, source: "git" });
    } catch { /* template file missing */ }
  }
  const saved = await readJson<CommitTemplate[]>(path.join(configDir(), "commit-templates.json"), []);
  return [...templates, ...saved.map((template) => ({ ...template, source: "chrono" as const }))];
}

export async function saveCommitTemplates(templates: CommitTemplate[]): Promise<void> {
  const clean = templates.filter((template) => template.source !== "git").map((template, index) => ({
    id: template.id || `t${Date.now()}-${index}`, name: String(template.name).slice(0, 80), text: String(template.text).slice(0, 5000), source: "chrono",
  }));
  await writeJson(path.join(configDir(), "commit-templates.json"), clean);
}

/** Repository AI instructions (AGENTS.md, copilot-instructions.md) fed to drafts. */
export async function repoInstructions(inputPath: string): Promise<string> {
  const root = await repositoryRoot(inputPath);
  for (const candidate of [".github/copilot-instructions.md", "AGENTS.md", ".chrono/commit-instructions.md"]) {
    try { return (await fs.readFile(path.join(root, candidate), "utf8")).slice(0, 3000); } catch { /* next */ }
  }
  return "";
}

// --- Fork point ---------------------------------------------------------------

export async function defaultBaseBranch(root: string, branch: string): Promise<string | null> {
  const parent = await configGet(root, `branch.${branch}.chronoParent`);
  if (parent) return parent;
  const originHead = (await runGit(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
  const candidates = [originHead, "main", "master", "develop", "origin/main", "origin/master"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === branch) continue;
    if ((await runGit(root, ["rev-parse", "-q", "--verify", `${candidate}^{commit}`])).code === 0) return candidate;
  }
  return null;
}

export async function forkPoint(inputPath: string, branchInput: string | null, baseInput: string | null): Promise<{ branch: string; base: string | null; forkPoint: string | null; ahead: number; behind: number }> {
  const root = await repositoryRoot(inputPath);
  const branch = branchInput?.trim() || (await runGit(root, ["branch", "--show-current"])).stdout.trim() || "HEAD";
  const base = baseInput?.trim() || await defaultBaseBranch(root, branch);
  if (!base) return { branch, base: null, forkPoint: null, ahead: 0, behind: 0 };
  safeRev(base, "base"); safeRev(branch, "branch");
  let fork = (await runGit(root, ["merge-base", "--fork-point", base, branch])).stdout.trim();
  if (!fork) fork = (await runGit(root, ["merge-base", base, branch])).stdout.trim();
  const counts = (await runGit(root, ["rev-list", "--left-right", "--count", `${base}...${branch}`])).stdout.trim().split(/\s+/);
  return { branch, base, forkPoint: fork || null, behind: Number(counts[0]) || 0, ahead: Number(counts[1]) || 0 };
}

// ===========================================================================
// Tier 2
// ===========================================================================

// --- Conflict prediction ----------------------------------------------------

export interface ConflictPrediction { supported: boolean; clean: boolean; files: string[]; approximate: boolean; message: string }

export async function predictConflicts(inputPath: string, mode: "merge" | "cherry-pick" | "revert" | "rebase", source: string, target: string | null): Promise<ConflictPrediction> {
  const root = await repositoryRoot(inputPath);
  const version = await gitVersion();
  if (!atLeast(version, 2, 38)) return { supported: false, clean: true, files: [], approximate: true, message: "conflict prediction needs git 2.38+" };
  const ours = safeRev(target || "HEAD", "target");
  const theirs = safeRev(source, "source");
  const args = ["merge-tree", "--write-tree", "--name-only", "--no-messages"];
  let approximate = false;
  if (mode === "cherry-pick" || mode === "revert") {
    if (!atLeast(version, 2, 40)) return { supported: false, clean: true, files: [], approximate: true, message: "cherry-pick prediction needs git 2.40+" };
    const parent = (await runGit(root, ["rev-parse", "-q", "--verify", `${theirs}^`])).stdout.trim();
    if (!parent) return { supported: true, clean: true, files: [], approximate: true, message: "root commit — not predicted" };
    if (mode === "cherry-pick") args.push(`--merge-base=${parent}`, ours, theirs);
    else args.push(`--merge-base=${theirs}`, ours, parent);
  } else {
    if (mode === "rebase") approximate = true; // whole-range approximation of a per-commit replay
    args.push(ours, theirs);
  }
  const out = await runGit(root, args);
  if (out.code !== 0 && out.code !== 1) return { supported: true, clean: true, files: [], approximate, message: out.stderr.trim() || "prediction failed" };
  const lines = out.stdout.split(/\r?\n/);
  const files = out.code === 1 ? [...new Set(lines.slice(1).filter((line) => line.trim().length > 0))] : [];
  return {
    supported: true,
    clean: out.code === 0,
    files,
    approximate,
    message: out.code === 0 ? "No conflicts expected." : `${files.length} file(s) would conflict${approximate ? " (approximation for rebase)" : ""}.`,
  };
}

// --- Merged / stale branch cleanup ------------------------------------------

export interface CleanupCandidate { branch: string; target: string; reasons: Array<"merged" | "squash-merged" | "upstream-gone" | "stale">; lastCommit: string; daysOld: number }

export async function cleanupCandidates(inputPath: string, targetInput: string | null, staleDays = 90): Promise<{ target: string; candidates: CleanupCandidate[] }> {
  const root = await repositoryRoot(inputPath);
  const current = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  const target = targetInput?.trim() || await defaultBaseBranch(root, current) || current;
  safeRev(target, "target");
  const merged = new Set((await runGit(root, ["branch", "--format=%(refname:short)", "--merged", target])).stdout.split(/\r?\n/).filter(Boolean));
  const refs = (await checkedStdout(root, ["for-each-ref", "--format=%(refname:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(objectname)", "refs/heads"]))
    .split(/\r?\n/).filter(Boolean).map((line) => line.split("\u001f"));
  const now = Date.now() / 1000;
  const targetShort = target.replace(/^origin\//, "");
  const candidates: CleanupCandidate[] = [];
  for (const [branch, track, date, sha] of refs) {
    if (branch === current || branch === target || branch === targetShort) continue;
    const reasons: CleanupCandidate["reasons"] = [];
    if (merged.has(branch)) reasons.push("merged");
    else {
      // squash/rebase merge detection: squash the branch into one synthetic
      // commit on its merge-base and ask `git cherry` whether target has it.
      const base = (await runGit(root, ["merge-base", target, branch])).stdout.trim();
      if (base) {
        const tree = (await runGit(root, ["rev-parse", `${branch}^{tree}`])).stdout.trim();
        const synthetic = (await runGit(root, ["commit-tree", tree, "-p", base, "-m", "chrono squash probe"], { GIT_AUTHOR_NAME: "chrono", GIT_AUTHOR_EMAIL: "chrono@localhost", GIT_COMMITTER_NAME: "chrono", GIT_COMMITTER_EMAIL: "chrono@localhost" })).stdout.trim();
        if (synthetic) {
          const cherry = (await runGit(root, ["cherry", target, synthetic])).stdout.trim();
          if (cherry.startsWith("-")) reasons.push("squash-merged");
        }
      }
    }
    if (/\bgone\b/.test(track)) reasons.push("upstream-gone");
    const days = Math.floor((now - Number(date)) / 86400);
    if (days >= staleDays) reasons.push("stale");
    if (reasons.length) candidates.push({ branch, target, reasons, lastCommit: sha, daysOld: days });
  }
  return { target, candidates };
}

export async function archiveBranches(inputPath: string, branches: string[], mode: "archive" | "delete"): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const current = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  const done: string[] = [];
  for (const name of branches) {
    const branch = await validBranchName(root, name);
    if (branch === current) continue;
    const sha = (await checkedStdout(root, ["rev-parse", `refs/heads/${branch}`])).trim();
    if (mode === "archive") await checked(root, ["update-ref", `refs/chrono/archive/${branch}`, sha]);
    await checked(root, ["branch", "-D", branch]);
    done.push(branch);
  }
  return `${mode === "archive" ? "Archived" : "Deleted"} ${done.length} branch(es)`;
}

export async function archivedBranches(inputPath: string): Promise<Array<{ branch: string; sha: string; date: string }>> {
  const root = await repositoryRoot(inputPath);
  const out = await runGit(root, ["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)", "refs/chrono/archive"]);
  return out.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, sha, date] = line.split("\u001f");
    return { branch: ref.replace(/^refs\/chrono\/archive\//, ""), sha, date };
  });
}

export async function restoreArchived(inputPath: string, branch: string): Promise<void> {
  const root = await repositoryRoot(inputPath);
  const name = await validBranchName(root, branch);
  const sha = (await checkedStdout(root, ["rev-parse", `refs/chrono/archive/${name}`])).trim();
  await checked(root, ["branch", name, sha]);
  await checked(root, ["update-ref", "-d", `refs/chrono/archive/${name}`]);
}

// --- Stacked branches -------------------------------------------------------

export async function stackParents(inputPath: string): Promise<Record<string, string>> {
  const root = await repositoryRoot(inputPath);
  const out = await runGit(root, ["config", "--local", "--get-regexp", "^branch\\..*\\.chronoparent$"]);
  const result: Record<string, string> = {};
  for (const line of out.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = /^branch\.(.+)\.chronoparent\s+(.+)$/.exec(line);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}

export async function setStackParent(inputPath: string, branch: string, parent: string | null): Promise<void> {
  const root = await repositoryRoot(inputPath);
  const name = await validBranchName(root, branch);
  if (!parent) { await runGit(root, ["config", "--local", "--unset", `branch.${name}.chronoParent`]); return; }
  const parentName = safeRev(parent, "parent");
  if (parentName === name) throw invalidError("a branch cannot be its own parent");
  const parents = await stackParents(root);
  let cursor: string | undefined = parentName;
  for (let guard = 0; cursor && guard < 100; guard += 1) {
    if (cursor === name) throw invalidError("that parent would create a cycle");
    cursor = parents[cursor];
  }
  await checked(root, ["config", "--local", `branch.${name}.chronoParent`, parentName]);
}

export async function createStackedBranch(inputPath: string, parent: string, name: string): Promise<void> {
  const root = await repositoryRoot(inputPath);
  const branch = await validBranchName(root, name);
  const parentName = safeRev(parent, "parent");
  await checked(root, ["switch", "-c", branch, parentName]);
  await checked(root, ["config", "--local", `branch.${branch}.chronoParent`, parentName]);
}

/** Restack: rebase the whole stack that starts at `branch` onto its parent in
 *  one `rebase --update-refs` run from the stack tip, then return to the
 *  originally checked-out branch. */
export async function restack(inputPath: string, branch: string): Promise<CommandResult & { tip: string; base: string }> {
  const root = await repositoryRoot(inputPath);
  const version = await gitVersion();
  if (!atLeast(version, 2, 38)) throw new AppError("unsupported", "restacking needs git 2.38+ (rebase --update-refs)");
  const parents = await stackParents(root);
  const base = parents[branch];
  if (!base) throw invalidError(`${branch} has no parent branch — set one first`);
  let tip = branch;
  for (let guard = 0; guard < 50; guard += 1) {
    const children = Object.entries(parents).filter(([, parent]) => parent === tip).map(([child]) => child);
    if (children.length !== 1) break;
    tip = children[0];
  }
  const original = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  if (original !== tip) await checked(root, ["switch", tip]);
  const result = await checked(root, ["rebase", "--update-refs", base]);
  if (original && original !== tip) await runGit(root, ["switch", original]);
  return { ...result, tip, base };
}

// --- Identity profiles ------------------------------------------------------

export interface IdentityProfile { name: string; userName: string; userEmail: string; signingKey: string; gpgFormat: string; file: string; folders: string[]; repos: string[] }

const profilesDir = () => path.join(configDir(), "profiles");

function profileFile(name: string): string {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw invalidError("profile names may use letters, digits, . _ - (max 40)");
  return path.join(profilesDir(), `${name}.gitconfig`);
}

export async function listProfiles(inputPath: string | null): Promise<{ profiles: IdentityProfile[]; effective: { name: string; email: string; origin: string } | null }> {
  let entries: string[] = [];
  try { entries = (await fs.readdir(profilesDir())).filter((name) => name.endsWith(".gitconfig")); } catch { entries = []; }
  const globalIncludes = (await runGit(null, ["config", "--global", "--get-regexp", "^includeif\\..*\\.path$"])).stdout.split(/\r?\n/).filter(Boolean);
  const root = inputPath ? await repositoryRoot(inputPath).catch(() => null) : null;
  const localIncludes = root ? (await runGit(root, ["config", "--local", "--get-all", "include.path"])).stdout.split(/\r?\n/).filter(Boolean) : [];
  const profiles: IdentityProfile[] = [];
  for (const entry of entries) {
    const file = path.join(profilesDir(), entry);
    const get = async (key: string) => (await runGit(null, ["config", "--file", file, "--get", key])).stdout.trim();
    profiles.push({
      name: entry.replace(/\.gitconfig$/, ""),
      userName: await get("user.name"),
      userEmail: await get("user.email"),
      signingKey: await get("user.signingkey"),
      gpgFormat: await get("gpg.format"),
      file,
      folders: globalIncludes.filter((line) => line.endsWith(` ${file}`)).map((line) => line.replace(/^includeif\.gitdir:/i, "").replace(/\.path .*$/, "")),
      repos: localIncludes.includes(file) && root ? [root] : [],
    });
  }
  let effective = null;
  if (root) {
    const out = await runGit(root, ["config", "--show-origin", "--get", "user.email"]);
    effective = { name: (await configGet(root, "user.name")), email: (await configGet(root, "user.email")), origin: out.stdout.split("\t")[0] ?? "" };
  }
  return { profiles, effective };
}

export async function saveProfile(profile: { name: string; userName: string; userEmail: string; signingKey?: string; gpgFormat?: string }): Promise<void> {
  const file = profileFile(profile.name);
  if (!profile.userName.trim() || !/^[^\s@]+@[^\s@]+$/.test(profile.userEmail.trim())) throw invalidError("a profile needs a name and a valid email");
  await fs.mkdir(profilesDir(), { recursive: true });
  await fs.writeFile(file, "", { flag: "a" });
  const set = async (key: string, value?: string) => {
    if (value && value.trim()) await checked(null, ["config", "--file", file, key, value.trim()]);
    else await runGit(null, ["config", "--file", file, "--unset", key]);
  };
  await set("user.name", profile.userName);
  await set("user.email", profile.userEmail);
  await set("user.signingkey", profile.signingKey);
  await set("gpg.format", profile.gpgFormat);
}

export async function deleteProfile(name: string): Promise<void> {
  const file = profileFile(name);
  const includes = (await runGit(null, ["config", "--global", "--get-regexp", "^includeif\\..*\\.path$"])).stdout.split(/\r?\n/).filter((line) => line.endsWith(` ${file}`));
  for (const line of includes) await runGit(null, ["config", "--global", "--unset", line.slice(0, line.indexOf(" ")), file]);
  await fs.rm(file, { force: true });
}

/** Attach a profile to this repository (local include.path) or to every
 *  repository under a folder (global includeIf "gitdir:<folder>/"). Repo
 *  user/email keys are never rewritten — switching profiles only swaps
 *  includes, so nothing is lost. */
export async function applyProfile(inputPath: string | null, name: string, scope: "repo" | "folder", folder: string | null): Promise<string> {
  const file = profileFile(name);
  await fs.stat(file).catch(() => { throw invalidError(`profile ${name} does not exist`); });
  const all = (await fs.readdir(profilesDir()).catch(() => [] as string[])).map((entry) => path.join(profilesDir(), entry));
  if (scope === "repo") {
    if (!inputPath) throw invalidError("open a repository first");
    const root = await repositoryRoot(inputPath);
    for (const other of all) await runGit(root, ["config", "--local", "--unset-all", "include.path", `^${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`]);
    await checked(root, ["config", "--local", "--add", "include.path", file]);
    return `Profile ${name} now applies to ${root}`;
  }
  const dir = (folder ?? "").trim();
  if (!dir || !path.isAbsolute(dir)) throw invalidError("choose an absolute folder");
  const gitdir = dir.endsWith("/") ? dir : `${dir}/`;
  await checked(null, ["config", "--global", `includeIf.gitdir:${gitdir}.path`, file]);
  return `Profile ${name} now applies to repositories under ${gitdir}`;
}

export async function detachProfile(inputPath: string, name: string): Promise<void> {
  const root = await repositoryRoot(inputPath);
  const file = profileFile(name);
  await runGit(root, ["config", "--local", "--unset-all", "include.path", `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`]);
}

// --- Custom commands --------------------------------------------------------

export interface CustomCommandParam { name: string; label: string; type: "text" | "branch" | "checkbox"; default?: string }
export interface CustomCommand { id: string; name: string; argv: string[]; scope: "repository" | "commit" | "branch" | "files"; confirm: boolean; refresh: boolean; params: CustomCommandParam[] }

const commandsFile = () => path.join(configDir(), "custom-commands.json");

export async function listCustomCommands(): Promise<CustomCommand[]> {
  return readJson<CustomCommand[]>(commandsFile(), []);
}

export async function saveCustomCommands(commands: CustomCommand[]): Promise<void> {
  for (const command of commands) {
    if (!command.name?.trim() || !Array.isArray(command.argv) || !command.argv.length || command.argv.some((arg) => typeof arg !== "string")) throw invalidError(`command "${command.name}" needs a name and an argv array`);
    for (const param of command.params ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) throw invalidError(`invalid parameter name ${param.name}`);
  }
  await writeJson(commandsFile(), commands.map((command, index) => ({
    id: command.id || `cmd${Date.now()}${index}`, name: command.name.trim(), argv: command.argv, scope: command.scope ?? "repository",
    confirm: Boolean(command.confirm), refresh: command.refresh !== false, params: command.params ?? [],
  })));
}

export async function runCustomCommand(inputPath: string, id: string, context: { sha?: string; branch?: string; files?: string[]; params?: Record<string, string> }, allowNonGit: boolean): Promise<CommandResult & { argv: string[] }> {
  const root = await repositoryRoot(inputPath);
  const command = (await listCustomCommands()).find((candidate) => candidate.id === id);
  if (!command) throw invalidError("unknown custom command");
  const branch = context.branch ?? (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  const vars: Record<string, string> = { REPO: root, BRANCH: branch, SHA: context.sha ?? "", ...Object.fromEntries(Object.entries(context.params ?? {}).map(([key, value]) => [`PARAM_${key}`, String(value)])) };
  // Substitution happens per argv element only — values never reach a shell.
  const argv: string[] = [];
  for (const arg of command.argv) {
    if (arg === "$FILES") { argv.push(...(context.files ?? [])); continue; }
    argv.push(arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, bare: string | undefined) => { const name = braced ?? bare ?? ""; return name in vars ? vars[name] : whole; }));
  }
  const [executable, ...rest] = argv;
  if (executable !== "git" && !allowNonGit) throw new AppError("unsupported", "only git commands may run when Chrono is reachable from other machines");
  const result = await new Promise<CommandResult>((resolve) => {
    execFile(executable, rest, { cwd: root, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && code === 1 ? error.message : ""), exitCode: code });
    });
  });
  return { ...result, argv };
}

// --- Blobs for image diff ---------------------------------------------------

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
export const IMAGE_EXTENSIONS = Object.keys(MIME);

export async function fileBlob(inputPath: string, revision: string, file: string): Promise<{ exists: boolean; mime: string; size: number; base64: string; lfs: boolean }> {
  const root = await repositoryRoot(inputPath);
  const rel = file.replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.startsWith("-") || /(^|\/)\.\.(\/|$)/.test(rel)) throw invalidError("invalid path");
  const mime = MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
  let buffer: Buffer | null = null;
  if (revision === "WORKTREE") {
    try { buffer = await fs.readFile(path.join(root, rel)); } catch { buffer = null; }
  } else {
    const spec = revision === "INDEX" ? `:${rel}` : `${safeRev(revision)}:${rel}`;
    const out = await runGitRaw(root, ["cat-file", "--filters", spec]);
    buffer = out.code === 0 ? out.stdout : null;
  }
  if (!buffer) return { exists: false, mime, size: 0, base64: "", lfs: false };
  const lfs = buffer.length < 300 && buffer.toString("utf8").startsWith("version https://git-lfs");
  if (buffer.length > 25 * 1024 * 1024) throw invalidError("image is larger than 25 MB");
  return { exists: true, mime, size: buffer.length, base64: lfs ? "" : buffer.toString("base64"), lfs };
}

// ===========================================================================
// Tier 3
// ===========================================================================

// --- Agent worktrees --------------------------------------------------------

export async function createAgentWorktree(inputPath: string, name: string, base: string, location: string | null): Promise<{ path: string; branch: string }> {
  const root = await repositoryRoot(inputPath);
  const branch = await validBranchName(root, name);
  const baseRev = safeRev(base || "HEAD", "base");
  const target = location?.trim() ? path.resolve(location.trim()) : path.join(path.dirname(root), `${path.basename(root)}-agents`, branch.replace(/\//g, "-"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await checked(root, ["worktree", "add", "-b", branch, target, baseRev]);
  return { path: target, branch };
}

export async function removeAgentWorktree(inputPath: string, worktree: string, deleteBranch: boolean, force: boolean): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const list = (await checkedStdout(root, ["worktree", "list", "--porcelain"])).split(/\n\n/);
  const entry = list.find((block) => block.startsWith(`worktree ${worktree}\n`) || block === `worktree ${worktree}`);
  if (!entry) throw invalidError("not a worktree of this repository");
  const branch = /\nbranch refs\/heads\/(.+)/.exec(entry)?.[1] ?? null;
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktree);
  await checked(root, args);
  if (deleteBranch && branch) await checked(root, ["branch", "-D", branch]);
  return `Removed ${worktree}${deleteBranch && branch ? ` and branch ${branch}` : ""}`;
}

// --- Git-flow ---------------------------------------------------------------

export interface GitflowConfig { initialized: boolean; master: string; develop: string; feature: string; release: string; hotfix: string; support: string; versionTag: string }

export async function gitflowConfig(inputPath: string): Promise<GitflowConfig> {
  const root = await repositoryRoot(inputPath);
  const get = (key: string) => configGet(root, key);
  const [master, develop, feature, release, hotfix, support, versionTag] = await Promise.all([
    get("gitflow.branch.master"), get("gitflow.branch.develop"), get("gitflow.prefix.feature"), get("gitflow.prefix.release"),
    get("gitflow.prefix.hotfix"), get("gitflow.prefix.support"), get("gitflow.prefix.versiontag"),
  ]);
  return {
    initialized: Boolean(master && develop),
    master: master || "main", develop: develop || "develop", feature: feature || "feature/", release: release || "release/",
    hotfix: hotfix || "hotfix/", support: support || "support/", versionTag,
  };
}

export async function gitflowInit(inputPath: string, config: Partial<GitflowConfig>): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const current = await gitflowConfig(root);
  const merged = { ...current, ...config };
  const master = await validBranchName(root, merged.master);
  const develop = await validBranchName(root, merged.develop);
  for (const [key, value] of [["gitflow.branch.master", master], ["gitflow.branch.develop", develop], ["gitflow.prefix.feature", merged.feature], ["gitflow.prefix.release", merged.release], ["gitflow.prefix.hotfix", merged.hotfix], ["gitflow.prefix.support", merged.support], ["gitflow.prefix.versiontag", merged.versionTag ?? ""]] as const) {
    if (/[\s\0]/.test(value)) throw invalidError(`invalid value for ${key}`);
    await checked(root, ["config", "--local", key, value]);
  }
  if ((await runGit(root, ["rev-parse", "-q", "--verify", `refs/heads/${master}`])).code !== 0) throw invalidError(`production branch ${master} does not exist`);
  if ((await runGit(root, ["rev-parse", "-q", "--verify", `refs/heads/${develop}`])).code !== 0) await checked(root, ["branch", develop, master]);
  return `Git-flow initialised (${master} / ${develop})`;
}

export type FlowType = "feature" | "release" | "hotfix" | "support";

export async function gitflowStart(inputPath: string, type: FlowType, name: string, base: string | null): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const flow = await gitflowConfig(root);
  if (!flow.initialized) throw invalidError("initialise git-flow first");
  const prefix = flow[type];
  const branch = await validBranchName(root, `${prefix}${name.trim()}`);
  const from = base?.trim() ? safeRev(base) : type === "feature" || type === "release" ? flow.develop : flow.master;
  await checked(root, ["switch", "-c", branch, from]);
  return `Started ${branch} from ${from}`;
}

export async function gitflowFinish(inputPath: string, type: FlowType, name: string, options: { tagMessage?: string; keepBranch?: boolean }): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const flow = await gitflowConfig(root);
  if (!flow.initialized) throw invalidError("initialise git-flow first");
  const short = name.startsWith(flow[type]) ? name.slice(flow[type].length) : name;
  const branch = await validBranchName(root, `${flow[type]}${short}`);
  const steps: string[] = [];
  if (type === "feature") {
    await checked(root, ["switch", flow.develop]);
    await checked(root, ["merge", "--no-ff", "--no-edit", branch]);
    steps.push(`merged into ${flow.develop}`);
  } else if (type === "release" || type === "hotfix") {
    await checked(root, ["switch", flow.master]);
    await checked(root, ["merge", "--no-ff", "--no-edit", branch]);
    const tag = `${flow.versionTag}${short}`;
    const sign = (await configGet(root, "tag.gpgsign")) === "true";
    await checked(root, ["tag", sign ? "-s" : "-a", tag, "-m", options.tagMessage?.trim() || `${type === "release" ? "Release" : "Hotfix"} ${short}`]);
    await checked(root, ["switch", flow.develop]);
    await checked(root, ["merge", "--no-ff", "--no-edit", branch]);
    steps.push(`merged into ${flow.master} and ${flow.develop}`, `tagged ${tag}${sign ? " (signed)" : ""}`);
  } else {
    throw invalidError("support branches are not finished");
  }
  if (!options.keepBranch) { await checked(root, ["branch", "-d", branch]); steps.push(`deleted ${branch}`); }
  return `Finished ${branch}: ${steps.join(", ")}`;
}

// --- Local-first AI explanations --------------------------------------------

async function ollama(prompt: string, model: string, tokens = 400): Promise<string | null> {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, prompt, options: { temperature: 0.2, num_predict: tokens } }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { response?: unknown };
    return typeof data.response === "string" && data.response.trim() ? data.response.trim() : null;
  } catch {
    return null;
  }
}

function summarizeStat(stat: string): string {
  const lines = stat.split(/\r?\n/).filter((line) => line.includes("|"));
  const dirs = new Map<string, number>();
  for (const line of lines) {
    const file = line.split("|")[0].trim();
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "(root)";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([dir, count]) => `- ${dir}: ${count} file(s)`);
  const total = stat.split(/\r?\n/).filter(Boolean).pop() ?? "";
  return [total.trim(), ...top].filter(Boolean).join("\n");
}

export type ExplainKind = "commit" | "branch" | "working" | "pr";

export async function explain(inputPath: string, kind: ExplainKind, ref: string | null, base: string | null): Promise<{ text: string; source: "ollama" | "local-rules"; title?: string }> {
  const root = await repositoryRoot(inputPath);
  const model = process.env.CHRONO_LOCAL_AI_MODEL || "qwen2.5:3b";
  let stat = "";
  let patch = "";
  let subjects: string[] = [];
  let heading = "";
  if (kind === "commit") {
    const rev = safeRev(ref ?? "HEAD");
    heading = (await checkedStdout(root, ["log", "-1", "--format=%s%n%n%b", rev])).trim();
    stat = (await checkedStdout(root, ["show", "--stat", "--format=", rev])).trim();
    patch = (await checkedStdout(root, ["show", "--format=", "--unified=2", rev])).slice(0, 12000);
  } else if (kind === "branch" || kind === "pr") {
    const head = safeRev(ref ?? "HEAD");
    const baseRev = base?.trim() ? safeRev(base) : await defaultBaseBranch(root, head) ?? "HEAD~1";
    subjects = (await checkedStdout(root, ["log", "--format=%s", "--no-merges", `${baseRev}..${head}`])).split(/\r?\n/).filter(Boolean).slice(0, 60);
    stat = (await checkedStdout(root, ["diff", "--stat", `${baseRev}...${head}`])).trim();
    patch = (await checkedStdout(root, ["diff", "--unified=1", `${baseRev}...${head}`])).slice(0, 12000);
    heading = `${head} vs ${baseRev}`;
  } else {
    stat = (await runGit(root, ["diff", "HEAD", "--stat"])).stdout.trim();
    patch = (await runGit(root, ["diff", "HEAD", "--unified=1"])).stdout.slice(0, 12000);
    heading = "working changes";
  }
  const task = kind === "pr"
    ? "Write a pull request description in Markdown with sections: Summary (2-3 sentences), Changes (bullets), Testing (bullets of what to check). Be factual; do not invent details."
    : "Explain these changes for a code reviewer in at most 6 short bullet points: what changed, why it likely changed, and any risk. Be factual; do not invent details.";
  const prompt = `${task}\n\nContext: ${heading}\n${subjects.length ? `Commits:\n${subjects.map((s) => `- ${s}`).join("\n")}\n` : ""}Diffstat:\n${stat}\n\nPatch (truncated):\n${patch}`;
  const modelText = await ollama(prompt, model, kind === "pr" ? 600 : 350);
  if (modelText) return { text: modelText, source: "ollama", title: subjects[0] };
  // Deterministic offline fallback.
  const summary = summarizeStat(stat);
  if (kind === "pr") {
    const text = `## Summary\n${subjects.length ? `This branch contains ${subjects.length} commit(s).` : "No commits ahead of the base branch."}\n\n## Changes\n${subjects.map((s) => `- ${s}`).join("\n") || "- (none)"}\n\n## Diffstat\n\`\`\`\n${summary}\n\`\`\`\n\n## Testing\n- [ ] Describe how this was tested`;
    return { text, source: "local-rules", title: subjects[subjects.length - 1] ?? subjects[0] };
  }
  const text = `${kind === "commit" ? `Commit: ${heading.split("\n")[0]}\n` : kind === "branch" ? `Branch ${heading}: ${subjects.length} commit(s)\n${subjects.slice(0, 10).map((s) => `• ${s}`).join("\n")}\n` : "Working changes\n"}\n${summary || "No changes."}\n\n(Offline summary — start Ollama on 127.0.0.1:11434 for an AI explanation.)`;
  return { text, source: "local-rules" };
}

// --- Sparse checkout helpers ------------------------------------------------

export async function sparseStatus(inputPath: string): Promise<{ enabled: boolean; cone: boolean; patterns: string[] }> {
  const root = await repositoryRoot(inputPath);
  const enabled = (await configGet(root, "core.sparsecheckout")) === "true";
  const cone = (await configGet(root, "core.sparsecheckoutcone")) !== "false";
  const list = enabled ? (await runGit(root, ["sparse-checkout", "list"])).stdout.split(/\r?\n/).filter(Boolean) : [];
  return { enabled, cone, patterns: list };
}

export async function sparseAction(inputPath: string, action: "set" | "add" | "reapply" | "disable", patterns: string[]): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  for (const pattern of patterns) if (!pattern.trim() || pattern.startsWith("-") || pattern.includes("\0")) throw invalidError(`invalid pattern: ${pattern}`);
  switch (action) {
    case "set": return checked(root, ["sparse-checkout", "set", "--cone", ...patterns]);
    case "add": return checked(root, ["sparse-checkout", "add", ...patterns]);
    case "reapply": return checked(root, ["sparse-checkout", "reapply"]);
    case "disable": return checked(root, ["sparse-checkout", "disable"]);
    default: throw invalidError("unknown sparse-checkout action");
  }
}

// --- Git notes --------------------------------------------------------------

export async function notesGet(inputPath: string, commit: string, ref = "commits"): Promise<string> {
  const root = await repositoryRoot(inputPath);
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw invalidError("invalid notes ref");
  const out = await runGit(root, ["notes", `--ref=${ref}`, "show", safeRev(commit)]);
  return out.code === 0 ? out.stdout.replace(/\s+$/, "") : "";
}

export async function notesSet(inputPath: string, commit: string, text: string, ref = "commits"): Promise<void> {
  const root = await repositoryRoot(inputPath);
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw invalidError("invalid notes ref");
  const sha = safeRev(commit);
  if (!text.trim()) { await runGit(root, ["notes", `--ref=${ref}`, "remove", "--ignore-missing", sha]); return; }
  await checked(root, ["notes", `--ref=${ref}`, "add", "-f", "-m", text, sha]);
}

// ===========================================================================
// Hosting providers: remote parsing, PR creation, CI checks
// ===========================================================================

export interface RemoteHost { provider: "github" | "gitlab" | "gitea"; host: string; owner: string; repository: string; apiBase: string; webBase: string }

export function parseRemote(url: string): RemoteHost | null {
  const trimmed = url.trim();
  let host = "";
  let repoPath = "";
  const scp = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    try { const parsed = new URL(trimmed); host = parsed.hostname; repoPath = parsed.pathname; } catch { return null; }
  } else if (scp) {
    host = scp[1]; repoPath = scp[2];
  } else return null;
  const parts = repoPath.replace(/^\/+/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repository = parts.pop()!;
  const owner = parts.join("/");
  if (host === "github.com") return { provider: "github", host, owner, repository, apiBase: "https://api.github.com", webBase: `https://github.com/${owner}/${repository}` };
  if (host.includes("gitlab")) return { provider: "gitlab", host, owner, repository, apiBase: `https://${host}/api/v4`, webBase: `https://${host}/${owner}/${repository}` };
  return { provider: "gitea", host, owner, repository, apiBase: `https://${host}/api/v1`, webBase: `https://${host}/${owner}/${repository}` };
}

export async function remoteHost(inputPath: string, remote: string): Promise<RemoteHost | null> {
  const root = await repositoryRoot(inputPath);
  const url = (await runGit(root, ["remote", "get-url", safeRev(remote, "remote")])).stdout.trim();
  return url ? parseRemote(url) : null;
}

export async function pullRequestTemplate(inputPath: string): Promise<string> {
  const root = await repositoryRoot(inputPath);
  for (const candidate of [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", ".gitlab/merge_request_templates/Default.md", ".gitea/pull_request_template.md"]) {
    try { return await fs.readFile(path.join(root, candidate), "utf8"); } catch { /* next */ }
  }
  return "";
}

async function providerFetch(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new AppError("http", `request to ${url} failed: ${(error as Error).message}`); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" ? String((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error ?? "") : "";
    throw new AppError("http", `provider responded ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return body;
}

function authHeaders(provider: RemoteHost["provider"], token: string): Record<string, string> {
  if (!token) return {};
  if (provider === "gitlab") return { "PRIVATE-TOKEN": token };
  return { Authorization: `Bearer ${token}` };
}

export async function createPullRequest(target: RemoteHost, token: string, request: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }> {
  if (!token) throw invalidError("a provider token is required to create pull requests");
  if (!request.title.trim()) throw invalidError("title is required");
  const headers = { "content-type": "application/json", Accept: "application/json", ...authHeaders(target.provider, token) };
  if (target.provider === "github") {
    const body = await providerFetch(`${target.apiBase}/repos/${target.owner}/${target.repository}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: request.title, body: request.body, head: request.head, base: request.base, draft: request.draft }) }) as Record<string, unknown>;
    return { number: Number(body.number), url: String(body.html_url) };
  }
  if (target.provider === "gitlab") {
    const project = encodeURIComponent(`${target.owner}/${target.repository}`);
    const body = await providerFetch(`${target.apiBase}/projects/${project}/merge_requests`, { method: "POST", headers, body: JSON.stringify({ title: request.draft ? `Draft: ${request.title}` : request.title, description: request.body, source_branch: request.head, target_branch: request.base }) }) as Record<string, unknown>;
    return { number: Number(body.iid), url: String(body.web_url) };
  }
  const body = await providerFetch(`${target.apiBase}/repos/${target.owner}/${target.repository}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: request.draft ? `WIP: ${request.title}` : request.title, body: request.body, head: request.head, base: request.base }) }) as Record<string, unknown>;
  return { number: Number(body.number), url: String(body.html_url ?? body.url) };
}

export interface CheckRun { id: string; name: string; status: string; conclusion: string; url: string; rerunnable: boolean }

export async function ciChecks(target: RemoteHost, token: string, sha: string): Promise<{ state: string; checks: CheckRun[] }> {
  const rev = safeRev(sha);
  const headers = { Accept: "application/json", ...authHeaders(target.provider, token) };
  const checks: CheckRun[] = [];
  if (target.provider === "github") {
    const runs = await providerFetch(`${target.apiBase}/repos/${target.owner}/${target.repository}/commits/${rev}/check-runs?per_page=100`, { headers }) as { check_runs?: Array<Record<string, unknown>> };
    for (const run of runs.check_runs ?? []) {
      const details = String(run.details_url ?? run.html_url ?? "");
      const conclusion = String(run.conclusion ?? "");
      checks.push({ id: String(run.id), name: String(run.name), status: String(run.status), conclusion, url: details, rerunnable: /\/actions\/runs\/\d+/.test(details) && ["failure", "cancelled", "timed_out", "action_required"].includes(conclusion) });
    }
    const combined = await providerFetch(`${target.apiBase}/repos/${target.owner}/${target.repository}/commits/${rev}/status`, { headers }).catch(() => null) as { statuses?: Array<Record<string, unknown>> } | null;
    for (const status of combined?.statuses ?? []) checks.push({ id: String(status.id), name: String(status.context), status: "completed", conclusion: String(status.state), url: String(status.target_url ?? ""), rerunnable: false });
  } else if (target.provider === "gitlab") {
    const project = encodeURIComponent(`${target.owner}/${target.repository}`);
    const pipelines = await providerFetch(`${target.apiBase}/projects/${project}/pipelines?sha=${rev}&per_page=20`, { headers }) as Array<Record<string, unknown>>;
    for (const pipeline of pipelines ?? []) checks.push({ id: String(pipeline.id), name: `pipeline #${String(pipeline.id)} (${String(pipeline.ref ?? "")})`, status: ["success", "failed", "canceled", "skipped"].includes(String(pipeline.status)) ? "completed" : String(pipeline.status), conclusion: String(pipeline.status), url: String(pipeline.web_url ?? ""), rerunnable: String(pipeline.status) === "failed" });
  } else {
    const combined = await providerFetch(`${target.apiBase}/repos/${target.owner}/${target.repository}/commits/${rev}/status`, { headers }) as { statuses?: Array<Record<string, unknown>> };
    for (const status of combined.statuses ?? []) checks.push({ id: String(status.id), name: String(status.context), status: "completed", conclusion: String(status.status ?? status.state ?? ""), url: String(status.target_url ?? ""), rerunnable: false });
  }
  const failed = checks.some((check) => ["failure", "failed", "error", "timed_out", "cancelled", "action_required"].includes(check.conclusion));
  const pending = checks.some((check) => check.status !== "completed" || ["pending", "running", "created"].includes(check.conclusion));
  return { state: !checks.length ? "none" : failed ? "failure" : pending ? "pending" : "success", checks };
}

export async function rerunCheck(target: RemoteHost, token: string, check: CheckRun): Promise<string> {
  if (!token) throw invalidError("a provider token is required");
  const headers = { Accept: "application/json", ...authHeaders(target.provider, token) };
  if (target.provider === "github") {
    const runId = /\/actions\/runs\/(\d+)/.exec(check.url)?.[1];
    if (!runId) throw invalidError("only GitHub Actions runs can be re-run from Chrono");
    await fetch(`${target.apiBase}/repos/${target.owner}/${target.repository}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST", headers, signal: AbortSignal.timeout(20000) }).then((response) => { if (!response.ok) throw new AppError("http", `provider responded ${response.status}`); });
    return `Re-running failed jobs of run ${runId}`;
  }
  if (target.provider === "gitlab") {
    const project = encodeURIComponent(`${target.owner}/${target.repository}`);
    await providerFetch(`${target.apiBase}/projects/${project}/pipelines/${encodeURIComponent(check.id)}/retry`, { method: "POST", headers });
    return `Retrying pipeline ${check.id}`;
  }
  throw new AppError("unsupported", "re-running checks is not supported for this provider");
}

// ===========================================================================
// Repository treemap (size and churn per file)
// ===========================================================================

export interface TreemapFile { path: string; size: number; churn: number; commits: number }

export async function repoTreemap(inputPath: string, revision: string, days: number): Promise<{ revision: string; files: TreemapFile[]; truncated: boolean; days: number }> {
  const root = await repositoryRoot(inputPath);
  const rev = safeRev(revision || "HEAD");
  if (!(await hasHead(root))) return { revision: rev, files: [], truncated: false, days };
  const tree = await checkedStdout(root, ["ls-tree", "-r", "-l", "-z", rev]);
  const files = new Map<string, TreemapFile>();
  for (const record of tree.split("\0")) {
    const match = /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(record);
    if (match) files.set(match[2], { path: match[2], size: match[1] === "-" ? 0 : Number(match[1]), churn: 0, commits: 0 });
  }
  const span = Math.min(Math.max(Math.floor(days) || 90, 1), 3650);
  const log = await runGit(root, ["log", rev, `--since=${span}.days`, "--numstat", "--format=%x1e", "--no-renames", "-n", "20000"]);
  for (const chunk of log.stdout.split("\u001e")) {
    for (const line of chunk.split(/\r?\n/)) {
      const [add, del, ...rest] = line.split("\t");
      const file = rest.join("\t");
      const entry = file ? files.get(file) : undefined;
      if (!entry) continue;
      entry.churn += (Number(add) || 0) + (Number(del) || 0);
      entry.commits += 1;
    }
  }
  const all = [...files.values()];
  const LIMIT = 60000;
  return { revision: rev, files: all.length > LIMIT ? all.sort((a, b) => b.size - a.size).slice(0, LIMIT) : all, truncated: all.length > LIMIT, days: span };
}
