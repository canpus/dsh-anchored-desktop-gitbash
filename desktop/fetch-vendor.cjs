// Fetch the official npm engine into desktop/vendor (0.4.0-slim). Runs on the
// DEVELOPER machine only — the packaged green zip already contains the tree.
// Proxy comes from shell-config.json (标题栏「代理设置」); empty = direct.
//   node desktop/fetch-vendor.cjs [version]
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DESKTOP = __dirname
const config = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'shell-config.json'), 'utf8'))
const version = process.argv[2] || (config.watch && config.watch.harness && config.watch.harness.lockedVersion) || 'latest'
// pnpm rides along so `dsh plugin add` (official pnpm forwarder) works on
// machines without a system Node — desktop/pnpm-shim/pnpm.cmd routes bare
// `pnpm` to the bundled node.exe + this vendored pnpm.
const pnpmVersion = config.vendorPnpm || 'latest'

const VENDOR = path.join(DESKTOP, 'vendor')
fs.rmSync(VENDOR, { recursive: true, force: true })
fs.mkdirSync(VENDOR, { recursive: true })

const p = config.proxy || {}
const proxy = (p.https || p.http || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
const args = [
  'install', '--prefix', VENDOR,
  '--omit=dev', '--no-fund', '--no-audit', '--loglevel=warn',
  ...(proxy ? ['--proxy', proxy, '--https-proxy', proxy] : []),
  `@deepseek-ai/dsh@${version}`,
  `pnpm@${pnpmVersion}`,
]
console.log(`[fetch-vendor] npm install @deepseek-ai/dsh@${version} pnpm@${pnpmVersion} (proxy: ${proxy ? 'configured' : 'direct'})`)
// npm is npm.cmd on Windows — plain spawnSync cannot execute .cmd shims
// without a shell (status would be null / ENOENT).
const r = spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' })
if (r.error || r.status !== 0) {
  console.error(`[fetch-vendor] FAILED (${r.error ? r.error.message : 'exit ' + r.status})`)
  process.exit(r.error ? 1 : (r.status || 1))
}
const bin = path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const web = path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
const pnpm = path.join(VENDOR, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
console.log(fs.existsSync(bin) ? `[fetch-vendor] OK: ${path.relative(DESKTOP, bin)}` : '[fetch-vendor] WARNING: lib/bin.js missing')
console.log(fs.existsSync(web) ? `[fetch-vendor] OK: ${path.relative(DESKTOP, web)}` : '[fetch-vendor] WARNING: web dist missing')
console.log(fs.existsSync(pnpm) ? `[fetch-vendor] OK: ${path.relative(DESKTOP, pnpm)}` : '[fetch-vendor] WARNING: pnpm missing')
