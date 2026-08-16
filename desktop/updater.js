// Stage 3 updater (0.4.2) — five-way update check:
//   self     — shell release tags (git ls-remote); actionable via 整包自更新.
//   harness  — the official backend now ships as the bundled npm package under
//              desktop/vendor; check the npm registry for a newer
//              @deepseek-ai/dsh version. Informational only: the engine rides
//              inside the green package, so downloading a new green zip IS the
//              upgrade (the 0.3.9 in-place git rebuild flow is gone with the
//              source-checkout engine).
//   anchored / router / gitbash — preset template repos (git ls-remote,
//              repo-side). anchored+router are the 实验开关搬运 presets;
//              gitbash is the legacy Windows minimal variant.
//
// Pure Node module (no electron imports) so it is testable from the CLI:
//   node desktop/updater.js check
'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const DESKTOP = __dirname
const CONFIG_PATH = path.join(DESKTOP, 'shell-config.json')

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}
const config = loadConfig()

// Proxy comes from shell-config.json (标题栏「代理设置」writes it). Read
// dynamically so a change saved from the GUI applies to the next check without
// restarting the shell. Empty = direct connection — never hard-code a
// fallback, machines without a proxy must not hang or leak traffic through a
// stranger's port.
function currentProxy() {
  const cfg = loadConfig()
  const p = cfg.proxy
  const parts = typeof p === 'string'
    ? { http: String(p || '').trim(), https: String(p || '').trim() }
    : (p && typeof p === 'object'
      ? { http: String(p.http || '').trim(), https: String(p.https || '').trim() }
      : { http: '', https: '' })
  return parts.https || parts.http || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
}

const log = (...args) => console.log(`[updater ${(Date.now() / 1000).toFixed(1)}s]`, ...args)

// ls-remote an arbitrary repo URL (self/anchored/gitbash checks), proxy-aware.
function lsRemote(repoUrl, ref) {
  const proxy = currentProxy()
  const proxyFlags = proxy
    ? ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`]
    : []
  return execFileSync('git', [...proxyFlags, 'ls-remote', repoUrl, ref], {
    encoding: 'utf8',
    timeout: 180000,
  }).trim()
}

// ---- version helpers ----
function parseVersionTag(tag) {
  const m = /^refs\/tags\/v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}
function localShellVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ''))
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  } catch { return null }
}

// npm semver-ish compare for the harness check: stable beats prerelease;
// same-release prereleases compare by their trailing number (rc.6 < rc.7).
function compareNpmVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || ''))
    if (!m) return null
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return String(a).localeCompare(String(b))
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const ra = /^(.*?)(\d+)$/.exec(pa.pre)
  const rb = /^(.*?)(\d+)$/.exec(pb.pre)
  if (ra && rb && ra[1] === rb[1]) return Number(ra[2]) - Number(rb[2])
  return pa.pre.localeCompare(pb.pre)
}

// ---- per-target checks ----
function checkSelf(entry) {
  const out = lsRemote(entry.repo, 'refs/tags/v*')
  const tags = out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]).filter(Boolean)
  let latest = null
  for (const t of tags) {
    const v = parseVersionTag(t)
    if (v && (!latest || compareVersions(v, latest) > 0)) latest = v
  }
  const local = localShellVersion()
  if (latest === null) {
    return { name: 'self', note: entry.note, hasUpdate: false, detail: local ? `v${local.join('.')}（远端暂无 Release tag）` : '未知版本' }
  }
  const hasUpdate = local === null || compareVersions(latest, local) > 0
  const detail = hasUpdate
    ? `v${local ? local.join('.') : '?'} → v${latest.join('.')}`
    : `v${local.join('.')}（最新）`
  return {
    name: 'self', note: entry.note, hasUpdate,
    detail: entry.pauseNote ? `${detail}（${entry.pauseNote}）` : detail,
  }
}

function checkUpstream(entry, name) {
  const out = lsRemote(entry.repo, `refs/heads/${entry.branch}`)
  const head = out.split(/\s+/)[0] || ''
  if (!head) throw new Error('ls-remote 返回为空')
  const locked = String(entry.lockedCommit || '').trim()
  if (locked && locked.length < 7) {
    throw new Error('lockedCommit 长度不足 7 位：' + locked)
  }
  // Compare by prefix, not exact equality: the persisted lock is a short SHA
  // while git ls-remote reports the full 40-char SHA, so `head !== locked`
  // would always be true and falsely report an update. The 7-char minimum
  // keeps the prefix unambiguous for realistic repo sizes.
  const hasUpdate = Boolean(locked) && locked.length >= 7 && !head.toLowerCase().startsWith(locked.toLowerCase())
  return {
    name, note: entry.note, hasUpdate,
    detail: hasUpdate ? `锁定 ${locked.slice(0, 8)} → 最新 ${head.slice(0, 8)}` : `与锁定 ${locked.slice(0, 8)} 一致`,
  }
}

function checkHarness(entry) {
  const proxy = currentProxy()
  const args = ['-sS', '--max-time', '30']
  if (proxy) args.push('-x', proxy)
  args.push(`https://registry.npmjs.org/${encodeURIComponent(entry.npm)}/latest`)
  const out = execFileSync('curl.exe', args, { encoding: 'utf8', windowsHide: true })
  let latest = ''
  try { latest = String(JSON.parse(out).version || '') } catch { throw new Error('npm 注册表响应无法解析') }
  if (!latest) throw new Error('npm 注册表未返回版本')
  const locked = String(entry.lockedVersion || '').trim()
  if (!locked) throw new Error('lockedVersion 缺失')
  const hasUpdate = compareNpmVersions(latest, locked) > 0
  return {
    name: 'harness', note: entry.note, hasUpdate,
    detail: hasUpdate ? `${locked} → ${latest}` : `与锁定 ${locked} 一致`,
  }
}

async function checkForUpdate({ onResult, onStep } = {}) {
  const watch = (config.watch && typeof config.watch === 'object') ? config.watch : {}
  const results = []
  const checks = [
    ['self', () => checkSelf(watch.self)],
    ['harness', () => checkHarness(watch.harness)],
    ['anchored', () => checkUpstream(watch.anchored, 'anchored')],
    ['router', () => checkUpstream(watch.router, 'router')],
    ['gitbash', () => checkUpstream(watch.gitbash, 'gitbash')],
  ]
  for (const [key, fn] of checks) {
    const entry = watch[key]
    if (!entry) continue
    onStep && onStep(`▶ 检查 ${entry.note || key}…`)
    try {
      results.push(fn())
    } catch (error) {
      results.push({ name: key, note: entry.note || key, hasUpdate: false, error: String(error?.message ?? error) })
    }
  }
  const anyUpdate = results.some((r) => r.hasUpdate)
  onResult && onResult({ ok: true, results, anyUpdate })
}

// ---- CLI entry ----
if (require.main === module) {
  const mode = process.argv[2]
  ;(async () => {
    if (mode === 'check') {
      let exit = 0
      await checkForUpdate({
        onResult: (r) => {
          for (const x of r.results) {
            const line = x.error
              ? `[${x.name}] 检查失败: ${x.error}`
              : x.hasUpdate
                ? `[${x.name}] 有更新 — ${x.detail}`
                : `[${x.name}] 最新 — ${x.detail}`
            console.log(line)
            if (x.error) exit = 1
          }
          console.log(r.anyUpdate ? 'UPDATE AVAILABLE' : 'ALL UP TO DATE')
        },
      })
      process.exit(exit)
    }
    console.log('usage: node desktop/updater.js check')
    process.exit(2)
  })().catch((e) => { console.error(e); process.exit(1) })
}

module.exports = { checkForUpdate }
