// In-app folder picker backend, plus a guard that UI code never relies on
// window.prompt/confirm/alert (Electron does not implement prompt(), so such
// buttons silently do nothing in the desktop app).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFolders } from "../server/src/folders.ts";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-folders-")));
for (const dir of ["beta", "Alpha", "item10", "item9", ".hidden", "repo"]) fs.mkdirSync(path.join(temp, dir));
fs.writeFileSync(path.join(temp, "file.txt"), "x");
execFileSync("git", ["init", "-q", path.join(temp, "repo")]);
fs.symlinkSync(path.join(temp, "beta"), path.join(temp, "link-to-beta"));
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };

const listing = await listFolders(temp);
eq(listing.entries.map((entry) => entry.name), ["Alpha", "beta", "item9", "item10", "link-to-beta", "repo"], "folders only, natural order, hidden skipped, symlinked folders kept");
eq(listing.entries.find((entry) => entry.name === "repo")?.repo, true, "git repositories are marked");
eq(listing.entries.find((entry) => entry.name === "beta")?.repo, false, "plain folders are not repos");
eq(listing.parent, path.dirname(temp), "parent folder reported");
eq((await listFolders(temp, true)).entries.some((entry) => entry.name === ".hidden"), true, "hidden folders on request");
eq((await listFolders(path.join(temp, "repo"))).repo, true, "current folder repo flag");
eq((await listFolders(path.join(temp, "beta", "missing", "deeper"))).path, path.join(temp, "beta"), "missing tail walks up to an existing folder");
eq((await listFolders(null)).path, os.homedir(), "defaults to home");
eq((await listFolders("/")).parent, null, "root has no parent");
await assert.rejects(listFolders("relative/dir"), /absolute path/); checks += 1;
eq(listing.places[0]?.name, "Home", "places start with Home");

const offenders: string[] = [];
const allowed = new Set(["src/components/DialogHost.tsx", "src/components/FolderPicker.tsx"]); // fallbacks when no host is mounted
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) {
      const rel = path.relative(process.cwd(), full);
      if (allowed.has(rel)) continue;
      fs.readFileSync(full, "utf8").split("\n").forEach((line, index) => {
        if (/window\.(prompt|confirm|alert)\s*\(/.test(line)) offenders.push(`${rel}:${index + 1}`);
      });
    }
  }
};
walk("src");
eq(offenders, [], "no window.prompt/confirm/alert in UI code");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`folders: ${checks} checks passed`);
