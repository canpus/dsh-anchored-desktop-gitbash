// Standalone probe: boot the desktop host tree in plain Node and print the
// full nested loader error chain (Electron not required for host-boot).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHarness } from './host-boot.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function printChain(error, depth = 0) {
  const pad = '  '.repeat(depth)
  console.error(`${pad}${error?.name ?? 'Error'}: ${error?.message}`)
  if (error?.errors && Array.isArray(error.errors)) {
    for (const sub of error.errors) printChain(sub, depth + 1)
  }
  if (error?.cause) printChain(error.cause, depth + 1)
}

try {
  const booted = await bootHarness({ repo: path.join(ROOT, 'repo') })
  const log = (...args) => console.log(`[probe ${(Date.now() / 1000).toFixed(1)}s]`, ...args)
  log('boot OK')
  log('apiProxy:', typeof booted.handler.fetch)

  // Hard watchdog: never hang forever, even if tree disposal blocks.
  setTimeout(() => { log('WATCHDOG exit'); process.exit(3) }, 180000).unref()

  // Wire-level roundtrip through the official fetch handler: the same
  // envelope the renderer sends over IPC. No HTTP involved.
  const envelope = {
    type: 'client-request',
    rpcId: 'probe-1',
    method: 'host.describe',
    payload: {},
  }
  const response = await booted.handler.fetch(new Request('http://dsh.internal/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  }))
  log('host.describe status:', response.status)
  const result = await response.json()
  log('host.describe ok:', result?.result?.ok, '| rpcId echo:', result?.rpcId)

  // --- stream probe: GET /api/events.mux must deliver SSE frames ------------
  // Create real activity first (a session + prompt), then read the stream.
  log('opening events.mux stream...')
  const muxResponse = await booted.handler.fetch(new Request('http://dsh.internal/api/events.mux'))
  log('mux status:', muxResponse.status)
  const reader = muxResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames = []
  let comments = 0
  const enqueueFrame = (raw) => {
    const line = raw.split('\n').find((l) => l.startsWith('data: '))
    if (line) frames.push(line.slice(6))
    else if (raw.startsWith(':')) comments++
  }
  const drain = async (budgetMs) => {
    const deadline = Date.now() + budgetMs
    // ONE pending read at a time: a timed-out read must stay pending and be
    // awaited again — never issue a second read() over an unresolved one.
    let pending = reader.read()
    while (Date.now() < deadline) {
      const winner = await Promise.race([
        pending.then((v) => ({ read: v })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
      ])
      if (winner.timeout) continue
      const { done, value } = winner.read
      if (done) return 'closed'
      pending = reader.read()
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        enqueueFrame(frame)
      }
    }
    return 'budget'
  }
  log('initial drain (8s):', await drain(8000), '| frames:', frames.length, '| comments:', comments)

  // Real activity: workspace → session → prompt (needs model key + proxy env).
  const rpc = async (method, payload) => {
    const res = await booted.handler.fetch(new Request(`http://dsh.internal/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-stream', method, payload }),
    }))
    return res.json()
  }
  const wc = await rpc('workspace.create', { path: 'C:/Users/Canpu/Desktop/DeepSeek_Harness/desktop' })
  const workspaceId = wc?.result?.value?.workspace?.id
  log('workspace.create ok:', wc?.result?.ok, '| id:', workspaceId)
  const sc = await rpc('session.create', { workspaceId })
  const sessionId = sc?.result?.value?.sessionId
  log('session.create ok:', sc?.result?.ok, '| id:', sessionId)
  const pr = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '只回复三个字：已通' }],
    clientTimeZone: 'Asia/Shanghai',
  })
  log('prompt sent:', pr?.result?.ok)
  log('draining 40s for session/event frames...')
  const drainResult = await drain(40000)
  const types = frames.map((f) => {
    try {
      const parsed = JSON.parse(f)
      return parsed?.payload?.event?.type ?? parsed?.payload?.type ?? parsed?.method ?? '?'
    } catch {
      return 'unparseable'
    }
  })
  log('drain result:', drainResult, '| total frames:', frames.length)
  log('event types seen:', [...new Set(types)].slice(0, 25).join(', '))
  const assistantMessage = frames.find((f) => {
    try { return JSON.parse(f)?.payload?.event?.type === 'assistant/message' } catch { return false }
  })
  if (assistantMessage) {
    const event = JSON.parse(assistantMessage)?.payload?.event
    // assistant/message data: { turn, step, message, usage? }
    const text = (event?.data?.message?.content ?? []).map((b) => b.text ?? '').join('')
    log('assistant/message text:', text.slice(0, 60))
    log('usage:', JSON.stringify(event?.data?.usage ?? null)?.slice(0, 120))
  }
  reader.cancel().catch(() => {})
  log('stream probe done; skipping full dispose (watchdog owns exit)')
  process.exit(0)
} catch (error) {
  console.error('[probe] boot FAILED:')
  printChain(error)
  process.exitCode = 1
}
