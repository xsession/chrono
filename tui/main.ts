// Chrono TUI: a keyboard-driven terminal interface in the style of lazygit,
// for people who live in the terminal or have nothing else (SSH, servers).
// It runs the same backend as the desktop app, directly, without a server:
// nested submodule commits, the undo journal, hooks, AI commit drafts and the
// live file watcher all work here too. No dependencies beyond Node itself.
//
//   npm run tui [-- <path>]      or   node bin/chrono-tui.mjs [path]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import * as backend from "../server/src/backend.ts";
import { draftCommitMessage } from "../server/src/commitWriter.ts";
import * as features from "../server/src/features.ts";
import * as forks from "../server/src/forks.ts";
import * as gk from "../server/src/gkOps.ts";
import { repositoryRoot, runGit } from "../server/src/lib/git.ts";
import { stopLlamaServer } from "../server/src/localLlm.ts";
import { closeAllWatches, waitForChange } from "../server/src/repoWatch.ts";
import * as repo from "../server/src/repo.ts";

// ----------------------------------------------------------------- styled text

type Style = { fg?: number; bg?: number; bold?: boolean; dim?: boolean; inverse?: boolean };
type Seg = [string, Style?];
type Line = Seg[];

const C = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, grey: 90, brightGreen: 92, brightCyan: 96 };
const sgr = (style?: Style) => {
  if (!style) return "";
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.inverse) codes.push(7);
  if (style.fg) codes.push(style.fg);
  if (style.bg) codes.push(style.bg);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
};
/** Strip control characters so file names and git output cannot move the cursor. */
const clean = (text: string) => text.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]|\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Render a line clipped/padded to exactly `width` columns. */
function fit(line: Line, width: number, fill?: Style): string {
  let out = "";
  let used = 0;
  for (const [raw, style] of line) {
    if (used >= width) break;
    const text = clean(raw);
    const chars = [...text];
    const take = chars.slice(0, width - used).join("");
    out += `${sgr(style)}${take}${style ? "\x1b[0m" : ""}`;
    used += [...take].length;
  }
  if (used < width) out += `${sgr(fill)}${" ".repeat(width - used)}${fill ? "\x1b[0m" : ""}`;
  return out;
}

// ----------------------------------------------------------------- state

type PanelId = "status" | "files" | "branches" | "commits" | "stash";
const PANELS: PanelId[] = ["status", "files", "branches", "commits", "stash"];
const TITLES: Record<PanelId, string> = { status: "Status", files: "Files", branches: "Branches", commits: "Commits", stash: "Stash" };

interface FileRow { path: string; staged: boolean; unstaged: boolean; code: string; conflicted: boolean; submodule: string | null }
interface Row { key: string; line: Line }

type Overlay =
  | { kind: "prompt"; title: string; value: string; cursor: number; hint?: string; onSubmit: (value: string) => Promise<void> | void }
  | { kind: "confirm"; title: string; text: string; onYes: () => Promise<void> | void }
  | { kind: "help" }
  | null;

const state = {
  root: "",
  focus: 1, // files
  selected: new Map<PanelId, number>(),
  scroll: new Map<PanelId, number>(),
  mainScroll: 0,
  mainFocus: false,
  summary: null as backend.RepositorySummary | null,
  files: [] as FileRow[],
  branches: [] as backend.BranchRecord[],
  commits: [] as Array<{ sha: string; graph: string; text: string }>,
  stashes: [] as Array<{ ref: string; subject: string }>,
  forks: [] as forks.ForkStatus[],
  main: [] as Line[],
  mainTitle: "",
  message: { text: "", error: false },
  busy: "",
  overlay: null as Overlay,
  mainKey: "",
  quitting: false,
};

const focused = () => PANELS[state.focus];
const sel = (panel: PanelId) => state.selected.get(panel) ?? 0;
const say = (text: string, error = false) => { state.message = { text, error }; };

// ----------------------------------------------------------------- data

const statusCode = (change: backend.FileChange) => (change.conflicted ? "UU" : `${change.indexStatus || " "}${change.worktreeStatus || " "}`);

async function loadAll(): Promise<void> {
  const root = state.root;
  const [summary, changes, branches, log, stashes, forkTree] = await Promise.all([
    backend.repositorySummary(root),
    backend.repositoryStatus(root),
    backend.repositoryBranches(root).catch(() => [] as backend.BranchRecord[]),
    runGit(root, ["log", "--graph", "--all", "--exclude=refs/stash", "--exclude=refs/notes/*", "--exclude=refs/chrono/*", "-n", "300", "--format=%x1f%h%x1f%ar%x1f%an%x1f%d %s"]),
    runGit(root, ["stash", "list", "--format=%gd%x1f%s"]),
    forks.forkTree(root).catch(() => [] as forks.ForkStatus[]),
  ]);
  state.forks = forkTree;
  state.summary = summary;
  state.files = changes.map((change) => {
    const inner = change.submodule;
    const stagedInside = inner ? hasStagedInside(inner) : false;
    const unstagedWorktree = change.conflicted || (change.worktreeStatus !== " " && change.worktreeStatus !== "") || change.indexStatus === "?";
    const stagedIndex = !change.conflicted && change.indexStatus !== " " && change.indexStatus !== "?" && change.indexStatus !== "";
    return {
      path: change.path,
      staged: stagedIndex || stagedInside,
      unstaged: unstagedWorktree,
      code: statusCode(change),
      conflicted: change.conflicted,
      submodule: inner ? describeSubmodule(inner) : null,
    };
  });
  state.branches = [...branches].sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
  state.commits = log.stdout.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\x1f");
    return parts.length >= 5 ? { graph: parts[0], sha: parts[1], text: `${parts[1]} ${parts[4].trim()}` } : { graph: parts[0], sha: "", text: "" };
  });
  state.stashes = stashes.stdout.split("\n").filter(Boolean).map((line) => { const [ref, subject] = line.split("\x1f"); return { ref, subject: subject ?? "" }; });
  for (const panel of PANELS) state.selected.set(panel, Math.min(sel(panel), Math.max(0, rowsOf(panel).length - 1)));
}

/** Anything staged inside a submodule (or deeper) counts: it will get its own commit. */
function hasStagedInside(info: NonNullable<backend.FileChange["submodule"]>): boolean {
  return info.changes.some((change) => (!change.conflicted && change.indexStatus !== " " && change.indexStatus !== "?" && change.indexStatus !== "") || (change.submodule ? hasStagedInside(change.submodule) : false));
}

function describeSubmodule(info: NonNullable<backend.FileChange["submodule"]>): string {
  const parts: string[] = [];
  if (info.newCommits) parts.push(info.movedBack ? "other commit checked out" : `${info.commits.length}${info.moreCommits ? "+" : ""} new commit${info.commits.length === 1 ? "" : "s"}`);
  if (info.changes.length) parts.push(`${info.changes.length} changed`);
  return parts.join(", ") || "changed";
}

// ----------------------------------------------------------------- panel rows

function rowsOf(panel: PanelId): Row[] {
  switch (panel) {
    case "status": {
      const s = state.summary;
      if (!s) return [{ key: "x", line: [["loading…", { fg: C.grey }]] }];
      const sync = s.ahead || s.behind ? ` ↑${s.ahead} ↓${s.behind}` : "";
      const fork = state.forks.find((entry) => entry.path === "" && entry.kind === "fork");
      const forkText = fork ? `  ⑂${fork.behind ? ` ↓${fork.behind} upstream` : ""}` : "";
      return [{ key: "status", line: [[`${s.name} → `, { fg: C.grey }], [s.branch ?? "(detached)", { fg: C.brightGreen, bold: true }], [sync, { fg: C.yellow }], [s.dirty ? " ●" : "", { fg: C.yellow }], [forkText, { fg: fork?.behind ? C.yellow : C.cyan }]] }];
    }
    case "files":
      return state.files.map((file) => {
        const color = file.conflicted ? C.red : file.staged && !file.unstaged ? C.green : file.staged ? C.yellow : C.red;
        return { key: file.path, line: [
          [file.code.padEnd(3), { fg: color }],
          [file.path, { fg: file.submodule ? C.magenta : undefined }],
          [file.submodule ? `  (submodule: ${file.submodule})` : "", { fg: C.grey }],
        ] };
      });
    case "branches":
      return state.branches.map((branch) => ({ key: branch.name, line: [
        [branch.current ? "* " : "  ", { fg: C.brightGreen, bold: true }],
        [branch.name, { fg: branch.remote ? C.red : branch.current ? C.brightGreen : undefined }],
        [branch.upstream && !branch.remote ? `  → ${branch.upstream}` : "", { fg: C.grey }],
      ] }));
    case "commits":
      return state.commits.map((commit, index) => ({ key: `${index}`, line: [
        [commit.graph, { fg: C.cyan }],
        [commit.sha ? `${commit.sha} ` : "", { fg: C.yellow }],
        [commit.sha ? commit.text.slice(commit.sha.length + 1) : "", {}],
      ] }));
    case "stash":
      return state.stashes.map((stash) => ({ key: stash.ref, line: [[`${stash.ref} `, { fg: C.yellow }], [stash.subject, {}]] }));
  }
}

// ----------------------------------------------------------------- main view

const diffLine = (text: string): Line => {
  if (text.startsWith("+++") || text.startsWith("---")) return [[text, { bold: true }]];
  if (text.startsWith("+")) return [[text, { fg: C.green }]];
  if (text.startsWith("-")) return [[text, { fg: C.red }]];
  if (text.startsWith("@@")) return [[text, { fg: C.cyan }]];
  if (/^(diff --git|index |commit |Merge:|Author:|Date:|new file|deleted file)/.test(text)) return [[text, { fg: C.yellow }]];
  return [[text]];
};
const textLines = (text: string): Line[] => text.replace(/\s+$/, "").split("\n").map(diffLine);

async function buildMain(): Promise<void> {
  const panel = focused();
  const root = state.root;
  const index = sel(panel);
  let key: string = panel;
  let title = "";
  let lines: Line[] = [];
  if (panel === "files") {
    const file = state.files[index];
    key = `files:${file?.path}:${file?.code}`;
    if (!file) { title = "Diff"; lines = [[["No changes. ", { fg: C.grey }], ["Working tree clean.", { fg: C.green }]]]; }
    else if (file.submodule) {
      title = `Submodule ${file.path}`;
      const sub = path.join(root, file.path);
      const [status, log] = await Promise.all([runGit(sub, ["status", "--short", "--branch"]), runGit(sub, ["log", "--oneline", "-n", "15"])]);
      lines = [[[`${file.path}: ${file.submodule}`, { fg: C.magenta, bold: true }]], [], [["Status inside the submodule:", { bold: true }]], ...textLines(status.stdout), [], [["Recent commits:", { bold: true }]], ...textLines(log.stdout),
        [], [["space stages everything inside it; committing here commits it first, then records its new commit id.", { fg: C.grey }]]];
    } else {
      title = `Diff ${file.path}`;
      const untracked = file.code.startsWith("?");
      const [staged, unstaged] = await Promise.all([
        file.staged ? runGit(root, ["diff", "--cached", "--no-color", "--", file.path]) : Promise.resolve({ stdout: "" }),
        untracked ? runGit(root, ["diff", "--no-index", "--no-color", "--", process.platform === "win32" ? "NUL" : "/dev/null", file.path]) : file.unstaged ? runGit(root, ["diff", "--no-color", "--", file.path]) : Promise.resolve({ stdout: "" }),
      ]);
      if (staged.stdout.trim()) lines.push([["── staged ──", { fg: C.green, bold: true }]], ...textLines(staged.stdout), []);
      if (unstaged.stdout.trim()) lines.push([[untracked ? "── new file ──" : "── unstaged ──", { fg: C.red, bold: true }]], ...textLines(unstaged.stdout));
      if (!lines.length) lines = [[["(no textual diff)", { fg: C.grey }]]];
    }
  } else if (panel === "branches") {
    const branch = state.branches[index];
    key = `branches:${branch?.name}`;
    title = branch ? `Log ${branch.name}` : "Branches";
    if (branch) lines = (await runGit(root, ["log", "--graph", "--no-color", "--format=%h %d %s  (%an, %ar)", "-n", "200", branch.name])).stdout.split("\n").map((text) => [[text]] as Line);
  } else if (panel === "commits") {
    const commit = state.commits[index];
    key = `commits:${commit?.sha}`;
    title = commit?.sha ? `Commit ${commit.sha}` : "Commits";
    if (commit?.sha) lines = textLines((await runGit(root, ["show", "--stat", "--patch", "--no-color", commit.sha])).stdout);
  } else if (panel === "stash") {
    const stash = state.stashes[index];
    key = `stash:${stash?.ref}`;
    title = stash ? `Stash ${stash.ref}` : "Stash";
    if (stash) lines = textLines((await runGit(root, ["stash", "show", "-p", "--include-untracked", "--no-color", stash.ref])).stdout);
  } else {
    title = "Chrono";
    const s = state.summary;
    lines = [
      [["Chrono TUI", { bold: true, fg: C.brightCyan }], ["  ·  the same backend as the desktop app", { fg: C.grey }]],
      [],
      [["Repository  ", { fg: C.grey }], [state.root]],
      [["Branch      ", { fg: C.grey }], [s?.branch ?? "(detached)", { fg: C.brightGreen }], [state.branches.find((branch) => branch.current)?.upstream ? `  tracking ${state.branches.find((branch) => branch.current)?.upstream}` : "", { fg: C.grey }]],
      [["HEAD        ", { fg: C.grey }], [s?.head?.slice(0, 12) ?? "(no commits)"]],
      [["Sync        ", { fg: C.grey }], [s ? `${s.ahead} ahead, ${s.behind} behind` : ""]],
      [],
      [["Press ? for all keys. Panels: 1 status · 2 files · 3 branches · 4 commits · 5 stash", { fg: C.grey }]],
      [],
      [["Forks & upstreams", { bold: true, fg: C.brightCyan }], ["  (F: fetch upstreams and fast-forward every fork)", { fg: C.grey }]],
      ...state.forks.map((entry): Line => {
        const name = `${"  ".repeat(entry.depth)}${entry.path || entry.name}`.padEnd(28);
        if (entry.kind !== "fork") return [[name, {}], [entry.kind === "plain" ? "not a known fork" : "local only", { fg: C.grey }]];
        const up = entry.upstream?.owner ? `${entry.upstream.owner}/${entry.upstream.repository}` : entry.upstream?.url ?? "";
        const where = entry.defaultBranch ? (entry.behind === null ? `${entry.defaultBranch}: no local branch` : entry.behind ? `${entry.defaultBranch} ↓${entry.behind} behind` : `${entry.defaultBranch} up to date`) : "fetch upstream first";
        return [[name, {}], ["⑂ ", { fg: C.cyan }], [`${up}  `, { fg: C.grey }], [where, { fg: entry.behind ? C.yellow : C.green }], [entry.ahead ? `  ↑${entry.ahead} own` : "", { fg: C.magenta }]];
      }),
    ];
  }
  if (key !== state.mainKey) state.mainScroll = 0;
  state.mainKey = key;
  state.mainTitle = title;
  state.main = lines;
}

// ----------------------------------------------------------------- layout & drawing

const out = process.stdout;
const write = (text: string) => out.write(text);

function box(title: string, rows: string[], width: number, height: number, active: boolean, footer = ""): string[] {
  const color = active ? C.brightGreen : C.grey;
  const inner = width - 2;
  const head = `─${title ? ` ${title} ` : ""}`;
  const top = `${sgr({ fg: color, bold: active })}╭${head}${"─".repeat(Math.max(0, inner - [...head].length))}╮\x1b[0m`;
  const foot = footer ? ` ${footer} ` : "";
  const bottom = `${sgr({ fg: color })}╰${"─".repeat(Math.max(0, inner - [...foot].length - 1))}${foot}─╯\x1b[0m`;
  const body: string[] = [];
  for (let i = 0; i < height - 2; i++) body.push(`${sgr({ fg: color })}│\x1b[0m${rows[i] ?? " ".repeat(inner)}${sgr({ fg: color })}│\x1b[0m`);
  return [top, ...body, bottom];
}

function panelHeights(total: number): number[] {
  // Status is 3 rows; the focused panel gets the most room.
  const rest = total - 3;
  const weights = PANELS.slice(1).map((panel, i) => (state.focus === i + 1 ? 3 : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const heights = weights.map((w) => Math.max(3, Math.floor((rest * w) / sum)));
  heights[heights.length - 1] += rest - heights.reduce((a, b) => a + b, 0);
  return [3, ...heights];
}

const KEYS: Record<PanelId | "global", string> = {
  global: "q quit · ? keys · ←→/tab panels · p pull · P push · f fetch · F sync forks · z undo · Z redo · r refresh",
  status: "enter: open repository info",
  files: "space stage · a stage all · c commit · C AI draft · A amend · d discard · s stash · e edit",
  branches: "space checkout · n new · d delete · M merge into current · R rebase current onto",
  commits: "enter/l scroll diff · J/K scroll · n new branch here",
  stash: "space apply · g pop · d drop",
};

function draw(): void {
  if (state.quitting) return;
  const cols = out.columns || 100;
  const rows = out.rows || 30;
  const leftW = Math.max(28, Math.min(70, Math.floor(cols * 0.38)));
  const rightW = cols - leftW;
  const bodyH = rows - 1;
  const heights = panelHeights(bodyH);
  const left: string[] = [];
  PANELS.forEach((panel, i) => {
    const h = heights[i];
    const items = rowsOf(panel);
    const visible = h - 2;
    let scroll = state.scroll.get(panel) ?? 0;
    const index = sel(panel);
    if (index < scroll) scroll = index;
    if (index >= scroll + visible) scroll = index - visible + 1;
    state.scroll.set(panel, Math.max(0, scroll));
    const lines: string[] = [];
    for (let r = 0; r < visible; r++) {
      const item = items[scroll + r];
      const selected = Boolean(item) && scroll + r === index && state.focus === i && !state.mainFocus;
      const dimSelected = Boolean(item) && scroll + r === index && !selected;
      const line = !item ? [] : selected ? item.line.map(([text, style]) => [text, { ...style, bg: 44 }] as Seg) : dimSelected ? item.line.map(([text, style]) => [text, { ...style, bg: 100 }] as Seg) : item.line;
      lines.push(fit(line, leftW - 2, selected ? { bg: 44 } : dimSelected ? { bg: 100 } : undefined));
    }
    const count = panel === "status" ? "" : `${items.length ? index + 1 : 0} of ${items.length}`;
    left.push(...box(`[${i + 1}] ${TITLES[panel]}`, lines, leftW, h, state.focus === i && !state.mainFocus, count));
  });
  const mainVisible = bodyH - 2;
  const maxScroll = Math.max(0, state.main.length - mainVisible);
  state.mainScroll = Math.min(state.mainScroll, maxScroll);
  const mainRows = state.main.slice(state.mainScroll, state.mainScroll + mainVisible).map((line) => fit(line, rightW - 2));
  const position = state.main.length > mainVisible ? `${state.mainScroll + 1}-${Math.min(state.main.length, state.mainScroll + mainVisible)} of ${state.main.length}` : "";
  const right = box(state.mainTitle, mainRows, rightW, bodyH, state.mainFocus, position);
  let screen = "\x1b[H";
  for (let r = 0; r < bodyH; r++) screen += `${left[r] ?? " ".repeat(leftW)}${right[r] ?? ""}\x1b[K\r\n`;
  // Bottom line: what is happening, or the keys for this panel.
  const status: Line = state.busy
    ? [[`⏳ ${state.busy}`, { fg: C.yellow, bold: true }]]
    : state.message.text
      ? [[state.message.text, { fg: state.message.error ? C.red : C.brightGreen }]]
      : [[KEYS[focused()], { fg: C.cyan }], ["  │  ", { fg: C.grey }], [KEYS.global, { fg: C.grey }]];
  screen += fit(status, cols);
  write(screen + drawOverlay(cols, rows));
}

function drawOverlay(cols: number, rows: number): string {
  const overlay = state.overlay;
  if (!overlay) return "";
  let lines: Line[] = [];
  let title = "";
  if (overlay.kind === "prompt") {
    title = overlay.title;
    const width = Math.min(cols - 6, 90) - 4;
    const value = overlay.value;
    // Show the end of long values; the cursor is drawn as an inverse cell.
    const before = value.slice(0, overlay.cursor);
    const at = value[overlay.cursor] ?? " ";
    const after = value.slice(overlay.cursor + 1);
    const visible = [...before].slice(-(width - 2)).join("");
    lines = [[[visible], [at, { inverse: true }], [after]], [], [[overlay.hint ?? "enter: confirm · esc: cancel", { fg: C.grey }]]];
  } else if (overlay.kind === "confirm") {
    title = overlay.title;
    lines = [...overlay.text.split("\n").map((text) => [[text]] as Line), [], [["y / enter: yes · n / esc: no", { fg: C.grey }]]];
  } else {
    title = "Keys";
    lines = [
      [["Everywhere", { bold: true, fg: C.brightCyan }]],
      ...[["q / ctrl-c", "quit"], ["1-5, tab, ←/→, h/l", "switch panel"], ["j/k, ↑/↓", "move"], ["enter", "focus the diff (j/k/pgup/pgdn scroll, esc back)"], ["J / K, ctrl-d / ctrl-u", "scroll the diff"], ["p / P / f", "pull (ff-only) / push / fetch"], ["F", "sync forks: fetch upstreams, fast-forward default branches (with submodules)"], ["z / Z", "undo / redo (Chrono's journal)"], ["r", "refresh (also automatic)"]].map(([k, v]) => [[`  ${k.padEnd(24)}`, { fg: C.yellow }], [v]] as Line),
      [], [["Files", { bold: true, fg: C.brightCyan }]],
      ...[["space", "stage / unstage (a submodule: everything inside it)"], ["a", "stage all / unstage all"], ["c", "commit (stages everything if nothing is staged)"], ["C", "commit with an AI-drafted message"], ["A", "amend the last commit"], ["d", "discard changes to the file"], ["s", "stash all changes"], ["e", "open the file in $EDITOR"]].map(([k, v]) => [[`  ${k.padEnd(24)}`, { fg: C.yellow }], [v]] as Line),
      [], [["Branches · Commits · Stash", { bold: true, fg: C.brightCyan }]],
      ...[["space", "checkout branch / apply stash"], ["n", "new branch (from HEAD, or the selected commit)"], ["d", "delete branch / drop stash"], ["M / R", "merge into current / rebase current onto"], ["g", "pop stash"]].map(([k, v]) => [[`  ${k.padEnd(24)}`, { fg: C.yellow }], [v]] as Line),
      [], [["Commits from here go through nested submodules: each submodule with staged changes is committed first.", { fg: C.grey }]],
      [["any key closes this", { fg: C.grey }]],
    ];
  }
  const width = Math.min(cols - 4, Math.max(50, Math.min(96, Math.max(...lines.map((line) => line.reduce((n, [t]) => n + [...t].length, 0))) + 4)));
  const height = Math.min(rows - 2, lines.length + 2);
  const x = Math.floor((cols - width) / 2) + 1;
  const y = Math.max(1, Math.floor((rows - height) / 2));
  const framed = box(title, lines.slice(0, height - 2).map((line) => fit(line, width - 2)), width, height, true);
  return framed.map((row, i) => `\x1b[${y + i};${x}H${row}`).join("");
}

// ----------------------------------------------------------------- actions

async function refresh(): Promise<void> {
  try { await loadAll(); await buildMain(); } catch (error) { say(errorText(error), true); }
  draw();
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();

/** Run a git action with a busy line, then refresh. */
async function act(label: string, work: () => Promise<unknown>, done?: string): Promise<void> {
  state.busy = `${label}…`;
  say("");
  draw();
  try {
    const result = await work();
    // An action that reported its own outcome (commit) keeps its message.
    if (!state.message.text) say(typeof result === "string" && result.trim() && !done ? result.trim().split("\n").pop()! : done ?? `${label}: done`);
  } catch (error) {
    say(`${label}: ${errorText(error)}`, true);
  } finally {
    state.busy = "";
    await refresh();
  }
}

function prompt(title: string, initial: string, onSubmit: (value: string) => Promise<void> | void, hint?: string) {
  state.overlay = { kind: "prompt", title, value: initial, cursor: initial.length, hint, onSubmit };
  draw();
}
function confirm(title: string, text: string, onYes: () => Promise<void> | void) {
  state.overlay = { kind: "confirm", title, text, onYes };
  draw();
}

async function commit(message: string, amend = false, noVerify = false): Promise<void> {
  const nothingStaged = !state.files.some((file) => file.staged);
  if (nothingStaged && !amend) await backend.stagePaths(state.root, state.files.map((file) => file.path));
  const result = await features.commitWithHooks(state.root, { message, amend, noVerify });
  if (!result.ok) {
    if (result.hookFailed) {
      confirm(`${result.hookFailed} hook failed`, `${result.output.trim().split("\n").slice(-6).join("\n")}\n\nCommit anyway with --no-verify?`, () => act("Commit (hooks bypassed)", () => commit(message, amend, true)));
      return;
    }
    throw new Error(result.output.trim().split("\n").pop() || "commit failed");
  }
  const nested = result.nested?.length ? ` (also committed in ${result.nested.map((entry) => entry.path).join(", ")})` : "";
  say(`Committed ${result.commit?.slice(0, 8)}${nested}`);
}

function commitPrompt(initial: string, amend = false) {
  prompt(amend ? "Amend commit" : "Commit message", initial, (value) => {
    if (!value.trim() && !amend) { say("Commit message is empty", true); return; }
    return act(amend ? "Amending" : "Committing", async () => { await commit(value, amend); return undefined; }, undefined);
  }, "enter: commit · esc: cancel · ctrl-u: clear");
}

async function onFilesKey(name: string): Promise<boolean> {
  const file = state.files[sel("files")];
  switch (name) {
    case "space":
      if (!file) return true;
      await act(file.staged && !file.unstaged ? "Unstaging" : "Staging", () => (file.staged && !file.unstaged ? backend.unstagePaths(state.root, [file.path]) : backend.stagePaths(state.root, [file.path])), " ");
      return true;
    case "a": {
      const allStaged = state.files.length > 0 && state.files.every((entry) => entry.staged && !entry.unstaged);
      await act(allStaged ? "Unstaging all" : "Staging all", () => (allStaged ? backend.unstagePaths(state.root, state.files.map((entry) => entry.path)) : backend.stagePaths(state.root, state.files.filter((entry) => !entry.conflicted).map((entry) => entry.path))), " ");
      return true;
    }
    case "c":
      if (!state.files.length) { say("Nothing to commit", true); draw(); return true; }
      commitPrompt("");
      return true;
    case "C": {
      if (!state.files.length) { say("Nothing to commit", true); draw(); return true; }
      state.busy = "Drafting a commit message…";
      draw();
      try {
        if (!state.files.some((entry) => entry.staged)) await backend.stagePaths(state.root, state.files.map((entry) => entry.path));
        const draft = await draftCommitMessage(state.root, "auto", null, { style: "conventional" });
        state.busy = "";
        await refresh();
        say(draft.source === "local-rules" ? `Offline draft${draft.notice ? ` (${draft.notice})` : ""}` : `Drafted by ${draft.source}${draft.model ? ` (${draft.model})` : ""}`, Boolean(draft.notice));
        commitPrompt(draft.message.replace(/\n+/g, " ⏎ "));
      } catch (error) { state.busy = ""; say(`Draft: ${errorText(error)}`, true); draw(); }
      return true;
    }
    case "A":
      commitPrompt((await gk.lastCommitMessage(state.root)).split("\n")[0] ?? "", true);
      return true;
    case "d":
      if (!file) return true;
      confirm("Discard changes", `Discard all changes to ${file.path}?${file.code.startsWith("?") ? "\nThe untracked file is deleted." : ""}\nThis can be undone with z (Chrono's journal) only for tracked files.`, () => act("Discarding", () => gk.journaled(state.root, `Discard ${file.path}`, "keep", () => gk.discard(state.root, [file.path])), `Discarded ${file.path}`));
      return true;
    case "s":
      prompt("Stash message", "", (value) => act("Stashing", () => backend.runWorkflow(state.root, { operation: "stash_push", args: value.trim() ? [value.trim()] : [] }), "Stashed"));
      return true;
    case "e":
      if (!file || file.submodule) return true;
      editFile(path.join(state.root, file.path));
      return true;
  }
  return false;
}

async function onBranchKey(name: string): Promise<boolean> {
  const branch = state.branches[sel("branches")];
  switch (name) {
    case "space":
      if (!branch || branch.current) return true;
      await act(`Checking out ${branch.name}`, () => gk.journaled(state.root, `Checkout ${branch.name}`, "keep", () => (branch.remote ? backend.checkoutRemoteBranch(state.root, branch.name) : backend.switchBranch(state.root, branch.name))), `Checked out ${branch.name}`);
      return true;
    case "n":
      prompt("New branch name (from HEAD, checked out)", "", (value) => act("Creating branch", () => gk.journaled(state.root, `Create branch ${value}`, "keep", () => backend.createBranch(state.root, value.trim())), `Created and checked out ${value.trim()}`));
      return true;
    case "d":
      if (!branch || branch.current || branch.remote) { say(branch?.current ? "Cannot delete the checked-out branch" : "Select a local branch", true); draw(); return true; }
      confirm("Delete branch", `Delete ${branch.name}?`, () => act("Deleting", () => gk.journaled(state.root, `Delete branch ${branch.name}`, "keep", () => repo.deleteBranch(state.root, branch.name, false)), `Deleted ${branch.name}`));
      return true;
    case "M":
      if (!branch || branch.current) return true;
      confirm("Merge", `Merge ${branch.name} into ${state.summary?.branch ?? "HEAD"}?`, () => act("Merging", () => gk.journaled(state.root, `Merge ${branch.name}`, "keep", () => gk.branchAction(state.root, { action: "merge_into_current", branch: branch.name })), `Merged ${branch.name}`));
      return true;
    case "R":
      if (!branch || branch.current) return true;
      confirm("Rebase", `Rebase ${state.summary?.branch ?? "HEAD"} onto ${branch.name}?`, () => act("Rebasing", () => gk.journaled(state.root, `Rebase onto ${branch.name}`, "keep", () => gk.branchAction(state.root, { action: "rebase_current_onto", branch: branch.name })), `Rebased onto ${branch.name}`));
      return true;
  }
  return false;
}

async function onCommitKey(name: string): Promise<boolean> {
  const commitRow = state.commits[sel("commits")];
  if (name === "n" && commitRow?.sha) {
    prompt(`New branch at ${commitRow.sha}`, "", (value) => act("Creating branch", () => gk.journaled(state.root, `Create branch ${value}`, "keep", () => backend.createBranchAt(state.root, value.trim(), commitRow.sha)), `Created ${value.trim()} at ${commitRow.sha}`));
    return true;
  }
  return false;
}

async function onStashKey(name: string): Promise<boolean> {
  const stash = state.stashes[sel("stash")];
  if (!stash) return false;
  if (name === "space") { await act("Applying", () => backend.runWorkflow(state.root, { operation: "stash_apply", args: [stash.ref] }), `Applied ${stash.ref}`); return true; }
  if (name === "g") { await act("Popping", () => gk.journaled(state.root, "stash pop", "keep", () => backend.runWorkflow(state.root, { operation: "stash_pop", args: [stash.ref] })), `Popped ${stash.ref}`); return true; }
  if (name === "d") { confirm("Drop stash", `Drop ${stash.ref} (${stash.subject})?`, () => act("Dropping", () => backend.runWorkflow(state.root, { operation: "stash_drop", args: [stash.ref] }), `Dropped ${stash.ref}`)); return true; }
  return false;
}

// ----------------------------------------------------------------- terminal

function enterScreen() {
  write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
}
function leaveScreen() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  write("\x1b[0m\x1b[?25h\x1b[?1049l");
}

function editFile(file: string) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  leaveScreen();
  spawnSync(editor, [file], { stdio: "inherit", shell: process.platform === "win32" });
  enterScreen();
  void refresh();
}

async function quit() {
  state.quitting = true;
  leaveScreen();
  closeAllWatches();
  await stopLlamaServer().catch(() => undefined);
  process.exit(0);
}

function move(delta: number) {
  if (state.mainFocus) { state.mainScroll = Math.max(0, state.mainScroll + delta); draw(); return; }
  const panel = focused();
  const count = rowsOf(panel).length;
  state.selected.set(panel, Math.max(0, Math.min(count - 1, sel(panel) + delta)));
  void buildMain().then(draw);
}

function focusPanel(index: number) {
  state.focus = (index + PANELS.length) % PANELS.length;
  state.mainFocus = false;
  say("");
  void buildMain().then(draw);
}

async function onKey(str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string }) {
  if (key.ctrl && key.name === "c") { await quit(); return; }
  const overlay = state.overlay;
  if (overlay?.kind === "prompt") {
    const value = overlay.value;
    if (key.name === "escape") state.overlay = null;
    else if (key.name === "return") { state.overlay = null; draw(); await overlay.onSubmit(value.replace(/ ⏎ /g, "\n\n")); return; }
    else if (key.name === "backspace") { if (overlay.cursor > 0) { overlay.value = value.slice(0, overlay.cursor - 1) + value.slice(overlay.cursor); overlay.cursor -= 1; } }
    else if (key.name === "delete") overlay.value = value.slice(0, overlay.cursor) + value.slice(overlay.cursor + 1);
    else if (key.name === "left") overlay.cursor = Math.max(0, overlay.cursor - 1);
    else if (key.name === "right") overlay.cursor = Math.min(value.length, overlay.cursor + 1);
    else if (key.name === "home" || (key.ctrl && key.name === "a")) overlay.cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e")) overlay.cursor = value.length;
    else if (key.ctrl && key.name === "u") { overlay.value = ""; overlay.cursor = 0; }
    else if (str && !key.ctrl && str >= " ") { overlay.value = value.slice(0, overlay.cursor) + str + value.slice(overlay.cursor); overlay.cursor += str.length; }
    draw();
    return;
  }
  if (overlay?.kind === "confirm") {
    state.overlay = null;
    if (key.name === "y" || key.name === "return") { draw(); await overlay.onYes(); } else { say("Cancelled"); draw(); }
    return;
  }
  if (overlay?.kind === "help") { state.overlay = null; draw(); return; }
  {
    const name = key.name === "space" || str === " " ? "space" : str && /^[A-Z]$/.test(str) ? str : key.name ?? str ?? "";
    if (state.mainFocus) {
      if (name === "escape" || name === "h" || name === "left" || name === "q") { state.mainFocus = false; draw(); return; }
      if (name === "j" || name === "down") return move(1);
      if (name === "k" || name === "up") return move(-1);
      if (name === "pagedown" || (key.ctrl && name === "d")) return move(Math.floor((out.rows || 30) / 2));
      if (name === "pageup" || (key.ctrl && name === "u")) return move(-Math.floor((out.rows || 30) / 2));
      return;
    }
    if (name === "q") { await quit(); return; }
    if (name === "?") { state.overlay = { kind: "help" }; draw(); return; }
    if (/^[1-5]$/.test(name)) return focusPanel(Number(name) - 1);
    if (name === "tab" && !key.shift) return focusPanel(state.focus + 1);
    if (name === "tab" && key.shift) return focusPanel(state.focus - 1);
    if (name === "right" || name === "l") return focusPanel(state.focus + 1);
    if (name === "left" || name === "h") return focusPanel(state.focus - 1);
    if (name === "j" || name === "down") return move(1);
    if (name === "k" || name === "up") return move(-1);
    if (name === "pagedown") return move(10);
    if (name === "pageup") return move(-10);
    if (name === "return") { state.mainFocus = true; draw(); return; }
    if (name === "J" || (key.ctrl && name === "d")) { state.mainScroll += Math.floor((out.rows || 30) / 2); draw(); return; }
    if (name === "K" || (key.ctrl && name === "u")) { state.mainScroll = Math.max(0, state.mainScroll - Math.floor((out.rows || 30) / 2)); draw(); return; }
    if (name === "r") { say("Refreshed"); await refresh(); return; }
    const panel = focused();
    if (panel === "files" && await onFilesKey(name)) return;
    if (panel === "branches" && await onBranchKey(name)) return;
    if (panel === "commits" && await onCommitKey(name)) return;
    if (panel === "stash" && await onStashKey(name)) return;
    if (name === "p") return act("Pulling", () => gk.journaled(state.root, "Pull (ff-only)", "keep", () => gk.pull(state.root, "ff-only")), "Pulled");
    if (name === "P") return act("Pushing", () => gk.push(state.root, {}), "Pushed");
    if (name === "f") return act("Fetching", () => backend.fetchRepository(state.root), "Fetched");
    if (name === "z") return act("Undo", () => gk.undo(state.root));
    if (name === "Z") return act("Redo", () => gk.redo(state.root));
    if (name === "F") {
      const count = state.forks.filter((entry) => entry.kind === "fork").length;
      if (!count) { say("No forks here: add the original repository as an `upstream` remote (or use the desktop app's Forks view)", true); draw(); return; }
      confirm("Sync forks", `Fetch the upstream of ${count} fork${count === 1 ? "" : "s"} (this repository and submodules)\nand fast-forward each default branch? Diverged branches are left alone.`, () => act("Syncing forks", async () => {
        const results = await forks.syncAllForks(state.root);
        const failed = results.filter((result) => !result.ok);
        say(failed.length ? `Synced ${results.length - failed.length}/${results.length}; ${failed.map((result) => `${result.path || "repo"}: ${result.message}`).join("; ")}` : `Synced ${results.length} fork${results.length === 1 ? "" : "s"}: ${results.map((result) => `${result.path || "repo"} ${result.message}`).join("; ")}`, failed.length > 0);
      }));
      return;
    }
  }
}

/** Refresh by itself when files or refs change (edits in an editor, commits elsewhere). */
async function watchLoop() {
  let seen = -1;
  for (;;) {
    if (state.quitting) return;
    try {
      const change = await waitForChange(state.root, seen, undefined, 25_000);
      if (seen >= 0 && change.version !== seen && !state.busy && !state.overlay) await refresh();
      seen = change.version;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main() {
  const input = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : process.cwd();
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Chrono TUI: a terminal interface for git, in the style of lazygit.\n\nUsage: chrono-tui [repository]   (default: the current folder)\nPress ? inside for the keys.\n");
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("chrono-tui needs an interactive terminal.\n");
    process.exit(1);
  }
  try { state.root = await repositoryRoot(path.resolve(input)); } catch (error) {
    process.stderr.write(`chrono-tui: ${errorText(error)}\n`);
    process.exit(1);
  }
  process.on("exit", () => { if (!state.quitting) write("\x1b[0m\x1b[?25h\x1b[?1049l"); });
  process.on("uncaughtException", (error) => { leaveScreen(); process.stderr.write(`chrono-tui crashed: ${error.stack ?? error}\n`); process.exit(1); });
  enterScreen();
  emitKeypressEvents(process.stdin);
  // Keys are handled one after another, so keys typed during an action are not lost.
  let queue = Promise.resolve();
  process.stdin.on("keypress", (str, key) => {
    if (key?.ctrl && key.name === "c") { void quit(); return; }
    queue = queue.then(() => onKey(str, key ?? {})).catch((error) => { say(errorText(error), true); draw(); });
  });
  out.on("resize", () => { write("\x1b[2J"); draw(); });
  state.busy = "Reading the repository…";
  draw();
  await loadAll().catch((error) => say(errorText(error), true));
  state.busy = "";
  await buildMain().catch(() => undefined);
  draw();
  void watchLoop();
}

void main();
