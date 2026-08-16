// Green-package builder (0.4.0-slim) — assemble dist/DeepSeek-Harness-v<ver>-green.zip:
//   desktop/         thin shell + bundled node.exe + official electron dist
//   desktop/vendor/  the official npm engine — @deepseek-ai/dsh production
//                    install, plain real files (no junctions, no first-launch
//                    relink). Fetch with `node desktop/fetch-vendor.cjs` before
//                    packing; pack-green fails fast if it is missing.
//
// The 0.3.9 source-checkout engine (repo/ pnpm store + link-manifest +
// relink.mjs) is gone: npm trees are junction-free, so the zip carries the
// engine directly and first launch boots in seconds with no rebuild step.
//
// Packaging red lines (History_log 打包红线):
//   - DeepSeek API.txt / MIMO API.txt / third-party / docs / History_log live at
//     the PROJECT ROOT outside repo/ and desktop/ — never staged.
//   - No fc-* presets or proxy values are pre-baked; .dsh is created on first run.
//   - stage2-archive, dev test scripts and lock files are stripped from desktop/.
// Usage: node desktop/pack-green.mjs [--stage-only]   (pure Node; robocopy + node:zlib)
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeZip, listZipNames } from './zip-write.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const STAGE = path.join(DIST, 'DeepSeek-Harness')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
const ZIP = path.join(DIST, `DeepSeek-Harness-v${pkg.version}-green.zip`)

const log = (...a) => console.log(`[pack ${(Date.now() / 1000).toFixed(1)}s]`, ...a)

// robocopy exit codes 0-7 are success. Only used on junction-free trees
// (desktop/ + the npm vendor install).
function robocopy(src, dst, { excludeDirs = [] } = {}) {
  const args = [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']
  for (const d of excludeDirs) args.push('/XD', path.join(src, d))
  const r = spawnSync('robocopy', args, { stdio: 'inherit' })
  if (r.status > 7) throw new Error(`robocopy failed (${r.status})`)
}

// The zip itself is written by desktop/zip-write.mjs (pure Node). Console
// archivers are NOT used here: Git Bash's GNU tar cannot write zips at all and
// silently produced a plain tar with `-a` (v0.3.0 incident, D61), and the
// System32 bsdtar stores non-ASCII names in the ANSI codepage with the UTF-8
// flag unset — 用户指南.md extracts as mojibake everywhere (D68).

// ---- engine gate ----
// The shell boots the harness from the vendored npm package (lib/bin.js is the
// official build artifact shipped in the npm tarball — no local build step).
// Packing without it would ship a launcher that cannot start.
const VENDOR = path.join(__dirname, 'vendor')
const VENDOR_BIN = path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const VENDOR_WEB = path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
if (!fs.existsSync(VENDOR_BIN) || !fs.existsSync(VENDOR_WEB)) {
  log('FATAL: desktop/vendor 缺失或不完整 — 先跑 node desktop/fetch-vendor.cjs 再打包')
  process.exit(1)
}

// ---- stage ----
log('clean staging dir')
fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

log('stage desktop/ (exclude node_modules + vendor + stage2-archive)')
robocopy(path.join(__dirname), path.join(STAGE, 'desktop'), { excludeDirs: ['node_modules', 'vendor', 'stage2-archive'] })

log('stage vendor/ (npm production engine, plain files)')
robocopy(VENDOR, path.join(STAGE, 'desktop', 'vendor'))

fs.mkdirSync(path.join(STAGE, 'desktop', 'node_modules', 'electron'), { recursive: true })
robocopy(
  path.join(__dirname, 'node_modules', 'electron', 'dist'),
  path.join(STAGE, 'desktop', 'node_modules', 'electron', 'dist'),
)
for (const f of ['rpc-test.mjs', 'ui-drive.mjs', 'package-lock.json', 'gen-icons.js', 'pack-green.mjs', 'zip-write.mjs', 'fetch-vendor.cjs', 'preset-mount-test.cjs', 'relink.mjs']) {
  fs.rmSync(path.join(STAGE, 'desktop', f), { force: true })
}
// 0.4.0 experiment leftovers (封存): the 0.3.9 fc-child template has no anchor
// turn / compaction-epoch plugins — they must not ship.
for (const f of ['anchor-turn.mjs', 'compaction-epoch.mjs']) {
  fs.rmSync(path.join(STAGE, 'desktop', 'presets', 'fc-child-fusion', f), { force: true })
}

log('bundle node.exe (the runtime this script runs under)')
fs.copyFileSync(process.execPath, path.join(STAGE, 'desktop', 'node.exe'))

log('write launcher + readme + user guide')
fs.writeFileSync(
  path.join(STAGE, '启动.bat'),
  '@echo off\r\necho [launch %date% %time%] >> "%~dp0launch.log"\r\nstart "" "%~dp0desktop\\node_modules\\electron\\dist\\electron.exe" "%~dp0desktop\\main.js" >> "%~dp0launch.log" 2>&1\r\n',
)
fs.writeFileSync(path.join(STAGE, '说明.txt'), [
  'DeepSeek Harness 桌面版（绿色版）— 快速上手',
  '',
  '1. 双击「启动.bat」，几秒内自动打开应用窗口（无需联网、无需预装 Node）。',
  '2. 在应用内「设置」填写 DeepSeek API Key。',
  '3. 完整使用说明（重点：如何开启「自定义子模型」模式）见「用户指南.md」。',
  '',
  '卸载：删除整个文件夹。数据目录 %USERPROFILE%\\.dsh 会保留。',
].join('\r\n'))
fs.copyFileSync(path.join(__dirname, 'user-guide.md'), path.join(STAGE, '用户指南.md'))

// ---- stage-only mode (项目 AGENTS §3.1: 先测试、后打包) ----
// The user tests the UNPACKED release first (double-click 启动.bat in the
// versioned dir below); the zip — compress + three-layer verify + publish —
// only runs AFTER the test passes. --stage-only builds the unpacked package
// and stops there. Without the flag: full pipeline.
const STAGE_ONLY = process.argv.includes('--stage-only')
if (STAGE_ONLY) {
  log('--stage-only: unpacked release only — skipping zip (test first, zip after user passes)')
} else {
// ---- zip (atomic publish) ----
// The archive is written to a .partial name and only renamed into place after
// a clean verify — the real zip path must NEVER point at a half-written file
// (a user unzipping mid-build must not hit a corrupt archive), and the version
// number bumps with package.json so older packages are pruned, not overwritten.
const ZIP_TMP = path.join(DIST, `.${path.basename(ZIP)}.partial`)
log(`zip → ${ZIP}`)
fs.rmSync(ZIP_TMP, { force: true })
const zipCount = writeZip(STAGE, ZIP_TMP, path.basename(STAGE))

// ---- verify ----
log('verify zip contents')
// Names come straight from the central directory via listZipNames — flag-aware
// UTF-8 decode, zero codepage conversion (D68), and the EOCD parse itself
// asserts the archive really is a zip (a tar renamed .zip cannot fake it, D61).
const entries = listZipNames(ZIP_TMP)
if (entries.length !== zipCount) {
  log(`  entry count mismatch: wrote ${zipCount}, listed ${entries.length}`)
  process.exit(1)
}
const has = (suffix) => entries.some((e) => e.replace(/\\/g, '/').endsWith(suffix))
const required = [
  'desktop/main.js',
  'desktop/shell-config.json',
  'desktop/node.exe',
  'desktop/portable-agents.md',
  '用户指南.md',
  'desktop/node_modules/electron/dist/electron.exe',
  'desktop/vendor/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'desktop/vendor/node_modules/@deepseek-ai/dsh/package.json',
  'desktop/vendor/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'desktop/vendor/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml',
  'desktop/vendor/node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml',
  'desktop/presets/anchored-standard/agent.cordis.yml',
  'desktop/presets/anchored-standard/LICENSE',
  'desktop/presets/anchored-standard/NOTICE',
  'desktop/presets/router-standard/agent.cordis.yml',
  'desktop/presets/router-standard/router-bootstrap.mjs',
  'desktop/presets/router-standard/router-core.mjs',
  'desktop/presets/router-standard/LICENSE',
  'desktop/presets/router-standard/NOTICE',
  'desktop/presets/minimal-gitbash/agent.cordis.yml',
  'desktop/presets/minimal-gitbash/gitbash-executor.mjs',
  'desktop/presets/minimal-gitbash/preset.yml',
  'desktop/presets/minimal-gitbash/LICENSE',
  'desktop/presets/fc-child-fusion/agent.cordis.yml',
  'desktop/presets/fc-child-fusion/tool-bootstrap.mjs',
  'desktop/presets/fc-child-fusion/gitbash-executor.mjs',
  'desktop/preset-gen.cjs',
]
const forbidden = [
  'DeepSeek-Harness/third-party', // project-root third-party/ — upstream repo has its own legit "third-party" files
  'DeepSeek-Harness/AGENTS/', // project-root personal knowledge base — never ships
  'DeepSeek-Harness/desktop/stage2-archive',
  '/.git/',
  'API.txt',
  'History_log.md',
  'rpc-test.mjs',
  'ui-drive.mjs',
  'pack-green.mjs',
  'zip-write.mjs',
  'fetch-vendor.cjs',
  'relink.mjs',
  'anchor-turn.mjs',
  'compaction-epoch.mjs',
  'link-manifest.json',
]
let ok = true
for (const r of required) {
  const found = has(r)
  log(`  required ${r}: ${found ? 'OK' : 'MISSING'}`)
  if (!found) ok = false
}
for (const f of forbidden) {
  const found = entries.some((e) => e.toLowerCase().includes(f.toLowerCase()))
  log(`  forbidden ${f}: ${found ? 'FOUND!' : 'absent'}`)
  if (found) ok = false
}
const sizeMb = (fs.statSync(ZIP_TMP).size / 1048576).toFixed(1)
log(`entries=${entries.length}, zip=${sizeMb} MB, ${ok ? 'VERIFY OK' : 'VERIFY FAILED'}`)
if (!ok) process.exit(1)

// Format integrity: listZipNames already required a real EOCD, but assert the
// local-header magic too and, when unzip exists on PATH, run a full CRC pass
// as an independent third check.
function zipMagicOk(p) {
  const fd = fs.openSync(p, 'r')
  try {
    const head = Buffer.alloc(4)
    if (fs.readSync(fd, head, 0, 4, 0) !== 4) return false
    if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false // local file header
    const st = fs.fstatSync(fd)
    const tailLen = Math.min(65557, st.size) // EOCD max 22 + comment 65535
    const tail = Buffer.alloc(tailLen)
    if (fs.readSync(fd, tail, 0, tailLen, st.size - tailLen) !== tailLen) return false
    return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])) // end of central directory
  } finally {
    fs.closeSync(fd)
  }
}
if (!zipMagicOk(ZIP_TMP)) {
  log('  zip magic check FAILED: archive is not a ZIP (PK signatures missing)')
  process.exit(1)
}
log('  zip magic check: PK\x03\x04 head + PK\x05\x06 EOCD OK')
const unzipCheck = spawnSync('unzip', ['-t', ZIP_TMP], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (unzipCheck.error && unzipCheck.error.code === 'ENOENT') {
  log('  unzip not on PATH — skipping CRC pass (magic check only)')
} else if (unzipCheck.status !== 0) {
  log(`  unzip -t FAILED:\n${String(unzipCheck.stderr).slice(0, 2000)}`)
  process.exit(1)
} else {
  log('  unzip -t: CRC OK')
}

// Atomic publish: expose the real name only after a clean verify, then prune
// packages of older versions so dist/ never holds two confusingly-similar zips.
fs.rmSync(ZIP, { force: true })
fs.renameSync(ZIP_TMP, ZIP)
for (const f of fs.readdirSync(DIST)) {
  if (f.endsWith('-green.zip') && f !== path.basename(ZIP)) {
    fs.rmSync(path.join(DIST, f), { force: true })
    log(`pruned old package ${f}`)
  }
}
log(`published ${path.basename(ZIP)}`)
}

// ---- keep an UNPACKED sibling for quick local testing (user requirement,
// 2026-08-15): rename the staging tree to a versioned dir and prune unpacked
// dirs of older versions. npm trees are plain files — no pre-relink step, a
// double-click boots in seconds as shipped.
const UNPACKED = path.join(DIST, `DeepSeek-Harness-v${pkg.version}`)
try {
  fs.rmSync(UNPACKED, { recursive: true, force: true })
} catch (error) {
  // Explorer browsing the dir / a lingering handle can make the rm fail with
  // EPERM. Side-move the old dir instead of dying AFTER the zip has already
  // been published — the zip is the verified artifact; the unpacked copy is
  // replaceable.
  const stale = `${UNPACKED}.old-${Date.now()}`
  try {
    fs.renameSync(UNPACKED, stale)
    log(`  old unpacked dir busy — moved aside to ${path.basename(stale)}`)
  } catch {
    log(`FATAL: cannot replace ${path.relative(ROOT, UNPACKED)} (${String(error.code || error)}) — close the folder / stop the app and retry`)
    process.exit(1)
  }
}
fs.renameSync(STAGE, UNPACKED)
log(`unpacked copy: ${path.relative(ROOT, UNPACKED)}`)

for (const f of fs.readdirSync(DIST)) {
  try {
    const p = path.join(DIST, f)
    if (f.startsWith('DeepSeek-Harness-v') && f !== path.basename(UNPACKED) && fs.statSync(p).isDirectory()) {
      fs.rmSync(p, { recursive: true, force: true })
      log(`pruned old unpacked dir ${f}`)
    }
  } catch { /* not a dir we manage */ }
}
process.exit(0)
