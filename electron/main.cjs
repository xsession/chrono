const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

let backend;
let backendPort;
let mainWindow;
let pendingDeepLinks = [];
let quitting = false;

const PROTOCOL = "chrono";
// Packaged builds keep server/, dist/ and public/ (plus ws/node-pty) in
// app.asar.unpacked so the backend can run as plain files with real
// node_modules next to it.
const root = () => (app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.resolve(__dirname, ".."));

// --- GitKraken RE §11.2: chrono:// deep-link protocol -----------------------
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Shell integration: the OS file-manager menu starts Chrono as
//   Chrono --tgit=<action> <absolute path> [<absolute path> …]
// (or passes a ready chrono:// URI). Both become a chrono://tgit deep link.
function argvToDeepLink(argv) {
  const uri = argv.find((arg) => typeof arg === "string" && arg.startsWith(`${PROTOCOL}://`));
  if (uri) return uri;
  const index = argv.findIndex((arg) => typeof arg === "string" && arg.startsWith("--tgit"));
  if (index < 0) return null;
  let action = argv[index].includes("=") ? argv[index].slice(argv[index].indexOf("=") + 1) : argv[index + 1];
  const rest = argv.slice(argv[index].includes("=") ? index + 1 : index + 2);
  if (!/^[a-z]+$/.test(action || "")) action = "explore";
  const params = new URLSearchParams({ action });
  for (const arg of rest) if (arg && !arg.startsWith("-") && path.isAbsolute(arg)) params.append("path", arg);
  return params.getAll("path").length ? `${PROTOCOL}://tgit?${params.toString()}` : null;
}

const launchLink = argvToDeepLink(process.argv);
if (launchLink) pendingDeepLinks.push(launchLink);

function forwardDeepLink(uri) {
  if (!mainWindow || mainWindow.isDestroyed()) { pendingDeepLinks.push(uri); return; }
  mainWindow.webContents.send("chrono:deep-link", uri);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const uri = argvToDeepLink(argv);
    if (uri) forwardDeepLink(uri);
    if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.on("open-url", (event, url) => { event.preventDefault(); forwardDeepLink(url); }); // macOS
}

async function wait(url) { for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("Backend start timeout"); }

async function launch() {
  backendPort = String(14210 + Math.floor(Math.random() * 1000));
  backend = spawn(process.execPath, ["--experimental-strip-types", path.join(root(), "server", "index.ts")], { cwd: root(), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CHRONO_PORT: backendPort, CHRONO_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let backendLog = "";
  // Keep the backend's output on disk too (<userData>/logs/backend.log), so a
  // crash can be investigated after the app has closed.
  const logFile = path.join(app.getPath("userData"), "logs", "backend.log");
  let logStream = null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { if (fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, `${logFile}.1`); } catch {}
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    logStream.write(`\n--- ${new Date().toISOString()} Chrono ${app.getVersion()} backend on port ${backendPort} ---\n`);
  } catch {}
  const capture = (chunk) => { backendLog = (backendLog + chunk).slice(-4000); logStream?.write(chunk); };
  backend.stdout.on("data", capture);
  backend.stderr.on("data", capture);
  backend.on("exit", (code, signal) => {
    logStream?.write(`--- backend exited: code ${code} signal ${signal} ---\n`);
    if (quitting) return;
    dialog.showErrorBox("Chrono backend stopped", `exit code ${code}${signal ? ` (${signal})` : ""}\n\nLog: ${logFile}\n\n${backendLog}`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  await wait(`http://127.0.0.1:${backendPort}/api/health`);
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 860, minHeight: 600, backgroundColor: "#111318", title: "Chrono", autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true } });
  await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
  for (const uri of pendingDeepLinks.splice(0)) forwardDeepLink(uri);
  mainWindow.on("closed", () => { mainWindow = null; });
  // A crashed or killed renderer leaves a blank window: record why, then reload.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logStream?.write(`--- window renderer gone: ${details.reason} (exit ${details.exitCode}) ---\n`);
    if (details.reason !== "clean-exit" && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });
}

ipcMain.handle("chrono:pick-directory", async () => { const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; });

// GitKraken RE §11.2 — renderer may invoke registered sagas through the shell.
ipcMain.handle("chrono:invoke-saga", async (_event, name, payload) => {
  try {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/sagas/${encodeURIComponent(String(name))}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
    return await res.json();
  } catch (error) { return { ok: false, error: String(error) }; }
});

// Linux WM_CLASS follows the app name; keep it equal to StartupWMClass=Chrono.
if (process.platform === "linux") {
  const userData = app.getPath("userData"); // keep existing settings/localStorage where they are
  app.setName("Chrono");
  app.setPath("userData", userData);
}
app.whenReady().then(launch).catch((e) => { dialog.showErrorBox("Chrono failed to start", String(e)); app.quit(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { quitting = true; backend?.kill(); });
