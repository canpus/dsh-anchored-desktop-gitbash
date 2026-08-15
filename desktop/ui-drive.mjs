// UI-level drive test (unattended): drives the live Electron shell through
// the Chrome DevTools Protocol to verify, against the REAL official page:
//   1. the official row anchor `data-chat-anchor-key` exists (message-level
//      right-click ops assumption)
//   2. the slash menu localizes to Chinese (MutationObserver display layer)
//   3. /目标 submit-time translation: composer "/目标" + Enter reaches the
//      official command chain as /goal (a no-op read — no model call)
//
//   node desktop/ui-drive.mjs
//
// Requires: the shell running with `npm start -- --remote-debugging-port=9222`
// and the backend on 127.0.0.1:3080.
'use strict'

import http from 'node:http'

const CDP_HOST = 'http://127.0.0.1:9222'
const PORT = 3080

// ---- tiny CDP client over the node-built-in WebSocket ----
function cdpClient(wsUrl) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(wsUrl)
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    }),
    close: () => ws.close(),
  }
}

async function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_HOST}/json/list`, (res) => {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => { try { resolve(JSON.parse(t)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

// ---- backend RPC (same envelope as the shell) ----
let rpcId = 0
function rpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: `drive-${++rpcId}`, method, payload })
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: `/api/${method}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(t)
          if (j.result && j.result.ok) resolve(j.result.value)
          else reject(new Error(`RPC ${method} failed: ${t.slice(0, 300)}`))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const results = []
function report(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.result && res.result.exceptionDetails) {
    throw new Error(`page exception: ${JSON.stringify(res.result.exceptionDetails).slice(0, 300)}`)
  }
  return res.result && res.result.result ? res.result.result.value : undefined
}

async function main() {
  // find the main-view page target (the backend URL, not the titlebar)
  let targets = []
  for (let i = 0; i < 20; i++) {
    targets = await getTargets()
    if (targets.some((t) => t.url.includes('3080'))) break
    await sleep(1000)
  }
  const page = targets.find((t) => t.type === 'page' && t.url.includes('3080'))
  if (!page) {
    console.error('FAIL: no page target for the official UI found')
    process.exit(1)
  }
  const cdp = cdpClient(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')

  // wait for the chat view to actually render (the shell reports ready before
  // the conversation has painted its rows)
  let dom = null
  for (let i = 0; i < 30; i++) {
    dom = await evalJs(cdp, `(() => {
      const ta = document.querySelector('textarea')
      return {
        textarea: !!ta,
        composerCard: !!document.querySelector('[data-composer-card]'),
        rows: document.querySelectorAll('[data-chat-anchor-key]').length,
        sampleKey: (document.querySelector('[data-chat-anchor-key]') || {}).getAttribute
          ? document.querySelector('[data-chat-anchor-key]').getAttribute('data-chat-anchor-key') : null,
      }
    })()`)
    if (dom.rows > 0) break
    await sleep(1000)
  }
  report('composer textarea exists', dom.textarea)
  report('data-composer-card anchor exists', dom.composerCard)
  report('chat rows carry data-chat-anchor-key', dom.rows > 0, `rows=${dom.rows} sample="${dom.sampleKey}"`)

  // 2. slash menu localization: type "/" through the controlled-input path
  const typed = await evalJs(cdp, `(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '/')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value
  })()`)
  report('composer accepted "/" input', typed === '/', `value="${String(typed)}"`)
  let menu = null
  for (let i = 0; i < 12; i++) {
    await sleep(1000)
    menu = await evalJs(cdp, `(() => {
      const rows = document.querySelectorAll('[role="option"]')
      const seen = []
      for (const r of rows) {
        const spans = [...r.querySelectorAll('span')].filter(s => s.getAttribute('aria-hidden') !== 'true')
        if (spans.length) seen.push(spans[0].textContent.trim())
      }
      return { rows: rows.length, names: seen }
    })()`)
    if (menu.rows > 0) break
  }
  // The localization runs in the mutation observer right after the menu
  // paints — give it a beat before reading the labels.
  await sleep(2000)
  menu = await evalJs(cdp, `(() => {
    const rows = document.querySelectorAll('[role="option"]')
    const seen = []
    for (const r of rows) {
      const spans = [...r.querySelectorAll('span')].filter(s => s.getAttribute('aria-hidden') !== 'true')
      if (spans.length) seen.push(spans[0].textContent.trim())
    }
    return { rows: rows.length, names: seen }
  })()`)
  report('slash menu opened with /', menu.rows > 0, `rows=${menu.rows}`)
  const localized = menu.names.some((n) => n === '压缩' || n === '目标' || n === '计划' || n === '权限' || n === '反馈' || n === '导出' || n === '模型')
  report('menu rows localized to Chinese', localized, JSON.stringify(menu.names.slice(0, 12)))

  // 2b. SECOND open of the same menu (user-reported bug: after deleting the
  // slash and typing it again the rows went back to English permanently)
  await evalJs(cdp, `(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(1500) // menu closes as the slash disappears
  await evalJs(cdp, `(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '/')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  let menu2 = null
  for (let i = 0; i < 8; i++) {
    await sleep(1000)
    menu2 = await evalJs(cdp, `(() => {
      const rows = document.querySelectorAll('[role="option"]')
      const seen = []
      for (const r of rows) {
        const spans = [...r.querySelectorAll('span')].filter(s => s.getAttribute('aria-hidden') !== 'true')
        if (spans.length) seen.push(spans[0].textContent.trim())
      }
      return { rows: rows.length, names: seen }
    })()`)
    if (menu2.rows > 0) break
  }
  await sleep(2000)
  menu2 = await evalJs(cdp, `(() => {
    const rows = document.querySelectorAll('[role="option"]')
    const seen = []
    for (const r of rows) {
      const spans = [...r.querySelectorAll('span')].filter(s => s.getAttribute('aria-hidden') !== 'true')
      if (spans.length) seen.push(spans[0].textContent.trim())
    }
    return { rows: rows.length, names: seen }
  })()`)
  report('second menu open', menu2.rows > 0, `rows=${menu2.rows}`)
  const localized2 = menu2.names.some((n) => n === '压缩' || n === '目标' || n === '计划' || n === '权限' || n === '反馈' || n === '导出' || n === '模型')
  report('second menu still localized to Chinese', localized2, JSON.stringify(menu2.names.slice(0, 12)))

  // close the menu (Escape)
  await evalJs(cdp, `(() => {
    const ta = document.querySelector('textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }))
    return true
  })()`)

  // 3. submit-time translation: /目标 + Enter → command/run goal on the backend
  const slBefore = await rpc('session.list')
  const beforeIds = new Set((slBefore.items || []).map((s) => s.sessionId))
  await evalJs(cdp, `(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '/目标')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  await evalJs(cdp, `(() => {
    const ta = document.querySelector('textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    return true
  })()`)
  // Poll the backend for a fresh command/run goal event in any session.
  let goalEvent = null
  let scannedId = null
  for (let attempt = 0; attempt < 15 && !goalEvent; attempt++) {
    await sleep(2000)
    const sl = await rpc('session.list')
    const candidates = (sl.items || [])
      .filter((s) => !s.parentSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
    for (const s of candidates) {
      const h = await rpc('session.history', { sessionId: s.sessionId, maxMessages: 5 })
      const hit = (h.events || []).map((x) => x.event)
        .find((e) => e.type === 'command/run' && e.data?.name === 'goal' && e.time > Date.now() - 60000)
      if (hit) { goalEvent = hit; scannedId = s.sessionId; break }
    }
  }
  report('submit translation: /目标 executed as /goal', !!goalEvent, goalEvent ? `command/run on ${scannedId?.slice(0, 20)}` : 'no goal command event within 30s')

  // 4. session-row ellipsis menu persistence: open it, move the pointer out —
  // it must STAY open (shell interception of the official closeOnPointerLeave);
  // an outside click must still close it.
  const opened = await evalJs(cdp, `(() => {
    const btn = [...document.querySelectorAll('button[aria-label]')].find(b => b.offsetParent !== null)
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await sleep(800)
  const menuState1 = await evalJs(cdp, `(() => {
    const m = document.querySelector('[role="menu"]')
    return { exists: !!m, items: m ? m.querySelectorAll('[role="menuitem"]').length : 0 }
  })()`)
  report('ellipsis menu opened', !!opened && menuState1.exists && menuState1.items > 0, JSON.stringify(menuState1))
  await evalJs(cdp, `(() => {
    const m = document.querySelector('[role="menu"]')
    const item = m.querySelector('[role="menuitem"]')
    item.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerType: 'mouse' }))
    return true
  })()`)
  await sleep(600) // well past the official 200ms close grace
  const menuState2 = await evalJs(cdp, `!!document.querySelector('[role="menu"]')`)
  report('menu stays open after pointer-out', menuState2)
  await evalJs(cdp, `(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    return true
  })()`)
  await sleep(400)
  const menuState3 = await evalJs(cdp, `!!document.querySelector('[role="menu"]')`)
  report('outside click still closes menu', !menuState3)

  cdp.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', String(e?.message || e))
  process.exit(1)
})
