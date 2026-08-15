// Main-view bridge: zoom shortcuts only. The Chinese slash-command layer
// (submit-time translation + menu localization) lives in the MAIN world,
// injected from the main process on did-finish-load — this sandboxed preload
// world cannot reliably drive the page: it loads before navigation starts,
// its timers never fire, and its isolated prototypes make controlled-input
// rewrites of React's textarea unreliable.
const { ipcRenderer } = require('electron')

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
