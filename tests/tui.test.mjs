// End-to-end test of the terminal UI (tui/main.ts): it runs in a real
// pseudo-terminal (node-pty), the screen is decoded with a small ANSI parser,
// and keys are pressed like a user would. Checks staging, committing through
// a submodule, branches, the help overlay, stash and quitting cleanly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

if (process.platform === "win32") { console.log("tui: skipped on Windows"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-tui-")));
const env = {
  ...process.env, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config"), CHRONO_CONFIG_DIR: path.join(temp, "config"),
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", TERM: "xterm-256color",
};
delete env.GIT_CONFIG_GLOBAL;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
execFileSync("git", ["config", "--global", "protocol.file.allow", "always"], { env });
execFileSync("git", ["config", "--global", "init.defaultBranch", "main"], { env });

// A repository with a submodule.
const subSrc = path.join(temp, "lib-src");
fs.mkdirSync(subSrc); git(subSrc, "init", "-q"); fs.writeFileSync(path.join(subSrc, "lib.txt"), "lib 1\n"); git(subSrc, "add", "."); git(subSrc, "commit", "-qm", "lib");
const repo = path.join(temp, "app");
fs.mkdirSync(repo); git(repo, "init", "-q");
fs.writeFileSync(path.join(repo, "readme.md"), "hello\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "first");
git(repo, "submodule", "add", "-q", subSrc, "lib"); git(repo, "commit", "-qm", "add lib");
fs.writeFileSync(path.join(repo, "readme.md"), "hello world\n");
fs.writeFileSync(path.join(repo, "new.txt"), "new file\n");

// --- a minimal terminal emulator for what the TUI writes
const COLS = 140, ROWS = 40;
let grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
let row = 0, col = 0, raw = "", pending = "";
function feed(chunk) {
  raw += chunk;
  // An escape sequence can be split across chunks: keep an unfinished one for the next.
  let data = pending + chunk;
  pending = "";
  const tail = /\x1b(\[[?0-9;]*)?$/.exec(data);
  if (tail) { pending = tail[0]; data = data.slice(0, tail.index); }
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === "\x1b") {
      const m = /^\x1b\[([?0-9;]*)([A-Za-z])/.exec(data.slice(i));
      if (!m) continue;
      i += m[0].length - 1;
      const [, args, cmd] = m;
      if (cmd === "H") { const [r, c] = args.split(";").map(Number); row = (r || 1) - 1; col = (c || 1) - 1; }
      else if (cmd === "J" && args === "2") grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
      else if (cmd === "K") for (let c = col; c < COLS; c++) grid[row][c] = " ";
      continue;
    }
    if (ch === "\r") { col = 0; continue; }
    if (ch === "\n") { row = Math.min(ROWS - 1, row + 1); continue; }
    if (row < ROWS && col < COLS) grid[row][col] = ch;
    col += 1;
  }
}
const screen = () => grid.map((line) => line.join("")).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(test, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (test(screen())) return; await sleep(50); }
  throw new Error(`timed out waiting for ${label}\n--- screen ---\n${screen()}`);
}
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

// CHRONO_TUI_RUNTIME runs it with another Node, e.g. an installed Chrono in Node mode
// (ELECTRON_RUN_AS_NODE=1 /opt/Chrono/chrono), as the installed chrono-tui does.
const runtime = process.env.CHRONO_TUI_RUNTIME || process.execPath;
const child = pty.spawn(runtime, ["--experimental-strip-types", "--no-warnings", path.join(here, "..", "tui", "main.ts"), repo], { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: repo, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } });
let exitCode = null;
child.onData(feed);
child.onExit(({ exitCode: code }) => { exitCode = code; });
const press = async (keys, pause = 120) => { for (const key of keys) { child.write(key); await sleep(pause); } };
const type = (text) => press([...text], 15);

try {
  await waitFor((s) => s.includes("[2] Files") && s.includes("readme.md") && s.includes("new.txt") && s.includes("lib"), "the files panel");
  ok(raw.includes("\x1b[?1049h"), "uses the alternate screen");
  ok(/\[1\] Status[\s\S]*main/.test(screen()), "status shows the branch");
  ok(screen().includes("── unstaged ──") || screen().includes("── new file ──"), "the diff of the selected file is shown");

  // Stage readme.md with space (files are sorted by git status order: find it first).
  const order = () => screen().split("\n").filter((line) => /│(\?\?|.M|M.|A.)\s/.test(line.slice(0, 60)) || /│ M |│M  |│\?\? |│ m /.test(line));
  ok(order().length >= 2, "file rows are listed with their status codes");
  const filesBefore = screen();
  const lines = filesBefore.split("\n");
  const readmeIndex = lines.findIndex((line) => line.includes("readme.md"));
  const firstFile = lines.findIndex((line) => /│(\?\?|.M|M.|A.|UU)/.test(line.slice(0, 5)) || /│ M |│MM |│\?\? /.test(line.slice(0, 6)));
  for (let i = firstFile; i < readmeIndex; i++) await press(["j"]);
  await press([" "]);
  await waitFor(() => git(repo, "diff", "--cached", "--name-only") === "readme.md", "readme.md staged", 5000);
  ok(true, "space stages the selected file");
  await waitFor((s) => s.includes("── staged ──"), "the staged diff");
  ok(true, "the diff shows the staged part");

  // Stage the submodule's changes from here and commit everything: lib gets its own commit.
  fs.writeFileSync(path.join(repo, "lib", "lib.txt"), "lib 2\n");
  await waitFor((s) => /lib\s+\(submodule:/.test(s), "the changed submodule row", 8000);
  ok(true, "a changed submodule is listed with what changed inside");
  await press(["a"]);
  await waitFor(() => git(path.join(repo, "lib"), "diff", "--cached", "--name-only") === "lib.txt", "everything staged, inside the submodule too", 5000);
  ok(git(repo, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "new.txt,readme.md", "a stages all files");
  await press(["c"]);
  await waitFor((s) => s.includes("Commit message"), "the commit prompt");
  await type("Update readme, add new.txt and lib");
  await press(["\r"]);
  await waitFor((s) => s.includes("Committed") && s.includes("also committed in lib"), "the commit result", 10000);
  ok(git(repo, "log", "-1", "--format=%s") === "Update readme, add new.txt and lib", "the commit is made with the typed message");
  ok(git(path.join(repo, "lib"), "log", "-1", "--format=%s") === "Update readme, add new.txt and lib" && git(repo, "rev-parse", "HEAD:lib") === git(path.join(repo, "lib"), "rev-parse", "HEAD"), "the submodule got its own commit and the new id is recorded");
  ok(git(repo, "status", "--porcelain", "--ignore-submodules=none") === "", "nothing is left dirty");
  await waitFor((s) => s.includes("No changes") || s.includes("Working tree clean"), "a clean files panel", 5000);

  // Branches: create one with n, it is checked out.
  await press(["3", "n"]);
  await waitFor((s) => s.includes("New branch name"), "the branch prompt");
  await type("feature/tui");
  await press(["\r"]);
  await waitFor(() => git(repo, "branch", "--show-current") === "feature/tui", "the new branch checked out", 5000);
  ok(true, "n creates and checks out a branch");
  await waitFor((s) => s.includes("* feature/tui"), "the branch list");
  ok(true, "the branches panel marks the current branch");

  // Commits panel shows the graph and the selected commit.
  await press(["4"]);
  await waitFor((s) => s.includes("Commit ") && s.includes("Update readme, add new.txt and lib"), "the commit view");
  ok(true, "the commits panel shows the history and the selected commit");

  // Stash: make a change, stash it from the files panel, then pop it.
  fs.writeFileSync(path.join(repo, "readme.md"), "stash me\n");
  await press(["2"]);
  await waitFor((s) => s.includes("readme.md"), "the change to stash", 8000);
  await press(["s"]);
  await waitFor((s) => s.includes("Stash message"), "the stash prompt");
  await type("wip");
  await press(["\r"]);
  await waitFor(() => git(repo, "stash", "list").includes("wip"), "the stash", 5000);
  ok(git(repo, "status", "--porcelain") === "", "s stashes the changes");
  await press(["5"]);
  await waitFor((s) => s.includes("stash@{0}") && s.includes("wip"), "the stash panel");
  await press(["g"]);
  await waitFor(() => git(repo, "stash", "list") === "" && fs.readFileSync(path.join(repo, "readme.md"), "utf8") === "stash me\n", "the pop", 5000);
  ok(true, "g pops the stash");

  // Discard asks first; n cancels.
  await press(["2", "d"]);
  await waitFor((s) => s.includes("Discard changes"), "the discard confirmation");
  await press(["n"]);
  await waitFor((s) => s.includes("Cancelled"), "the cancel message");
  ok(fs.readFileSync(path.join(repo, "readme.md"), "utf8") === "stash me\n", "cancelling a discard keeps the change");

  // Help overlay.
  await press(["?"]);
  await waitFor((s) => s.includes("Keys") && s.includes("undo / redo"), "the help overlay");
  ok(true, "? shows the keys");
  await press(["x"]);
  await waitFor((s) => !s.includes("undo / redo (Chrono"), "the help closed");

  // Quit restores the terminal.
  await press(["q"]);
  for (let i = 0; i < 100 && exitCode === null; i++) await sleep(50);
  ok(exitCode === 0, "q quits with exit code 0");
  ok(raw.includes("\x1b[?1049l") && raw.includes("\x1b[?25h"), "the terminal is restored (main screen, cursor visible)");
} finally {
  if (exitCode === null) child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`tui: ${checks} checks passed`);
