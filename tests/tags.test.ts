// Tag pushes: force push with a lease on what the remote had, force push of
// all tags, and fetching tags that moved on the remote.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-tags-")));
Object.assign(process.env, { HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env }).trim();
const { tagAction, tagRemoteState } = await import("../server/src/gkOps.ts");
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; console.log(`  ok  ${message}`); };

const bare = path.join(temp, "remote.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
const repo = path.join(temp, "repo");
execFileSync("git", ["clone", "-q", bare, repo], { env: process.env, stdio: "pipe" });
const commit = (name: string) => { fs.writeFileSync(path.join(repo, name), name); git(repo, "add", name); git(repo, "commit", "-qm", name); return git(repo, "rev-parse", "HEAD"); };
const first = commit("a");
git(repo, "tag", "-a", "v1", "-m", "v1");
git(repo, "push", "-q", "origin", "main");
await tagAction(repo, "push", "v1", "origin");
const remoteTag = () => git(bare, "rev-parse", "v1^{commit}");
eq(remoteTag(), first, "tag pushed");

const second = commit("b");
git(repo, "tag", "-f", "-a", "v1", "-m", "v1 moved");
await assert.rejects(() => tagAction(repo, "push", "v1", "origin"), /rejected|already exists/); checks += 1; console.log("  ok  a moved tag is rejected by a plain push");

let state = await tagRemoteState(repo, "v1", "origin");
eq([state.remoteCommit, state.localCommit, state.remoteId !== state.localId], [first, second, true], "remote state shows the old and the new commit");
await assert.rejects(() => tagAction(repo, "force_push", "v1", "origin", { expect: "0".repeat(40) }), /stale|rejected/); checks += 1; console.log("  ok  force push refuses when the remote is not what was shown");
await tagAction(repo, "force_push", "v1", "origin", { expect: state.remoteId });
eq(remoteTag(), second, "force push with the shown id replaces the remote tag");
state = await tagRemoteState(repo, "v1", "origin");
eq(state.remoteId, state.localId, "remote and local tag are now the same object");

// Another clone still has the old tag; plain fetch refuses to move it.
const other = path.join(temp, "other");
const other0 = (() => { execFileSync("git", ["clone", "-q", bare, other], { env: process.env, stdio: "pipe" }); return other; })();
git(other0, "tag", "-f", "v1", first);
git(other0, "tag", "v2", first);
await tagAction(other0, "fetch_force", "", "origin");
eq([git(other0, "rev-parse", "v1^{commit}"), git(other0, "rev-parse", "v2")], [second, first], "fetch with overwrite moves changed tags and keeps local-only ones");

// Force push all: moved tags are replaced, others pushed.
git(repo, "tag", "-f", "v1", first);
git(repo, "tag", "v3", second);
await tagAction(repo, "force_push_all", "", "origin");
eq([remoteTag(), git(bare, "rev-parse", "v3")], [first, second], "force push all replaces moved tags and pushes new ones");

await assert.rejects(() => tagAction(repo, "force_push", "v1", "origin", { expect: "nothex" }), /invalid expected/); checks += 1;
await assert.rejects(() => tagAction(repo, "force_push", "--x", "origin")); checks += 1;
fs.rmSync(temp, { recursive: true, force: true });
console.log(`tags: ${checks} checks passed`);
