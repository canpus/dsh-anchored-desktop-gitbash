// Phase 2 renderer: boots the official client graph over the IPC bridge.
// The transport shims (fetch + WebSocket for the dsh.internal authority) are
// installed before boot; they carry the official ApiProxy protocol unchanged —
// the only replacement is the physical carrier.
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import manifest from './manifest.json'

const BRIDGE_AUTHORITY = 'dsh.internal'

// ---------------------------------------------------------------------------
// 1. fetch shim: route http://dsh.internal/* and relative /api/* through the
//    IPC bridge. Every response body becomes a ReadableStream fed by bridge
//    chunk events (the official AbstractApiClient base class consumes plain
//    fetch semantics, including its SSE parser).
// ---------------------------------------------------------------------------

function bridgeTarget(raw) {
  if (typeof raw !== 'string') return undefined
  if (raw.startsWith('/api/')) return new URL(raw, `http://${BRIDGE_AUTHORITY}`)
  try {
    const u = new URL(raw)
    if (u.hostname === BRIDGE_AUTHORITY) return u
    // Electron loadFile pages have origin 'file://' (not 'null'), so the
    // official client resolves its base to file:// and requests come in as
    // file:///api/... — reroute those to the bridge too.
    if (u.protocol === 'file:' && u.pathname.startsWith('/api/')) {
      const rerouted = new URL(u.pathname + u.search, `http://${BRIDGE_AUTHORITY}`)
      return rerouted
    }
    return undefined
  } catch {
    return undefined
  }
}

async function bridgeFetch(url, init) {
  const method = init?.method ?? 'GET'
  const headers = {}
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers).entries()) headers[key] = value
  }
  const meta = await window.dshBridge.fetch({
    url: url.href,
    method,
    headers,
    body: init?.body,
  })
  // Standard controller-enqueue mode: the producer (bridge chunk events)
  // enqueues into the stream directly; ReadableStream owns backpressure.
  // (The first hand-rolled waiter/queue/pull shuttle dropped chunks after
  // the first read on multi-chunk streams.)
  const stream = new ReadableStream({
    start(controller) {
      window.dshBridge.subscribeStream(meta.streamId, {
        onChunk: (b64) => {
          try {
            const bin = atob(b64)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            controller.enqueue(bytes)
          } catch (error) {
            // Enqueue after cancel/close: no consumer left to see it.
            console.warn('[desktop] bridge enqueue dropped:', String(error))
          }
        },
        onEnd: () => {
          try {
            controller.close()
          } catch {
            // Already closed or cancelled.
          }
        },
      })
    },
    cancel() {
      window.dshBridge.cancel(meta.streamId)
    },
  })
  return new Response(stream, { status: meta.status, statusText: meta.statusText, headers: meta.headers })
}

// ---------------------------------------------------------------------------
// 2. WebSocket shim: ws://dsh.internal/* is a downlink-only channel; the shim
//    backs it with the SSE GET over the same bridge (the host serves both the
//    same frame stream). Everything else stays native WebSocket.
// ---------------------------------------------------------------------------

function makeSseWebSocket(url) {
  const listeners = { open: [], message: [], close: [], error: [] }
  const socket = {
    readyState: 0, // CONNECTING
    binaryType: 'blob',
    url: url.href,
    addEventListener(type, cb) {
      ;(listeners[type] ??= []).push(cb)
    },
    removeEventListener(type, cb) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb)
    },
    close() {
      if (socket.readyState === 3) return
      socket.readyState = 3
      emit('close', { code: 1000 })
    },
    send() {
      throw new Error('downlink only: client messages are a protocol violation')
    },
  }
  function emit(type, event) {
    for (const cb of [...(listeners[type] ?? [])]) {
      try { cb(event) } catch {}
    }
  }
  const queue = []
  let waiter = null
  function push(data) {
    if (waiter) { const resolve = waiter; waiter = null; resolve(data) } else queue.push(data)
  }
  ;(async () => {
    let buffer = ''
    let opened = false
    try {
      const res = await bridgeFetch(new URL(url.href.replace(/^ws:/, 'http:')), {})
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('')
          if (data === '') continue // ': connected' comment / keepalive
          if (!opened) {
            opened = true
            socket.readyState = 1 // OPEN
            emit('open', {})
          }
          push(data)
        }
      }
    } catch {
      // fall through to close
    }
    if (socket.readyState !== 3) {
      socket.readyState = 3
      emit('close', { code: 1006 })
    }
  })()
  return socket
}

const REAL_FETCH = window.fetch.bind(window)
const REAL_WS = window.WebSocket

;(async () => {
  // Minimal Node-global polyfills: the vendored loader references `process`
  // on the ModuleLoader class field (never exercised in a browser — the
  // kernel overrides loader.internal before any import).
  window.process = window.process ?? {
    env: {},
    platform: 'win32',
    version: 'v24.0.0',
    versions: { node: '24.0.0' },
    execArgv: [],
    cwd: () => '/',
    on: () => {},
    nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
  }

  window.fetch = (input, init) => {
    // Official client passes a URL object (href, no url prop) — Request
    // objects carry .url, URL objects carry .href. Missing either sent every
    // official unary to the native fetch (file:// → immediate failure).
    const raw = typeof input === 'string' ? input : (input?.url ?? input?.href)
    const target = bridgeTarget(raw)
    if (target) return bridgeFetch(target, init)
    return REAL_FETCH(input, init)
  }

  window.WebSocket = function ShimWebSocket(raw, protocols) {
    let bridgeUrl
    try {
      bridgeUrl = new URL(String(raw))
    } catch {
      return new REAL_WS(raw, protocols)
    }
    if (bridgeUrl.hostname === BRIDGE_AUTHORITY) {
      return Object.assign(Object.create(ShimWebSocket.prototype), makeSseWebSocket(bridgeUrl))
    }
    // file:// base resolution: the official client resolves location.origin
    // ('file://' in Electron) as its base; assigning url.protocol = 'ws:' on a
    // file: URL is a no-op in Chromium, so the URL stays file:///api/... with
    // an empty hostname. Same for bare ws:///api/... paths. Reroute both.
    if ((bridgeUrl.protocol === 'ws:' || bridgeUrl.protocol === 'wss:' || bridgeUrl.protocol === 'file:')
      && bridgeUrl.pathname.startsWith('/api/')) {
      const rerouted = new URL(bridgeUrl.pathname, `http://${BRIDGE_AUTHORITY}`)
      return Object.assign(Object.create(ShimWebSocket.prototype), makeSseWebSocket(rerouted))
    }
    return new REAL_WS(raw, protocols)
  }
  window.WebSocket.prototype = REAL_WS.prototype
  window.WebSocket.CONNECTING = REAL_WS.CONNECTING
  window.WebSocket.OPEN = REAL_WS.OPEN
  window.WebSocket.CLOSING = REAL_WS.CLOSING
  window.WebSocket.CLOSED = REAL_WS.CLOSED

  // -------------------------------------------------------------------------
  // 3. Boot the official client graph. __DSH_BOOT__ is synthesized from the
  //    scanned dsh.client roster; the loadBundle seam feeds each plugin bundle
  //    its real built lib/client.js artifact through the bridge.
  // -------------------------------------------------------------------------

  window.__DSH_BOOT__ = { rev: 'desktop', entries: manifest.entries }

  const bundles = new Map()
  const entry = new AppWebEntry(document.getElementById('root'), {
    loadBundle: async (url) => {
      let pending = bundles.get(url)
      if (!pending) {
        pending = window.dshBridge.readBundle(url).then((code) => {
          ;(0, eval)(code)
        })
        bundles.set(url, pending)
      }
      await pending
    },
  })

  await entry.run()

  // -------------------------------------------------------------------------
  // 4. Settle verdict for the smoke automation (main watches console-message).
  // -------------------------------------------------------------------------

  await new Promise((resolve) => setTimeout(resolve, 2500))
  // innerText (not textContent): the page inlines the whole bundle inside a
  // <script> tag, whose source text would false-positive the failure regex.
  const text = document.body.innerText ?? ''
  if (!/did not activate|web boot:/.test(text)) {
    console.log('[desktop] RENDERER_SETTLED_OK')
  } else {
    console.log('[desktop] RENDERER_SETTLED_FAIL ' + text.slice(0, 400).replace(/\s+/g, ' '))
  }

  // -------------------------------------------------------------------------
  // 5. Drive mode (DSH_DESKTOP_DRIVE): functional self-test over the real
  //    wire — unary RPCs, streaming mux frames, model roundtrip, approval
  //    reject chain. Verdict exits the app via console-message in main.
  // -------------------------------------------------------------------------
  if (new URLSearchParams(location.search).has('drive')) {
    await runDriveTest()
  }

  async function driveRpc(method, payload) {
    const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload }
    const res = await window.fetch(`http://${BRIDGE_AUTHORITY}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    return res.json()
  }

  async function driveOpenMux() {
    const res = await window.fetch(`http://${BRIDGE_AUTHORITY}/api/events.mux`)
    const state = { reader: res.body.getReader(), decoder: new TextDecoder(), buffer: '', openedAt: Date.now() }
    console.log('[desktop] DRIVE_STEP mux-open ' + JSON.stringify({ status: res.status }))
    return state
  }

  async function driveNextFrame(state) {
    for (;;) {
      const idx = state.buffer.indexOf('\n\n')
      if (idx !== -1) {
        const frame = state.buffer.slice(0, idx)
        state.buffer = state.buffer.slice(idx + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('')
        if (data === '') continue
        return JSON.parse(data)
      }
      state.reads = (state.reads ?? 0) + 1
      const { done, value } = await state.reader.read()
      if (done) return null
      state.buffer += state.decoder.decode(value, { stream: true })
      // First-byte telemetry: proves whether ANY bytes cross the bridge.
      if (!state.firstByteAt) {
        state.firstByteAt = Date.now() - state.openedAt
        console.log('[desktop] DRIVE_STEP mux-first-byte ' + JSON.stringify({ ms: state.firstByteAt, bytes: value.byteLength }))
      }
    }
  }

  async function driveWaitFor(state, predicate, timeoutMs, label) {
    // The read() itself can hang (an open SSE stream with no new frames),
    // which would deadlock a deadline-checked loop. Race each frame against
    // the remaining budget instead.
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`drive timeout waiting for ${label}`)
      const winner = await Promise.race([
        driveNextFrame(state).then((frame) => ({ frame })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ])
      if (winner.timeout) throw new Error(`drive timeout waiting for ${label}`)
      const frame = winner.frame
      if (frame === null) throw new Error(`mux closed while waiting for ${label}`)
      if (predicate(frame)) return frame
    }
  }

  async function runDriveTest() {
    const report = { pass: true, steps: [] }
    const log = (name, detail) => {
      report.steps.push({ name, ...detail })
      console.log('[desktop] DRIVE_STEP ' + name + ' ' + JSON.stringify(detail))
    }
    try {
      const desc = await driveRpc('host.describe', {})
      log('host.describe', { ok: desc?.result?.ok })
      if (!desc?.result?.ok) throw new Error('host.describe failed')

      // Typert remote dispatch (slash-form endpoint, args-object payload):
      // the settings→plugins tab renders from this RPC, and its regression
      // mode is a silent 404 (empty list) — assert it here.
      const pi = await driveRpc('pluginInventory/list', { args: {} })
      const piCount = pi?.result?.ok ? (pi?.result?.value?.entries?.length ?? 0) : -1
      log('pluginInventory.list', { ok: pi?.result?.ok, entries: piCount })
      if (!pi?.result?.ok || piCount <= 0) throw new Error('pluginInventory/list failed (remote dispatch regression)')

      const wc = await driveRpc('workspace.create', { path: 'C:/Users/Canpu/Desktop/DeepSeek_Harness/desktop' })
      log('workspace.create', { ok: wc?.result?.ok, created: wc?.result?.value?.created })
      const workspaceId = wc?.result?.value?.workspace?.workspaceId
      if (!workspaceId) throw new Error('workspace.create failed')

      const sc = await driveRpc('session.create', { workspaceId })
      log('session.create', { ok: sc?.result?.ok })
      const sessionId = sc?.result?.value?.sessionId
      if (!sessionId) throw new Error('session.create failed')

      const mux = await driveOpenMux()
      const pr = await driveRpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '只回复三个字：已通' }],
        clientTimeZone: 'Asia/Shanghai',
      })
      log('session.prompt', { ok: pr?.result?.ok })

      // Stream until the assistant message finalizes (usage rides the event).
      let chunks = 0
      let usage = null
      let finalText = ''
      await driveWaitFor(mux, (frame) => {
        const payload = frame.payload ?? {}
        const event = payload.event
        if (frame.method === 'session/event' && event?.type === 'assistant/chunk') {
          chunks++
          // assistant/chunk data: { turn, step, chunk: StreamChunk }
          if (event.data?.chunk?.type === 'usage') usage = event.data.chunk
        }
        if (frame.method === 'session/event' && event?.type === 'assistant/message') {
          // assistant/message data: { turn, step, message: AssistantMessage, usage? }
          const message = event.data?.message
          finalText = (message?.content ?? []).map((b) => b.text ?? '').join('')
          usage = usage ?? event.data?.usage ?? null
          return finalText.trim().length > 0
        }
        return false
      }, 240000, 'assistant/message')
      log('model-roundtrip', {
        chunks,
        finalText: finalText.slice(0, 80),
        usage: usage ?? undefined,
      })
      if (!finalText.trim()) throw new Error('empty assistant response')

      // Approval chain: request an out-of-workspace write, then REJECT it.
      const pr2 = await driveRpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '在 C:/Users/Canpu/Desktop 目录创建一个名为 dsh_drive_test.txt 的文件并写入一行文字' }],
        clientTimeZone: 'Asia/Shanghai',
      })
      log('approval-prompt', { ok: pr2?.result?.ok })

      const requested = await driveWaitFor(
        mux,
        (frame) => frame.method === 'approval/requested',
        240000,
        'approval/requested',
      )
      log('approval-requested', { toolName: requested?.payload?.toolName, reason: requested?.payload?.reason?.slice?.(0, 60) })

      const respondRes = await window.fetch(`http://${BRIDGE_AUTHORITY}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-response',
          rpcId: requested.rpcId,
          result: {
            ok: true,
            value: { sessionId, approvalId: requested.payload.approvalId, outcome: 'rejected' },
          },
        }),
      })
      const receipt = await respondRes.json()
      log('approval-reject-receipt', { accepted: receipt?.accepted, reason: receipt?.reason })

      const resolved = await driveWaitFor(
        mux,
        (frame) => frame.method === 'approval/resolved',
        60000,
        'approval/resolved',
      )
      log('approval-resolved', { outcome: resolved?.payload?.outcome })
      if (resolved?.payload?.outcome !== 'rejected') throw new Error('expected approval outcome "rejected"')

      // 7. UI-level check for the reported settings-dialog bug. The official
      //    Modal renders three layers: a transparent .root (fixed, z-index
      //    1000), a blurred .mask sibling, and the .dialog card
      //    (aria-modal="true") carrying the actual background. A working CSS
      //    pipeline means BOTH the mask and the card have non-transparent
      //    backgrounds; the old defect (empty CSS bundle) left every layer
      //    transparent with unstyled text floating over the page.
      const settingsBtn = [...document.querySelectorAll('button')].find((el) => (el.innerText ?? '').includes('设置'))
      if (!settingsBtn) throw new Error('settings button not found')
      settingsBtn.click()
      await new Promise((r) => setTimeout(r, 1000))
      const root = [...document.querySelectorAll('[role="presentation"]')].find((el) => {
        const s = getComputedStyle(el)
        return (s.position === 'fixed' || s.position === 'absolute')
          && (el.innerText ?? '').includes('模型')
          && el.getBoundingClientRect().width > 300
      })
      const dialog = root?.querySelector('[aria-modal="true"]') ?? null
      const mask = root ? root.querySelector('div[aria-hidden="true"]') : null
      const dialogStyle = dialog ? getComputedStyle(dialog) : null
      const maskStyle = mask ? getComputedStyle(mask) : null
      log('settings-dialog', {
        found: !!root,
        position: root ? getComputedStyle(root).position : undefined,
        zIndex: root ? getComputedStyle(root).zIndex : undefined,
        dialogBackground: dialogStyle?.backgroundColor,
        maskBackground: maskStyle?.backgroundColor,
      })
      if (!root) throw new Error('settings dialog root not found')
      const dialogBg = dialogStyle?.backgroundColor ?? ''
      const maskBg = maskStyle?.backgroundColor ?? ''
      if (dialogBg === 'rgba(0, 0, 0, 0)' || dialogBg === 'transparent') {
        throw new Error(`settings dialog card transparent (got ${dialogBg})`)
      }
      if (maskBg === 'rgba(0, 0, 0, 0)' || maskBg === 'transparent') {
        throw new Error(`settings dialog mask transparent (got ${maskBg})`)
      }

      report.drivePass = true
    } catch (error) {
      report.pass = false
      report.error = String(error?.message ?? error)
    }
    console.log('[desktop] DRIVE_RESULT ' + JSON.stringify(report))
  }
})()
