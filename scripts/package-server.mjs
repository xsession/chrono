#!/usr/bin/env node
// Package the headless server (web UI + API) as release/chrono-server-<v>.tar.gz.
// Install on a host with Node 22+ and git:
//   tar xzf chrono-server-<v>.tar.gz && cd chrono-server-<v>
//   npm ci --omit=dev && CHRONO_API_TOKEN=... ./run.sh   (or installers/server/*)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const name = `chrono-server-${version}`;
const stage = path.join(root, "release", name);
if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("dist/ is missing — run `npm run build` first");
  process.exit(1);
}
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copy = (relative) => {
  const from = path.join(root, relative);
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, path.join(stage, relative), { recursive: true, filter: (source) => !source.endsWith(".tsbuildinfo") });
};
for (const item of ["dist", "server", "public", "shell-integration", "installers/server", "package.json", "package-lock.json", "run.sh", "run.bat", "run.ps1", "README.md", "LICENSE"]) copy(item);
fs.mkdirSync(path.join(root, "release"), { recursive: true });
const archive = path.join(root, "release", `${name}.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", path.join(root, "release"), name], { stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`wrote ${path.relative(root, archive)}`);
