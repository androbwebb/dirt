// Minimal, typed-by-convention bridge: the renderer can only call named methods.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dirt', {
  invoke: (method, args) => ipcRenderer.invoke('dirt', method, args),
  onAgent: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('dirt:agent', fn);
    return () => ipcRenderer.removeListener('dirt:agent', fn);
  },
  platform: process.platform,
});
