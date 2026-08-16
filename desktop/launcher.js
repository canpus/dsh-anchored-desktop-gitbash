// Hidden launcher (0.4.2) — spawns electron with windowsHide + pipes, and
// appends ALL output to the package-root launch.log. 启动日志管道
// (项目 AGENTS §3.2) satisfied WITHOUT any visible console window:
//   ≤0.4.1: `start "" electron.exe >> launch.log` — the redirect bound to
//           `start` itself, the detached child's output was DISCARDED.
//   0.4.2 D91: `start "" cmd /c "… >> launch.log"` — output captured, but
//           cmd waits for electron to exit → persistent black console window
//           (user-reported regression).
//   now: wscript (GUI subsystem, window style 0) runs THIS script hidden;
//        node spawns electron with windowsHide + pipes → full capture,
//        no console window at any stage.
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const desktopDir = __dirname
const logPath = path.join(desktopDir, '..', 'launch.log')
const electron = path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const main = path.join(desktopDir, 'main.js')

const append = (d) => {
  try { fs.appendFileSync(logPath, String(d), 'utf8') } catch { /* never break the launch chain */ }
}

const child = spawn(electron, [main], {
  cwd: desktopDir,
  // NO windowsHide here: electron.exe is a GUI-subsystem binary (no console
  // to hide), and hiding the spawn state made the MAIN WINDOW inherit the
  // hidden state — the app landed in the tray with no window (reported
  // 2026-08-17). Pipes still capture all output into launch.log.
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
})
child.stdout.on('data', append)
child.stderr.on('data', append)
child.on('error', (e) => {
  append(`[launcher] failed to start electron: ${String((e && e.stack) || e)}\n`)
  process.exit(1)
})
child.on('exit', () => process.exit(0))
