// Direct host-side checks for the two "empty list" reports:
//   workspace.list  (unary, /api/workspace.list)
//   pluginInventory.list  (Typert remote, /api/pluginInventory.list)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHarness } from './host-boot.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const log = (...args) => console.log(`[rpc ${(Date.now() / 1000).toFixed(1)}s]`, ...args)

setTimeout(() => { log('WATCHDOG exit'); process.exit(3) }, 120000).unref()

try {
  const booted = await bootHarness({ repo: path.join(ROOT, 'repo') })
  log('boot OK')
  // The gateway's connection interceptor registers through ctx.inject when
  // the connection service appears; give the inject callback a tick.
  await new Promise((resolve) => setTimeout(resolve, 1000))

  log('typertGateway:', booted.ctx.get('typertGateway') !== undefined)
  log('typert:', booted.ctx.get('typert') !== undefined)
  log('connection:', booted.ctx.get('connection') !== undefined)
  log('pluginInventory service:', booted.ctx.get('pluginInventory') !== undefined)

  const typertSvc = booted.ctx.get('typert')
  log('typert.local keys:', JSON.stringify(typertSvc.local.list().map((r) => r.key).slice(0, 40)))
  log('typert.local.get(pluginInventory/list):', typertSvc.local.get('pluginInventory/list') !== undefined)

  // Bypass the interceptor: invoke the gateway directly.
  const gw = booted.ctx.get('typertGateway')
  try {
    const direct = await gw.invoke({ namespace: 'pluginInventory', method: 'list', args: {} })
    log('gateway.invoke direct:', JSON.stringify(direct).slice(0, 120))
  } catch (error) {
    log('gateway.invoke direct FAILED:', String(error?.message ?? error))
  }

  // Manual interceptor experiment: register the exact interception the
  // gateway should have registered, then retry the wire call.
  const conn = booted.ctx.get('connection')
  try {
    conn.rpc.intercept(
      '/api',
      (endpoint) => endpoint === 'probe-marker',
      () => Promise.resolve({ ok: true, value: { manual: true } }),
      { authority: 'trusted-host' },
    )
    log('manual intercept registered (probe-marker)')
  } catch (error) {
    log('manual intercept SKIPPED:', String(error?.message ?? error))
  }

  const rpc = async (method, payload) => {
    const res = await booted.handler.fetch(new Request(`http://dsh.internal/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-' + method, method, payload }),
    }))
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { __httpStatus: res.status, __body: text.slice(0, 120) }
    }
  }

  const wl = await rpc('workspace.list', {})
  log('workspace.list:', JSON.stringify(wl?.result ?? wl).slice(0, 600))

  // Typert remote endpoints use slash form: pluginInventory/list (the dot
  // form is not a real wire endpoint). The payload carries one plain-object
  // args field.
  const pi = await rpc('pluginInventory/list', { args: {} })
  log('pluginInventory/list:', JSON.stringify(pi?.result ?? pi).slice(0, 300))

  const marker = await rpc('probe-marker', { args: [] })
  log('probe-marker wire:', JSON.stringify(marker?.result ?? marker).slice(0, 200))

  // Also probe the raw service face (bypasses wire routing).
  const picker = booted.ctx.get('directoryPicker')
  log('directoryPicker service:', picker ? `kind=${picker.capability().kind}` : 'MISSING')
  const inv = booted.ctx.get('pluginInventory')
  log('pluginInventory service:', inv ? `methods=${typeof inv.list}` : 'MISSING')

  process.exit(0)
} catch (error) {
  console.error('[rpc] FAILED:', error)
  process.exit(1)
}
