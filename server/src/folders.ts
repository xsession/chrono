// Folder browser for the in-app "Open repository" picker.
//
// The native dialog is not always usable: the web build has none, and on
// Linux Electron's GTK/portal dialog fails silently when the session runs out
// of inotify instances. Listing folders on the server keeps the picker working
// everywhere and lets it mark which folders are Git repositories.

import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppError } from "./lib/errors.ts";

export interface FolderEntry {
  name: string;
  path: string;
  repo: boolean;
  hidden: boolean;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  repo: boolean;
  entries: FolderEntry[];
  truncated: boolean;
  places: Array<{ name: string; path: string }>;
}

const MAX_ENTRIES = 3000;

const isRepo = (dir: string) => existsSync(path.join(dir, ".git"));

async function isDirectory(target: string): Promise<boolean> {
  try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}

async function places(): Promise<Array<{ name: string; path: string }>> {
  const home = os.homedir();
  const result: Array<{ name: string; path: string }> = [{ name: "Home", path: home }];
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      if (existsSync(drive)) result.push({ name: `${letter}:`, path: drive });
    }
    return result;
  }
  result.push({ name: "Computer", path: "/" });
  const user = os.userInfo().username;
  const mountRoots = process.platform === "darwin" ? ["/Volumes"] : [`/media/${user}`, `/run/media/${user}`, "/mnt"];
  for (const root of mountRoots) {
    const children = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isDirectory() || child.isSymbolicLink()) result.push({ name: child.name, path: path.join(root, child.name) });
    }
  }
  return result;
}

export async function listFolders(requested: string | null, showHidden = false): Promise<FolderListing> {
  let dir = requested && requested.trim() ? requested.trim() : os.homedir();
  if (dir === "~" || dir.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(1));
  if (!path.isAbsolute(dir)) throw new AppError("invalid", `use an absolute path: ${dir}`);
  dir = path.resolve(dir);
  // Walk up to the nearest existing folder so a mistyped tail still lands somewhere useful.
  while (!(await isDirectory(dir))) {
    const up = path.dirname(dir);
    if (up === dir) throw new AppError("invalid", `folder not found: ${requested}`);
    dir = up;
  }
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    throw new AppError("io", `cannot read ${dir}: ${error.code ?? error.message}`);
  });
  const candidates = dirents.filter((dirent) => dirent.name !== ".git" && (showHidden || !dirent.name.startsWith(".")));
  // existsSync is faster than async fs calls here, notably on fuse/NTFS mounts.
  const checked = await Promise.all(candidates.map(async (dirent): Promise<FolderEntry | null> => {
    const full = path.join(dir, dirent.name);
    const folder = dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectory(full)));
    if (!folder) return null;
    return { name: dirent.name, path: full, repo: isRepo(full), hidden: dirent.name.startsWith(".") };
  }));
  const entries = checked.filter((entry): entry is FolderEntry => entry !== null);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    repo: isRepo(dir),
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    places: await places(),
  };
}
