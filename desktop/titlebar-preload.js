// Titlebar bridge: expose the one-way shell actions plus the experiment
// preset toggles (anchored / router, mutually exclusive in the main process).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  send: (action) => ipcRenderer.send('shell-action', action),
  togglePreset: (experiment) => ipcRenderer.invoke('preset-toggle', { experiment }),
  onPresetState: (cb) => ipcRenderer.on('preset-state', (_e, s) => cb(s)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
})
