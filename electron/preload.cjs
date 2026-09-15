const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("chronoDesktop",{pickDirectory:()=>ipcRenderer.invoke("chrono:pick-directory"),platform:process.platform});
