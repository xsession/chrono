const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("chronoDesktop", {
  pickDirectory: () => ipcRenderer.invoke("chrono:pick-directory"),
  platform: process.platform,
  invokeSaga: (name, payload) => ipcRenderer.invoke("chrono:invoke-saga", name, payload),
  onDeepLink: (callback) => {
    const listener = (_event, uri) => callback(uri);
    ipcRenderer.on("chrono:deep-link", listener);
    return () => ipcRenderer.removeListener("chrono:deep-link", listener);
  },
});
