import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listRefGroups } from "../server/src/repo.ts";

const exec = promisify(execFile);
const runGit = (cwd, ...args) => exec("git", ["-C", cwd, ...args]);
const repo = await mkdtemp(path.join(tmpdir(), "chrono-ref-groups-"));

try {
  await runGit(repo, "init", "-b", "main");
  await runGit(repo, "config", "user.name", "Chrono Test");
  await runGit(repo, "config", "user.email", "chrono@example.com");
  await writeFile(path.join(repo, "README.md"), "chrono\n");
  await runGit(repo, "add", "README.md");
  await runGit(repo, "commit", "-m", "initial");
  await runGit(repo, "branch", "feature/ui");
  await runGit(repo, "update-ref", "refs/remotes/origin/feature/ui", "HEAD");

  const groups = await listRefGroups(repo);
  const local = groups.branches.find((branch) => branch.name === "feature/ui");
  const remote = groups.branches.find((branch) => branch.name === "feature/ui" && branch.remote === "origin");

  assert.ok(local, "slash-containing local branch should be listed");
  assert.equal(local.remote, null, "slash-containing local branch must not be classified as remote");
  assert.ok(remote, "remote branch should still be listed separately");
  assert.equal(remote.remote, "origin");

  await runGit(repo, "tag", "-a", "v-annotated", "-m", "annotated");
  const withTag = await listRefGroups(repo);
  assert.equal(withTag.tags.length, 1, "annotated tag is listed");
  assert.equal(withTag.tags[0].target.length, 40, "annotated tag is peeled to its commit target");

  await writeFile(path.join(repo, "wip.txt"), "wip\n");
  await runGit(repo, "stash", "push", "-u", "-m", "graph stash");
  const withStash = await listRefGroups(repo);
  assert.equal(withStash.stashes.length, 1, "stash is listed");
  assert.equal(withStash.stashes[0].ref, "stash@{0}");
  assert.equal(withStash.stashes[0].target.length, 40, "stash exposes its graph target commit");
  await runGit(repo, "stash", "drop", "stash@{0}");
  console.log("reference groups: slash-containing branch assertions passed");
} finally {
  await rm(repo, { recursive: true, force: true });
}
