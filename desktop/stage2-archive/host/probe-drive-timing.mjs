// Reproduce the drive test's EXACT wire sequence in plain Node (drive's mux
// opens AFTER session.create, unlike probe.mjs which opens it first). If this
// works in Node, the drive hang is Electron-specific; if it hangs here too,
// the sequence itself is the problem.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHarness } from './host-boot.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const log = (...args) => console.log(`[pt ${(Date.now() / 1000).toFixed(1)}s]`, ...args)

setTimeout(() => { log('WATCHDOG exit'); process.exit(3) }, 180000).unref()

try {
  const booted = await bootHarness({ repo: path.join(ROOT, 'repo') })
  log('boot OK')
  booted.ctx.on('session/event', (session, event) => {
    log('host session/event', session.id.slice(0, 8), event.type)
  })

  const rpc = async (method, payload) => {
    const res = await booted.handler.fetch(new Request(`http://dsh.internal/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'pt-' + method, method, payload }),
    }))
    return res.json()
  }

  const desc = await rpc('host.describe', {})
  log('host.describe ok:', desc?.result?.ok)
  const wc = await rpc('workspace.create', { path: 'C:/Users/Canpu/Desktop/DeepSeek_Harness/desktop' })
  log('workspace.create ok:', wc?.result?.ok, '| created:', wc?.result?.value?.created)
  const workspaceId = wc?.result?.value?.workspace?.workspaceId
  const sc = await rpc('session.create', { workspaceId })
  log('session.create ok:', sc?.result?.ok)
  const sessionId = sc?.result?.value?.sessionId

  // drive's order: mux AFTER session.create
  const muxResponse = await booted.handler.fetch(new Request('http://dsh.internal/api/events.mux'))
  log('mux status:', muxResponse.status)
  const reader = muxResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  let frames = 0

  const pr = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '只回复三个字：已通' }],
    clientTimeZone: 'Asia/Shanghai',
  })
  log('prompt ok:', pr?.result?.ok)

  // Single pending read (the probe fix): never issue a second read over an
  // unresolved one.
  let pending = reader.read()
  const deadline = Date.now() + 60000
  let firstByteAt = null
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      pending.then((v) => ({ read: v })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000)),
    ])
    if (winner.timeout) {
      log('no bytes for 3s; buffer size', buffer.length)
      continue
    }
    const { done, value } = winner.read
    if (done) { log('stream closed'); break }
    if (firstByteAt === null) firstByteAt = Date.now()
    pending = reader.read()
    buffer += decoder.decode(value, { stream: true })
    bytes += value.byteLength
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
      if (data === '') continue
      frames++
      try {
        const parsed = JSON.parse(data)
        const type = parsed?.payload?.event?.type ?? parsed?.payload?.type ?? '?'
        log('frame #' + frames, type)
      } catch {
        log('frame #' + frames, 'unparseable')
      }
    }
    if (frames > 40) break
  }
  log('SUMMARY bytes:', bytes, 'frames:', frames, 'firstByteMs:', firstByteAt === null ? null : firstByteAt - (Date.now() - 60000))
  reader.cancel().catch(() => {})
  process.exit(0)
} catch (error) {
  console.error('[pt] FAILED:', error)
  process.exit(1)
}
