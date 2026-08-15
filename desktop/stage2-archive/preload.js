// Preload: expose the minimal IPC bridge surface to the renderer page.
// The page composes its own fetch/WebSocket shims over these primitives.
// Chunks arriving before the page subscribes are buffered, not dropped.
const { contextBridge, ipcRenderer } = require('electron')

const streamSubs = new Map() // streamId -> { buffer, onMeta, onError, onChunk, onEnd }

ipcRenderer.on('dsh:response', (_event, msg) => {
  const sub = streamSubs.get(msg.id)
  if (sub) {
    if (msg.error) sub.onError(msg.error)
    else sub.onMeta(msg)
  }
})
ipcRenderer.on('dsh:chunk', (_event, msg) => {
  const sub = streamSubs.get(msg.id)
  if (!sub) return
  if (sub.onChunk) sub.onChunk(msg.data)
  else sub.buffer.push(msg.data)
})
ipcRenderer.on('dsh:end', (_event, msg) => {
  const sub = streamSubs.get(msg.id)
  if (!sub) return
  if (sub.onEnd) {
    streamSubs.delete(msg.id)
    sub.onEnd()
  } else {
    // The page has not subscribed yet: keep the sub (with its buffered
    // chunks) so a later subscribeStream flushes data BEFORE seeing the end.
    // Dropping either the chunks or the end hangs or truncates the body.
    sub.ended = true
  }
})

let counter = 0

contextBridge.exposeInMainWorld('dshBridge', {
  readBundle: (url) => ipcRenderer.invoke('dsh:readBundle', url),
  // Opens one streaming request; resolves with response metadata once headers
  // arrive; body chunks follow via subscribeStream below.
  fetch: (req) => {
    const id = `${Date.now()}-${counter++}`
    return new Promise((resolve, reject) => {
      streamSubs.set(id, {
        buffer: [],
        ended: false,
        onMeta: (meta) => resolve({ ...meta, streamId: id }),
        onError: (error) => { streamSubs.delete(id); reject(new Error(error)) },
        onChunk: null,
        onEnd: null,
      })
      ipcRenderer.invoke('dsh:fetch', { ...req, id }).catch((error) => {
        streamSubs.delete(id)
        reject(error)
      })
    })
  },
  subscribeStream: (streamId, handlers) => {
    const sub = streamSubs.get(streamId)
    if (!sub) {
      handlers.onEnd?.()
      return () => {}
    }
    sub.onChunk = handlers.onChunk ?? (() => {})
    sub.onEnd = handlers.onEnd ?? (() => {})
    const buffered = sub.buffer
    sub.buffer = []
    for (const data of buffered) sub.onChunk(data)
    if (sub.ended) {
      streamSubs.delete(streamId)
      sub.onEnd()
    }
    return () => { streamSubs.delete(streamId) }
  },
  cancel: (streamId) => ipcRenderer.send('dsh:cancel', streamId),
})
