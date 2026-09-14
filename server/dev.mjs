// Dev process supervisor: runs the TypeScript API server (via Node's
// type-stripping) and Vite's dev server, wiring `/api` (and asset prefixes) to
// the API on a separate port. Replaces `tauri dev`.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const PORT = process.env.CHRONO_PORT ?? "1421";
const VITE_PORT = process.env.CHRONO_VITE_PORT ?? "1420";

const server = spawn(process.execPath, ["--experimental-strip-types", path.join(import.meta.dirname, "index.ts")], {
  stdio: "inherit",
  env: { ...process.env, CHRONO_PORT: PORT },
});

// Launch Vite's CLI directly with node (avoids shelling out to `npm`, which
// needs a shell on Windows).
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteBin, "--host", "0.0.0.0"], {
  stdio: "inherit",
  env: { ...process.env, CHRONO_PORT: PORT, CHRONO_VITE_PORT: VITE_PORT },
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    server.kill();
    vite.kill();
  } finally {
    process.exit(code);
  }
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
server.on("exit", (code) => shutdown(code ?? 0));
vite.on("exit", (code) => shutdown(code ?? 0));
