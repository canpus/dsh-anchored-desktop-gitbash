// Runtime route diagnostics (plan_v0.4.2 §3, dev-only — never ships).
//
// Against a RUNNING engine on 127.0.0.1:3080, read the ACTUAL child routes a
// session used: every continuable subagent persists its resolved
// agentProvider/agentModel in a `subagent/descriptor` event seeded into the
// child's own session history (official descriptor-seed.ts), which this
// script reads read-only. That is the evidence for "省钱模式生效" — asking
// the subagent "what model are you" is NOT evidence (the official runtime
// deliberately hides its own model identity from the model).
//
// Usage:
//   node desktop/route-probe.cjs [sessionId] [--expect providerId/modelId]
//   - no sessionId: probe every subagent session listed in session.list
//   - --expect: fail unless EVERY child route equals the given pair
// Exit code 0 = all probed children matched; 1 = mismatch/error.
'use strict'

const http = require('node:http')

const HOST = '127.0.0.1'
const PORT = Number(process.env.DSH_PORT) || 3080

function rpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method,
      payload,
    })
    const req = http.request({
      host: HOST,
      port: PORT,
      path: `/api/${method}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        try {
          const json = JSON.parse(text)
          if (json.result && json.result.ok) resolve(json.result.value)
          else reject(new Error((json.result && json.result.error && json.result.error.message) || `RPC ${method} failed: ${text.slice(0, 200)}`))
        } catch { reject(new Error(`RPC ${method}: bad response`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}

async function main() {
  // args: [sessionId?] [--expect providerId/modelId]  (--expect also accepted first)
  let sessionIdArg = null
  let expect = null
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--expect') { expect = process.argv[i + 1]; i += 1; continue }
    if (!sessionIdArg) sessionIdArg = process.argv[i]
  }
  const sl = await rpc('session.list')
  const items = sl.items || []
  const targets = sessionIdArg
    ? items.filter((s) => s.parentSessionId === sessionIdArg)
    : items.filter((s) => s.parentSessionId)
  if (!targets.length) {
    console.log('no subagent children found' + (sessionIdArg ? ` for session ${sessionIdArg}` : ''))
    process.exit(sessionIdArg ? 1 : 0)
  }
  let allOk = true
  for (const child of targets) {
    let route = null
    let mode = null
    let source = null
    try {
      const history = await rpc('session.history', { sessionId: child.sessionId, maxMessages: 10 })
      const events = (history.events || []).map((e) => e.event)
      const descriptor = events.find((e) => e && e.type === 'subagent/descriptor')
      const d = descriptor && descriptor.data
      mode = d ? d.mode : null
      if (d && d.agentProvider && d.agentModel) {
        route = `${d.agentProvider}/${d.agentModel}`
        source = 'descriptor'
      } else {
        // One-shot children persist no agentModel in the descriptor; the
        // child's own request/header still records the ACTUAL resolved
        // route (observed: config.provider/model = the injected pair).
        const header = events.find((e) => e && e.type === 'request/header')
        const cfg = header && header.data && header.data.header && header.data.header.config
        if (cfg && cfg.provider && cfg.model) {
          route = `${cfg.provider}/${cfg.model}`
          source = 'header'
        }
      }
    } catch (e) {
      console.log(`[child ${child.sessionId}] history read failed: ${String((e && e.message) || e)}`)
      allOk = false
      continue
    }
    const ok = route !== null && (!expect || route === expect)
    if (!ok) allOk = false
    console.log(
      `[child ${child.sessionId}] parent=${child.parentSessionId} mode=${mode || 'n/a'} ` +
      `route=${route || 'n/a'} (${source || 'no evidence'}) ${ok ? 'OK' : (expect ? `MISMATCH (expected ${expect})` : 'MISMATCH')}`,
    )
  }
  process.exit(allOk ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
