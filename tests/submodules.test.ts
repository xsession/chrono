// Submodule project map: a 3-level nested hierarchy with dirty, moved,
// uninitialized and clean submodules, actions on nested paths, superproject
// breadcrumbs, and git notes staying out of the history graph.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { submoduleAction, submoduleBulk, submoduleForeach, submoduleManifest, submoduleTree, superprojectChain } from "../server/src/submodules.ts";
import { repositoryHistoryPage } from "../server/src/backend.ts";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-subs-")));
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: temp, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
process.env.HOME = temp;
Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };

const upstream = (name: string, subs: Array<[string, string]> = []) => {
  const dir = path.join(temp, `${name}.src`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const n of [1, 2]) { fs.writeFileSync(path.join(dir, `f${n}.txt`), `${name} ${n}\n`); git(dir, "add", "."); git(dir, "commit", "-qm", `${name} ${n}`); }
  for (const [where, from] of subs) { git(dir, "submodule", "add", "-q", path.join(temp, `${from}.git`), where); git(dir, "commit", "-qm", `add ${where}`); }
  execFileSync("git", ["clone", "-q", "--bare", dir, path.join(temp, `${name}.git`)], { env });
};
upstream("leaf");
upstream("mid", [["lib/leaf", "leaf"]]);
upstream("infra", [["lib/mid", "mid"]]);
upstream("a"); upstream("b"); upstream("c");
upstream("top", [["src/infra", "infra"], ["lib/a", "a"], ["lib/b", "b"], ["lib/c", "c"]]);
const root = path.join(temp, "top");
execFileSync("git", ["clone", "-q", "--recurse-submodules", path.join(temp, "top.git"), root], { env });

fs.appendFileSync(path.join(root, "lib/a/f1.txt"), "dirty\n");
fs.writeFileSync(path.join(root, "src/infra/lib/mid/lib/leaf/new.txt"), "untracked\n");
git(path.join(root, "lib/b"), "checkout", "-q", "HEAD~1");
git(root, "submodule", "deinit", "-q", "-f", "lib/c");

let tree = await submoduleTree(root);
const byPath = new Map(tree.nodes.map((node) => [node.path, node]));
eq(tree.nodes.map((node) => node.path).sort(), ["lib/a", "lib/b", "lib/c", "src/infra", "src/infra/lib/mid", "src/infra/lib/mid/lib/leaf"], "all nested submodules listed");
eq(tree.maxDepth, 3, "three levels");
eq(byPath.get("src/infra/lib/mid/lib/leaf")?.parent, "src/infra/lib/mid", "nested parent");
eq(byPath.get("src/infra/lib/mid/lib/leaf")?.depth, 2, "nested depth");
eq(byPath.get("lib/a")?.changes, 1, "dirty submodule counted");
eq(byPath.get("lib/b")?.state, "drift", "moved submodule detected");
eq(byPath.get("lib/b")?.drift, { ahead: 0, behind: 1 }, "drift is one commit behind the recorded one");
eq(byPath.get("lib/c")?.state, "uninitialized", "deinit'ed submodule is uninitialized");
eq(byPath.get("lib/c")?.url?.endsWith("c.git"), true, "uninitialized url read from .gitmodules");
eq(byPath.get("src/infra/lib/mid/lib/leaf")?.untracked, 1, "untracked file at level 3");
eq(byPath.get("src/infra")?.attentionBelow, 1, "problems bubble up to the top-level parent");
eq(byPath.get("src/infra")?.changes, 0, "parent does not count nested dirt as its own change");
eq(tree.totals, { all: 6, dirty: 2, drift: 1, uninitialized: 1, conflict: 0, detached: 5, outdated: 1 }, "totals (lib/b sits one commit behind main)");

eq((await superprojectChain(path.join(root, "src/infra/lib/mid/lib/leaf"))).map((entry) => entry.name), ["top", "infra", "mid"], "breadcrumb chain outermost first");
eq(await superprojectChain(root), [], "top-level repo has no superproject");

await submoduleAction(root, "init", "lib/c");
await submoduleAction(root, "update", "lib/b");
await submoduleAction(root, "update", "src/infra/lib/mid/lib/leaf");
tree = await submoduleTree(root);
eq(tree.nodes.find((node) => node.path === "lib/c")?.state, "ok", "nested-safe init works");
eq(tree.nodes.find((node) => node.path === "lib/b")?.state, "ok", "update restores the recorded commit");
await assert.rejects(() => submoduleAction(root, "update", "../escape"), /relative/); checks += 1;
await assert.rejects(() => submoduleAction(root, "update", "lib/nope"), /not a submodule/); checks += 1;

// ---- bulk management -------------------------------------------------
// New upstream commit in "a": after a bulk fetch, lib/a reports it is behind its branch.
const aSrc = path.join(temp, "a.src");
fs.writeFileSync(path.join(aSrc, "f3.txt"), "a 3\n"); git(aSrc, "add", "."); git(aSrc, "commit", "-qm", "a 3");
git(aSrc, "push", "-q", path.join(temp, "a.git"), "main");
let bulk = await submoduleBulk(root, "fetch", ["lib/a", "lib/c"]);
eq(bulk.map((item) => item.status), ["ok", "ok"], "bulk fetch");
let node = (await submoduleTree(root)).nodes.find((entry) => entry.path === "lib/a")!;
eq(node.tracking, { branch: "main", behind: 1 }, "pin is one commit behind its tracked branch");
git(path.join(root, "lib/a"), "checkout", "-q", "--", ".");
bulk = await submoduleBulk(root, "update_remote", ["lib/a"]);
eq(bulk[0].status, "ok", "update to remote");
node = (await submoduleTree(root)).nodes.find((entry) => entry.path === "lib/a")!;
eq([node.state, node.tracking?.behind], ["drift", 0], "moved to the branch tip, now differs from the recorded pin");
eq((await submoduleBulk(root, "pull", ["lib/a"]))[0].status, "skipped", "pull skips a detached submodule");
bulk = await submoduleBulk(root, "attach", ["lib/a", "lib/c"]);
eq(bulk[0].status, "ok", `attach puts lib/a on main (${bulk[0].message})`);
eq(git(path.join(root, "lib/a"), "symbolic-ref", "--short", "HEAD").trim(), "main", "lib/a is on main");
eq(bulk[1].status, "ok", "lib/c's pin is its branch tip, so it attaches too");
git(path.join(root, "lib/b"), "checkout", "-q", "--detach", "HEAD~1");
eq((await submoduleBulk(root, "attach", ["lib/b"]))[0].status, "skipped", "attach never moves a submodule whose commit is not a branch tip");
await submoduleBulk(root, "update", ["lib/b"]);
eq((await submoduleBulk(root, "pull", ["lib/a"]))[0].status, "ok", "pull works once on a branch");
bulk = await submoduleBulk(root, "record", ["lib/a", "lib/c"]);
eq(bulk.map((item) => item.status), ["ok", "skipped"], "record stages only moved pins");
eq(git(root, "diff", "--cached", "--name-only").trim(), "lib/a", "new pointer staged in the superproject");
bulk = await submoduleBulk(root, "fetch", ["src/infra/lib/mid/lib/leaf", "src/infra"]);
eq(bulk.map((item) => item.path), ["src/infra", "src/infra/lib/mid/lib/leaf"], "bulk runs parents before nested submodules");
await assert.rejects(() => submoduleBulk(root, "fetch", ["../x"]), /invalid submodule path/); checks += 1;
await assert.rejects(() => submoduleBulk(root, "fetch", []), /select at least one/); checks += 1;
const runs = await submoduleForeach(root, 'printf "%s|%s" "$sm_path" "$(git rev-parse --abbrev-ref HEAD)"', ["lib/a", "src/infra/lib/mid"]);
eq(runs.map((run) => [run.code, run.stdout]), [[0, "lib/a|main"], [0, "src/infra/lib/mid|HEAD"]], "foreach runs in each submodule with $sm_path");
eq((await submoduleForeach(root, "exit 3", ["lib/a"]))[0].code, 3, "foreach reports exit codes");
const manifest = await submoduleManifest(root);
eq([manifest.submodules.length, manifest.root, manifest.submodules.find((entry) => entry.path === "lib/a")?.branch], [6, root, "main"], "manifest lists every submodule");

// git notes must not appear as an orphan commit in the graph
git(root, "notes", "add", "-m", "a note", "HEAD");
const page = await repositoryHistoryPage(root, 50, null);
eq(page.commits.some((commit) => commit.subject.startsWith("Notes added by")), false, "notes ref excluded from history");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`submodules: ${checks} assertions passed`);
