// Submodules of a trusted repository on a drive where git sees every folder
// as owned by someone else (NTFS, fuseblk): git refuses each submodule that is
// not itself in safe.directory. Chrono's git processes inside a trusted
// repository trust its submodules too (server/src/lib/gitTrust.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-trust-")));
const home = path.join(temp, "home");
fs.mkdirSync(home);
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" });
delete process.env.GIT_CONFIG_GLOBAL;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env });

const { parseTrustedRoots, insideTrusted, trustConfigFor } = await import("../server/src/lib/gitTrust.ts");
const { gitProcessEnv } = await import("../server/src/lib/gitCredentials.ts");
const { submoduleTree, submoduleAction } = await import("../server/src/submodules.ts");
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; console.log(`  ok  ${message}`); };

eq(parseTrustedRoots("/a/b\0*\0relative\0/c/*\0"), ["/a/b", "/c"], "absolute entries kept, * and relative ones ignored");
eq(parseTrustedRoots("/a\0\0/b\0"), ["/b"], "an empty entry clears the ones before it");
eq([insideTrusted("/a/b/c", ["/a/b"]), insideTrusted("/a/b", ["/a/b"]), insideTrusted("/a/bc", ["/a/b"]), insideTrusted(null, ["/a/b"])], [true, true, false, false], "inside a trusted folder, not a sibling with the same prefix");
eq(trustConfigFor("/elsewhere", ["/a"]), [], "no extra trust outside trusted folders");

// A superproject with a nested submodule, cloned recursively while ownership is normal.
const make = (name: string, sub?: [string, string]) => {
  const dir = path.join(temp, `${name}.src`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}\n`);
  git(dir, "add", "."); git(dir, "commit", "-qm", name);
  if (sub) { git(dir, "submodule", "add", "-q", path.join(temp, `${sub[1]}.git`), sub[0]); git(dir, "commit", "-qm", `add ${sub[0]}`); }
  execFileSync("git", ["clone", "-q", "--bare", dir, path.join(temp, `${name}.git`)], { env: process.env });
};
make("leaf"); make("mid", ["lib/leaf", "leaf"]); make("top", ["lib/mid", "mid"]);
const root = path.join(temp, "top");
execFileSync("git", ["clone", "-q", "--recurse-submodules", path.join(temp, "top.git"), root], { env: process.env });

// From now on git treats every repository as owned by another user.
process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
const refused = (() => { try { execFileSync("git", ["-C", path.join(root, "lib/mid"), "rev-parse", "HEAD"], { env: process.env, stdio: "pipe" }); return false; } catch { return true; } })();
eq(refused, true, "git refuses the submodule (test setup)");

git(home, "config", "--global", "--add", "safe.directory", root);
eq(gitProcessEnv(path.join(root, "lib/mid")).GIT_CONFIG_KEY_1, "safe.directory", "trust entry chained after existing GIT_CONFIG entries");
eq(gitProcessEnv(path.join(root, "lib/mid")).GIT_CONFIG_COUNT, "2", "count covers both");

let tree = await submoduleTree(root);
eq(tree.nodes.map((node) => [node.path, node.state]), [["lib/mid", "ok"], ["lib/mid/lib/leaf", "ok"]], "submodules of a trusted repository are seen as initialized");

git(root, "submodule", "deinit", "-q", "-f", "--all");
await submoduleAction(root, "update", "");
tree = await submoduleTree(root);
eq(tree.nodes.map((node) => node.state), ["ok", "ok"], "recursive initialization works through nested submodules");

// A repository nobody trusted stays refused.
const other = path.join(temp, "other");
execFileSync("git", ["clone", "-q", path.join(temp, "leaf.git"), other], { env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "0" } });
await assert.rejects(() => submoduleTree(other)); checks += 1; console.log("  ok  an untrusted repository is still refused");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`git trust: ${checks} checks passed`);
