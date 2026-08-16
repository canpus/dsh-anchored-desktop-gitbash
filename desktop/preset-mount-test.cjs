// Dev-only headless test (0.4.2): generate the economy preset + install the
// two verbatim experiment presets against the vendored npm engine, then
// verify mount + select via the official RPC.
//   USERPROFILE=<tmp> DSH_HOME=<tmp>/.dsh node desktop/preset-mount-test.cjs
// The env overrides preset-gen's os.homedir() and the engine's DSH_HOME into
// a temp dir — the real ~/.dsh stays untouched.
'use strict'

const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')

const home = os.homedir() // honors USERPROFILE override
const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
const bin = path.join(__dirname, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PORT = 3090
const log = (...a) => console.log('[preset-mount]', ...a)

if (!fs.existsSync(bin)) {
  console.error('vendor engine missing — run node desktop/fetch-vendor.cjs first')
  process.exit(1)
}

function rpc(method, payload = {}) {
  const body = JSON.stringify({ type: 'client-request', rpcId: String(Math.random()).slice(2), method, payload })
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: `/api/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { out += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(out)
            resolve(j && j.result ? j.result : j)
          } catch (e) { reject(new Error(`bad json: ${out.slice(0, 200)}`)) }
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function waitReady() {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) { clearInterval(t); resolve() }
      }).on('error', () => {})
    }, 500)
    setTimeout(() => { clearInterval(t); reject(new Error('engine not ready in 60s')) }, 60000)
  })
}

;(async () => {
  let failed = false
  const assert = (cond, label) => {
    log((cond ? 'PASS' : 'FAIL') + ':', label)
    if (!cond) failed = true
  }

  const {
    generateEconomy, readEconomyRoute,
    installAnchoredPreset, installRouterPreset,
    economyDir, anchoredDir, routerDir,
  } = require('./preset-gen.cjs')

  // 1. economy generation: provider+model pair, no fusion residue, roundtrip
  const pair = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
  const eco = generateEconomy({ ...pair, desktopDir: __dirname })
  const yml = fs.readFileSync(path.join(eco, 'agent.cordis.yml'), 'utf8')
  assert(yml.includes(`provider: ${pair.providerId}`) && yml.includes(`model: ${pair.modelId}`), 'economy: provider+model injected')
  assert(
    !fs.existsSync(path.join(eco, 'tool-bootstrap.mjs')) && !fs.existsSync(path.join(eco, 'gitbash-executor.mjs')),
    'economy: no fusion plugin residue (纯 Standard)',
  )
  const pyml = fs.readFileSync(path.join(eco, 'preset.yml'), 'utf8')
  assert(pyml.includes('name: 省钱模式'), 'economy: preset.yml name=省钱模式')
  const route = readEconomyRoute()
  assert(route && route.providerId === pair.providerId && route.modelId === pair.modelId, 'economy: readEconomyRoute roundtrip')
  let threw = false
  try { generateEconomy({ providerId: null, modelId: 'deepseek-v4-flash', desktopDir: __dirname }) } catch { threw = true }
  assert(threw, 'economy: missing provider → throw (no model-only downgrade)')

  // 2. anchored: verbatim install + the ONE transparent bashPath adaptation
  const a = installAnchoredPreset({ desktopDir: __dirname })
  assert(a.ok && fs.existsSync(path.join(anchoredDir(), 'agent.cordis.yml')), 'anchored: installed')
  const aYml = fs.readFileSync(path.join(anchoredDir(), 'agent.cordis.yml'), 'utf8')
  assert(
    !aYml.includes('C:\\Program Files\\Git\\bin\\bash.exe') && aYml.includes(`bashPath: '${a.adapted.bashPath}'`),
    'anchored: bashPath adapted to machine probe (其余逐字)',
  )
  assert(aYml.includes('tool-bootstrap'), 'anchored: upstream anchor logic intact (逐字搬运)')

  // 3. router: verbatim install incl router-bootstrap-v1.mjs (bandOf fix)
  const r = installRouterPreset({ desktopDir: __dirname })
  assert(r.ok && fs.existsSync(path.join(routerDir(), 'router-bootstrap-v1.mjs')), 'router: installed incl router-bootstrap-v1.mjs')

  // 4. boot the vendored engine against the temp home + mount verification
  const child = spawn(process.execPath, [bin, 'web', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: path.join(__dirname, 'vendor'),
    env: { ...process.env, DSH_HOME: dshHome },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write('[engine] ' + s) })
  await waitReady()
  log('engine ready')

  const list = await rpc('agentPreset.list')
  const ids = (list.value?.presets || []).map((p) => p.id)
  log('presets:', ids.join(', '))
  for (const want of ['economy', 'anchored-standard', 'router-standard', 'standard', 'minimal']) {
    assert(ids.includes(want), `mounted: ${want}`)
  }
  const created = await rpc('session.create', {})
  const sid = created.value?.sessionId
  const sel = await rpc('agentPreset.select', { sessionId: sid, agentPreset: 'economy' })
  log('select economy on new session:', JSON.stringify(sel))
  assert(sel.ok && sel.value?.agentPreset === 'economy', 'economy: select ok:true')

  execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
  log(failed ? 'TEST FAILED' : 'TEST PASSED')
  process.exitCode = failed ? 1 : 0
})().catch((e) => { console.error(e); process.exit(1) })
