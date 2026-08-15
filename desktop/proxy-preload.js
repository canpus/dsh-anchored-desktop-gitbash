// Proxy settings dialog bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshProxy', {
  get: () => ipcRenderer.invoke('proxy-dialog:get'),
  save: (value) => ipcRenderer.invoke('proxy-dialog:save', value),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  close: () => ipcRenderer.send('proxy-dialog:close'),
})
