// Submodules of a trusted repository count as trusted.
//
// Git refuses to work in a repository owned by another user unless it is in
// safe.directory ("dubious ownership"). On NTFS or other foreign drives every
// folder looks owned by root, so after the user trusts a repository (Settings
// or the trust prompt, see trust.ts) git still refuses each of its
// submodules: Chrono then sees them as uninitialized, and
// `git submodule update --init --recursive` stops at the first nested one.
//
// When a git process runs inside a folder listed in the user's global
// safe.directory, Chrono adds `safe.directory=*` for that process only
// (GIT_CONFIG_COUNT/KEY/VALUE). The process works in that repository and the
// submodules below it, whose git directories live in the trusted repository's
// own .git/modules. Nothing is written to the user's git config, and folders
// outside a trusted repository are unaffected.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cache: { checkedAt: number; stamp: string; roots: string[] } | null = null;

function configFiles(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return [process.env.GIT_CONFIG_GLOBAL || path.join(os.homedir(), ".gitconfig"), path.join(xdg, "git", "config")];
}

function stampOf(files: string[]): string {
  return files.map((file) => { try { return String(fs.statSync(file).mtimeMs); } catch { return "-"; } }).join("|");
}

/** Absolute folders in the user's global safe.directory list. */
export function trustedRoots(): string[] {
  const now = Date.now();
  if (cache && now - cache.checkedAt < 1000) return cache.roots;
  const stamp = stampOf(configFiles());
  if (cache && cache.stamp === stamp) { cache.checkedAt = now; return cache.roots; }
  let roots: string[] = [];
  try {
    const output = execFileSync("git", ["config", "--global", "-z", "--get-all", "safe.directory"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
    roots = parseTrustedRoots(output);
  } catch {
    roots = []; // no entries: git exits 1
  }
  cache = { checkedAt: now, stamp, roots };
  return roots;
}

/** safe.directory values (NUL-terminated, `git config -z`) that name one
 *  folder: not "*"; an empty value clears the entries before it. */
export function parseTrustedRoots(output: string): string[] {
  const roots: string[] = [];
  const values = output.split("\0");
  if (values[values.length - 1] === "") values.pop();
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") { roots.length = 0; continue; } // an empty entry resets the list
    if (value === "*" || !path.isAbsolute(value)) continue;
    roots.push(path.resolve(value.replace(/\/\*$/, "")));
  }
  return [...new Set(roots)];
}

/** True when `dir` is a trusted folder or inside one. */
export function insideTrusted(dir: string | null | undefined, roots: string[] = trustedRoots()): boolean {
  if (!dir || !path.isAbsolute(dir)) return false;
  const target = path.resolve(dir);
  return roots.some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/** Config entries to add for a git process that runs in `cwd`. */
export function trustConfigFor(cwd: string | null | undefined, roots?: string[]): Array<[string, string]> {
  return insideTrusted(cwd, roots) ? [["safe.directory", "*"]] : [];
}
