// Roadmap feature smoke test: runs the Tier 1-3 backend functions against
// throwaway repositories (HOME and CHRONO_CONFIG_DIR point at a temp dir so
// the user's global git config is never touched).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-roadmap-"));
process.env.HOME = temp;
process.env.CHRONO_CONFIG_DIR = path.join(temp, "cfg");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const features = await import("../server/src/features.ts");
const repo = path.join(temp, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);

fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
git("config", "user.name", "T"); git("config", "user.email", "t@t");
write("a.txt", "a\n"); git("add", "."); git("commit", "-qm", "init");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };

// search operators
ok(features.parseSearchQuery('author:"Jane Doe" -message:wip path:src foo').length === 4, "parses quoted, negated and free tokens");

// hooks: failing pre-commit is reported, --no-verify bypasses
fs.writeFileSync(path.join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\necho blocked >&2\nexit 1\n", { mode: 0o755 });
write("b.txt", "b\n"); git("add", "b.txt");
const failed = await features.commitWithHooks(repo, { message: "add b" });
ok(!failed.ok && failed.hookFailed === "pre-commit" && failed.output.includes("blocked"), "pre-commit failure surfaces output");
const bypassed = await features.commitWithHooks(repo, { message: "add b", noVerify: true });
ok(bypassed.ok && bypassed.commit, "--no-verify commit succeeds");
await features.setHookEnabled(repo, "pre-commit", false);

// stacked branches + restack
await features.createStackedBranch(repo, "main", "s1"); write("s1.txt", "1\n"); git("add", "."); git("commit", "-qm", "s1");
await features.createStackedBranch(repo, "s1", "s2"); write("s2.txt", "2\n"); git("add", "."); git("commit", "-qm", "s2");
git("switch", "-q", "main"); write("m.txt", "m\n"); git("add", "."); git("commit", "-qm", "main moves");
const parents = await features.stackParents(repo);
ok(parents.s1 === "main" && parents.s2 === "s1", "stack parents stored in git config");
await assert.rejects(features.setStackParent(repo, "s1", "s2"), /cycle/); checks += 1;
await features.restack(repo, "s1");
ok(git("merge-base", "--is-ancestor", "main", "s1") === "" && git("merge-base", "--is-ancestor", "s1", "s2") === "", "restack moved the whole stack onto main");
ok(git("branch", "--show-current") === "main", "restack returns to the original branch");

// conflict prediction
git("switch", "-q", "-c", "c1", "main"); write("a.txt", "one\n"); git("commit", "-qam", "c1");
git("switch", "-q", "main"); write("a.txt", "two\n"); git("commit", "-qam", "main a");
const conflict = await features.predictConflicts(repo, "merge", "c1", null);
ok(conflict.supported ? !conflict.clean && conflict.files.includes("a.txt") : true, "merge-tree predicts the a.txt conflict");
ok(git("status", "--porcelain") === "", "prediction leaves the work tree untouched");

// squash-merge detection + archive/restore
git("switch", "-q", "-c", "sq", "main"); write("q.txt", "q\n"); git("add", "."); git("commit", "-qm", "q1"); write("q.txt", "q2\n"); git("commit", "-qam", "q2");
git("switch", "-q", "main"); git("merge", "-q", "--squash", "sq"); git("commit", "-qm", "squash sq");
const cleanup = await features.cleanupCandidates(repo, "main");
ok(cleanup.candidates.find((candidate) => candidate.branch === "sq")?.reasons.includes("squash-merged"), "squash merge detected");
await features.archiveBranches(repo, ["sq"], "archive");
ok((await features.archivedBranches(repo)).some((item) => item.branch === "sq"), "branch archived under refs/chrono/archive");
await features.restoreArchived(repo, "sq");
ok(git("branch", "--list", "sq").includes("sq"), "archived branch restored");

// git-flow
await features.gitflowInit(repo, { master: "main", develop: "develop", versionTag: "v" });
await features.gitflowStart(repo, "release", "1.0", null); write("r.txt", "r\n"); git("add", "."); git("commit", "-qm", "rel");
await features.gitflowFinish(repo, "release", "1.0", { tagMessage: "Release 1.0" });
ok(git("tag", "--list", "v1.0") === "v1.0" && git("branch", "--list", "release/1.0") === "", "release finished, tagged and deleted");

// custom commands: per-argv substitution, never a shell
await features.saveCustomCommands([{ id: "echo", name: "Echo", argv: ["git", "log", "-1", "--format=%s", "$BRANCH"], scope: "branch", confirm: false, refresh: false, params: [] },
  { id: "p", name: "Param", argv: ["git", "rev-parse", "--verify", "-q", "$PARAM_target"], scope: "repository", confirm: false, refresh: false, params: [{ name: "target", label: "Target", type: "text" }] }]);
const echo = await features.runCustomCommand(repo, "echo", { branch: "main" }, false);
ok(echo.exitCode === 0 && echo.stdout.trim().length > 0, "custom git command runs");
const injected = await features.runCustomCommand(repo, "p", { params: { target: "main; rm -rf /" } }, false);
ok(injected.argv.at(-1) === "main; rm -rf /" && injected.exitCode !== 0, "parameter stays one argv element");
await features.saveCustomCommands([{ id: "x", name: "X", argv: ["echo", "hi"], scope: "repository", confirm: false, refresh: false, params: [] }]);
await assert.rejects(features.runCustomCommand(repo, "x", {}, false), /only git commands/); checks += 1;

// autolinks, notes, perf preset, profiles
await features.setAutolinks(repo, [{ pattern: "#(\\d+)", url: "https://example.test/issues/$1" }]);
ok((await features.getAutolinks(repo)).rules.length === 1, "autolink rule stored");
await features.notesSet(repo, "HEAD", "reviewed");
ok((await features.notesGet(repo, "HEAD")) === "reviewed", "git note round-trips");
await features.perfApply(repo, "preset");
ok((await features.perfStatus(repo)).commitGraph, "preset writes a commit-graph");
await features.saveProfile({ name: "work", userName: "Work", userEmail: "w@work.test" });
await features.applyProfile(repo, "work", "repo", null);
ok(git("config", "user.email") === "w@work.test", "profile include overrides identity");
await features.detachProfile(repo, "work");
ok(git("config", "user.email") === "t@t", "detaching restores the repo identity");

// image blob through cat-file --filters
fs.writeFileSync(path.join(repo, "x.png"), Buffer.from([137, 80, 78, 71])); git("add", "x.png"); git("commit", "-qm", "png");
const blob = await features.fileBlob(repo, "HEAD", "x.png");
ok(blob.exists && blob.mime === "image/png" && blob.base64 === Buffer.from([137, 80, 78, 71]).toString("base64"), "blob served for image diff");

// remote parsing
ok(features.parseRemote("git@github.com:owner/repo.git")?.provider === "github", "scp-style GitHub remote parsed");
ok(features.parseRemote("https://gitlab.example.com/group/sub/proj.git")?.owner === "group/sub", "nested GitLab group parsed");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`roadmap features: ${checks} assertions passed`);
