// Live repository changes (server/src/repoWatch.ts): edits, new folders,
// commits and branch moves must be reported well within one second, and
// ignored folders must not cause refreshes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-watch-")));
Object.assign(process.env, {
  HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config"),
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
delete process.env.GIT_CONFIG_GLOBAL;
const { waitForChange, closeAllWatches } = await import("../server/src/repoWatch.ts");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };
const repo = path.join(temp, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
write("src/app.ts", "export const a = 1;\n");
write(".gitignore", "node_modules/\n");
write("node_modules/dep/index.js", "x\n");
git("add", "."); git("commit", "-qm", "init");

let state = await waitForChange(repo, -1);
// Give the watcher time to set itself up (it starts on the first request).
for (let i = 0; i < 50 && state.mode === "starting"; i++) { await sleep(50); state = await waitForChange(repo, -1); }
ok(state.mode === "events", `watching with file-system events (mode ${state.mode})`);

/** Make a change and measure how long until the watcher reports it. */
async function timed(label: string, act: () => void): Promise<{ ms: number; git: boolean }> {
  const before = await waitForChange(repo, -1);
  const started = performance.now();
  const pending = waitForChange(repo, before.version, undefined, 5000);
  act();
  const after = await pending;
  const ms = Math.round(performance.now() - started);
  ok(after.version > before.version, `${label}: reported (${ms} ms)`);
  ok(ms < 1000, `${label}: within one second (${ms} ms)`);
  return { ms, git: after.gitVersion > before.gitVersion };
}

const edit = await timed("edit a tracked file", () => write("src/app.ts", "export const a = 2;\n"));
ok(!edit.git, "a working-tree edit does not ask for a graph reload");
await sleep(150);
await timed("create a file in a new folder", () => write("docs/new/readme.md", "hi\n"));
await sleep(300); // the new folder gets its own watcher
await timed("edit inside the new folder", () => write("docs/new/readme.md", "hello\n"));
await sleep(150);
const stage = await timed("stage (index changes)", () => git("add", "-A"));
ok(!stage.git, "staging only reloads the status");
await sleep(150);
const commit = await timed("commit", () => git("commit", "-qm", "two"));
ok(commit.git, "a commit asks for a graph reload");
await sleep(150);
const branch = await timed("create a nested branch", () => git("branch", "feature/x"));
ok(branch.git, "a new ref asks for a graph reload");
await sleep(150);
const checkout = await timed("checkout", () => git("checkout", "-q", "feature/x"));
ok(checkout.git, "a checkout asks for a graph reload");

// Ignored folders are not watched: writing there reports nothing.
await sleep(300);
const quiet = await waitForChange(repo, -1);
const ignored = waitForChange(repo, quiet.version, undefined, 1000);
write("node_modules/dep/index.js", "changed\n");
ok((await ignored).version === quiet.version, "changes in ignored node_modules are not reported");

// A cancelled wait returns at once.
const controller = new AbortController();
const cancelled = waitForChange(repo, (await waitForChange(repo, -1)).version, controller.signal, 20000);
const cancelStart = performance.now();
controller.abort();
await cancelled;
ok(performance.now() - cancelStart < 200, "an aborted wait returns immediately");

closeAllWatches();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`repo watch: ${checks} checks passed`);
