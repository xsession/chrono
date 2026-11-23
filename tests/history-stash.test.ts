// The graph shows one node per stash: the stash's index and untracked-files
// helper commits are hidden, and so are the lines to them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-stash-history-")));
Object.assign(process.env, {
  HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config"),
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
delete process.env.GIT_CONFIG_GLOBAL;
const { repositoryHistoryPage } = await import("../server/src/backend.ts");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };
const repo = path.join(temp, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
git("add", "."); git("commit", "-qm", "one");
fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
git("commit", "-qam", "two");

const plain = await repositoryHistoryPage(repo, 50, null);
ok(plain.commits.length === 2, "no stash: every commit is listed");

// A stash with staged, unstaged and untracked changes has three commits.
fs.writeFileSync(path.join(repo, "a.txt"), "3\n");
git("add", "a.txt");
fs.writeFileSync(path.join(repo, "a.txt"), "4\n");
fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n");
git("stash", "push", "-u", "-q", "-m", "work");
const stash = git("rev-parse", "stash@{0}");
// "<stash> <HEAD> <index> <untracked>"
const [, , index, untracked] = git("rev-list", "--parents", "-n", "1", stash).split(" ");

const page = await repositoryHistoryPage(repo, 50, null);
const ids = page.commits.map((commit) => commit.id);
ok(ids.includes(stash), "the stash itself is shown");
ok(Boolean(index && untracked) && !ids.includes(index) && !ids.includes(untracked), "its index and untracked commits are hidden");
const node = page.commits.find((commit) => commit.id === stash);
ok(node?.parents.length === 1 && node.parents[0] === git("rev-parse", "HEAD"), "the stash links only to the commit it was made on");
ok(page.commits.length === 3, "two commits and one stash");

// Paging still advances by git's own offset.
const first = await repositoryHistoryPage(repo, 2, null);
ok(first.hasMore && first.nextCursor === "2", "cursor counts the commits git skipped");
const rest = await repositoryHistoryPage(repo, 50, first.nextCursor);
const seen = new Set([...first.commits, ...rest.commits].map((commit) => commit.id));
ok(seen.size === 3 && seen.has(stash) && !seen.has(index), "pages together show every visible commit once");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`stash history: ${checks} checks passed`);
