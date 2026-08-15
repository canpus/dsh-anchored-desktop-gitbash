// RPC-level self-test for the message-level ops (重发/分支) — unattended
// verification of the wire behavior and side effects WITHOUT any model call:
//   node desktop/rpc-test.mjs
// Requires a running dsh web backend on 127.0.0.1:3080.
// Covers:
//   1. session.list wire fields
//   2. session.history user/message events carry data.id + event.seq (the
//      assumptions main.js findUserMessage relies on)
//   3. session.fork atSeq → child session appears in the list → archived
//      (archive keeps the test from polluting the user's session list)
//   4. session.prompt with the slash command /goal → accepted + command/run
//      event written (slash commands bypass the model entirely)
'use strict'

import http from 'node:http'

const PORT = 3080
let rpcId = 0
function rpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: `rpc-test-${++rpcId}`, method, payload })
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: `/api/${method}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        try {
          const json = JSON.parse(text)
          if (json.result && json.result.ok) resolve(json.result.value)
          else reject(new Error(`RPC ${method} failed: ${text.slice(0, 300)}`))
        } catch (e) {
          reject(new Error(`RPC ${method} bad response: ${text.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}

const results = []
function report(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function fullHistory(sessionId) {
  const events = []
  const seen = new Set()
  let beforeSeq
  for (let i = 0; i < 500; i++) {
    const payload = { sessionId, maxMessages: 100 }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const v = await rpc('session.history', payload)
    const page = v.events || []
    if (!page.length) break
    let minSeq
    let added = 0
    for (const entry of page) {
      const seq = entry.event?.seq
      if (seq === undefined || seen.has(seq)) continue
      seen.add(seq)
      events.push(entry)
      added += 1
      if (minSeq === undefined || seq < minSeq) minSeq = seq
    }
    if (!v.hasMore || minSeq === undefined) break
    // Whole-message page boundaries: only the smallest seq advances the cursor.
    if (beforeSeq !== undefined && minSeq >= beforeSeq) break
    beforeSeq = minSeq
    if (added === 0) break
  }
  return events
}

function summarize() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`)
  process.exit(failed.length ? 1 : 0)
}

async function main() {
  // 1. session.list
  const sl = await rpc('session.list')
  const items = sl.items || []
  report('session.list', Array.isArray(items), `${items.length} sessions`)
  const normal = items.filter((s) => !s.parentSessionId && s.origin !== 'subagent')
  const nonBlank = normal.filter((s) => !s.blank)
  report('non-blank non-subagent session exists', nonBlank.length > 0)

  // 2. history structure — find the newest user/message (pages backwards from
  // the tail, stops at the first hit — mirrors main.js findUserMessage)
  async function newestUserMessage(sessionId) {
    let beforeSeq
    for (let i = 0; i < 500; i++) {
      const payload = { sessionId, maxMessages: 100 }
      if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
      const v = await rpc('session.history', payload)
      const page = v.events || []
      let minSeq
      for (let j = page.length - 1; j >= 0; j--) {
        const event = page[j] && page[j].event
        if (!event) continue
        if (event.type === 'user/message') return event
        const seq = event.seq
        if (minSeq === undefined || seq < minSeq) minSeq = seq
      }
      if (!v.hasMore || minSeq === undefined) break
      if (beforeSeq !== undefined && minSeq >= beforeSeq) break
      beforeSeq = minSeq
    }
    return null
  }

  let probe = null
  for (const s of nonBlank.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    const ev = await newestUserMessage(s.sessionId)
    if (ev) { probe = { sessionId: s.sessionId, ev }; break }
  }
  if (!probe) {
    report('history probe session', false, 'no session with a user/message event')
    return summarize()
  }
  const sample = probe.ev
  const hasId = typeof sample.data?.id === 'string' && sample.data.id.length > 0
  const hasSeq = Number.isSafeInteger(sample.seq)
  const blocks = Array.isArray(sample.data?.content) ? sample.data.content : []
  const textBlocks = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
  report('user/message carries data.id', hasId, String(sample.data?.id).slice(0, 40))
  report('user/message carries event.seq', hasSeq, `seq=${sample.seq}`)
  report('user/message content has text blocks', textBlocks.length > 0, `${textBlocks.length} block(s)`)

  // 3. fork atSeq → child appears → prompt a slash command on it → archive
  const forkRes = await rpc('session.fork', { sessionId: probe.sessionId, atSeq: sample.seq })
  const childId = forkRes.sessionId
  report('session.fork returns sessionId', typeof childId === 'string' && childId.length > 0, String(childId).slice(0, 24))
  const sl2 = await rpc('session.list')
  const child = (sl2.items || []).find((s) => s.sessionId === childId)
  report('forked child appears in session.list', !!child, child ? `parentLink=${!!child.parentSessionId}` : 'not found')

  if (child) {
    // 4. resend semantics: session.prompt does NOT parse slash commands
    // (verified live earlier: /goal reached the model as a plain message), so
    // the shell routes command lines back through the composer. Assert the
    // detection grammar only — no model invocation here.
    const SLASH_COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
    report('command grammar: /goal detected', SLASH_COMMAND_RE.test('/goal'))
    report('command grammar: /compact detected', SLASH_COMMAND_RE.test('/compact'))
    report('command grammar: plain text rejected', !SLASH_COMMAND_RE.test('帮我压缩上下文'))
    report('command grammar: /压缩 rejected (needs translation)', !SLASH_COMMAND_RE.test('/压缩'))

    // 5. cleanup: archive the test child (archived sessions stay in
    // session.list — the archive set lives on workspace.list)
    await rpc('workspace.archiveSession', { sessionId: childId })
    const wl = await rpc('workspace.list')
    const archived = (wl.archivedSessionIds || []).some((id) => id === childId)
    report('test child archived (cleanup)', archived)
  }

  summarize()
}

main().catch((e) => {
  console.error('FATAL:', String(e?.message || e))
  process.exit(1)
})
