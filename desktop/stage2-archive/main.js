// Phase 2: zero-port desktop.
// The harness Host boots IN-PROCESS inside the Electron main process (official
// seam: dsh-app-boot's boot() with bareModuleBaseUrl pointing at the repo).
// The renderer runs the official client graph and drives the host through an
// IPC bridge that carries the official ApiProxy fetch protocol
// (toFetchHandler). No HTTP server, no child process, no listening ports.
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')

const REPO = path.resolve(__dirname, '..', 'repo')
const RENDERER_HTML = path.join(__dirname, 'renderer', 'index.html')

let hostCtx = null
let handler = null
let mainWindow = null
let quitting = false

// --- Host boot ---------------------------------------------------------------

async function startHost() {
  const { bootHarness } = await import(pathToFileURL(path.join(__dirname, 'host', 'host-boot.mjs')).href)
  const booted = await bootHarness({ repo: REPO })
  hostCtx = booted.ctx
  handler = booted.handler
  console.log('[desktop] harness host booted in-process (zero ports)')
  // Host-side event telemetry (drive only): confirms the host tree produces
  // events so "no frames arrived" can be told apart from "host silent".
  if (process.env.DSH_DESKTOP_DRIVE) {
    hostCtx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'turn/start') {
        console.log(`[desktop] host session/event ${session.id.slice(0, 8)} ${event.type}`)
      }
    })
  }
}

// --- IPC bridge: fetch protocol + bundle loader ------------------------------

const streams = new Map() // streamId -> { controller }

function registerBridge() {
  // Bundle loader: the renderer's loadBundle seam resolves a fake /plugins/<id>.js
  // URL to the built lib/client.js artifact on disk.
  ipcMain.handle('dsh:readBundle', async (_event, url) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer', 'manifest.json'), 'utf8'))
    const entry = manifest.entries.find((it) => it.url === url)
    if (!entry) throw new Error(`[desktop] unknown bundle ${url}`)
    return fs.readFileSync(path.join(REPO, entry.bundlePath), 'utf8')
  })

  // One fetch-shaped request per call; the response body streams back to the
  // renderer as dsh:chunk events (SSE streams stay open for the life of the
  // subscription).
  ipcMain.handle('dsh:fetch', async (event, req) => {
    const { id, url, method, headers, body } = req
    const controller = new AbortController()
    let response
    try {
      const request = new Request(url, {
        method,
        headers: headers ?? {},
        body: body === undefined || body === null ? undefined : body,
        signal: controller.signal,
      })
      response = await handler.fetch(request)
    } catch (error) {
      event.sender.send('dsh:response', { id, error: String(error?.message ?? error) })
      return { ok: true }
    }
    const outHeaders = {}
    response.headers.forEach((value, key) => { outHeaders[key] = value })
    streams.set(id, { controller })
    event.sender.send('dsh:response', { id, status: response.status, statusText: response.statusText, headers: outHeaders })
    pumpStream(event.sender, id, response.body, url)
    return { ok: true }
  })

  ipcMain.on('dsh:cancel', (_event, id) => {
    const stream = streams.get(id)
    if (stream) {
      stream.controller.abort()
      streams.delete(id)
    }
  })
}

async function pumpStream(sender, id, body, url) {
  const reader = body.getReader()
  const t0 = Date.now()
  let bytes = 0
  let chunks = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      chunks++
      sender.send('dsh:chunk', { id, data: Buffer.from(value).toString('base64') })
    }
  } catch {
    // aborted by the renderer or a transport fault
  }
  if (process.env.DSH_DESKTOP_DRIVE) {
    console.log(`[desktop] stream ${id} ${url} ended: ${chunks} chunks, ${bytes} bytes, ${Date.now() - t0}ms`)
  }
  sender.send('dsh:end', { id })
  streams.delete(id)
}

// --- Window ------------------------------------------------------------------

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Renderer boot verdicts arrive as console lines; always log them, and in
  // smoke mode also capture screenshots for visual self-inspection.
  let verdict = 'no-verdict'
  mainWindow.webContents.on('console-message', (...args) => {
    const message = typeof args[2] === 'string' ? args[2] : args[0]?.message
    if (typeof message !== 'string') return
    if (message.startsWith('[desktop] RENDERER_SETTLED_OK')) {
      verdict = 'ok'
      console.log('[desktop] renderer settled OK')
    }
    if (message.startsWith('[desktop] RENDERER_SETTLED_FAIL')) {
      verdict = 'fail'
      console.error('[desktop] renderer failed to settle:', message)
    }
    // Drive mode: functional self-test verdict; exit immediately with its code.
    if (message.startsWith('[desktop] DRIVE_RESULT')) {
      const payload = message.slice('[desktop] DRIVE_RESULT '.length)
      console.log('[desktop] DRIVE_RESULT', payload)
      const passed = payload.includes('"pass":true')
      app.exit(passed ? 0 : 1)
    }
    if (message.startsWith('[desktop] DRIVE_STEP')) {
      console.log('[desktop]', message.slice('[desktop] '.length))
    }
    // Drive diagnostics: mirror every other renderer console line (the
    // official client's transport failures etc.) into the main log.
    if (process.env.DSH_DESKTOP_DRIVE && !message.startsWith('[desktop] ')) {
      console.log('[desktop] [r]', message.slice(0, 400))
    }
  })

  await mainWindow.loadFile(
    RENDERER_HTML,
    process.env.DSH_DESKTOP_DRIVE ? { query: { drive: '1' } } : undefined,
  )

  if (process.env.DSH_DESKTOP_SMOKE) {
    const delay = Number(process.env.DSH_DESKTOP_SMOKE) || 15000
    setTimeout(async () => {
      try {
        const image = await mainWindow.webContents.capturePage()
        const fs2 = require('node:fs')
        fs2.writeFileSync(path.join(__dirname, '..', 'docs', 'phase2-screenshot.png'), image.toPNG())
        console.log('[desktop] smoke: screenshot saved to docs/phase2-screenshot.png')
      } catch (error) {
        console.error('[desktop] smoke: screenshot failed:', error)
      }
      try {
        const dom = await mainWindow.webContents.executeJavaScript(`(() => {
          const bodyStyle = getComputedStyle(document.body)
          const root = document.getElementById('root')
          const rootStyle = root ? getComputedStyle(root) : null
          const styleTags = [...document.querySelectorAll('style')]
          return {
            title: document.title,
            bodyBg: bodyStyle.backgroundColor,
            bodyFont: bodyStyle.fontFamily?.slice(0, 40),
            bodyColor: bodyStyle.color,
            rootChildren: root?.children.length ?? 0,
            rootBg: rootStyle?.backgroundColor,
            styleTagCount: styleTags.length,
            pluginStyleCount: styleTags.filter(s => s.hasAttribute('data-plugin')).length,
            visibleText: (document.body.innerText ?? '').slice(0, 120).replace(/\\s+/g, ' '),
          }
        })()`)
        console.log('[desktop] smoke: DOM report:', JSON.stringify(dom))
      } catch (error) {
        console.error('[desktop] smoke: DOM probe failed:', error)
      }
      console.log(`[desktop] smoke: verdict=${verdict}, auto-quit`)
      app.exit(verdict === 'ok' ? 0 : 1)
    }, delay)
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// --- Lifecycle ----------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      // Optional CDP endpoint for automated GUI driving (browser-use).
      if (process.env.DSH_DESKTOP_CDP_PORT) {
        app.commandLine.appendSwitch('remote-debugging-port', process.env.DSH_DESKTOP_CDP_PORT)
      }
      registerBridge()
      await startHost()
      await createWindow()
      if (process.env.DSH_DESKTOP_DRIVE) {
        // Drive mode owns its own exit; fail loud if the test never reports.
        setTimeout(() => {
          console.error('[desktop] drive watchdog: no verdict in 8 minutes')
          app.exit(2)
        }, 8 * 60_000)
      }
    } catch (error) {
      console.error('[desktop] boot failed:', error)
      app.exit(1)
    }
  })

  app.on('window-all-closed', () => {
    // In drive mode the self-test owns the exit: closing the window must not
    // kill the run halfway through.
    if (!process.env.DSH_DESKTOP_DRIVE) app.quit()
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error('[desktop] renderer process gone:', JSON.stringify(details))
  })

  // Graceful host teardown: dispose the Cordis tree so sessions flush and
  // subprocesses reach quiescence.
  app.on('will-quit', async (event) => {
    if (quitting || !hostCtx) return
    quitting = true
    event.preventDefault()
    try {
      await hostCtx.fiber.dispose()
    } catch (error) {
      console.error('[desktop] host dispose failed:', error)
    }
    app.exit(0)
  })
}
