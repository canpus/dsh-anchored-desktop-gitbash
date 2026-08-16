// Upstream component updater (plan_v0.4.2 §6) — GUI-driven "update the
// vendored third-party presets without waiting for a new release".
//
// Snapshots live in ~/.dsh/upstream-snapshots/<component>/<commit>/ (user
// data dir, survives green-package upgrades; the bundled desktop/presets/*
// templates remain the baseline). Every update:
//   1. resolves the target commit (one-click = upstream HEAD; router =
//      the preset submodule commit pinned by the suite HEAD),
//   2. shallow-fetches that single commit (proxy-aware) into a temp dir,
//   3. collects the component's files, hashes them, writes a .manifest.json,
//   4. installs via the preset-gen installers (snapshot-first), adapted as
//      defined (anchored bashPath / gitbash shellPath),
//   5. verifies the preset actually mounts (engine RPC), then records
//      current.json; any failure keeps the previous version untouched.
// Reverts keep the last N snapshots and restore the previous one.
//
// Pure Node module (no electron imports) — testable from the CLI:
//   node desktop/upstream-update.cjs check [component]
//   node desktop/upstream-update.cjs update <component>
//   node desktop/upstream-update.cjs revert <component>
'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { COMPONENTS, ALLOWED_REPOS } = require('./component-defs.cjs')

const KEEP_SNAPSHOTS = 5

// Robust recursive remove: git repos contain READ-ONLY .git objects, and a
// plain fs.rmSync then throws EPERM on Windows (component update failed with
// "EPERM: permission denied" on the fetch temp dir, 2026-08-17). Clear the
// read-only attribute on files before removing.
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
    return
  } catch { /* fall through to attribute-clearing */ }
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) walk(f)
        else { try { fs.chmodSync(f, 0o666) } catch { /* best effort */ } }
      }
      try { fs.chmodSync(d, 0o777) } catch { /* best effort */ }
    }
    walk(p)
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
  } catch { /* best effort — leftover dirs are inert */ }
}

const snapshotsRoot = () => path.join(os.homedir(), '.dsh', 'upstream-snapshots')
const componentRoot = (id) => path.join(snapshotsRoot(), id)
const currentDir = (id) => path.join(componentRoot(id), 'current')
const currentJsonPath = (id) => path.join(componentRoot(id), 'current.json')

// ---- git ----
function findGit() {
  const env = process.env
  const candidates = []
  for (const p of [
    env.GIT_EXE,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
  ]) {
    if (p) candidates.push(p)
  }
  for (const hive of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows']) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'InstallPath'], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const m = /REG_SZ\s+(.+)/.exec(out)
      if (m) candidates.push(path.join(m[1].trim(), 'cmd', 'git.exe'))
    } catch { /* key absent */ }
  }
  candidates.push('D:\\Git\\cmd\\git.exe', 'D:\\Git\\mingw64\\bin\\git.exe')
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'git.exe'))
  }
  const seen = new Set()
  for (const p of candidates) {
    if (!p || seen.has(p.toLowerCase())) continue
    seen.add(p.toLowerCase())
    if (fs.existsSync(p)) return p
  }
  return null
}

// ---- proxy ----
// Proxy precedence: shell-config (GUI-set) → environment. 网络纪律
// (项目 AGENTS §3.5): 查询境外网站必须走代理 — an update with NO proxy at
// all is refused with a clear message instead of silently hitting GitHub
// directly (direct access fails on CN networks with opaque errors like
// "permission denied", reported 2026-08-17).
function currentProxy() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'shell-config.json'), 'utf8'))
    const p = cfg.proxy
    const parts = typeof p === 'string'
      ? { http: String(p || '').trim(), https: String(p || '').trim() }
      : (p && typeof p === 'object'
        ? { http: String(p.http || '').trim(), https: String(p.https || '').trim() }
        : {})
    if (parts.https || parts.http) return parts.https || parts.http
  } catch { /* config unreadable — fall through to env */ }
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
}

// Probe the proxy BEFORE any git operation (same discipline as releases):
// a dead or malformed proxy must fail with a readable message, not an opaque
// git error. No proxy configured at all → refuse (network discipline).
// Cached per process (5 min) — git runs many subcommands per update.
let proxyCache = { at: 0, value: null }
function requireProxy() {
  const proxy = currentProxy()
  if (!proxy) throw new Error('未配置代理：上游组件在境外（GitHub），必须走代理访问。请先在标题栏「代理设置」填写代理（如 http://127.0.0.1:10809）再更新。')
  if (proxyCache.value === proxy && Date.now() - proxyCache.at < 300000) return proxy
  execFileSync('curl.exe', ['-sS', '--max-time', '10', '-x', proxy, '-o', 'NUL', 'https://github.com'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
  })
  proxyCache = { at: Date.now(), value: proxy }
  return proxy
}

function git(args, { cwd } = {}) {
  const gitPath = findGit()
  if (!gitPath) throw new Error('未找到 git.exe（Git for Windows）——组件更新需要 Git，请安装后重试')
  const proxy = requireProxy()
  const env = { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy }
  const r = spawnSync(gitPath, args, { cwd, encoding: 'utf8', env, timeout: 240000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args[0]} 失败: ${String(r.stderr || r.stdout || '').slice(0, 400)}`)
  return r.stdout.trim()
}

// ---- state ----
function readCurrent(id) {
  try {
    const j = JSON.parse(fs.readFileSync(currentJsonPath(id), 'utf8'))
    return { commit: String(j.commit || ''), installedAt: Number(j.installedAt) || 0, history: Array.isArray(j.history) ? j.history : [] }
  } catch {
    return { commit: '', installedAt: 0, history: [] }
  }
}
function writeCurrent(id, state) {
  fs.mkdirSync(componentRoot(id), { recursive: true })
  fs.writeFileSync(currentJsonPath(id), JSON.stringify(state, null, 2) + '\n')
}
function snapshotDirOf(id, commit) {
  return path.join(componentRoot(id), commit)
}
function pruneOld(id, keep = KEEP_SNAPSHOTS) {
  try {
    const entries = fs.readdirSync(componentRoot(id)).filter((d) => /^[0-9a-f]{40}$/.test(d))
    entries.sort()
    for (const d of entries.slice(0, Math.max(0, entries.length - keep))) {
      rmrf(path.join(componentRoot(id), d))
    }
  } catch { /* best effort */ }
}

// ---- remote resolution ----
// One-click target: upstream HEAD. For router the effective commit is the
// preset submodule commit pinned by the suite HEAD (resolveSubmoduleCommit).
function remoteHead(id) {
  const comp = COMPONENTS[id]
  if (!comp) throw new Error('未知组件: ' + id)
  const suiteHead = git(['ls-remote', comp.repo, 'refs/heads/main']).split(/\s+/)[0]
  if (!suiteHead) throw new Error(`ls-remote 返回为空: ${comp.repo}`)
  return comp.submodule ? resolveSubmoduleCommit(id, suiteHead) : suiteHead
}
function resolveSubmoduleCommit(id, suiteCommit) {
  const comp = COMPONENTS[id]
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upstream-'))
  try {
    git(['init', '-q'], { cwd: tmp })
    git(['remote', 'add', 'origin', comp.repo], { cwd: tmp })
    git(['fetch', '-q', '--depth', '1', 'origin', suiteCommit], { cwd: tmp })
    git(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: tmp })
    const line = git(['ls-tree', 'HEAD', comp.submodule.path], { cwd: tmp })
    const gitlink = line.split(/\s+/)[2]
    if (!gitlink) throw new Error(`suite HEAD 未锁定子模块 ${comp.submodule.path}`)
    return gitlink
  } finally {
    rmrf(tmp)
  }
}

// ---- fetch + snapshot ----
// Collect the component's files at `targetCommit` into
// ~/.dsh/upstream-snapshots/<id>/<commit>/ (+ .manifest.json). Nothing is
// installed yet — a failed download leaves the old state fully intact.
function fetchComponentCommit(id, targetCommit) {
  const comp = COMPONENTS[id]
  if (!comp) throw new Error('未知组件: ' + id)
  if (!/^[0-9a-f]{40}$/.test(targetCommit)) throw new Error('非法 commit: ' + targetCommit)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upstream-'))
  const subTmp = comp.submodule ? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upstream-sub-')) : null
  try {
    let tree = tmp
    let snapshotCommit = targetCommit
    let suiteCommit = null
    if (comp.submodule) {
      // For router the target IS the pinned preset commit; fetch the suite
      // HEAD only to VERIFY it still pins exactly that commit (a suite that
      // moved its lock must not silently install a mismatched preset).
      const suiteHead = git(['ls-remote', comp.repo, 'refs/heads/main']).split(/\s+/)[0]
      if (!suiteHead) throw new Error(`ls-remote 返回为空: ${comp.repo}`)
      git(['init', '-q'], { cwd: tmp })
      git(['remote', 'add', 'origin', comp.repo], { cwd: tmp })
      git(['fetch', '-q', '--depth', '1', 'origin', suiteHead], { cwd: tmp })
      git(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: tmp })
      const gitlink = git(['ls-tree', 'HEAD', comp.submodule.path], { cwd: tmp }).split(/\s+/)[2]
      if (!gitlink || gitlink !== targetCommit) {
        throw new Error(`suite HEAD 锁定的预设为 ${gitlink ? gitlink.slice(0, 8) : '?'}，目标 ${targetCommit.slice(0, 8)} 不一致——拒绝`)
      }
      suiteCommit = suiteHead
      snapshotCommit = gitlink
      git(['init', '-q'], { cwd: subTmp })
      git(['remote', 'add', 'origin', comp.submodule.repo], { cwd: subTmp })
      git(['fetch', '-q', '--depth', '1', 'origin', gitlink], { cwd: subTmp })
      git(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: subTmp })
      tree = subTmp
    } else {
      git(['init', '-q'], { cwd: tmp })
      git(['remote', 'add', 'origin', comp.repo], { cwd: tmp })
      git(['fetch', '-q', '--depth', '1', 'origin', targetCommit], { cwd: tmp })
      git(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: tmp })
    }
    const files = comp.submodule ? comp.submodule.files : comp.files
    const snapshot = snapshotDirOf(id, snapshotCommit)
    rmrf(snapshot)
    fs.mkdirSync(snapshot, { recursive: true })
    const hashes = {}
    for (const { src, name } of files) {
      const from = path.join(tree, src)
      if (!fs.existsSync(from)) throw new Error(`上游文件缺失: ${src}`)
      const buf = fs.readFileSync(from)
      fs.copyFileSync(from, path.join(snapshot, name))
      hashes[name] = crypto.createHash('sha256').update(buf).digest('hex')
    }
    fs.writeFileSync(path.join(snapshot, '.manifest.json'), JSON.stringify({
      upstream: comp.repo,
      ...(comp.submodule ? { suiteCommit, presetCommit: snapshotCommit } : { commit: snapshotCommit }),
      note: comp.manifestNote,
      adaptedFields: comp.adapter === 'anchored-bashPath' ? ['agent.cordis.yml:bashPath']
        : comp.adapter === 'gitbash-shellPath' ? ['agent.cordis.yml:shellPath']
        : [],
      files: hashes,
    }, null, 2) + '\n')
    return { id, commit: snapshotCommit, suiteCommit, snapshot, fileCount: Object.keys(hashes).length }
  } finally {
    rmrf(tmp)
    if (subTmp) rmrf(subTmp)
  }
}

// ---- install from the current snapshot (preset-gen installers, snapshot-first) ----
function installFromSnapshot(id) {
  const comp = COMPONENTS[id]
  const snapshot = currentDir(id)
  if (!fs.existsSync(path.join(snapshot, '.manifest.json'))) {
    throw new Error(`组件 ${id} 没有可用快照（先执行更新）`)
  }
  const { installAnchoredPreset, installRouterPreset, installMinimalGitbash } = require('./preset-gen.cjs')
  if (id === 'anchored-standard') return installAnchoredPreset({ templateDir: snapshot })
  if (id === 'router-standard') return installRouterPreset({ templateDir: snapshot })
  if (id === 'minimal-gitbash') return installMinimalGitbash({ templateDir: snapshot })
  throw new Error('未知组件: ' + id)
}

// ---- verification ----
// agentPreset.list is enumerated at ENGINE START (measured: a preset
// installed while the engine runs does not appear until a restart), so a
// runtime install can never be verified against the live list. The updater
// therefore verifies FILES here and returns a mounted state; the GUI layer
// restarts the backend and re-checks the list (auto-revert on failure).
function verifyFiles(id) {
  const installed = path.join(os.homedir(), '.dsh', '.agent-presets', id)
  if (!fs.existsSync(path.join(installed, 'agent.cordis.yml'))) return false
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(currentDir(id), '.manifest.json'), 'utf8'))
    const adapted = new Set(manifest.adaptedFields || [])
    for (const [name, want] of Object.entries(manifest.files || {})) {
      const p = path.join(installed, name)
      if (!fs.existsSync(p)) return false
      if (adapted.has(`${name}:bashPath`) || adapted.has(`${name}:shellPath`)) {
        // The file is adapted at install (machine path) — presence + non-empty
        // is the contract; the pristine hash lives in the snapshot itself.
        if (fs.readFileSync(p, 'utf8').trim().length === 0) return false
        continue
      }
      const got = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      if (got !== want) return false
    }
    return true
  } catch {
    return false
  }
}
function rpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.DSH_PORT) || 3080
    const body = JSON.stringify({ type: 'client-request', rpcId: 'cu-' + Math.random().toString(36).slice(2), method, payload })
    const req = http.request({
      host: '127.0.0.1', port, path: `/api/${method}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 8000,
    }, (res) => {
      let t = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { t += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(t)
          j.result && j.result.ok ? resolve(j.result.value) : reject(new Error((j.result?.error?.message) || 'rpc fail'))
        } catch { reject(new Error('bad rpc response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}
async function mountedState(id) {
  try {
    const list = await rpc('agentPreset.list')
    return (list.presets || []).some((p) => p.id === id)
  } catch {
    return null // engine unreachable — caller decides
  }
}

// Install from the bundled template (baseline — used when no snapshot exists).
function installFromTemplate(id) {
  const { installAnchoredPreset, installRouterPreset, installMinimalGitbash } = require('./preset-gen.cjs')
  if (id === 'anchored-standard') return installAnchoredPreset({ desktopDir: __dirname })
  if (id === 'router-standard') return installRouterPreset({ desktopDir: __dirname })
  if (id === 'minimal-gitbash') return installMinimalGitbash({ desktopDir: __dirname })
  throw new Error('未知组件: ' + id)
}

// Roll back to a previous state (used by update failure paths).
async function rollbackTo(id, state) {
  writeCurrent(id, state)
  rmrf(currentDir(id))
  if (state.commit && fs.existsSync(snapshotDirOf(id, state.commit))) {
    fs.cpSync(snapshotDirOf(id, state.commit), currentDir(id), { recursive: true })
    installFromSnapshot(id)
  } else {
    installFromTemplate(id)
  }
}

// ---- public ops ----
async function updateComponent(id, { onStep } = {}) {
  const comp = COMPONENTS[id]
  if (!comp) throw new Error('未知组件: ' + id)
  const cur = readCurrent(id)
  const target = remoteHead(id)
  if (cur.commit === target) {
    return { ok: true, id, commit: target, alreadyUpToDate: true, mounted: null }
  }
  onStep?.('下载上游快照（' + target.slice(0, 8) + '）…')
  const fetched = fetchComponentCommit(id, target)
  // Promote the fetched snapshot to current ONLY after install + file verify.
  const next = { commit: fetched.commit, installedAt: Date.now(), history: cur.commit ? [...cur.history, { commit: cur.commit, installedAt: cur.installedAt }].slice(-KEEP_SNAPSHOTS) : [] }
  writeCurrent(id, next)
  rmrf(currentDir(id))
  fs.cpSync(snapshotDirOf(id, fetched.commit), currentDir(id), { recursive: true })
  onStep?.('安装到 ~/.dsh/.agent-presets …')
  let installed
  try {
    installed = installFromSnapshot(id)
    if (!verifyFiles(id)) throw new Error('安装文件校验失败')
  } catch (e) {
    await rollbackTo(id, cur).catch(() => {})
    throw new Error('组件安装失败（' + String((e && e.message) || e) + '），已回退到上一版')
  }
  const mounted = await mountedState(id)
  if (mounted === true) {
    pruneOld(id)
    return { ok: true, id, commit: fetched.commit, suiteCommit: fetched.suiteCommit, mounted: true, adapted: installed.adapted }
  }
  // Engine either unreachable (null) or has not re-enumerated the preset
  // (false — needs a backend restart to appear). The GUI layer restarts the
  // backend, re-checks the list, and reverts on failure.
  pruneOld(id)
  return {
    ok: true, id, commit: fetched.commit, suiteCommit: fetched.suiteCommit,
    mounted: mounted === true, restartRequired: true, adapted: installed.adapted,
  }
}

async function revertComponent(id) {
  const comp = COMPONENTS[id]
  if (!comp) throw new Error('未知组件: ' + id)
  const cur = readCurrent(id)
  if (cur.history.length === 0) throw new Error(`组件 ${id} 没有可回退的上一版`)
  const prev = cur.history[cur.history.length - 1]
  if (!fs.existsSync(snapshotDirOf(id, prev.commit))) throw new Error(`上一版快照 ${prev.commit.slice(0, 8)} 已不存在，无法回退`)
  const target = { commit: prev.commit, installedAt: Date.now(), history: cur.history.slice(0, -1) }
  await rollbackTo(id, target)
  const mounted = await mountedState(id)
  return { ok: true, id, commit: prev.commit, mounted: mounted === true, restartRequired: mounted === false }
}

function componentStatus(id) {
  const comp = COMPONENTS[id]
  const cur = readCurrent(id)
  let remote = null
  let remoteError = null
  try {
    remote = remoteHead(id)
  } catch (e) {
    remoteError = String((e && e.message) || e)
  }
  return {
    id,
    label: comp.label,
    currentCommit: cur.commit || null,
    installedAt: cur.installedAt || null,
    hasSnapshot: fs.existsSync(currentDir(id)),
    canRevert: cur.history.length > 0,
    remoteCommit: remote,
    remoteError,
    hasUpdate: Boolean(remote) && remote !== cur.commit,
  }
}

// ---- CLI ----
if (require.main === module) {
  const [, , mode, arg] = process.argv
  ;(async () => {
    if (mode === 'check') {
      const ids = arg ? [arg] : Object.keys(COMPONENTS)
      for (const id of ids) {
        const s = componentStatus(id)
        console.log(`[${id}] 当前=${s.currentCommit ? s.currentCommit.slice(0, 8) : '（基线/未安装）'}${s.installedAt ? ' @' + new Date(s.installedAt).toISOString().slice(0, 16) : ''}`)
        if (s.remoteError) console.log(`        远端=${s.remoteError}`)
        else console.log(`        远端=${s.remoteCommit.slice(0, 8)} ${s.hasUpdate ? '→ 有更新' : '（最新）'} 回退=${s.canRevert ? '可用' : '无'}`)
      }
      return
    }
    if (mode === 'update') {
      if (!arg) { console.error('usage: node desktop/upstream-update.cjs update <component>'); process.exit(2) }
      const r = await updateComponent(arg, { onStep: (s) => console.log('  ' + s) })
      console.log(r.alreadyUpToDate ? `[${arg}] 已是最新 ${r.commit.slice(0, 8)}` : `[${arg}] 已更新到 ${r.commit.slice(0, 8)}${r.suiteCommit ? '（suite ' + r.suiteCommit.slice(0, 8) + '）' : ''} mounted=${r.mounted}`)
      return
    }
    if (mode === 'revert') {
      if (!arg) { console.error('usage: node desktop/upstream-update.cjs revert <component>'); process.exit(2) }
      const r = await revertComponent(arg)
      console.log(`[${arg}] 已回退到 ${r.commit.slice(0, 8)} mounted=${r.mounted}`)
      return
    }
    console.error('usage: node desktop/upstream-update.cjs check|update|revert [component]')
    process.exit(2)
  })().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1) })
}

module.exports = { COMPONENTS, findGit, currentProxy, remoteHead, fetchComponentCommit, updateComponent, revertComponent, componentStatus }
