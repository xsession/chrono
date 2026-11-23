// Committing from a superproject reaches into submodules at any depth: each
// submodule with staged changes gets a normal commit (deepest first) and every
// parent records the new commit id, so nothing is left "-dirty".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-nested-commit-")));
Object.assign(process.env, {
  HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config"), CHRONO_CONFIG_DIR: path.join(temp, "config"),
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
delete process.env.GIT_CONFIG_GLOBAL;
execFileSync("git", ["config", "--global", "protocol.file.allow", "always"]);
execFileSync("git", ["config", "--global", "init.defaultBranch", "main"]);
const { commitWithHooks } = await import("../server/src/features.ts");
const { stagePaths, unstagePaths } = await import("../server/src/backend.ts");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const repo = (name: string) => { const dir = path.join(temp, "src", name); fs.mkdirSync(dir, { recursive: true }); git(dir, "init", "-q"); write(path.join(dir, `${name}.txt`), `${name} 1\n`); git(dir, "add", "."); git(dir, "commit", "-qm", `${name} init`); return dir; };

// leaf → mid → top, then a fresh recursive clone (submodules detached, as
// `git submodule update` leaves them).
const leafSrc = repo("leaf");
const midSrc = repo("mid");
git(midSrc, "submodule", "add", "-q", leafSrc, "leaf"); git(midSrc, "commit", "-qm", "add leaf");
const topSrc = repo("top");
git(topSrc, "submodule", "add", "-q", midSrc, "mid"); git(topSrc, "commit", "-qm", "add mid");
const top = path.join(temp, "work");
execFileSync("git", ["clone", "-q", "--recurse-submodules", topSrc, top]);
const mid = path.join(top, "mid");
const leaf = path.join(mid, "leaf");
const recorded = (parent: string, sub: string) => git(parent, "rev-parse", `HEAD:${sub}`);
const clean = (dir: string) => git(dir, "status", "--porcelain", "--ignore-submodules=none") === "";
// Point each submodule's branch at its checkout, so the commit can attach to it.
for (const dir of [mid, leaf]) git(dir, "branch", "-f", "main", "HEAD");
const detached = (dir: string) => { try { git(dir, "symbolic-ref", "-q", "HEAD"); return false; } catch { return true; } };
ok(detached(mid) && detached(leaf), "a recursive clone leaves submodules detached");

// 1. Change the deepest repository and one file in the middle, stage it all
//    from the top by staging the submodule, then commit from the top.
write(path.join(leaf, "leaf.txt"), "leaf 2\n");
write(path.join(leaf, "new.txt"), "brand new\n");
write(path.join(mid, "mid.txt"), "mid 2\n");
await stagePaths(top, ["mid"]);
ok(git(leaf, "diff", "--cached", "--name-only").split("\n").sort().join(",") === "leaf.txt,new.txt", "staging the submodule stages the files inside the nested one");
ok(git(mid, "diff", "--cached", "--name-only").includes("mid.txt"), "…and inside the submodule itself");

const leafBefore = git(leaf, "rev-parse", "HEAD");
const result = await commitWithHooks(top, { message: "Update everything" });
ok(result.ok, `commit from the top succeeds (${result.output})`);
ok(result.nested?.map((entry) => entry.path).join(",") === "mid/leaf,mid", "submodules are committed deepest first");
ok(git(leaf, "rev-parse", "HEAD") !== leafBefore && git(leaf, "log", "-1", "--format=%s") === "Update everything", "the leaf got a normal commit");
ok(recorded(mid, "leaf") === git(leaf, "rev-parse", "HEAD"), "mid records the leaf's new commit");
ok(recorded(top, "mid") === git(mid, "rev-parse", "HEAD"), "top records mid's new commit");
ok(clean(top) && clean(mid) && clean(leaf), "nothing is left dirty at any level");
ok(git(top, "show", "--stat", "--format=", "HEAD").includes("mid"), "the top commit contains the submodule update");
ok(result.nested?.every((entry) => !entry.detached && entry.attachedTo === "main"), "detached submodules were put back on the branch at their HEAD");
ok(git(leaf, "rev-parse", "main") === git(leaf, "rev-parse", "HEAD"), "the branch moved with the commit");

// 2. Staging inside the deepest repository only, then committing from the top.
write(path.join(leaf, "leaf.txt"), "leaf 3\n");
git(leaf, "add", "leaf.txt");
const second = await commitWithHooks(top, { message: "Leaf only" });
ok(second.ok && second.nested?.length === 2, "a staged change deep down commits every level above it");
ok(clean(top) && recorded(top, "mid") === git(mid, "rev-parse", "HEAD") && recorded(mid, "leaf") === git(leaf, "rev-parse", "HEAD"), "the chain of commit ids is consistent");

// 3. Unstaging the submodule from the top unstages inside it too.
write(path.join(leaf, "leaf.txt"), "leaf 4\n");
await stagePaths(top, ["mid"]);
await unstagePaths(top, ["mid"]);
ok(git(leaf, "diff", "--cached", "--name-only") === "" && git(mid, "diff", "--cached", "--name-only") === "", "unstaging the submodule unstages inside it");

// 4. Unstaged submodule changes are left alone: no submodule commit, no dirty record.
write(path.join(top, "top.txt"), "top 2\n");
git(top, "add", "top.txt");
const leafHead = git(leaf, "rev-parse", "HEAD");
const third = await commitWithHooks(top, { message: "Top only" });
ok(third.ok && (third.nested?.length ?? 0) === 0 && git(leaf, "rev-parse", "HEAD") === leafHead, "only staged changes are committed in submodules");

// 5. A one-off identity applies to every commit in the chain.
git(leaf, "add", "leaf.txt");
const fourth = await commitWithHooks(top, { message: "As someone else", identity: { name: "Ada Lovelace", email: "ada@example.com" } });
ok(fourth.ok, "commit with an identity");
ok([top, mid, leaf].every((dir) => git(dir, "log", "-1", "--format=%an <%ae>|%cn") === "Ada Lovelace <ada@example.com>|Ada Lovelace"), "author and committer at every level");
await assert.rejects(() => commitWithHooks(top, { message: "x", identity: { name: "", email: "bad" } }), /identity/);
checks += 1;

// 6. A failing hook in a submodule stops before the parents and says where.
const hook = path.join(git(leaf, "rev-parse", "--absolute-git-dir"), "hooks", "pre-commit");
write(hook, "#!/bin/sh\necho 'leaf says no'\nexit 1\n"); fs.chmodSync(hook, 0o755);
write(path.join(leaf, "leaf.txt"), "leaf 5\n");
await stagePaths(top, ["mid"]);
const midHead = git(mid, "rev-parse", "HEAD");
const blocked = await commitWithHooks(top, { message: "Blocked" });
ok(!blocked.ok && blocked.output.includes("mid/leaf") && blocked.output.includes("leaf says no"), "the failure names the submodule and shows the hook output");
ok(blocked.hookFailed === "pre-commit", "the hook is reported so the UI can offer --no-verify");
ok(git(mid, "rev-parse", "HEAD") === midHead, "parents are not committed after a failure");
const bypass = await commitWithHooks(top, { message: "Bypassed", noVerify: true });
ok(bypass.ok && clean(top) && clean(leaf), "--no-verify goes through every level");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`nested commit: ${checks} checks passed`);
