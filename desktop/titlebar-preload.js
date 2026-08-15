// Titlebar bridge: expose a minimal one-way channel to the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  send: (action) => ipcRenderer.send('shell-action', action),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
})
