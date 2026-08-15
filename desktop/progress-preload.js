// Progress window bridge: subscribe to upgrade step updates.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  onStep: (cb) => {
    ipcRenderer.on('upgrade-step', (_e, text) => cb(String(text)))
  },
})
