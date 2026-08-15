// Stage 3 updater — check for upstream commits and run a full-auto upgrade
// (fetch → checkout → install → build lib → build web → smoke probe) with
// automatic rollback to the previous commit on failure.
//
// Pure Node module (no electron imports) so it is testable from the CLI:
//   node desktop/updater.js check   — compare remote vs locked commit
//   node desktop/updater.js upgrade — full-auto upgrade (interactive risk: long)
'use strict'

const { execFileSync, spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const DESKTOP = __dirname
const ROOT = path.resolve(DESKTOP, '..')
const CONFIG_PATH = path.join(DESKTOP, 'shell-config.json')

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}
const config = loadConfig()
const REPO = path.resolve(DESKTOP, config.repoPath)
const REMOTE = config.upstream.remote
const BRANCH = config.upstream.branch

// Proxy comes from shell-config.json (标题栏「代理设置」writes it). v0.3.6: the
// field is { http, https } (legacy single string = both). https falls back to
// http; empty = direct connection — never hard-code a fallback, machines
// without a proxy must not hang or leak traffic through a stranger's port.
// Read dynamically so a change saved from the GUI applies to the next check
// without restarting the shell.
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

// ---- git helpers ----
function git(args, opts = {}) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 120000,
  }).trim()
}
// Fetch/ls-remote need the proxy config; regular rev-parse must not depend on it.
// Empty proxy = direct connection: skip the -c flags entirely (git rejects an
// empty proxy URL).
function gitProxy(args, opts = {}) {
  const proxy = currentProxy()
  const proxyFlags = proxy
    ? ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`]
    : []
  return execFileSync('git', [
    '-C', REPO,
    ...proxyFlags,
    ...args,
  ], { encoding: 'utf8', timeout: opts.timeout ?? 180000 }).trim()
}

function localHead() {
  return git(['rev-parse', 'HEAD'])
}
function remoteHead() {
  // ls-remote fetches refs only; the working tree is untouched.
  const out = gitProxy(['ls-remote', REMOTE, `refs/heads/${BRANCH}`])
  return out.split(/\s+/)[0] || ''
}

// ls-remote an arbitrary repo URL (four-way check targets), proxy-aware.
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

// ---- smoke probe: start the harness, wait for ready, kill it ----
function probeSmoke(startCommand, port, ready, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = startCommand
    const child = spawn(cmd, args, { cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    const kill = () => {
      if (!child || !child.pid) return
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }) } catch { /* gone */ }
    }
    child.stdout.on('data', (d) => process.stdout.write(`[probe] ${d}`))
    child.stderr.on('data', (d) => process.stderr.write(`[probe] ${d}`))
    const timer = setInterval(() => {
      const req = http.get({ host: '127.0.0.1', port, path: ready.path, timeout: 2000 }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c; if (body.length > 40000) res.destroy() })
        res.on('end', () => {
          const titleMatch = body.match(/<title>([^<]*)<\/title>/i)
          const title = titleMatch ? titleMatch[1].trim() : ''
          const titleOk = !ready.titleContains || title.includes(ready.titleContains)
          if (res.statusCode === ready.status && titleOk && !settled) {
            settled = true
            clearInterval(timer)
            kill()
            setTimeout(() => resolve({ status: res.statusCode, title }), 800)
          }
        })
      })
      req.on('error', () => { /* not ready */ })
      req.on('timeout', () => req.destroy())
    }, 500)
    const watchdog = setTimeout(() => {
      if (settled) return
      settled = true
      clearInterval(timer)
      kill()
      reject(new Error(`smoke probe timed out: no HTTP ${ready.status} on :${port}`))
    }, timeoutMs)
    child.on('exit', () => {
      if (!settled) {
        settled = true
        clearInterval(timer)
        clearTimeout(watchdog)
        reject(new Error('harness process exited before readiness'))
      }
    })
  })
}

// ---- step runner with progress callback ----
function runStep(label, cmd, { onStep, cwd = REPO, timeout = 30 * 60_000, proxy = false } = {}) {
  onStep && onStep(`▶ ${label}: ${cmd.join(' ')}`)
  const res = spawnSyncSafe(cmd, { cwd, timeout, proxy })
  if (res.status !== 0) {
    const err = new Error(`step failed: ${label} (exit ${res.status})`)
    err.step = label
    err.output = res.stdout?.slice(-4000) + res.stderr?.slice(-4000)
    throw err
  }
  onStep && onStep(`✓ ${label} done`)
}

// spawnSync with streaming passthrough for long builds.
const { spawnSync } = require('node:child_process')
function spawnSyncSafe(cmd, { cwd, timeout, proxy }) {
  const proxyUrl = currentProxy()
  const env = proxy && proxyUrl
    ? { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: 'localhost,127.0.0.1' }
    : process.env
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout,
  })
}

const pnpm = (sub) => ['cmd', '/c', `corepack pnpm@11.7.0 ${sub}`]

// ---- full-auto upgrade with rollback ----
async function runUpgrade({ onStep } = {}) {
  const baseline = localHead()
  onStep && onStep(`baseline commit: ${baseline}`)
  const target = remoteHead()
  onStep && onStep(`target commit: ${target}`)

  const smoke = async () => probeSmoke(config.startCommand, config.port, config.ready)

  const rebuild = async () => {
    runStep('pnpm install (frozen lockfile)', pnpm('install --frozen-lockfile'), { onStep, proxy: true, timeout: 20 * 60_000 })
    runStep('build:lib (host → client, Typert generation)', pnpm('run build:lib'), { onStep, timeout: 30 * 60_000 })
    // Root build:web wrapper calls pnpm from PATH; bypass it (same as stage 0 SOP).
    runStep('build web frontend', pnpm('--filter @deepseek-ai/dsh-web-frontend run build'), { onStep, timeout: 20 * 60_000 })
  }

  let failure = null
  try {
    const fetchProxy = currentProxy()
    const fetchFlags = fetchProxy
      ? ['-c', `http.proxy=${fetchProxy}`, '-c', `https.proxy=${fetchProxy}`]
      : []
    runStep('git fetch upstream', ['git', '-C', REPO, ...fetchFlags, 'fetch', '--depth', '1', REMOTE, BRANCH], { onStep, timeout: 10 * 60_000 })
    runStep('checkout new commit', ['git', '-C', REPO, 'checkout', '--detach', 'FETCH_HEAD'], { onStep })
    await rebuild()
    const ready = await smoke()
    onStep && onStep(`smoke probe OK: HTTP ${ready.status}, title "${ready.title}"`)
    // Persist the new lock.
    config.upstream.lockedCommit = localHead()
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    onStep && onStep(`lockedCommit updated to ${config.upstream.lockedCommit}`)
    return { ok: true, baseline, target }
  } catch (error) {
    failure = error
    onStep && onStep(`✗ FAILED: ${String(error.message ?? error)}`)
    onStep && onStep(`rolling back to ${baseline}`)
    try {
      runStep('checkout baseline', ['git', '-C', REPO, 'checkout', '--detach', baseline], { onStep })
      await rebuild()
      await smoke()
      onStep && onStep('rollback complete: baseline rebuilds and passes smoke')
    } catch (rollbackError) {
      onStep && onStep(`✗ ROLLBACK ALSO FAILED: ${String(rollbackError.message ?? rollbackError)} — manual intervention required`)
    }
    writeReport(baseline, target, failure)
    return { ok: false, baseline, target, error: failure }
  }
}

// ---- upgrade report for a future agent session ----
function writeReport(baseline, target, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(ROOT, `upgrade-report-${stamp}.md`)
  const lines = [
    '# 升级失败报告（自动生成）',
    '',
    `- 时间：${new Date().toLocaleString('zh-CN')}`,
    `- 目标 commit：\`${target}\``,
    `- 回滚锚点：\`${baseline}\``,
    `- 失败步骤：\`${error?.step ?? 'unknown'}\``,
    `- 错误信息：${String(error?.message ?? error)}`,
    '',
    '## 后续处理',
    '',
    '新开对话交给 Agent，附上本文件路径，让其按失败步骤排查后重跑 `node desktop/updater.js upgrade`。',
    '',
    '## 失败输出尾部',
    '',
    '```',
    String(error?.output ?? '').slice(-4000),
    '```',
  ]
  fs.writeFileSync(file, lines.join('\n'))
  log(`upgrade report written: ${file}`)
  return file
}

// ---- public API (used by main.js) ----
// Four-way check (v0.3.6):
//   1. self     — this desktop shell: ls-remote refs/tags/v* vs the local
//                 package.json version. Needs no GitHub API; a private repo
//                 degrades to "无法检查" on machines without credentials.
//   2. harness  — official backend (the upgradable target): branch head vs lock.
//   3. anchored — xiaobright/dsh-anchored-standard: branch head vs lock.
//   4. gitbash  — lices/dsh-gitbash-preset: branch head vs lock.
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
  return {
    name: 'self', note: entry.note, hasUpdate,
    detail: hasUpdate
      ? `v${local ? local.join('.') : '?'} → v${latest.join('.')}`
      : `v${local.join('.')}（最新）`,
  }
}

function checkUpstream(entry, name) {
  const out = lsRemote(entry.repo, `refs/heads/${entry.branch}`)
  const head = out.split(/\s+/)[0] || ''
  if (!head) throw new Error('ls-remote 返回为空')
  const locked = String(entry.lockedCommit || '')
  const hasUpdate = Boolean(locked) && head !== locked
  return {
    name, note: entry.note, hasUpdate,
    detail: hasUpdate ? `锁定 ${locked.slice(0, 8)} → 最新 ${head.slice(0, 8)}` : `与锁定 ${locked.slice(0, 8)} 一致`,
  }
}

async function checkForUpdate({ onResult, onStep } = {}) {
  const watch = (config.watch && typeof config.watch === 'object') ? config.watch : {}
  const results = []
  const checks = [
    ['self', () => checkSelf(watch.self)],
    ['harness', () => checkUpstream(watch.harness, 'harness')],
    ['anchored', () => checkUpstream(watch.anchored, 'anchored')],
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
    if (mode === 'upgrade') {
      const result = await runUpgrade({ onStep: (s) => log(s) })
      console.log(result.ok ? '[updater] UPGRADE OK' : '[updater] UPGRADE FAILED (rolled back)')
      process.exit(result.ok ? 0 : 1)
    }
    console.log('usage: node desktop/updater.js <check|upgrade>')
    process.exit(2)
  })().catch((e) => { console.error(e); process.exit(1) })
}

module.exports = { checkForUpdate, runUpgrade, remoteHead, localHead, probeSmoke }
