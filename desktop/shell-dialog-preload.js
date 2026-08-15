// Generic shell dialog bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDialog', {
  onInit: (cb) => ipcRenderer.on('dialog-init', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  choose: (index) => ipcRenderer.send('dialog-choose', index),
})
