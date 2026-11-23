// Recent changes for the landscape's heatmap: per file, when it was last
// committed, how many commits touched it lately, and whether it has
// uncommitted edits. Not cached (unlike the scan, which is keyed by HEAD),
// because the working tree changes without HEAD moving; it is cheap enough to
// run on every live change.

import path from "node:path";
import { repositoryRoot, runGit } from "./lib/git.ts";

export interface RecentFile {
  /** Unix seconds of the newest commit that touched the file (0: none). */
  t: number;
  /** Commits that touched the file in the window. */
  n: number;
  /** Uncommitted: modified, staged or new in the working tree. */
  w?: 1;
}

export interface LandscapeRecent {
  root: string;
  /** Server time, Unix seconds, so ages don't depend on the client's clock. */
  now: number;
  days: number;
  files: Record<string, RecentFile>;
  /** Commits read; `capped` when the window held more than MAX_COMMITS. */
  commits: number;
  capped: boolean;
}

const MAX_DAYS = 365;
const MAX_COMMITS = 4000;   // per repository; enough for a year of most projects
const MAX_DEPTH = 4;        // nested submodules

const CONTROL = String.fromCharCode(1);

async function commitsIn(dir: string, prefix: string, days: number, files: Record<string, RecentFile>): Promise<{ count: number; capped: boolean }> {
  const log = await runGit(dir, [
    "log", "--no-merges", "--no-renames", `--since=${days}.days.ago`, `-n${MAX_COMMITS}`,
    `--format=${CONTROL}%ct`, "--name-only", "-z",
  ]);
  if (log.code !== 0) return { count: 0, capped: false }; // e.g. no commits yet
  let count = 0;
  let time = 0;
  for (const token of log.stdout.split("\0")) {
    // -z separates names with NUL; each commit starts with "\x01<time>" on its own line.
    let name = token;
    const header = name.indexOf(CONTROL);
    if (header >= 0) {
      const line = name.slice(header + 1);
      const end = line.indexOf("\n");
      time = Number(end >= 0 ? line.slice(0, end) : line) || 0;
      count += 1;
      name = end >= 0 ? line.slice(end + 1) : "";
    }
    name = name.replace(/^\n+/, "");
    if (!name) continue;
    const key = prefix + name;
    const entry = files[key] ?? (files[key] = { t: 0, n: 0 });
    entry.n += 1;
    if (time > entry.t) entry.t = time;
  }
  return { count, capped: count >= MAX_COMMITS };
}

async function uncommittedIn(dir: string, prefix: string, files: Record<string, RecentFile>): Promise<string[]> {
  // Submodules are read on their own, so their gitlinks are skipped here.
  const status = await runGit(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (status.code !== 0) return [];
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4) continue;
    const code = item.slice(0, 2);
    const key = prefix + item.slice(3);
    (files[key] ?? (files[key] = { t: 0, n: 0 })).w = 1;
    if (code[0] === "R" || code[0] === "C") i += 1; // the original name follows
  }
  const subs = await runGit(dir, ["submodule", "status"]);
  if (subs.code !== 0) return [];
  return subs.stdout.split("\n")
    .filter((line) => line && !line.startsWith("-")) // "-": not initialised, nothing on disk
    .map((line) => /^[ +U][0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line)?.[1])
    .filter((sub): sub is string => Boolean(sub));
}

export async function landscapeRecent(inputPath: string, days = 90): Promise<LandscapeRecent> {
  const root = await repositoryRoot(inputPath);
  const window = Math.max(1, Math.min(MAX_DAYS, Math.round(days) || 90));
  const files: Record<string, RecentFile> = {};
  let commits = 0;
  let capped = false;
  const visit = async (dir: string, prefix: string, depth: number) => {
    const [log, subs] = await Promise.all([commitsIn(dir, prefix, window, files), uncommittedIn(dir, prefix, files)]);
    commits += log.count;
    capped ||= log.capped;
    // The superproject's log names a submodule as one path; its files come next.
    for (const sub of subs) delete files[`${prefix}${sub}`];
    if (depth >= MAX_DEPTH) return;
    await Promise.all(subs.map((sub) => visit(path.join(dir, sub), `${prefix}${sub}/`, depth + 1)));
  };
  await visit(root, "", 0);
  return { root, now: Math.floor(Date.now() / 1000), days: window, files, commits, capped };
}
