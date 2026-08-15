// Proxy settings dialog bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshProxy', {
  get: () => ipcRenderer.invoke('proxy-dialog:get'),
  save: (http, https) => ipcRenderer.invoke('proxy-dialog:save', { http, https }),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  close: () => ipcRenderer.send('proxy-dialog:close'),
})
