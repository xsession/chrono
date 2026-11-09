const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

let backend;
let backendPort;
let mainWindow;
let pendingDeepLinks = [];

const PROTOCOL = "chrono";
const root = () => (app.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."));

// --- GitKraken RE §11.2: chrono:// deep-link protocol -----------------------
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function forwardDeepLink(uri) {
  if (!mainWindow || mainWindow.isDestroyed()) { pendingDeepLinks.push(uri); return; }
  mainWindow.webContents.send("chrono:deep-link", uri);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const uri = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (uri) forwardDeepLink(uri);
    if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.on("open-url", (event, url) => { event.preventDefault(); forwardDeepLink(url); }); // macOS
}

async function wait(url) { for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("Backend start timeout"); }

async function launch() {
  backendPort = String(14210 + Math.floor(Math.random() * 1000));
  backend = spawn(process.execPath, ["--experimental-strip-types", path.join(root(), "server", "index.ts")], { cwd: root(), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CHRONO_PORT: backendPort, CHRONO_HOST: "127.0.0.1" }, stdio: "pipe" });
  await wait(`http://127.0.0.1:${backendPort}/api/health`);
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 860, minHeight: 600, backgroundColor: "#111318", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true } });
  await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
  for (const uri of pendingDeepLinks.splice(0)) forwardDeepLink(uri);
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("chrono:pick-directory", async () => { const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; });

// GitKraken RE §11.2 — renderer may invoke registered sagas through the shell.
ipcMain.handle("chrono:invoke-saga", async (_event, name, payload) => {
  try {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/sagas/${encodeURIComponent(String(name))}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
    return await res.json();
  } catch (error) { return { ok: false, error: String(error) }; }
});

app.whenReady().then(launch).catch((e) => { dialog.showErrorBox("Chrono failed to start", String(e)); app.quit(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => backend?.kill());
