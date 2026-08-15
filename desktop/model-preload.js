// Model dialog bridge: draft-commit preset management, all via official RPCs.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  getData: () => ipcRenderer.invoke('model-dialog:get-data'),
  apply: (draft) => ipcRenderer.invoke('model-dialog:apply', draft),
  copy: (from, name) => ipcRenderer.invoke('model-dialog:copy', { from, name }),
  remove: (agentPreset) => ipcRenderer.invoke('model-dialog:remove', { agentPreset }),
  openDocument: (agentPreset, trust) => ipcRenderer.invoke('model-dialog:open-document', { agentPreset, trust }),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  onStage: (cb) => ipcRenderer.on('apply-stage', (_e, s) => cb(s)),
  close: () => ipcRenderer.send('model-dialog:close'),
})
