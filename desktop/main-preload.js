// Main-view bridge: zoom shortcuts + file-drop interception. The Chinese
// slash-command layer (submit-time translation + menu localization) lives in
// the MAIN world, injected from the main process on did-finish-load — this
// sandboxed preload world cannot reliably drive the page: it loads before
// navigation starts, its timers never fire, and its isolated prototypes make
// controlled-input rewrites of React's textarea unreliable.
const { ipcRenderer, webUtils } = require('electron')

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  // deltaY < 0 means scroll UP → zoom IN (intuitive direction).
  ipcRenderer.send('zoom-delta', -Math.sign(e.deltaY))
}, { passive: false })

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return
  if (e.key === '=' || e.key === '+') {
    e.preventDefault()
    ipcRenderer.send('zoom-delta', 1)
  } else if (e.key === '-') {
    e.preventDefault()
    ipcRenderer.send('zoom-delta', -1)
  } else if (e.key === '0') {
    e.preventDefault()
    ipcRenderer.send('zoom-reset')
  }
})

// ---- file drop: window-level interception ----
// The official composer accepts image drops only. Any drop containing at
// least one NON-image file is taken over: the paths go to the main process,
// which copies the files into a per-conversation temp dir and injects
// name+path context into the composer. Pure-image drops are NOT touched here
// — the official image attach flow keeps working.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
function fileExt(name) {
  const m = /\.([^.]+)$/.exec(String(name || '').toLowerCase())
  return m ? m[1] : ''
}
window.addEventListener('dragover', (e) => {
  // Allow drop anywhere in the window (no browser file-navigation), without
  // disturbing the official zone's own dragover highlight.
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    e.preventDefault()
  }
}, { passive: false })
window.addEventListener('drop', (e) => {
  const dt = e.dataTransfer
  if (!dt || !dt.files || dt.files.length === 0) return
  const files = Array.from(dt.files)
  const metas = files.map((f) => ({ name: f.name, isImage: IMAGE_EXT.has(fileExt(f.name)) }))
  if (metas.every((m) => m.isImage)) return // official image flow untouched
  e.preventDefault()
  e.stopImmediatePropagation() // capture phase on window: nothing below sees this drop
  const items = files.map((f, i) => ({ name: f.name, path: webUtils.getPathForFile(f), isImage: metas[i].isImage }))
  ipcRenderer.send('shell:file-drop', items)
}, true)
