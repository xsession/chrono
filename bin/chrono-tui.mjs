#!/usr/bin/env node
// Launcher for the terminal UI (tui/main.ts): runs it with TypeScript type
// stripping, which Node 22 needs as a flag. `npm link` puts it on PATH as
// `chrono-tui`.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tui", "main.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
