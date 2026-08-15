// Stage 3 thin shell — spawn the official `dsh web` child process, open a
// frameless window with a custom titlebar (double WebContentsView, zero
// contact with the web page), a tray menu, and a smoke mode.
// Shell interface parameters live in shell-config.json (auto-adapted by the
// updater), never hard-coded here.
'use strict'

const {
  app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, nativeImage, dialog,
  Notification, globalShortcut, shell: electronShell, nativeTheme,
} = require('electron')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const log = (...args) => console.log(`[desktop ${(Date.now() / 1000).toFixed(1)}s]`, ...args)

// ---- shell interface config (auto-adapted by updater, see shell-config.json) ----
const CONFIG_PATH = path.join(__dirname, 'shell-config.json')
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  return JSON.parse(raw)
}
const config = loadConfig()
const REPO = path.resolve(__dirname, config.repoPath)
const PORT = config.port
const READY = config.ready || { path: '/', status: 200 }

// ---- smoke mode: auto-quit after DSH_DESKTOP_SMOKE ms (0 = persistent) ----
const SMOKE_MS = Number(process.env.DSH_DESKTOP_SMOKE) || 0

// ---- close-path test: after readiness, exercise win.close() — the exact
// window-X path — and expect the process to exit on its own (0 = disabled) ----
const CLOSE_TEST_MS = Number(process.env.DSH_DESKTOP_CLOSE_TEST) || 0

// ---- test isolation: DSH_USER_DATA overrides the Electron userData dir (and
// with it the single-instance lock scope) so automated runs never fight a live
// user instance for the lock ----
if (process.env.DSH_USER_DATA) {
  app.setPath('userData', process.env.DSH_USER_DATA)
}

// ---- single instance (with retry: a relaunched instance may start while the
// old one is still releasing the lock after app.quit()) ----
const LOCK_RETRIES = 5
let lockAttempts = LOCK_RETRIES
function tryAcquireLock() {
  if (app.requestSingleInstanceLock()) {
    app.on('second-instance', () => {
      if (win) { win.show(); win.focus() }
    })
    app.whenReady().then(main)
    return
  }
  lockAttempts -= 1
  if (lockAttempts > 0) {
    log(`single-instance lock busy, retrying (${LOCK_RETRIES - lockAttempts}/${LOCK_RETRIES - 1})`)
    setTimeout(tryAcquireLock, 1000)
    return
  }
  log('another instance holds the lock, quitting')
  app.quit()
}
tryAcquireLock()

// ---- state ----
let win = null
let mainView = null
let titlebarView = null
let tray = null
let child = null
let quitting = false
const TITLEBAR_H = 36

// ---- harness child process ----
// proxy 现在是 { http, https } 对象（v0.3.6 起；兼容旧的单字符串：双协议同值）。
// https 未填时回退 http 的值；两者皆空 = 直连。
function proxyParts() {
  const p = config.proxy
  if (typeof p === 'string') {
    const v = String(p || '').trim()
    return { http: v, https: v }
  }
  const o = (p && typeof p === 'object') ? p : {}
  return { http: String(o.http || '').trim(), https: String(o.https || '').trim() }
}

function harnessEnv() {
  // Proxy for the backend comes from shell-config.json (标题栏「代理设置」writes
  // it; empty = direct). Injected at spawn time — restart applies changes.
  const { http: httpProxy, https: httpsProxy } = proxyParts()
  const httpsEffective = httpsProxy || httpProxy
  if (!httpProxy && !httpsProxy) return process.env
  return {
    ...process.env,
    ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    ...(httpsEffective ? { HTTPS_PROXY: httpsEffective } : {}),
    NO_PROXY: 'localhost,127.0.0.1',
  }
}

// The green package bundles node.exe next to the shell so the zip runs without
// a system Node install; dev checkouts keep resolving `node` from PATH.
function resolveNode() {
  const bundled = path.join(__dirname, 'node.exe')
  return fs.existsSync(bundled) ? bundled : 'node'
}

function startHarness() {
  const [cmd, ...baseArgs] = config.startCommand
  const args = [...baseArgs]
  const bin = cmd === 'node' ? resolveNode() : cmd
  const patchPath = config.modelPatch ? path.resolve(__dirname, config.modelPatch) : null
  if (patchPath && fs.existsSync(patchPath)) {
    // --patch is a launcher flag: it must precede the web app's inner args
    // (anything after the first unrecognized token is handed to the app).
    const modeIdx = args.indexOf('web')
    if (modeIdx !== -1) args.splice(modeIdx + 1, 0, '--patch', patchPath)
    else args.push('--patch', patchPath)
  }
  const proxyOn = String(config.proxy || '').trim() !== ''
  log(`spawning harness: ${bin} ${args.join(' ')} (cwd ${REPO}, proxy ${proxyOn ? 'configured' : 'direct'})`)
  child = spawn(bin, args, {
    cwd: REPO,
    windowsHide: true, // no console window
    stdio: ['ignore', 'pipe', 'pipe'],
    env: harnessEnv(),
  })
  const myChild = child
  myChild.stdout.on('data', (d) => process.stdout.write(`[dsh] ${d}`))
  myChild.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`))
  myChild.on('exit', (code, signal) => {
    log(`harness child exited code=${code} signal=${signal}`)
    // Closure capture: a restarted backend spawns a NEW child object; a stale
    // exit event from the killed predecessor must not tear down the new one.
    if (child !== myChild) return
    child = null
    if (!quitting) {
      // Harness died unexpectedly: tear the window down with it.
      log('harness exited unexpectedly, closing window')
      if (win) win.destroy()
      app.quit()
    }
  })
}

function killHarness() {
  if (!child) return
  const proc = child
  const pid = proc.pid
  child = null // detach first: the async exit event then reads as normal shutdown
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
  } catch {
    // Tree kill failed — at least kill the direct child handle.
    try { proc.kill() } catch { /* already gone */ }
  }
  // Verify, never silently: a surviving backend is exactly the "ghost on
  // 127.0.0.1:3080" failure mode observed live.
  try {
    const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { windowsHide: true, encoding: 'utf8' })
    if (check.status === 0 && check.stdout.includes(String(pid))) {
      log(`WARNING: harness pid ${pid} survived killHarness — ghost backend on :${PORT}`)
    }
  } catch { /* diagnostic only */ }
}

// ---- readiness probe: HTTP status + optional <title> substring ----
// The alive check guards against a false positive when a stray instance of
// the web server already listens on the port (our own child died on EADDRINUSE
// while the probe would otherwise read the stranger's HTTP 200 as ready).
function probeReady(timeoutMs, isChildAlive) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`readiness timeout: no HTTP ${READY.status} on :${PORT}${READY.path}`))
        return
      }
      if (!isChildAlive()) {
        clearInterval(timer)
        reject(new Error('harness process died before readiness (port already taken?)'))
        return
      }
      const req = http.get({ host: '127.0.0.1', port: PORT, path: READY.path, timeout: 2000 }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
          if (body.length > 40000) res.destroy()
        })
        res.on('end', () => {
          const titleMatch = body.match(/<title>([^<]*)<\/title>/i)
          const title = titleMatch ? titleMatch[1].trim() : ''
          const titleOk = !READY.titleContains || title.includes(READY.titleContains)
          if (res.statusCode === READY.status && titleOk) {
            clearInterval(timer)
            resolve({ status: res.statusCode, title })
          }
        })
      })
      req.on('error', () => { /* not ready yet */ })
      req.on('timeout', () => req.destroy())
    }, 500)
  })
}

// ---- window ----
function layoutViews() {
  if (!win) return
  const [w, h] = win.getContentSize()
  titlebarView.setBounds({ x: 0, y: 0, width: w, height: TITLEBAR_H })
  mainView.setBounds({ x: 0, y: TITLEBAR_H, width: w, height: Math.max(0, h - TITLEBAR_H) })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1e293b', symbolColor: '#e2e8f0', height: TITLEBAR_H },
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Show immediately: the window's own webContents stays blank (the UI lives
    // in mainView), so 'ready-to-show' may never fire and delay the window.
    show: true,
  })
  win.on('resize', layoutViews)
  win.on('closed', () => {
    win = null
    mainView = null
    titlebarView = null
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      shutdown()
    }
  })

  titlebarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'titlebar-preload.js'), contextIsolation: true },
  })
  mainView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'main-preload.js'),
    },
  })
  mainView.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('PRELOAD ERROR:', preloadPath, String(error && error.message || error))
  })
  mainView.webContents.on('did-finish-load', () => {
    injectMainWorldScript()
    if (initialZoom !== 0) mainView.webContents.setZoomLevel(initialZoom)
  })
  win.contentView.addChildView(titlebarView)
  win.contentView.addChildView(mainView)
  layoutViews()

  titlebarView.webContents.loadFile(path.join(__dirname, 'titlebar.html'))
  titlebarView.webContents.on('did-finish-load', () => pushTheme(titlebarView.webContents))
  mainView.webContents.loadURL(`http://127.0.0.1:${PORT}${READY.path}`)
  installContextMenu()
}

// ---- tray ----
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png')
  let icon = null
  try { icon = nativeImage.createFromPath(iconPath) } catch { icon = null }
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.on('click', () => {
    if (win) { win.show(); win.focus() }
  })
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => { if (win) { win.show(); win.focus() } } },
    { type: 'separator' },
    { label: '模式切换', click: () => onShellAction('subagent-model') },
    { label: '导出对话 PDF', click: () => openExportDialog() },
    { label: '检查更新', click: () => onShellAction('check-update') },
    { label: '代理设置', click: () => openProxyDialog() },
    { type: 'separator' },
    {
      label: '完成通知',
      type: 'checkbox',
      checked: config.notifyOnSettle !== false,
      click: (item) => {
        config.notifyOnSettle = item.checked
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => shutdown() },
  ]))
}

// ---- titlebar button actions ----
function onShellAction(action) {
  switch (action) {
    case 'subagent-model':
      openModelDialog()
      break
    case 'check-update':
      checkUpdateInteractive()
      break
    case 'export-pdf':
      openExportDialog()
      break
    case 'proxy':
      openProxyDialog()
      break
    case 'font-minus':
      adjustZoom(-0.5)
      break
    case 'font-plus':
      adjustZoom(0.5)
      break
    case 'restart':
      restart()
      break
    default:
      break
  }
}

// ---- HTTP RPC helper (talks to the official web server on 127.0.0.1) ----
function httpRpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: `shell-${Date.now()}-${method}`, method, payload })
    const req = http.request({
      host: '127.0.0.1',
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
        } catch {
          reject(new Error(`RPC ${method}: bad response: ${text.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}

// ---- zoom (Ctrl+wheel / Ctrl+=/-/0 forwarded by the main-view preload;
// persisted in shell-state.json so the font size survives restarts) ----
const STATE_PATH = path.join(__dirname, 'shell-state.json')
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function persistZoom(level) {
  try {
    const st = loadState()
    st.zoomLevel = level
    fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n')
  } catch (e) { log('zoom persist failed:', String(e)) }
}
const initialZoom = Number(loadState().zoomLevel) || 0

function adjustZoom(dir) {
  if (!mainView || mainView.webContents.isDestroyed()) return
  const level = Math.max(-3, Math.min(5, (mainView.webContents.getZoomLevel() || 0) + (dir > 0 ? 0.5 : -0.5)))
  mainView.webContents.setZoomLevel(level)
  persistZoom(level)
}
ipcMain.on('zoom-delta', (_e, dir) => adjustZoom(dir))
ipcMain.on('zoom-reset', () => {
  if (mainView && !mainView.webContents.isDestroyed()) mainView.webContents.setZoomLevel(0)
  persistZoom(0)
})

// ---- export a FULL conversation as PDF (session.history → HTML → printToPDF) ----
let exportDialog = null

function openExportDialog() {
  if (exportDialog) {
    exportDialog.focus()
    return
  }
  exportDialog = new BrowserWindow({
    width: 560,
    height: 480,
    frame: false,
    resizable: false,
    backgroundColor: '#0f172a',
    parent: win || undefined,
    webPreferences: { preload: path.join(__dirname, 'export-preload.js'), contextIsolation: true },
  })
  exportDialog.loadFile(path.join(__dirname, 'export-dialog.html'))
  exportDialog.webContents.on('did-finish-load', () => pushTheme(exportDialog.webContents))
  exportDialog.on('closed', () => {
    exportDialog = null
    if (win && !win.isDestroyed()) win.focus()
  })
}

ipcMain.handle('export-dialog:get-sessions', async (_e, { includeHistory = false } = {}) => {
  const [sl, wl] = await Promise.all([httpRpc('session.list'), httpRpc('workspace.list')])
  const items = sl.items || []
  const archived = new Set(wl.archivedSessionIds || [])
  // The session projection carries no workspaceId; workspace.list maps each
  // workspace to its sessionIds. "Current workspace" = the one holding the
  // most recently updated non-archived session (exact with one workspace).
  let currentIds = null
  let best = -1
  for (const w of wl.items || []) {
    const ids = w.sessionIds || []
    const recent = Math.max(0, ...ids.map((id) => {
      const s = items.find((x) => x.sessionId === id)
      return s ? (s.updatedAt || 0) : 0
    }))
    if (recent > best) { best = recent; currentIds = new Set(ids) }
  }
  const inCurrent = (s) => currentIds === null || currentIds.has(s.sessionId)
  const sessions = items
    .filter((s) => !s.blank && !s.parentSessionId && s.origin !== 'subagent')
    .filter((s) => inCurrent(s) && (includeHistory || !archived.has(s.sessionId)))
    .map((s) => ({
      sessionId: s.sessionId,
      title: (s.projections && s.projections.values && s.projections.values.title) || '未命名会话',
      updatedAt: s.updatedAt || 0,
      archived: archived.has(s.sessionId),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions, historyCount: archived.size }
})

function escapeHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function fetchFullHistory(sessionId) {
  const events = []
  const seen = new Set()
  let beforeSeq
  for (let i = 0; i < 500; i++) {
    const payload = { sessionId, maxMessages: 100 }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const v = await httpRpc('session.history', payload)
    const page = v.events || []
    if (page.length === 0) break
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
    // Page boundaries align to whole messages: the SMALLEST seq in the page is
    // the only cursor that advances (the largest one re-yields the same page).
    if (beforeSeq !== undefined && minSeq >= beforeSeq) break // no-progress guard
    beforeSeq = minSeq
    if (added === 0) break
  }
  return events
}

function renderHistoryHtml(title, events) {
  const rows = []
  for (const { event } of events) {
    if (!event || typeof event.type !== 'string' || !event.type.endsWith('/message')) continue
    const data = event.data || {}
    // user/message carries data.content; assistant/message carries
    // data.message.content (asymmetric — reading only data.content dropped
    // every assistant reply from the export).
    const rawContent = Array.isArray(data.content) ? data.content
      : data.message && Array.isArray(data.message.content) ? data.message.content
      : []
    const text = rawContent
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    if (!text) continue
    const role = (data.role || (data.message && data.message.role)) === 'user' ? '用户' : '助手'
    const time = new Date(event.time).toLocaleString('zh-CN', { hour12: false })
    rows.push(`<div class="msg ${role === '用户' ? 'user' : 'assistant'}"><div class="head">${role} · ${time}</div><pre>${escapeHtml(text)}</pre></div>`)
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;margin:24px;color:#111}h1{font-size:20px}
.msg{margin:12px 0;border:1px solid #ddd;border-radius:8px;padding:10px 14px}
.msg.user{background:#eef4ff}.msg.assistant{background:#f6f6f6}
.head{font-size:12px;color:#666;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;line-height:1.6;margin:0}
</style></head><body><h1>${escapeHtml(title)}</h1>${rows.join('\n')}</body></html>`
}

async function exportConversationPdf(sessionId, title) {
  const events = await fetchFullHistory(sessionId)
  if (events.length === 0) throw new Error('该会话没有可导出的消息')
  const html = renderHistoryHtml(title, events)
  const pdfWin = new BrowserWindow({ show: false, width: 900, height: 1200 })
  await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const data = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
  pdfWin.destroy()
  return data
}

ipcMain.handle('export-dialog:export', async (_e, { sessionId, title }) => {
  const data = await exportConversationPdf(sessionId, title)
  const { canceled, filePath } = await dialog.showSaveDialog(exportDialog || win, {
    title: '导出对话 PDF',
    defaultPath: `${String(title).replace(/[\\/:*?"<>|]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return { ok: true, canceled: true }
  fs.writeFileSync(filePath, data)
  return { ok: true, filePath }
})

// ---- notifications: poll session state; fire when a running session or
// subagent settles. Approval events are NOT in the official forwarded-event
// whitelist, so approvals cannot notify without DOM probing (out of scope).
let notifySeen = new Set()
async function pollNotifications() {
  if (quitting) return
  try {
    const sl = await httpRpc('session.list')
    for (const s of sl.items || []) {
      if (s.running === false && notifySeen.has(s.sessionId)) {
        notifySeen.delete(s.sessionId)
        if (config.notifyOnSettle === false) continue
        const body = s.parentSessionId ? '子 Agent 已完成' : '会话执行完成'
        if (Notification.isSupported()) {
          new Notification({ title: 'DeepSeek Harness', body }).show()
        }
      } else if (s.running === true) {
        notifySeen.add(s.sessionId)
      }
    }
  } catch { /* backend busy or gone */ }
  setTimeout(pollNotifications, 8000)
}

// ---- "子 Agent 模型" dialog: one dynamic user preset `fc-child` + the
// official default-preset switch, all driven from the shell (the official
// per-session switcher UI is disabled via --patch).
const os = require('node:os')
const { generateFcChild, installRouterPreset, installMinimalGitbash, fcChildDir } = require('./preset-gen.cjs')

// Generate the ONE user preset `fc-child` (display name「自定义子模型」) from
// the bundled anchored-standard template with the child-model agentOptions
// injected — re-applying a model re-derives everything from the current
// template (upstream xiaobright/dsh-anchored-standard).
function writeFcChild(modelId) {
  generateFcChild(modelId, { desktopDir: __dirname })
}

function readFcChildModel() {
  try {
    const text = fs.readFileSync(path.join(fcChildDir(), 'agent.cordis.yml'), 'utf8')
    const m = text.match(/agentOptions:\s*\n\s+model:\s*(\S+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

async function restartHarness() {
  log('restarting harness backend…')
  killHarness()
  startHarness()
  const ready = await probeReady(60000, () => child !== null && child.exitCode === null && child.signalCode === null)
  log(`harness restarted, http ${ready.status}, title "${ready.title}"`)
  if (mainView) mainView.webContents.reload()
}

let modelDialog = null

function openModelDialog() {
  if (modelDialog) {
    modelDialog.focus()
    return
  }
  modelDialog = new BrowserWindow({
    width: 640,
    height: 620,
    frame: false,
    resizable: false,
    backgroundColor: '#0f172a',
    parent: win || undefined,
    webPreferences: { preload: path.join(__dirname, 'model-preload.js'), contextIsolation: true },
  })
  modelDialog.loadFile(path.join(__dirname, 'model-dialog.html'))
  modelDialog.webContents.on('did-finish-load', () => pushTheme(modelDialog.webContents))
  modelDialog.on('closed', () => {
    modelDialog = null
    if (win && !win.isDestroyed()) win.focus() // pull the main window back to front
  })
}

ipcMain.handle('model-dialog:get-data', async () => {
  const [catalog, presets] = await Promise.all([
    httpRpc('llm.models'),
    httpRpc('agentPreset.list'),
  ])
  const groups = (catalog.groups || []).map((g) => ({
    provider: g.name || g.id,
    models: (g.models || []).map((m) => ({
      id: typeof m === 'string' ? m : (m.id || m.model),
      chat: modelChatCapable(m),
    })).filter((m) => m.id),
  }))
  // Hide legacy fc-* presets from earlier iterations (their directories stay
  // on disk because live sessions still reference them in their headers), and
  // the third-party router/gitbash presets — the picker shows the official
  // four modes plus 自定义子模型 only (user request, v0.3.5).
  const LEGACY_FC = /^fc-(?!child$)/
  const HIDDEN_PRESETS = new Set(['minimal-gitbash', 'router-standard'])
  return {
    groups,
    presets: (presets.presets || []).filter((p) => !LEGACY_FC.test(p.id) && !HIDDEN_PRESETS.has(p.id)),
    currentModel: readFcChildModel(),
  }
})

// Switch the global DEFAULT preset (official hot-reload, no restart).
// Choosing fc-child materializes it once so the model picker has a target.
// Blank sessions are re-pointed too: the official "New Session" reuses a
// blank session whose header still names the preset it was created with, so
// without this sync a fresh conversation can land on a stale legacy preset
// (observed live: default fc-child but the new session ran fc-pro).
async function syncBlankSessionsTo(agentPreset) {
  try {
    const sl = await httpRpc('session.list')
    for (const s of sl.items || []) {
      if (!s.blank || s.parentSessionId || s.agentPreset === agentPreset) continue
      try {
        await httpRpc('agentPreset.select', { sessionId: s.sessionId, agentPreset })
      } catch {
        // individual blanks may refuse (resume quirks) — never block the switch
      }
    }
  } catch { /* backend busy or gone */ }
}

ipcMain.handle('model-dialog:set-default', async (_e, { agentPreset }) => {
  if (agentPreset === 'fc-child' && readFcChildModel() === null) {
    // Materialize fc-child with a sensible child model. The apply path gates
    // with isChatModel, but a direct default switch reaches here first — pick
    // the first CHAT-capable model instead of whatever the catalog lists first
    // (the first group may be ASR/TTS-only).
    const catalog = await httpRpc('llm.models')
    let fallback = null
    for (const g of catalog.groups || []) {
      for (const m of g.models || []) {
        if (modelChatCapable(m)) {
          fallback = typeof m === 'string' ? m : (m.id || m.model)
          break
        }
      }
      if (fallback) break
    }
    writeFcChild(fallback || 'deepseek-v4-flash')
  }
  if (agentPreset === 'router-standard') installRouterPreset({ desktopDir: __dirname })
  if (agentPreset === 'minimal-gitbash') installMinimalGitbash({ desktopDir: __dirname })
  await httpRpc('settings.update', { ns: 'agent-presets', patch: { default: agentPreset } })
  await syncBlankSessionsTo(agentPreset)
  return { ok: true }
})

// Draft-commit apply: the dialog only STAGES changes; this single handler
// commits them (close-without-apply discards everything).
//   enableFc=true  → confirm dialog (restart warning) → rewrite fc-child +
//                    default=fc-child → restart backend.
//   enableFc=false → default=presetId (official hot-reload, no restart).
ipcMain.handle('model-dialog:apply', async (_e, { enableFc, modelId, presetId }) => {
  if (!enableFc) {
    if (presetId === 'router-standard') installRouterPreset({ desktopDir: __dirname })
    if (presetId === 'minimal-gitbash') installMinimalGitbash({ desktopDir: __dirname })
    await httpRpc('settings.update', { ns: 'agent-presets', patch: { default: presetId || 'standard' } })
    await syncBlankSessionsTo(presetId || 'standard')
    return { ok: true }
  }
  if (!modelId) throw new Error('未选择模型')
  // Second gate: never let a non-text model (ASR/TTS/voice) become the child.
  if (!(await isChatModel(modelId))) {
    throw new Error(`「${modelId}」不是文本推理模型，不能作为子 Agent 模型`)
  }
  const busy = await countRunningSessions()
  const message = busy > 0
    ? `即将启用「自定义子模型」并将子模型切换为 ${modelId}。\n\n⚠ 此操作会重启后端；当前有 ${busy} 个活跃对话，重启会中断它们（思考/执行/回复中的任务会丢失）！`
    : `即将启用「自定义子模型」并将子模型切换为 ${modelId}。\n\n⚠ 此操作会重启后端（约半分钟）；当前没有活跃对话。`
  const choice = await showShellDialog({
    title: '重启后端确认',
    message,
    buttons: ['确认重启并切换', '取消'],
    danger: busy > 0,
  })
  if (choice !== 0) return { ok: false, canceled: true }
  // Confirmed: tell the dialog to show the committing stage before the
  // long backend restart blocks the IPC roundtrip.
  if (modelDialog && !modelDialog.isDestroyed()) {
    modelDialog.webContents.send('apply-stage', 'committing')
  }
  writeFcChild(modelId)
  await httpRpc('settings.update', { ns: 'agent-presets', patch: { default: 'fc-child' } })
  await syncBlankSessionsTo('fc-child')
  await restartHarness()
  return { ok: true }
})

ipcMain.handle('model-dialog:copy', async (_e, { from, name }) => {
  const value = await httpRpc('agentPreset.copy', {
    from,
    agentPreset: `custom-${Date.now().toString(36)}`,
    name,
  })
  return { agentPreset: value.agentPreset }
})

ipcMain.handle('model-dialog:remove', async (_e, { agentPreset }) => {
  await httpRpc('agentPreset.remove', { agentPreset })
  return { ok: true }
})

ipcMain.handle('model-dialog:open-document', async (_e, { agentPreset, trust }) => {
  // Official RPC agentPreset.openDocument rejects system presets ("cannot be
  // written: it ships with the deployment") — open the file locally instead.
  const p = trust === 'system'
    ? path.join(REPO, 'apps', 'cli', 'config', 'agent-presets', agentPreset, 'agent.cordis.yml')
    : path.join(os.homedir(), '.dsh', '.agent-presets', agentPreset, 'agent.cordis.yml')
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`)
  await electronShell.openPath(p)
  return { ok: true }
})

// Non-text models (ASR/TTS/voice) must never be picked as the child model.
// Official chat models carry a `reasoning` field; heuristic keyword net on
// top catches voice-class ids even if some provider declares reasoning.
const ASR_TTS_RE = /(^|[-_. ])(asr|tts|whisper|voice|speech|audio|sound)([-_. ]|$)/i

function modelChatCapable(m) {
  const id = typeof m === 'string' ? m : (m.id || m.model || '')
  const name = typeof m === 'object' ? (m.name || '') : ''
  const hasReasoning = typeof m === 'object' && m.reasoning !== undefined
  return hasReasoning && !ASR_TTS_RE.test(String(id)) && !ASR_TTS_RE.test(String(name))
}

async function isChatModel(modelId) {
  const catalog = await httpRpc('llm.models')
  for (const g of catalog.groups || []) {
    for (const m of g.models || []) {
      const id = typeof m === 'string' ? m : (m.id || m.model)
      if (id === modelId) return modelChatCapable(m)
    }
  }
  return false
}

// ---- theme follow: read the official page's actual light/dark state ----
function readThemePreference() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.dsh', 'settings.yaml'), 'utf8')
    const m = text.match(/ui-theme:\s*\n\s*preference:\s*(\w+)/)
    return m ? m[1] : 'system'
  } catch {
    return 'system'
  }
}

const THEME_PREF = readThemePreference()
// Initial guess before the page reports: official preference, else OS theme.
let currentTheme = THEME_PREF === 'light' ? 'light'
  : THEME_PREF === 'dark' ? 'dark'
  : (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

async function pollTheme() {
  if (quitting || !mainView) return
  try {
    const info = await mainView.webContents.executeJavaScript(`(() => {
      const raw = (el) => {
        if (!el) return null
        const bg = getComputedStyle(el).backgroundColor
        if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return null
        return bg
      }
      const bg = raw(document.documentElement) || raw(document.body)
      if (!bg) return null
      const m = bg.match(/\\d+(?:\\.\\d+)?/g)
      if (!m || m.length < 3) return null
      return (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) < 128 ? 'dark' : 'light'
    })()`, true)
    if (info && info !== currentTheme) {
      currentTheme = info
      applyTheme(info)
    }
  } catch { /* page not ready */ }
  setTimeout(pollTheme, 2000)
}

function pushTheme(webContents) {
  if (webContents && !webContents.isDestroyed()) webContents.send('theme', currentTheme)
}

function applyTheme(theme) {
  const dark = theme === 'dark'
  const barBg = dark ? '#1e293b' : '#f1f5f9'
  const symbol = dark ? '#e2e8f0' : '#0f172a'
  if (win) win.setTitleBarOverlay({ color: barBg, symbolColor: symbol, height: TITLEBAR_H })
  for (const wc of [
    titlebarView && titlebarView.webContents,
    modelDialog && modelDialog.webContents,
    exportDialog && exportDialog.webContents,
    shellDialogWin && shellDialogWin.webContents,
    proxyDialog && proxyDialog.webContents,
  ]) {
    if (wc && !wc.isDestroyed()) wc.send('theme', theme)
  }
}

ipcMain.on('model-dialog:close', () => {
  if (modelDialog) modelDialog.close()
})

ipcMain.on('export-dialog:close', () => {
  if (exportDialog) exportDialog.close()
})

// ---- Chinese slash-command layer (MAIN world, injected on did-finish-load).
// Lives here and not in the preload: the sandboxed preload world loads before
// navigation starts (documentElement null), its timers never fire, and its
// isolated prototypes make controlled-input rewrites of React's textarea
// unreliable. In the main world the rewrite + Enter replay is fully standard.
function readCommandAliases() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'command-aliases.json'), 'utf8'))
    return raw.commands || {}
  } catch {
    return {}
  }
}

function injectMainWorldScript() {
  if (!mainView || mainView.webContents.isDestroyed()) return
  const aliasesJson = JSON.stringify(readCommandAliases())
  const script = `(() => {
    'use strict'
    if (window.__dshZhLayerInstalled) return
    window.__dshZhLayerInstalled = true
    const ALIASES = ${aliasesJson}
    const ZH2EN = new Map()
    const DESC_ZH = new Map()
    for (const [en, meta] of Object.entries(ALIASES)) {
      if (meta && meta.zh) ZH2EN.set(meta.zh, en)
      if (meta && meta.enDescription && meta.description) DESC_ZH.set(meta.enDescription, meta.description)
    }
    const NAMES = Object.keys(ALIASES)
    if (!NAMES.length) return
    const NAME_RE = new RegExp('^(' + NAMES.join('|') + ')$')
    const COMMAND_TOKEN = /(^|[^\\w/])\\/([^\\s/]+)(?=$|[\\s\\t\\n\\r])/g

    function translateCommands(text) {
      return String(text).replace(COMMAND_TOKEN, function (m, prefix, name) {
        const en = ZH2EN.get(name)
        return en ? prefix + '/' + en : m
      })
    }

    // submit-time rewrite: /压缩 + Enter → /compact + Enter
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      const ta = e.target
      if (!ta || ta.tagName !== 'TEXTAREA') return
      const translated = translateCommands(ta.value)
      if (translated === ta.value) return
      e.stopPropagation()
      e.preventDefault()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, translated)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      // Microtask, NOT setTimeout: timers are throttled while the page is
      // hidden (locked screen / covered window) and the replay would stall.
      queueMicrotask(function () {
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }))
      })
    }, true)

    // display-layer localization: trigger menu rows + command cards
    const isLeaf = function (el) { return el.childElementCount === 0 }
    function localizeMenuRow(row) {
      const spans = []
      for (const s of row.querySelectorAll('span')) {
        if (s.getAttribute('aria-hidden') === 'true') continue
        const parent = s.parentElement
        if (parent && parent.getAttribute && parent.getAttribute('aria-hidden') === 'true') continue
        spans.push(s)
      }
      const name = spans[0]
      if (!name || !isLeaf(name)) return
      const enName = (name.textContent || '').trim()
      const meta = ALIASES[enName]
      if (!meta) return
      name.textContent = meta.zh
      const desc = spans[1]
      if (desc && isLeaf(desc)) {
        const zh = DESC_ZH.get((desc.textContent || '').trim())
        if (zh) desc.textContent = zh
      }
    }
    function localizeContainer(root) {
      if (!root || !root.querySelectorAll) return
      for (const el of root.querySelectorAll('span, div, button')) {
        if (!isLeaf(el)) continue
        const t = (el.textContent || '').trim()
        if (!t || !NAME_RE.test(t)) continue
        el.textContent = ALIASES[t].zh
      }
    }
    function localizeMutations() {
      for (const row of document.querySelectorAll('[role="option"]')) localizeMenuRow(row)
      for (const card of document.querySelectorAll('[data-variant]')) localizeContainer(card)
      for (const icon of document.querySelectorAll('[data-compaction-icon]')) localizeContainer(icon.closest('div'))
    }

    // ── menu persistence ────────────────────────────────────────────────────
    // The official session-row menus (ui-workspace Rows) pass
    // 'closeOnPointerLeave', so they close 200ms after the pointer leaves.
    // Keep them open instead (Menu's own default semantics): block the
    // pointerout that drives React's synthetic pointerleave. Outside click /
    // Escape / re-click still close them, unchanged.
    let menuList = null
    function trackMenuNode(n) {
      if (!n || n.nodeType !== 1) return
      if (n.getAttribute && n.getAttribute('role') === 'menu') { menuList = n; return }
      if (n.querySelector) {
        const m = n.querySelector('[role="menu"]')
        if (m) menuList = m
      }
    }
    document.addEventListener('pointerout', (e) => {
      if (!menuList || !menuList.isConnected) menuList = null
      if (!menuList) return
      const t = e.target
      if (!(t && t.nodeType === 1 && menuList.contains(t))) return
      const rt = e.relatedTarget
      const staying = rt && rt.nodeType === 1 && menuList.contains(rt)
      if (!staying) e.stopPropagation()
    }, true)
    // Two-path localization:
    // 1. menu rows translate IMMEDIATELY and locally (no debounce): the menu
    //    is transient and React may write the English labels back at any
    //    moment — a debounce that skips the write-back mutation is exactly
    //    the bug that left menus English after the first open.
    // 2. command cards get a full pass with a trailing timer debounce (timers
    //    may throttle while the page is hidden, which only delays card
    //    localization — nobody is looking).
    let cardTimer = null
    const observer = new MutationObserver(function (mutations) {
      try {
        let cardsDirty = false
        for (const m of mutations) {
          const nodes = m.type === 'childList' ? m.addedNodes : [m.target]
          for (const n of nodes) {
            trackMenuNode(n)
            if (!n || n.nodeType !== 1) continue
            if (n.matches && n.matches('[role="option"]')) { localizeMenuRow(n); cardsDirty = true; continue }
            if (n.querySelectorAll) {
              const rows = n.querySelectorAll('[role="option"]')
              if (rows.length) { for (const row of rows) localizeMenuRow(row); cardsDirty = true }
            }
          }
          if (m.target && m.target.nodeType === 3) {
            // characterData: React wrote a text node back — retranslate its row
            const parent = m.target.parentElement
            if (parent && parent.closest && parent.closest('[role="option"]')) {
              localizeMenuRow(parent.closest('[role="option"]'))
              cardsDirty = true
            }
          }
        }
        if (cardsDirty) {
          clearTimeout(cardTimer)
          cardTimer = setTimeout(localizeMutations, 300)
        }
      } catch (e) { /* page teardown mid-mutation */ }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    localizeMutations()
  })()`
  mainView.webContents.executeJavaScript(script, true)
    .catch((e) => log('main-world script injection failed:', String(e)))
}

// ---- proxy settings dialog (tray「代理设置」): writes shell-config.json,
// injected into the dsh child env on next start ----
let proxyDialog = null

function openProxyDialog() {
  if (proxyDialog) {
    proxyDialog.focus()
    return
  }
  proxyDialog = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    backgroundColor: '#0f172a',
    parent: win || undefined,
    webPreferences: { preload: path.join(__dirname, 'proxy-preload.js'), contextIsolation: true },
  })
  proxyDialog.loadFile(path.join(__dirname, 'proxy-dialog.html'))
  proxyDialog.webContents.on('did-finish-load', () => pushTheme(proxyDialog.webContents))
  proxyDialog.on('closed', () => {
    proxyDialog = null
    if (win && !win.isDestroyed()) win.focus()
  })
}

ipcMain.handle('proxy-dialog:get', () => proxyParts())

ipcMain.handle('proxy-dialog:save', async (_e, { http, https }) => {
  const norm = (v) => {
    let s = String(v || '').trim()
    // Friendly bare-address handling: "127.0.0.1:10809" → "http://127.0.0.1:10809".
    if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`
    return s
  }
  const h = norm(http)
  const s = norm(https)
  for (const [label, v] of [['HTTP 代理', h], ['HTTPS 代理', s]]) {
    if (v && !/^https?:\/\/\S+$/.test(v) && !/^socks5?:\/\/\S+$/.test(v)) {
      await showShellDialog({
        title: '代理设置',
        message: `${label}地址格式无法识别：${v}\n\n请使用 http:// 或 https:// 或 socks5:// 开头（或留空 = 直连）。`,
        danger: true,
      })
      return { ok: false }
    }
  }
  config.proxy = { http: h, https: s }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  if (proxyDialog && !proxyDialog.isDestroyed()) proxyDialog.close()
  await showShellDialog({
    title: '代理设置',
    message: (h || s)
      ? `HTTP 代理：${h || '（未设）'}\nHTTPS 代理：${s || '（未设，自动回退 HTTP 值）'}\n\n重启应用后生效（后端启动时注入，检查更新/升级即时生效）。`
      : '已清除代理设置（直连）。\n\n重启应用后生效。',
  })
  return { ok: true }
})

ipcMain.on('proxy-dialog:close', () => {
  if (proxyDialog) proxyDialog.close()
})

// ---- context menu on the official page: 复制 (native copy) + 引用 (inject
// the selection as a markdown quote block into the composer), plus two
// message-level ops on user messages — 重发此消息 (session.prompt queue) and
// 从此处分支 (session.fork atSeq) ----
function injectText(text) {
  const script = `(() => {
    const ta = document.querySelector('textarea')
    if (!ta) return { ok: false, why: 'no-textarea' }
    ta.focus()
    if (typeof ta.selectionStart === 'number') {
      ta.selectionStart = ta.selectionEnd = ta.value.length
    }
    const insert = ${JSON.stringify(text)}
    const prefixed = (ta.value && !ta.value.endsWith('\\n') ? '\\n' : '') + insert
    const ok = document.execCommand('insertText', false, prefixed)
    return { ok, why: ok ? undefined : 'execCommand-failed' }
  })()`
  return mainView.webContents.executeJavaScript(script, true)
    .then((r) => {
      if (!r || !r.ok) log('text injection failed:', JSON.stringify(r))
    })
    .catch((e) => log('text injection error:', String(e)))
}

function quoteSelection(selectionText) {
  const sel = selectionText
  if (!sel) return
  const quote = sel.split('\n').map((l) => '> ' + l).join('\n')
  injectText(quote + '\n\n')
}

// Parse the official row key `{kind.length}:{kind}{id}` (e.g.
// "13:input-message<messageId>", "9:turn-tail<2>").
function parseAnchorKey(key) {
  const m = /^(\d+):/.exec(key || '')
  if (!m) return null
  const n = Number(m[1])
  const kind = key.slice(m[0].length, m[0].length + n)
  const id = key.slice(m[0].length + n)
  return { kind, id }
}

// Locate the chat row under the right-click. elementFromPoint + zoom-aware
// coordinate mapping, reading the stable data-chat-anchor-key that the
// official renderer stamps on every row.
async function locateMessageAtPoint(x, y) {
  const zf = mainView.webContents.getZoomFactor() || 1
  const script = `(() => {
    let el = document.elementFromPoint(${x / zf}, ${y / zf})
    while (el && !el.hasAttribute('data-chat-anchor-key')) el = el.parentElement
    if (!el) return null
    return { key: el.getAttribute('data-chat-anchor-key'), kind: el.getAttribute('data-chat-flow-kind') }
  })()`
  const r = await mainView.webContents.executeJavaScript(script, true)
  if (!r || !r.key) return null
  return { ...parseAnchorKey(r.key), flowKind: r.kind }
}

// The official page exposes no current-session id anywhere (DOM or global);
// approximate via the session list: the running non-subagent session if any,
// else the most recently updated one.
async function locateCurrentSessionId() {
  const sl = await httpRpc('session.list')
  const items = (sl.items || []).filter((s) => !s.parentSessionId && s.origin !== 'subagent')
  if (!items.length) return null
  const running = items.filter((s) => s.running === true)
  const pool = (running.length ? running : items).slice().sort((a, b) => b.updatedAt - a.updatedAt)
  return pool[0].sessionId
}

// ---- file drop (v0.3.5): the main-view preload intercepts drops that contain
// at least one non-image file, sends the OS paths here; we copy every file
// into a per-conversation temp dir and inject name+path context into the
// composer (the user sends it — nothing is auto-submitted). Pure-image drops
// are left to the official composer attach flow untouched. Images inside a
// mixed drop are copied + path-referenced instead of attached. ----
ipcMain.on('shell:file-drop', async (_e, items) => {
  try {
    const sessionId = await locateCurrentSessionId()
    const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
    const dir = path.join(os.tmpdir(), 'dsh-desktop-uploads', safe)
    fs.mkdirSync(dir, { recursive: true })
    const lines = []
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || !it.name) continue
      const name = path.basename(String(it.name))
      const src = it.path
      if (!src || !fs.existsSync(src)) {
        lines.push(`[文件] ${name}（无法访问源文件: ${src || '未知路径'}）`)
        continue
      }
      let dest = path.join(dir, name)
      let n = 1
      const ext = path.extname(name)
      while (fs.existsSync(dest)) {
        dest = path.join(dir, `${path.basename(name, ext)}(${n})${ext}`)
        n += 1
      }
      fs.copyFileSync(src, dest)
      lines.push(`${it.isImage ? '[图片]' : '[文件]'} ${name} 已复制到会话临时区: ${dest}`)
    }
    if (lines.length > 0) injectText(lines.join('\n') + '\n')
  } catch (err) {
    log('file-drop failed:', String((err && err.message) || err))
  }
})

// Find the user/message in the history by its message id; return the
// prompt-able text parts plus its seq (the fork anchor). Pages backwards from
// the newest tail and stops as soon as the message is found.
async function findUserMessage(sessionId, messageId) {
  let beforeSeq
  for (let i = 0; i < 500; i++) {
    const payload = { sessionId, maxMessages: 100 }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const v = await httpRpc('session.history', payload)
    const page = v.events || []
    let minSeq
    let found = null
    for (let j = page.length - 1; j >= 0; j--) { // newest first
      const event = page[j] && page[j].event
      if (!event) continue
      if (event.type === 'user/message' && event.data && event.data.id === messageId) {
        const data = event.data
        const blocks = Array.isArray(data.content) ? data.content : []
        const textParts = blocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => ({ type: 'text', text: b.text }))
        const hasImage = blocks.some((b) => b && b.type === 'image')
        const preview = textParts.map((p) => p.text).join('\n').slice(0, 120)
        found = { seq: event.seq, textParts, hasImage, preview }
        break
      }
      const seq = event.seq
      if (minSeq === undefined || seq < minSeq) minSeq = seq
    }
    if (found) return found
    if (!v.hasMore || minSeq === undefined) break
    // Whole-message page boundaries: only the smallest seq advances the cursor.
    if (beforeSeq !== undefined && minSeq >= beforeSeq) break
    beforeSeq = minSeq
  }
  return null
}

// A single-line slash command must match the official parseCommand grammar
// (^/[a-z][a-z0-9_-]* followed by end/whitespace).
const SLASH_COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

async function resendMessageAt(msg) {
  if (msg.hasImage && msg.textParts.length === 0) {
    await showShellDialog({
      title: '重发此消息',
      message: '该消息仅含图片，暂不支持原样重发（官方 RPC 的图片附件为引用式存储）。',
      danger: true,
    })
    return
  }
  const fullText = msg.textParts.map((p) => p.text).join('\n')
  // session.prompt does NOT parse slash commands (verified against a live
  // fork: /goal reached the model as a plain message) — only the official
  // composer chain routes commands through the command registry. Re-run the
  // command through that path by injecting it into the composer.
  if (msg.textParts.length === 1 && SLASH_COMMAND_RE.test(fullText.trim())) {
    const choice = await showShellDialog({
      title: '重发此消息',
      message: `该消息是斜杠命令，官方 RPC 不支持直接重发命令（会被当成普通文本发给模型）。\n\n已把命令填入输入框，请在输入框中按回车重新执行：\n\n${fullText.trim()}`,
      buttons: ['填入输入框', '取消'],
    })
    if (choice !== 0) return
    await injectText(fullText.trim() + '\n')
    return
  }
  const note = msg.hasImage ? '\n\n（该消息含图片，重发将仅包含文本部分。）' : ''
  const choice = await showShellDialog({
    title: '重发此消息',
    message: `将把该消息原样重发给模型（旧的回复保留）：\n\n「${msg.preview || '（空消息）'}」\n${note}\n确定重发吗？`,
    buttons: ['重发', '取消'],
  })
  if (choice !== 0) return
  await httpRpc('session.prompt', { sessionId: msg.sessionId, mode: 'queue', content: msg.textParts })
}

async function forkAtMessage(msg) {
  const choice = await showShellDialog({
    title: '从此处分支',
    message: '将把该消息所在的整个回合分叉为一个新会话（原会话保留），新会话会出现在左侧会话列表中。\n\n确定分支吗？',
    buttons: ['分支', '取消'],
  })
  if (choice !== 0) return
  try {
    const res = await httpRpc('session.fork', { sessionId: msg.sessionId, atSeq: msg.seq })
    await showShellDialog({
      title: '分支完成',
      message: `已创建分支会话，可在左侧会话列表中找到并打开它。\n\n会话 ID：${res.sessionId}`,
    })
  } catch (error) {
    await showShellDialog({
      title: '分支失败',
      message: `无法从该消息分支：${String(error?.message || error)}\n\n（该消息所在回合可能仍在进行中，请等它结束后再试。）`,
      danger: true,
    })
  }
}

let contextMenuToken = 0

function installContextMenu() {
  mainView.webContents.on('context-menu', (event, params) => {
    event.preventDefault() // we pop the menu ourselves after async row location
    handleContextMenu(params).catch((e) => log('context menu error:', String(e)))
  })
}

async function handleContextMenu(params) {
  if (!win || win.isDestroyed()) return
  const token = ++contextMenuToken
  const template = []
  const hasSelection = !!(params.selectionText && params.selectionText.trim())
  if (hasSelection) {
    template.push({ label: '复制', role: 'copy' })
    template.push({ label: '引用', click: () => quoteSelection(params.selectionText) })
  } else {
    template.push({ label: '粘贴', role: 'paste' })
    template.push({ label: '全选', role: 'selectAll' })
  }
  // Message-level ops (user rows only): locate the row under the cursor, then
  // resolve the current session and the message's seq/content from history.
  let msg = null
  try {
    const loc = await locateMessageAtPoint(params.x, params.y)
    if (loc && loc.kind === 'input-message') {
      const sessionId = await locateCurrentSessionId()
      if (sessionId) {
        const found = await findUserMessage(sessionId, loc.id)
        if (found && found.textParts.length > 0) msg = { ...found, sessionId }
      }
    }
  } catch (error) {
    log('message-level menu disabled:', String(error))
  }
  if (token !== contextMenuToken) return // a newer right-click superseded this one
  if (msg) {
    template.push({ type: 'separator' })
    template.push({
      label: '重发此消息',
      click: () => { resendMessageAt(msg).catch((e) => log('resend failed:', String(e))) },
    })
    template.push({
      label: '从此处分支',
      click: () => { forkAtMessage(msg).catch((e) => log('fork failed:', String(e))) },
    })
  }
  Menu.buildFromTemplate(template).popup({ window: win })
}

// ---- check update (updater.js is a pure-node module, testable from CLI) ----
let updater = null
try {
  updater = require('./updater.js') // eslint-disable-line global-require
} catch (e) {
  updater = null
}

let upgrading = false
let progressWin = null

function openProgressWindow() {
  progressWin = new BrowserWindow({
    width: 640,
    height: 360,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#0f172a',
    parent: win || undefined,
    webPreferences: { preload: path.join(__dirname, 'progress-preload.js'), contextIsolation: true },
  })
  progressWin.loadFile(path.join(__dirname, 'progress.html'))
  progressWin.on('closed', () => { progressWin = null })
}

function closeProgressWindow() {
  if (progressWin) { progressWin.destroy(); progressWin = null }
}

// ---- self-drawn dialog (replaces the ugly system message boxes) ----
let shellDialogWin = null
let shellDialogResolver = null

function showShellDialog({ title, message, buttons = ['确定'], danger = false }) {
  return new Promise((resolve) => {
    if (shellDialogWin) shellDialogWin.destroy()
    shellDialogWin = new BrowserWindow({
      width: 440,
      height: 240,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      backgroundColor: '#0f172a',
      parent: win || undefined,
      webPreferences: { preload: path.join(__dirname, 'shell-dialog-preload.js'), contextIsolation: true },
    })
    shellDialogResolver = resolve
    shellDialogWin.loadFile(path.join(__dirname, 'shell-dialog.html'))
    shellDialogWin.webContents.on('did-finish-load', () => {
      if (shellDialogWin) {
        shellDialogWin.webContents.send('dialog-init', { title, message, buttons, danger })
        pushTheme(shellDialogWin.webContents)
      }
    })
    shellDialogWin.on('closed', () => {
      shellDialogWin = null
      if (shellDialogResolver) {
        const r = shellDialogResolver
        shellDialogResolver = null
        r(-1)
      }
      if (win && !win.isDestroyed()) win.focus()
    })
    // A failed dialog render must never hang the shutdown/restart chain.
    shellDialogWin.webContents.on('did-fail-load', () => {
      if (shellDialogWin) shellDialogWin.destroy() // closed handler resolves -1
    })
  })
}

ipcMain.on('dialog-choose', (_e, index) => {
  // Take the resolver FIRST: destroying the window may fire its 'closed'
  // handler synchronously, which would otherwise consume the promise with -1.
  let r = null
  if (shellDialogResolver) {
    r = shellDialogResolver
    shellDialogResolver = null
  }
  if (shellDialogWin) shellDialogWin.destroy()
  if (r) r(index)
})

function checkUpdateInteractive() {
  if (upgrading) return
  if (!updater) {
    showShellDialog({ title: '检查更新', message: '更新模块未加载。' })
    return
  }
  updater.checkForUpdate({
    onResult: async (r) => {
      if (!r.ok) {
        await showShellDialog({ title: '检查更新', message: `检测失败：${r.error}` })
        return
      }
      const lines = (r.results || []).map((x) => {
        if (x.error) return `${x.note || x.name}：✗ 无法检查（${x.error}）`
        return `${x.note || x.name}：${x.hasUpdate ? `🟢 有更新（${x.detail}）` : `✓ 最新（${x.detail}）`}`
      })
      const official = (r.results || []).find((x) => x.name === 'harness')
      if (official && official.hasUpdate) {
        const choice = await showShellDialog({
          title: '检查更新',
          message: `${lines.join('\n')}\n\n官方后端可升级：将拉取官方代码并重新构建（约 15-30 分钟），失败自动回滚。其余三路（本应用/锚定模板/GitBash 执行器）请在 Git 仓库侧跟进。`,
          buttons: ['升级', '取消'],
        })
        if (choice === 0) startUpgrade()
        return
      }
      await showShellDialog({ title: '检查更新', message: lines.join('\n') })
    },
  })
}

async function startUpgrade() {
  upgrading = true
  openProgressWindow()
  const result = await updater.runUpgrade({
    onStep: (s) => { if (progressWin) progressWin.webContents.send('upgrade-step', s) },
  })
  closeProgressWindow()
  upgrading = false
  if (result.ok) {
    const choice = await showShellDialog({
      title: '升级完成',
      message: `升级成功（${result.target.slice(0, 8)}）。重启应用生效。`,
      buttons: ['立即重启', '稍后'],
    })
    if (choice === 0) restart()
  } else {
    await showShellDialog({
      title: '升级失败',
      message: '升级失败，已自动回滚到原版本。\n详情报告见项目根目录 upgrade-report-*.md。',
      danger: true,
    })
  }
}

// NOTE: startup silently checking for updates was removed on purpose —
// machines without a proxy would hang on the git ls-remote timeout at launch.
// Updates are checked only from the explicit titlebar/tray「检查更新」entry.

// ---- restart / shutdown with running-session guard ----
async function countRunningSessions() {
  try {
    const sl = await httpRpc('session.list')
    return (sl.items || []).filter((s) => s.running === true).length
  } catch {
    return 0
  }
}

async function restart() {
  if (quitting) return
  // ALWAYS confirm — a misclick must never kill running work.
  const busy = await countRunningSessions()
  const message = busy > 0
    ? `当前有 ${busy} 个活跃对话，重启会中断它们（思考/执行/回复中的任务会丢失）！\n\n请确认是否重启应用。`
    : '请确认是否重启应用。'
  const choice = await showShellDialog({
    title: '重启应用确认',
    message,
    buttons: ['确认重启应用', '取消'],
    danger: busy > 0,
  })
  if (choice !== 0) return
  quitting = true
  killHarness()
  // Normal quit path (not app.exit) so the single-instance lock releases
  // reliably before the relaunched instance asks for it.
  app.relaunch()
  app.quit()
  // Fuse: if anything still holds the process after 5s, force-exit so a
  // relaunch never strands a half-alive shell.
  setTimeout(() => { log('restart fuse fired — force exiting'); app.exit(0) }, 5000)
}

// ---- shutdown ----
function shutdown() {
  if (quitting) return
  ;(async () => {
    const busy = await countRunningSessions()
    if (busy > 0) {
      const choice = await showShellDialog({
        title: '退出确认',
        message: `检测到 ${busy} 个会话正在运行（思考/执行/回复中），退出将中断它们！\n\n确定退出吗？`,
        buttons: ['确定退出', '取消'],
        danger: true,
      })
      if (choice !== 0) return
    }
    quitting = true
    killHarness()
    app.quit()
    // Fuse: if anything still holds the process 5s after quit (a stuck
    // dialog, a wedged renderer), force-exit so the shell never ghosts.
    setTimeout(() => { log('exit fuse fired — force exiting'); app.exit(0) }, 5000)
  })()
}

// ---- green-package first-launch relink ----
// The zip ships the pnpm virtual store without junctions (zip can't store them
// portably); on first launch rebuild every dependency link recorded in
// repo/link-manifest.json with the bundled node.exe. Dev checkouts without a
// manifest skip this entirely.
async function ensureLinked() {
  const relinkScript = path.join(__dirname, 'relink.mjs')
  const manifest = path.join(REPO, 'link-manifest.json')
  const marker = path.join(REPO, 'node_modules', '.dsh-green-linked')
  if (!fs.existsSync(relinkScript) || !fs.existsSync(manifest) || fs.existsSync(marker)) return
  if (!fs.existsSync(path.join(REPO, 'node_modules', '.pnpm'))) return
  log('first run: rebuilding dependency links (link-manifest.json)…')
  const code = await new Promise((resolve) => {
    const p = spawn(resolveNode(), [relinkScript], { cwd: __dirname, stdio: 'inherit', windowsHide: true })
    p.on('exit', resolve)
    p.on('error', () => resolve(-1))
  })
  log(`dependency relink finished (exit ${code})`)
}

// ---- first-run AGENTS baseline ----
// New users get the portable AGENTS constitution so the injected-instruction
// layer (and the "act-then-inject" safety chain) works out of the box. Only
// written when ~/.dsh/AGENTS.md does NOT exist — never overwrite an existing
// one. The template ships with the package (desktop/portable-agents.md).
function ensurePortableAgents() {
  const target = path.join(os.homedir(), '.dsh', 'AGENTS.md')
  if (fs.existsSync(target)) return
  const template = path.join(__dirname, 'portable-agents.md')
  if (!fs.existsSync(template)) return
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(template, target)
    log('first run: wrote portable AGENTS baseline to ~/.dsh/AGENTS.md')
  } catch (error) {
    log('failed to write portable AGENTS:', String(error))
  }
}

// ---- main ----
async function main() {
  app.on('window-all-closed', () => {
    // Closing the window quits on Windows.
    app.quit()
  })
  app.on('before-quit', () => {
    quitting = true
    killHarness() // any quit path must take the backend down, no exceptions
  })

  ipcMain.on('shell-action', (_event, action) => onShellAction(action))

  await ensureLinked()
  ensurePortableAgents()
  startHarness()
  try {
    const ready = await probeReady(60000, () => child !== null && child.exitCode === null && child.signalCode === null)
    log(`harness ready, http ${ready.status}, title "${ready.title}", opening window`)
  } catch (error) {
    log('READINESS FAILED:', String(error))
    killHarness()
    process.exitCode = 1
    app.quit()
    return
  }

  createWindow()
  createTray()
  applyTheme(currentTheme) // push the initial titlebar overlay color immediately

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (win) { win.show(); win.focus() }
  })
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (win) win.hide()
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())

  if (!SMOKE_MS) {
    pollNotifications()
    pollTheme()
  }

  if (CLOSE_TEST_MS) {
    setTimeout(() => {
      log('close-test: closing window (X path)')
      if (win && !win.isDestroyed()) win.close()
    }, CLOSE_TEST_MS)
  }

  if (SMOKE_MS) {
    log(`smoke: auto-quit in ${SMOKE_MS} ms`)
    setTimeout(() => {
      log('smoke: auto-quit')
      killHarness()
      setTimeout(() => process.exit(0), 500)
    }, SMOKE_MS)
  }
}
