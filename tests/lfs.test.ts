// Git LFS: status read without the git-lfs binary (patterns, pointers, local
// store), image content from the store, and the actions when git-lfs exists.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-lfs-")));
Object.assign(process.env, { HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env });
const { lfsStatus, lfsAction, lfsAuto, lfsVersion, parseLfsAttributes, parsePointer, parseLocks, objectPath } = await import("../server/src/lfs.ts");
const { fileBlob } = await import("../server/src/features.ts");
const { cloneRepository } = await import("../server/src/backend.ts");
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; console.log(`  ok  ${message}`); };

eq(parseLfsAttributes("# c\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text\n*.zip filter=lfs diff=lfs merge=lfs -text lockable\n", "assets/.gitattributes"),
  [{ pattern: "assets/*.psd", source: "assets/.gitattributes", lockable: false }, { pattern: "assets/*.zip", source: "assets/.gitattributes", lockable: true }], "patterns from .gitattributes, nested ones prefixed");
eq(parsePointer("version https://git-lfs.github.com/spec/v1\r\noid sha256:" + "a".repeat(64) + "\r\nsize 12\r\n"), { oid: "a".repeat(64), size: 12 }, "pointer parsed (CRLF too)");
eq(parsePointer("hello"), null, "not a pointer");
eq(parseLocks('[{"id":"7","path":"a.psd","owner":{"name":"ann"},"locked_at":"2026-01-01T00:00:00Z"}]'), [{ id: "7", path: "a.psd", owner: "ann", lockedAt: "2026-01-01T00:00:00Z" }], "locks JSON");

// A repository whose index holds LFS pointers, as a clone with git-lfs would.
const repo = path.join(temp, "repo");
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n*.bin filter=lfs diff=lfs merge=lfs -text lockable\n");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pointerOf = (content: Buffer) => `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash("sha256").update(content).digest("hex")}\nsize ${content.length}\n`;
fs.writeFileSync(path.join(repo, "here.png"), pointerOf(png));
fs.writeFileSync(path.join(repo, "missing.png"), pointerOf(Buffer.from("not downloaded")));
fs.writeFileSync(path.join(repo, "plain.bin"), Buffer.alloc(2048, 7)); // matches *.bin, stored in git
fs.writeFileSync(path.join(repo, "readme.txt"), "text\n");
git(repo, "add", "."); git(repo, "commit", "-qm", "init");
const oid = createHash("sha256").update(png).digest("hex");
const store = path.join(repo, ".git", "lfs", "objects");
fs.mkdirSync(path.dirname(objectPath(store, oid)), { recursive: true });
fs.writeFileSync(objectPath(store, oid), png);

const status = await lfsStatus(repo);
eq([status.used, status.patterns.map((entry) => [entry.pattern, entry.lockable])], [true, [["*.png", false], ["*.bin", true]]], "repository uses LFS, lockable flag read");
const byPath = new Map(status.files.map((file) => [file.path, file]));
eq([...byPath.keys()].sort(), ["here.png", "missing.png", "plain.bin"], "only files matched by an LFS pattern");
eq([byPath.get("here.png")?.downloaded, byPath.get("here.png")?.size, byPath.get("here.png")?.pointerInWorktree], [true, png.length, true], "downloaded object, but the folder still has the pointer");
eq([byPath.get("missing.png")?.downloaded, Boolean(byPath.get("missing.png")?.oid)], [false, true], "pointer without local content is not downloaded");
eq([byPath.get("plain.bin")?.oid, status.unconverted, status.missing], [null, 1, 1], "file stored in git counted as unconverted");
eq(status.storeBytes, png.length, "local store size");

const blob = await fileBlob(repo, "HEAD", "here.png");
eq([blob.lfs, Buffer.from(blob.base64, "base64").equals(png)], [false, true], "image diff shows the real image from the LFS store");
eq((await fileBlob(repo, "HEAD", "missing.png")).lfs, true, "a pointer without content stays a pointer");

const version = await lfsVersion();
if (!version) {
  await assert.rejects(() => lfsAction(repo, { action: "track", pattern: "*.psd" }), /git-lfs is not installed/); checks += 1;
  console.log("  ok  actions explain that git-lfs is missing (git-lfs not installed: skipping its tests)");
} else {
  await lfsAction(repo, { action: "install" });
  eq((await lfsStatus(repo)).hooks, true, "set up adds the filter and pre-push hook");
  await lfsAction(repo, { action: "track", pattern: "*.psd", lockable: true });
  eq((await lfsStatus(repo)).patterns.some((entry) => entry.pattern === "*.psd" && entry.lockable), true, "track adds a lockable pattern");
  await lfsAction(repo, { action: "untrack", pattern: "*.psd" });
  eq((await lfsStatus(repo)).patterns.some((entry) => entry.pattern === "*.psd"), false, "untrack removes it");
  await lfsAction(repo, { action: "convert", files: ["plain.bin"] });
  git(repo, "commit", "-qm", "convert");
  const after = (await lfsStatus(repo)).files.find((file) => file.path === "plain.bin");
  eq([Boolean(after?.oid), after?.downloaded, after?.size], [true, true, 2048], "convert stores the file in LFS");
  await assert.rejects(() => lfsAction(repo, { action: "track", pattern: "--evil" }), /invalid LFS pattern/); checks += 1;

  // Push to a remote, clone without content, then download one file.
  const bare = path.join(temp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: process.env });
  git(repo, "remote", "add", "origin", bare);
  git(repo, "config", "lfs.allowincompletepush", "true"); // missing.png has no content on purpose
  git(repo, "push", "-q", "origin", "main");
  await lfsAction(repo, { action: "push", all: true });
  const clone = path.join(temp, "clone");
  execFileSync("git", ["clone", "-q", bare, clone], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
  await lfsAction(clone, { action: "install" });
  let cloned = await lfsStatus(clone);
  eq(cloned.files.filter((file) => file.oid && !file.downloaded).map((file) => file.path), ["here.png", "missing.png", "plain.bin"], "clone without content: no LFS file is downloaded");
  eq(fs.statSync(path.join(clone, "plain.bin")).size < 200, true, "the folder holds the pointer");
  await lfsAction(clone, { action: "pull", files: ["plain.bin"] });
  cloned = await lfsStatus(clone);
  const pulled = cloned.files.find((file) => file.path === "plain.bin");
  eq([pulled?.downloaded, pulled?.pointerInWorktree, fs.statSync(path.join(clone, "plain.bin")).size], [true, false, 2048], "download puts the content in the folder");
  eq(git(clone, "status", "--porcelain").trim(), "", "and leaves the work tree clean");

  // A new LFS file pushed with plain git push uploads its object (pre-push hook).
  fs.writeFileSync(path.join(clone, "more.bin"), Buffer.alloc(4096, 9));
  git(clone, "add", "more.bin"); git(clone, "commit", "-qm", "more");
  git(clone, "push", "-q", "origin", "main");
  const third = path.join(temp, "third");
  execFileSync("git", ["clone", "-q", bare, third], { env: process.env });
  await lfsAction(third, { action: "install" });
  await lfsAction(third, { action: "pull", files: ["more.bin"] });
  eq(fs.statSync(path.join(third, "more.bin")).size, 4096, "pushed LFS content reaches a fresh clone");

  // Automatic setup: a plain clone (no global LFS filter here) gets LFS set
  // up and its files downloaded; a second run has nothing left to do.
  const plain = path.join(temp, "plain");
  execFileSync("git", ["clone", "-q", bare, plain], { env: process.env });
  eq((await lfsStatus(plain)).hooks, false, "a plain clone has no LFS set up");
  const auto = await lfsAuto(plain);
  eq([auto.setUp, auto.downloaded, fs.statSync(path.join(plain, "more.bin")).size], [true, 3, 4096], `automatic setup sets up LFS and downloads what the server has (${auto.message})`);
  eq(auto.message?.includes("1 file(s) could not be downloaded"), true, "the file the server lacks is reported");
  eq((await lfsAuto(plain)).setUp, false, "a second run does not set up again");
  const viaClone = path.join(temp, "via-clone");
  await cloneRepository({ url: bare, destination: viaClone, recurseSubmodules: false });
  eq([(await lfsStatus(viaClone)).hooks, fs.statSync(path.join(viaClone, "plain.bin")).size], [true, 2048], "cloning in Chrono sets up LFS and downloads files");
  const noLfs = path.join(temp, "no-lfs");
  await cloneRepository({ url: bare, destination: noLfs, recurseSubmodules: false, lfs: false });
  eq((await lfsStatus(noLfs)).hooks, false, "unless automatic setup is off");
  const again = await lfsAuto(path.join(temp, "repo"));
  eq([again.setUp, again.message?.includes("1 file(s) could not be downloaded")], [false, true], "an already set up repository is left alone; a file whose content exists nowhere is still reported");

  // Locks need an LFS server; with a file remote the error is reported, not hidden.
  await assert.rejects(() => lfsAction(clone, { action: "lock", files: ["plain.bin"] })); checks += 1;
  console.log("  ok  locking without a lock server fails with git-lfs's error");
}
await assert.rejects(() => lfsAction(repo, { action: "convert", files: ["../x"] }), version ? /invalid path/ : /git-lfs/); checks += 1;

fs.rmSync(temp, { recursive: true, force: true });
console.log(`lfs: ${checks} checks passed`);
