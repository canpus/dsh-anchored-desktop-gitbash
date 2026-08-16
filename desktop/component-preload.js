// Component update dialog bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  list: () => ipcRenderer.invoke('component-update:list'),
  do: (id) => ipcRenderer.invoke('component-update:do', { id }),
  revert: (id) => ipcRenderer.invoke('component-update:revert', { id }),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  close: () => ipcRenderer.send('component-dialog:close'),
})
