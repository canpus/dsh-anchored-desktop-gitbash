// Dev-only headless test (0.4.0-slim): generate the 0.3.9 presets against the
// vendored npm engine and verify mount + select via the official RPC.
//   USERPROFILE=<tmp> DSH_HOME=<tmp>/.dsh node desktop/preset-mount-test.cjs
// The env overrides route preset-gen's os.homedir() and the engine's DSH_HOME
// into a temp dir — the real ~/.dsh stays untouched.
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
  // 1. generate the three 0.3.9 user presets
  const { generateFcChild, installRouterPreset, installMinimalGitbash } = require('./preset-gen.cjs')
  const fc = generateFcChild('deepseek-v4-flash', { desktopDir: __dirname })
  const router = installRouterPreset({ desktopDir: __dirname })
  const gitbash = installMinimalGitbash({ desktopDir: __dirname })
  log('generated:', path.relative(home, fc), '|', path.relative(home, router), '|', path.relative(home, gitbash))

  // 2. boot the vendored engine against the temp home
  const child = spawn(process.execPath, [bin, 'web', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: path.join(__dirname, 'vendor'),
    env: { ...process.env, DSH_HOME: dshHome },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write('[engine] ' + s) })
  await waitReady()
  log('engine ready')

  // 3. mount + select verification
  const list = await rpc('agentPreset.list')
  const ids = (list.value?.presets || []).map((p) => p.id)
  log('presets:', ids.join(', '))
  for (const want of ['fc-child', 'router-standard', 'minimal-gitbash', 'standard', 'minimal']) {
    if (!ids.includes(want)) { console.error(`MISSING preset: ${want}`); process.exitCode = 1 }
  }
  const created = await rpc('session.create', {})
  const sid = created.value?.sessionId
  const sel = await rpc('agentPreset.select', { sessionId: sid, agentPreset: 'fc-child' })
  log('select fc-child on new session:', JSON.stringify(sel))
  if (!(sel.ok && sel.value?.agentPreset === 'fc-child')) process.exitCode = 1

  execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
  log(process.exitCode ? 'TEST FAILED' : 'TEST PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
