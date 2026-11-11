// Minimal, typed-by-convention bridge: the renderer can only call named methods.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dirt', {
  invoke: (method, args) => ipcRenderer.invoke('dirt', method, args),
  platform: process.platform,
});
