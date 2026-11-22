// Codebase landscape map: the server scan that feeds public/landscape/ and the
// embedded page's bridge to Chrono.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-landscape-")));
Object.assign(process.env, {
  HOME: temp, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(temp, ".config"), CHRONO_CONFIG_DIR: path.join(temp, "config"),
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
delete process.env.GIT_CONFIG_GLOBAL;
execFileSync("git", ["config", "--global", "protocol.file.allow", "always"]);
const { landscapeScan } = await import("../server/src/landscape.ts");

let checks = 0;
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks += 1; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// A library repository, later added as a submodule.
const lib = path.join(temp, "lib-src");
execFileSync("git", ["init", "-q", "-b", "main", lib]);
write(path.join(lib, "util.py"), "def helper():\n    return 1\n\nclass Tool:\n    pass\n");
git(lib, "add", "."); git(lib, "commit", "-qm", "lib");

const repo = path.join(temp, "app");
execFileSync("git", ["init", "-q", "-b", "main", repo]);
write(path.join(repo, "src/main.ts"), "import { App } from './app/App';\nimport './styles/theme.css';\nimport React from 'react';\n\nApp();\n");
write(path.join(repo, "src/app/App.tsx"), "export function App() {\n  return null;\n}\n");
write(path.join(repo, "src/styles/theme.css"), "body { color: red; }\n");
write(path.join(repo, "README.md"), "# app\n");
write(path.join(repo, "package-lock.json"), "{}\n");
write(path.join(repo, "notes.bin"), "binary-ish\n");
write(path.join(repo, ".gitignore"), "build/\n");
write(path.join(repo, "build/out.js"), "ignored();\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "app");
git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor-lib");
git(repo, "commit", "-qm", "add lib");

const scan = await landscapeScan(path.join(repo, "src"));
const byPath = new Map(scan.files.map((file) => [file.path, file]));
ok(scan.root === repo && scan.name === "app", "scan resolves the repository root from a subfolder");
ok(byPath.has("src/main.ts") && byPath.has("src/app/App.tsx") && byPath.has("README.md"), "tracked source files are listed");
ok(!byPath.has("package-lock.json"), "lock files are skipped");
ok(!byPath.has("notes.bin"), "files of unknown kinds are skipped");
ok(!byPath.has("build/out.js"), "ignored files are not mapped");
ok(byPath.has("vendor-lib/util.py"), "submodule files are included");
const main = byPath.get("src/main.ts")!;
ok(main.lang === "TypeScript" && main.loc === 4, `language and non-blank line count (${main.lang}, ${main.loc})`);
ok(main.specs.includes("./app/App") && main.specs.includes("./styles/theme.css") && main.specs.includes("react"), `imports found: ${main.specs.join(", ")}`);
ok(byPath.get("vendor-lib/util.py")!.syms.includes("helper") && byPath.get("vendor-lib/util.py")!.syms.includes("Tool"), "symbols found for the runtime view");
const sub = scan.repos.find((entry) => entry.path === "vendor-lib");
ok(scan.repos[0].path === "" && sub && sub.url === lib && /^[0-9a-f]{7}$/.test(sub.sha), "submodule reported as a nested repository");
ok(scan.cut === 0 && scan.head.length >= 40, "head and cut are reported");

// Cached until HEAD moves; force rescans.
write(path.join(repo, "src/extra.ts"), "export const x = 1;\n");
git(repo, "add", ".");
const cached = await landscapeScan(repo);
ok(cached === scan, "same HEAD returns the cached scan");
const forced = await landscapeScan(repo, true);
ok(forced !== scan && forced.files.some((file) => file.path === "src/extra.ts"), "force rescans the working tree");
git(repo, "commit", "-qm", "extra");
const moved = await landscapeScan(repo);
ok(moved.head !== scan.head, "a new HEAD triggers a fresh scan");
const diskDir = path.join(temp, "config", "landscape");
ok(fs.readdirSync(diskDir).some((name) => name.endsWith(".json")), "the last scan is kept on disk");

// The embedded page: works offline and only talks to its parent.
const page = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "landscape", "index.html"), "utf8");
const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
ok(!/fonts\.googleapis|fonts\.gstatic/.test(page), "no web font requests");
ok(/if\(EMBED\)return Promise\.reject/.test(script), "no CDN script load inside Chrono");
ok(/e\.source!==parent/.test(script), "the page accepts messages only from Chrono");
ok(/toChrono\(\{type:'ready'\}\)/.test(script) && /type==='scan'/.test(script), "ready/scan handshake present");
new Function(script); checks += 1; // parses

const view = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "components", "gk", "LandscapeView.tsx"), "utf8");
ok(/sandbox="allow-scripts"/.test(view) && !/allow-same-origin/.test(view), "map frame is sandboxed without same-origin access");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`landscape: ${checks} checks passed`);
