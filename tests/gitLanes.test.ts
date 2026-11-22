// Per-repository git lanes: a slow repository must not delay another one,
// identical concurrent reads share one git process, a write is never merged
// with a read issued before it, and reads of an abandoned request are killed.
// A core.fsmonitor hook that sleeps makes `git status` slow and counts runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CHRONO_GIT_PER_REPO = "2";
const { runGit, withAbortSignal } = await import("../server/src/lib/git.ts");

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-lanes-")));
Object.assign(process.env, { HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config") });
delete process.env.GIT_CONFIG_GLOBAL;
let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };

function makeRepo(name: string): string {
  const repo = path.join(temp, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}
const slow = makeRepo("slow");
const fast = makeRepo("fast");
const runs = path.join(temp, "hook-runs.log");
const hook = path.join(temp, "slow-fsmonitor.sh");
fs.writeFileSync(hook, `#!/bin/sh\necho run >> "${runs}"\nsleep 0.5\nexit 1\n`, { mode: 0o755 });
execFileSync("git", ["-C", slow, "config", "core.fsmonitor", hook]);
const hookRuns = () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).length : 0);
const resetRuns = () => fs.rmSync(runs, { force: true });
const elapsed = async <T>(work: Promise<T>) => { const start = performance.now(); const value = await work; return { value, ms: performance.now() - start }; };

// git may call the hook more than once per status; measure it.
resetRuns();
await runGit(slow, ["status", "--porcelain", "--", "baseline"]);
const perStatus = hookRuns();
ok(perStatus >= 1, `fsmonitor hook runs ${perStatus}x per status`);

// 1. Identical concurrent reads share one process.
resetRuns();
const [first, second] = await Promise.all([runGit(slow, ["status", "--porcelain"]), runGit(slow, ["status", "--porcelain"])]);
ok(first.code === 0 && second.code === 0 && first.stdout === second.stdout, "shared read returns the same output to both callers");
ok(hookRuns() === perStatus, `identical concurrent reads ran git once (ran ${hookRuns()}x)`);

// 2. A write between two identical reads forces a fresh read.
resetRuns();
const before = runGit(slow, ["status", "--porcelain"]);
await runGit(slow, ["config", "chrono.lanes", "1"]);
const after = runGit(slow, ["status", "--porcelain"]);
await Promise.all([before, after]);
ok(hookRuns() === 2 * perStatus, `a read after a write is not merged with an earlier one (ran ${hookRuns()}x)`);

// 3. A slow repository does not hold up another one, even with its lane full.
resetRuns();
const busy = [0, 1, 2].map((index) => runGit(slow, ["status", "--porcelain", "--", `x${index}`]));
await new Promise((resolve) => setTimeout(resolve, 100));
const other = await elapsed(runGit(fast, ["rev-parse", "HEAD"]));
ok(other.value.code === 0 && other.ms < 500, `other repository answered in ${Math.round(other.ms)} ms while the slow one was busy`);
const slowDone = await elapsed(Promise.all(busy));
ok(slowDone.value.every((output) => output.code === 0), "queued reads in the full lane still complete");
ok(slowDone.ms > 1200, `lane limit queues the third slow read (${Math.round(slowDone.ms)} ms)`);

// 4. Reads of an abandoned request are killed.
resetRuns();
const abandoned = new AbortController();
const killed = elapsed(withAbortSignal(abandoned.signal, () => runGit(slow, ["status", "--porcelain", "--", "abandoned"])));
setTimeout(() => abandoned.abort(), 150);
const result = await killed;
ok(result.value.code === 130 && result.ms < 800, `abandoned read stopped after ${Math.round(result.ms)} ms`);

// 5. A shared read survives when only one of its callers gives up.
const quitter = new AbortController();
const kept = runGit(slow, ["status", "--porcelain", "--", "shared"]);
const dropped = withAbortSignal(quitter.signal, () => runGit(slow, ["status", "--porcelain", "--", "shared"]));
setTimeout(() => quitter.abort(), 100);
ok((await kept).code === 0, "a caller that did not abort still gets the shared result");
await dropped;

// 6. Writes ignore the abort signal.
const writeSignal = new AbortController();
writeSignal.abort();
const write = await withAbortSignal(writeSignal.signal, () => runGit(slow, ["config", "chrono.write", "yes"]));
ok(write.code === 0 && execFileSync("git", ["-C", slow, "config", "chrono.write"], { encoding: "utf8" }).trim() === "yes", "writes run even when the request was abandoned");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`git lanes: ${checks} checks passed`);
