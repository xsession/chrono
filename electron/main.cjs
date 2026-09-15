const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
let backend;
const root = () => app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
async function wait(url) { for (let i=0;i<80;i++){ try { if((await fetch(url)).ok)return; } catch{} await new Promise(r=>setTimeout(r,100)); } throw new Error("Backend start timeout"); }
async function launch() {
  const port=String(14210+Math.floor(Math.random()*1000));
  backend=spawn(process.execPath,["--experimental-strip-types",path.join(root(),"server","index.ts")],{cwd:root(),env:{...process.env,ELECTRON_RUN_AS_NODE:"1",CHRONO_PORT:port,CHRONO_HOST:"127.0.0.1"},stdio:"pipe"});
  await wait(`http://127.0.0.1:${port}/api/health`);
  const win=new BrowserWindow({width:1440,height:900,minWidth:860,minHeight:600,backgroundColor:"#111318",webPreferences:{preload:path.join(__dirname,"preload.cjs"),contextIsolation:true,sandbox:true}});
  await win.loadURL(`http://127.0.0.1:${port}`);
}
ipcMain.handle("chrono:pick-directory",async()=>{const r=await dialog.showOpenDialog({properties:["openDirectory","createDirectory"]});return r.canceled?null:r.filePaths[0];});
app.whenReady().then(launch).catch(e=>{dialog.showErrorBox("Chrono failed to start",String(e));app.quit();});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();}); app.on("before-quit",()=>backend?.kill());
