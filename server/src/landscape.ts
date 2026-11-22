// Codebase landscape: the data behind the Landscape view (public/landscape/).
//
// The map draws folders as islands, files as hills and imports as roads. It
// builds all of that from one record per source file; this module produces
// those records from the repository on disk, the same way the map does when it
// reads a dropped folder: tracked files only (so .gitignore'd build output is
// left out), submodules included and reported as nested repositories.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkedStdout, repositoryRoot, runGit } from "./lib/git.ts";
import * as parse from "./landscapeParse.ts";
import { workspacesFile } from "./workspaces.ts";

const LANG = parse.LANG as Record<string, string>;
const FAM = parse.FAM as Record<string, string>;
const { SKIP, SKIPF, countLoc, extOf } = parse;
const specsOf = parse.specsOf as (text: string, fam: string) => string[];
const symsOf = parse.symsOf as (text: string, fam: string) => string[];
const csInfo = parse.csInfo as (text: string) => LandscapeRecord["cs"];

export interface LandscapeRecord {
  path: string;
  lang: string;
  loc: number;
  specs: string[];
  cs: { ns: string[]; uses: string[]; decl: string[]; toks: string[] } | null;
  syms: string[];
}

export interface LandscapeRepo { title: string; path: string; url: string; sha: string }

export interface LandscapeScan {
  name: string;
  root: string;
  head: string;
  files: LandscapeRecord[];
  repos: LandscapeRepo[];
  /** Source files left out because the map is capped at MAX_FILES. */
  cut: number;
  scannedAt: string;
  durationMs: number;
}

const MAX_FILES = 12000;          // the map's own limit (MAXF)
const MAX_BYTES = 1.5e6;          // skip generated giants, as the map does
const PARSE_BYTES = 8e5;          // read but don't parse very large files
const READ_POOL = 24;

const cache = new Map<string, LandscapeScan>();

// Big trees on slow disks take a while to read, so the last scan of each
// repository is also kept on disk and reused while HEAD stays the same.
const diskFile = (root: string) => path.join(path.dirname(workspacesFile()), "landscape", `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

async function readDisk(root: string, head: string): Promise<LandscapeScan | null> {
  try {
    const scan = JSON.parse(await fs.readFile(diskFile(root), "utf8")) as LandscapeScan;
    return scan.root === root && scan.head === head && Array.isArray(scan.files) ? scan : null;
  } catch {
    return null;
  }
}

async function writeDisk(scan: LandscapeScan): Promise<void> {
  const file = diskFile(scan.root);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(scan));
    await fs.rename(`${file}.tmp`, file);
  } catch { /* the cache is optional */ }
}

async function submoduleRepos(root: string, head: string): Promise<LandscapeRepo[]> {
  const repos: LandscapeRepo[] = [{ title: path.basename(root), path: "", url: "", sha: head.slice(0, 7) }];
  const status = await runGit(root, ["submodule", "status", "--recursive"]);
  if (status.code !== 0 || !status.stdout.trim()) return repos;
  const urls = new Map<string, Map<string, string>>(); // parent path → submodule path → url
  const urlFor = async (parent: string, relative: string): Promise<string> => {
    let table = urls.get(parent);
    if (!table) {
      table = new Map();
      urls.set(parent, table);
      const file = path.join(root, parent, ".gitmodules");
      const listed = await runGit(root, ["config", "-f", file, "--get-regexp", "^submodule\\..*\\.(path|url)$"]);
      const byName = new Map<string, { path?: string; url?: string }>();
      for (const line of listed.stdout.split("\n")) {
        const match = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line.trim());
        if (!match) continue;
        const entry = byName.get(match[1]) ?? {};
        entry[match[2] as "path" | "url"] = match[3];
        byName.set(match[1], entry);
      }
      for (const entry of byName.values()) if (entry.path) table.set(entry.path, entry.url ?? "");
    }
    return table.get(relative) ?? "";
  };
  const paths: string[] = [];
  for (const line of status.stdout.split("\n")) {
    const match = /^[ +\-U]([0-9a-f]{7,64}) (.+?)(?: \(.*\))?$/.exec(line);
    if (match && !line.startsWith("-")) paths.push(match[2]);
  }
  paths.sort((a, b) => a.length - b.length);
  for (const line of status.stdout.split("\n")) {
    const match = /^[ +\-U]([0-9a-f]{7,64}) (.+?)(?: \(.*\))?$/.exec(line);
    if (!match || line.startsWith("-")) continue; // not initialised: no files to map
    const subPath = match[2];
    const parent = paths.filter((other) => subPath.startsWith(`${other}/`)).sort((a, b) => b.length - a.length)[0] ?? "";
    const url = await urlFor(parent, parent ? subPath.slice(parent.length + 1) : subPath);
    const title = (url || subPath).replace(/\.git$/, "").replace(/\/$/, "").split(/[/:]/).pop() || subPath;
    repos.push({ title, path: subPath, url, sha: match[1].slice(0, 7) });
  }
  return repos;
}

export async function landscapeScan(inputPath: string, force = false): Promise<LandscapeScan> {
  const started = performance.now();
  const root = await repositoryRoot(inputPath);
  const head = (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
  const key = `${root}\u0000${head}`;
  if (!force) {
    const cached = cache.get(key) ?? await readDisk(root, head);
    if (cached) { cache.set(key, cached); return cached; }
  }

  const listed = await checkedStdout(root, ["ls-files", "-z", "--recurse-submodules"]);
  let keep = listed.split("\0").filter((file) => file && !SKIP.test(file) && !SKIPF.test(file) && LANG[extOf(file)]);
  keep = [...new Set(keep)].sort((a, b) => a.localeCompare(b));
  let cut = 0;
  if (keep.length > MAX_FILES) { cut = keep.length - MAX_FILES; keep = keep.slice(0, MAX_FILES); }

  const records: Array<LandscapeRecord | null> = new Array(keep.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < keep.length) {
      const index = next++;
      const relative = keep[index];
      const absolute = path.join(root, relative);
      let text = "";
      try {
        const info = await fs.stat(absolute);
        if (!info.isFile() || info.size >= MAX_BYTES) continue;
        text = await fs.readFile(absolute, "utf8");
      } catch {
        continue; // deleted in the working tree, or unreadable
      }
      const lang = LANG[extOf(relative)];
      const fam = FAM[lang] as string | undefined;
      const parseable = Boolean(fam) && text.length < PARSE_BYTES;
      records[index] = {
        path: relative,
        lang,
        loc: countLoc(text),
        specs: parseable && fam ? specsOf(text, fam) : [],
        cs: parseable && fam === "cs" ? csInfo(text) : null,
        syms: parseable && fam && fam !== "cs" ? symsOf(text, fam) : [],
      };
    }
  };
  await Promise.all(Array.from({ length: READ_POOL }, worker));

  const scan: LandscapeScan = {
    name: path.basename(root),
    root,
    head,
    files: records.filter((record): record is LandscapeRecord => record !== null),
    repos: await submoduleRepos(root, head),
    cut,
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
  for (const [other, entry] of cache) if (entry.root === root) cache.delete(other);
  cache.set(key, scan);
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  await writeDisk(scan);
  return scan;
}
