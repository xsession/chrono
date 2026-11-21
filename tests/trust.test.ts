// Repositories owned by another user ("dubious ownership"): Chrono detects
// git's refusal and can add the folder to the global safe.directory list.
// GIT_TEST_ASSUME_DIFFERENT_OWNER makes git treat every repo as foreign.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTrust, trustRepository, untrustedDirectory } from "../server/src/trust.ts";
import { repositoryBranches } from "../server/src/backend.ts";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-trust-")));
Object.assign(process.env, { HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config") });
delete process.env.GIT_CONFIG_GLOBAL;
const repo = path.join(temp, "foreign repo");
fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", repo]);
let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };

ok(untrustedDirectory("fatal: detected dubious ownership in repository at '/a b/c'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '/a b/c'") === "/a b/c", "parses quoted hint");
ok(untrustedDirectory("To add an exception for this directory, call: git config --global --add safe.directory /x/y") === "/x/y", "parses bare hint");

ok((await checkTrust(repo)).trusted, "own repo is trusted");
process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
const before = await checkTrust(path.join(repo, "sub"));
ok(!before.trusted && before.directory === repo, `foreign repo reported with its top level (${before.directory})`);
await assert.rejects(repositoryBranches(repo), /dubious ownership/, "branch listing surfaces git's refusal"); checks += 1;

await assert.rejects(trustRepository("relative/path"), /not a folder/); checks += 1;
const result = await trustRepository(path.join(repo, "sub"));
ok(result.trusted && result.directory === repo, "trusting from a subfolder trusts the top level");
const listed = execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8" }).trim().split("\n");
ok(listed.length === 1 && listed[0] === repo, "exactly one safe.directory entry added");
ok(Array.isArray(await repositoryBranches(repo)), "branches load after trusting");
await trustRepository(repo);
ok(execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8" }).trim().split("\n").length === 1, "trusting again adds nothing");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`trust: ${checks} checks passed`);
