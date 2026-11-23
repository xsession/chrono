// Forks and upstreams (server/src/forks.ts): detection from remotes, how far a
// fork is behind, syncing (fast-forward only, optional push), merging upstream,
// and the same for a submodule that is itself a fork. All repositories local.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-forks-")));
Object.assign(process.env, {
  HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config"), CHRONO_CONFIG_DIR: path.join(temp, "config"),
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
delete process.env.GIT_CONFIG_GLOBAL;
execFileSync("git", ["config", "--global", "protocol.file.allow", "always"]);
execFileSync("git", ["config", "--global", "init.defaultBranch", "main"]);
const forks = await import("../server/src/forks.ts");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const commit = (dir: string, file: string, text: string, message: string) => { fs.writeFileSync(path.join(dir, file), text); git(dir, "add", file); git(dir, "commit", "-qm", message); };

/** original (upstream) → fork on the "server" (bare clone) → your checkout of the fork. */
function forkSetup(name: string, prepare?: (original: string) => void) {
  const original = path.join(temp, "server", "alice", name);
  fs.mkdirSync(original, { recursive: true });
  git(original, "init", "-q");
  commit(original, "a.txt", "1\n", `${name} one`);
  prepare?.(original);
  const fork = path.join(temp, "server", "me", `${name}.git`);
  execFileSync("git", ["clone", "-q", "--bare", original, fork]);
  return { original, fork };
}

// --- the main repository is a fork, and its submodule "lib" is a fork too
// (the app's .gitmodules points at your fork of lib, as patched dependencies do).
const lib = forkSetup("lib");
const app = forkSetup("app", (original) => { git(original, "submodule", "add", "-q", lib.fork, "lib"); git(original, "commit", "-qm", "add lib"); });
const work = path.join(temp, "work");
execFileSync("git", ["clone", "-q", "--recurse-submodules", app.fork, work]);
git(path.join(work, "lib"), "switch", "-q", "main");
git(work, "remote", "add", "upstream", app.original);
git(path.join(work, "lib"), "remote", "add", "upstream", lib.original);

// Upstream moves on.
commit(app.original, "b.txt", "2\n", "app two");
commit(app.original, "c.txt", "3\n", "app three");
commit(lib.original, "b.txt", "2\n", "lib two");

let tree = await forks.forkTree(work);
ok(tree.length === 2 && tree[0].path === "" && tree[1].path === "lib" && tree[1].depth === 1, "the repository and its submodule are listed");
ok(tree.every((entry) => entry.kind === "fork" && entry.upstream?.name === "upstream" && entry.origin?.name === "origin"), "both are forks: origin is the copy, upstream the original");
ok(tree[0].defaultBranch === null || tree[0].behind === 0, "before fetching upstream, nothing is known to be behind");

// Fetch (through sync) and fast-forward the checked-out default branch, then push to the fork.
const synced = await forks.syncFork(work, "", { push: true });
ok(synced.ok && /fast-forwarded by 2/.test(synced.message) && synced.pushed, `sync fast-forwards main by 2 and pushes (${synced.message})`);
ok(git(work, "rev-parse", "main") === git(app.original, "rev-parse", "main"), "local main equals upstream main");
ok(git(app.fork, "rev-parse", "main") === git(app.original, "rev-parse", "main"), "your fork on the server was pushed too");
tree = await forks.forkTree(work);
ok(tree[0].defaultBranch === "main" && tree[0].behind === 0 && tree[0].originBehind === 0 && tree[0].fetchedAt, "status after sync: up to date, fetched");

// The submodule fork: sync everything.
const all = await forks.syncAllForks(work);
const libResult = all.find((result) => result.path === "lib");
ok(libResult?.ok && /fast-forwarded by 1/.test(libResult.message), `the submodule fork is synced too (${libResult?.message})`);
ok(git(path.join(work, "lib"), "rev-parse", "HEAD") === git(lib.original, "rev-parse", "main"), "the submodule's main now matches its upstream");

// Behind counts, on a branch that is not checked out.
commit(app.original, "d.txt", "4\n", "app four");
git(work, "switch", "-q", "-c", "feature");
commit(work, "feature.txt", "f\n", "my feature");
git(work, "fetch", "-q", "upstream");
tree = await forks.forkTree(work);
ok(tree[0].currentBranch === "feature" && tree[0].behind === 1 && tree[0].branchBehind === 1, "main and the feature branch are each 1 behind upstream");
const offBranch = await forks.syncFork(work, "");
ok(offBranch.ok && git(work, "rev-parse", "main") === git(app.original, "rev-parse", "main") && git(work, "branch", "--show-current") === "feature", "main is fast-forwarded without checking it out");

// Merge upstream into the feature branch.
await forks.mergeUpstream(work, "");
ok(git(work, "merge-base", "--is-ancestor", "upstream/main", "HEAD") === "" && fs.existsSync(path.join(work, "d.txt")), "merge upstream brings upstream's commits into the branch");

// A default branch with its own commits is never rewritten.
git(work, "switch", "-q", "main");
commit(work, "mine.txt", "m\n", "my own commit on main");
commit(app.original, "e.txt", "5\n", "app five");
const before = git(work, "rev-parse", "main");
const diverged = await forks.syncFork(work, "");
ok(!diverged.ok && /1 commit\(s\) that upstream does not/.test(diverged.message) && git(work, "rev-parse", "main") === before, `a diverged main is left alone with an explanation (${diverged.message})`);

// Without an upstream remote: plain; adding one makes it a fork.
const plain = path.join(temp, "plain");
execFileSync("git", ["clone", "-q", lib.fork, plain]);
ok((await forks.forkStatusOf(plain)).kind === "plain", "a clone with only origin is not known to be a fork");
const added = await forks.addUpstream(plain, "", lib.original);
ok(added.kind === "fork" && added.upstream?.url === lib.original && added.defaultBranch === "main" && added.behind === 1, "adding upstream fetches it and shows how far behind main is");
ok(await forks.detectParent(plain) === null, "no parent lookup for repositories without a hosting service");

// Another remote holding the same repository counts as the upstream, whatever it is called.
const renamed = path.join(temp, "renamed");
execFileSync("git", ["clone", "-q", app.fork, renamed]);
git(renamed, "remote", "add", "alice", app.original);
const byName = await forks.forkStatusOf(renamed);
ok(byName.kind === "fork" && byName.upstream?.name === "alice", "a second remote with the same repository name is taken as upstream");

// Pull request links for hosted forks.
const hosted = path.join(temp, "hosted");
fs.mkdirSync(hosted); git(hosted, "init", "-q"); commit(hosted, "a.txt", "1\n", "one");
git(hosted, "remote", "add", "origin", "https://github.com/me/app.git");
git(hosted, "remote", "add", "upstream", "https://github.com/alice/app.git");
git(hosted, "update-ref", "refs/remotes/upstream/main", "HEAD");
git(hosted, "switch", "-q", "-c", "fix-typo");
const link = (await forks.forkStatusOf(hosted)).compareUrl;
ok(link === "https://github.com/alice/app/compare/main...me:app:fix-typo", `GitHub compare link from the fork's branch (${link})`);

await assert.rejects(() => forks.syncFork(work, "../outside"), /invalid submodule path/); checks += 1;

fs.rmSync(temp, { recursive: true, force: true });
console.log(`forks: ${checks} checks passed`);
