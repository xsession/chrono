import assert from "node:assert/strict";
import { referenceKey, reachableCommitIds, visibleRefCommitIds } from "../src/refVisibility.ts";
import type { BranchRecord, CommitRecord } from "../src/types.ts";

const commit = (id: string, parents: string[] = []): CommitRecord => ({
  id, parents, authorName: "Test", authorEmail: "test@example.test", authoredAt: "2026-01-01T00:00:00Z", subject: id,
});
const branch = (name: string, target: string, remote = false): BranchRecord => ({ name, target, remote, current: name === "main" && !remote, upstream: null });

const base = commit("a");
const feature = commit("b", [base.id]);
const main = commit("c", [base.id]);
const commits = [feature, main, base];
const refs = [branch("main", main.id), branch("feature", feature.id), branch("origin/main", main.id, true)];

assert.deepEqual([...reachableCommitIds(commits, feature.id)].sort(), ["a", "b"]);
assert.equal(referenceKey(refs[0]), "local:main");
assert.equal(referenceKey(refs[2]), "remote:origin/main");
assert.deepEqual([...visibleRefCommitIds(commits, refs, [])].sort(), ["a", "b", "c"]);
assert.deepEqual([...visibleRefCommitIds(commits, refs, ["local:feature", "remote:origin/main"])].sort(), ["a", "c"]);
assert.deepEqual([...visibleRefCommitIds(commits, refs, ["local:main", "remote:origin/main"])].sort(), ["a", "b"]);

console.log("reference visibility: hide/solo reachability assertions passed");
