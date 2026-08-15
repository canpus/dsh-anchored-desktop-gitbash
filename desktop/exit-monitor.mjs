// Exit-race monitor（退出后进程/端口竞态监控，项目 AGENTS §3.4 延伸）
//
// Spawned DETACHED by main.js at quit time: it outlives the shell and watches
// the killed backend PID and the web port for a few seconds AFTER exit, then
// appends its findings to the same structured log (~/.dsh/logs/desktop-shell.log).
// A ghost backend (harness pid survived taskkill) or a port still held by a
// stranger must never need the user's verbal report to diagnose — the log
// says who holds what.
//
// Usage: node exit-monitor.mjs <harnessPid> <port> <logFile> [seconds]
// First frame is delayed 800ms: the shell's own taskkill + port release need
// a moment, and an immediate probe would only record the pre-release state.
'use strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const [, , pidArg, portArg, logFile, secArg] = process.argv
const pid = Number(pidArg)
const port = Number(portArg)
const seconds = Math.max(1, Number(secArg) || 10)
if (!Number.isFinite(pid) || !Number.isFinite(port) || !logFile) {
  process.exit(2)
}

function line(s) {
  try { fs.appendFileSync(logFile, `[monitor ${(Date.now() / 1000).toFixed(1)}s] ${s}\n`, 'utf8') } catch { /* best effort — never crash */ }
}

// Is the killed backend pid still alive? (ghost backend after taskkill /T /F)
function pidAlive(p) {
  try {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${p}`], { encoding: 'utf8', windowsHide: true })
    return out.status === 0 && new RegExp(`\\s${p}\\s`).test(out.stdout)
  } catch {
    return null // tooling missing — reported as unknown below
  }
}

// Is the port still LISTENING, and who owns it?
function portListener() {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    for (const raw of out.stdout.split(/\r?\n/)) {
      const cols = raw.trim().split(/\s+/)
      if (cols.length < 5 || cols[3] !== 'LISTENING') continue
      const local = cols[1] // 127.0.0.1:3080 / 0.0.0.0:3080 / [::]:3080
      if (!local.endsWith(`:${port}`)) continue
      const ownerPid = cols[4]
      let ownerName = '?'
      try {
        const t = spawnSync('tasklist', ['/FI', `PID eq ${ownerPid}`], { encoding: 'utf8', windowsHide: true })
        const rows = t.stdout.split(/\r?\n/)
        ownerName = (rows[3] || '').trim().split(/\s+/)[0] || '?'
      } catch { /* best effort */ }
      return { ownerPid, ownerName }
    }
    return null
  } catch {
    return undefined // netstat unavailable — unknown
  }
}

await new Promise((r) => setTimeout(r, 800))

let ghostPid = false
let portHeld = false
let unknown = false
const ticks = Math.max(1, Math.ceil((seconds * 1000 - 800) / 500))
for (let i = 0; i < ticks; i++) {
  const alive = pidAlive(pid)
  if (alive === null) unknown = true
  if (alive === true && !ghostPid) {
    ghostPid = true
    line(`WARNING: ghost backend — killed harness pid ${pid} still alive after exit`)
  }
  const listener = portListener()
  if (listener === undefined) unknown = true
  if (listener && !portHeld) {
    portHeld = true
    line(`WARNING: port ${port} still LISTENING after exit — owner pid=${listener.ownerPid} name=${listener.ownerName}`)
  }
  await new Promise((r) => setTimeout(r, 500))
}
line(`exit monitor done: ghostPid=${ghostPid ? 'yes' : 'no'} portHeld=${portHeld ? 'yes' : 'no'}${unknown ? ' (some probes unavailable)' : ''} (watched ~${seconds}s)`)
process.exit(0)
