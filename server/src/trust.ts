// "Dubious ownership" handling.
//
// Git (2.35.2+) refuses to touch a repository owned by another user unless it
// is listed in safe.directory. This is common for repos on external drives or
// folders created by root, and git's error tells the user to run a command
// themselves. Chrono detects that error and offers to add the entry for them.

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runGit } from "./lib/git.ts";
import { AppError } from "./lib/errors.ts";

export const DUBIOUS_OWNERSHIP = /detected dubious ownership in repository/i;

// The directory git complains about. It is the repository top level, which
// can differ from the path that was opened (a subfolder of the repo).
export function untrustedDirectory(stderr: string): string | null {
  const hint = stderr.match(/safe\.directory\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
  if (hint) return hint[1] ?? hint[2] ?? hint[3] ?? null;
  const at = stderr.match(/dubious ownership in repository at '([^']+)'/i);
  return at ? at[1] : null;
}

export interface TrustCheck {
  trusted: boolean;
  directory: string | null;
}

export async function checkTrust(path: string): Promise<TrustCheck> {
  const result = await runGit(path, ["rev-parse", "--git-dir"]);
  if (result.code !== 0 && DUBIOUS_OWNERSHIP.test(result.stderr)) {
    return { trusted: false, directory: untrustedDirectory(result.stderr) };
  }
  return { trusted: true, directory: null };
}

// Add the repository to the user's global safe.directory list. Only acts when
// git really reports dubious ownership for this path, so it cannot be used to
// whitelist arbitrary folders.
export async function trustRepository(path: string): Promise<TrustCheck> {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new AppError("invalid", `not a folder: ${path}`);
  }
  const before = await checkTrust(path);
  if (before.trusted) return before;
  const directory = before.directory;
  if (!directory) throw new AppError("command", "git reported dubious ownership but did not name the folder");
  const added = await runGit(null, ["config", "--global", "--add", "safe.directory", directory]);
  if (added.code !== 0) throw new AppError("command", added.stderr.trim() || "could not update the global git config");
  const after = await checkTrust(path);
  if (!after.trusted) throw new AppError("command", `git still refuses ${directory} after adding it to safe.directory`);
  return { trusted: true, directory };
}
