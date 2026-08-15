// Export dialog bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  getSessions: (includeHistory) => ipcRenderer.invoke('export-dialog:get-sessions', { includeHistory: includeHistory === true }),
  export: (sessionId, title) => ipcRenderer.invoke('export-dialog:export', { sessionId, title }),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  close: () => ipcRenderer.send('export-dialog:close'),
})
