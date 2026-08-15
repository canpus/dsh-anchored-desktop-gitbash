// Green-package builder — assemble dist/DeepSeek-Harness-v<ver>-green.zip:
//   repo/    upstream runtime as the REAL tree only (pnpm virtual store + source;
//            every junction/symlink is SKIPPED and recorded in
//            repo/link-manifest.json — the zip cannot store junctions portably).
//   desktop/ thin shell + bundled node.exe + relink.mjs (first-launch link
//            rebuilder, runs with the bundled node, no admin rights needed:
//            Windows junctions are unprivileged) + official electron dist.
//
// First-launch flow on the target machine: 启动.bat → electron main.js →
// ensureLinked() runs relink.mjs → junction tree rebuilt from the manifest →
// dsh web starts. Fully offline, no pnpm/corepack download required.
//
// Packaging red lines (History_log 打包红线):
//   - DeepSeek API.txt / MIMO API.txt / third-party / docs / History_log live at
//     the PROJECT ROOT outside repo/ and desktop/ — never staged.
//   - No fc-* presets or proxy values are pre-baked; .dsh is created on first run.
//   - stage2-archive, dev test scripts and lock files are stripped from desktop/.
// Usage: node desktop/pack-green.mjs   (pure Node, no deps; robocopy + tar from OS)
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const STAGE = path.join(DIST, 'DeepSeek-Harness')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
const ZIP = path.join(DIST, `DeepSeek-Harness-v${pkg.version}-green.zip`)

const log = (...a) => console.log(`[pack ${(Date.now() / 1000).toFixed(1)}s]`, ...a)

// robocopy exit codes 0-7 are success. Used only for junction-free trees.
function robocopy(src, dst, { excludeDirs = [] } = {}) {
  const args = [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']
  for (const d of excludeDirs) args.push('/XD', path.join(src, d))
  const r = spawnSync('robocopy', args, { stdio: 'inherit' })
  if (r.status > 7) throw new Error(`robocopy failed (${r.status})`)
}

// Windows ships bsdtar (libarchive) at System32 — it supports zip via -a.
// Git Bash's GNU tar shadows PATH and cannot write zips ("Cannot connect to C:").
// WORSE: GNU tar `-a` with a .zip suffix silently writes a PLAIN TAR, and the
// verify below lists entries with libarchive (format-blind) — a tar-named-.zip
// passed entry checks and shipped broken (v0.3.0 incident, D61). Resolve System32
// bsdtar EXPLICITLY and fail fast unless it reports libarchive.
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
const tarVersion = spawnSync(TAR, ['--version'], { encoding: 'utf8' })
if (tarVersion.status !== 0 || !/libarchive|bsdtar/i.test(String(tarVersion.stdout || '') + String(tarVersion.stderr || ''))) {
  throw new Error(`System32 tar.exe is not bsdtar/libarchive (${tarVersion.stdout || tarVersion.stderr || 'missing'}) — refusing to build`)
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`)
}

// ---- real-tree copier + link manifest ----
// Copies every REAL file/dir once (global realpath dedupe). Every junction or
// symlink is skipped in the copy and recorded with a repo-relative target so
// relink.mjs can recreate it on the target machine. Link detection is by
// realpath identity (realpath(src) !== src) — independent of how the OS
// classifies reparse points.
const normKey = (p) => p.toLowerCase()
const IGNORE_DIRS = new Set(['.git'])

function copyRepoTree() {
  const srcRoot = path.join(ROOT, 'repo')
  const dst = path.join(STAGE, 'repo')
  const stats = { files: 0, dirs: 0, links: 0, fileLinks: 0, outside: 0, broken: 0, errors: 0, lastLog: Date.now() }
  const links = []

  async function walk(realDir, outDir) {
    const key = normKey(realDir)
    await fsp.mkdir(outDir, { recursive: true })
    const entries = await fsp.readdir(realDir, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isDirectory() && IGNORE_DIRS.has(ent.name)) continue
      const srcP = path.join(realDir, ent.name)
      const outP = path.join(outDir, ent.name)
      let st
      try { st = await fsp.lstat(srcP) } catch { stats.broken++; continue }
      if (st.isFile() && !st.isSymbolicLink()) {
        try {
          await fsp.copyFile(srcP, outP)
          stats.files++
        } catch (e) { stats.errors++; if (stats.errors < 5) log(`  copy error: ${srcP}: ${e.message}`) }
        continue
      }
      // Directories and links: identify by realpath identity.
      let rp
      try { rp = await fsp.realpath(srcP) } catch { stats.broken++; continue }
      if (normKey(rp) !== normKey(srcP)) {
        // It is a junction/symlink — record, don't materialize.
        let tst = null
        try { tst = await fsp.stat(rp) } catch { stats.broken++; continue }
        const linkRel = path.relative(srcRoot, srcP).replace(/\\/g, '/')
        const targetRel = path.relative(srcRoot, rp).replace(/\\/g, '/')
        const kind = tst.isDirectory() ? 'dir' : 'file'
        links.push({ link: linkRel, target: targetRel, kind })
        if (kind === 'dir') stats.links++
        else stats.fileLinks++
        if (targetRel.startsWith('..')) stats.outside++
        continue
      }
      // Real directory.
      stats.dirs++
      await walk(rp, outP)
      if (stats.files % 20000 === 0 && Date.now() - stats.lastLog > 3000) {
        stats.lastLog = Date.now()
        log(`  copy progress: files=${stats.files} dirs=${stats.dirs} links=${stats.links} fileLinks=${stats.fileLinks} outside=${stats.outside} broken=${stats.broken}`)
      }
    }
  }

  log('stage repo/ (real tree only; junctions recorded to link-manifest.json)')
  const started = Date.now()
  return (async () => {
    await walk(await fsp.realpath(srcRoot), dst)
    const manifest = { version: 1, repoPath: 'repo', links }
    fs.writeFileSync(path.join(dst, 'link-manifest.json'), JSON.stringify(manifest))
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    log(`repo copy done in ${secs}s: files=${stats.files} dirs=${stats.dirs} links=${stats.links} fileLinks=${stats.fileLinks} outsideTargets=${stats.outside} broken=${stats.broken} copyErrors=${stats.errors}`)
    if (stats.outside > 0) log(`WARNING: ${stats.outside} links point OUTSIDE repo — they will not relink on other machines`)
  })()
}

// ---- stage ----
log('clean staging dir')
fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

await copyRepoTree()

log('stage desktop/ (exclude node_modules + stage2-archive, then copy electron dist only)')
robocopy(path.join(__dirname), path.join(STAGE, 'desktop'), { excludeDirs: ['node_modules', 'stage2-archive'] })
fs.mkdirSync(path.join(STAGE, 'desktop', 'node_modules', 'electron'), { recursive: true })
robocopy(
  path.join(__dirname, 'node_modules', 'electron', 'dist'),
  path.join(STAGE, 'desktop', 'node_modules', 'electron', 'dist'),
)
for (const f of ['rpc-test.mjs', 'ui-drive.mjs', 'package-lock.json', 'gen-icons.js', 'pack-green.mjs']) {
  fs.rmSync(path.join(STAGE, 'desktop', f), { force: true })
}

log('bundle node.exe (the runtime this script runs under)')
fs.copyFileSync(process.execPath, path.join(STAGE, 'desktop', 'node.exe'))

log('write launcher + readme')
fs.writeFileSync(
  path.join(STAGE, '启动.bat'),
  '@echo off\r\nstart "" "%~dp0desktop\\node_modules\\electron\\dist\\electron.exe" "%~dp0desktop\\main.js"\r\n',
)
fs.writeFileSync(path.join(STAGE, '说明.txt'), [
  'DeepSeek Harness 桌面版（绿色版）',
  '',
  '用法：双击「启动.bat」。无需安装，不写注册表；删除整个文件夹即完全卸载。',
  '',
  '1. 首次启动会重建依赖链接（约 1-5 分钟，无需联网、无需管理员权限），并在 %USERPROFILE%\\.dsh 自建数据目录；',
  '   API Key 请在应用内「设置」中填写（不随包分发）。',
  '2. 模型与子 Agent 模型：窗口标题栏「子 Agent 模型」按钮。',
  '3. 网络代理：托盘图标「代理设置」（默认直连，留空即可）。',
  '4. 升级：托盘图标「检查更新」——需要本机装有 git 与 Node（pnpm 由 corepack 提供）。',
  '5. 若 Windows SmartScreen 提示：electron 二进制为官方签名，zip 本身未签名，选择「仍要运行」。',
  '',
  `版本：v${pkg.version}（上游 deepseek-harness @${pkg.upstreamCommit ?? '见 desktop/shell-config.json'}）`,
].join('\r\n'))

// ---- zip (atomic publish) ----
// The archive is written to a .partial name and only renamed into place after
// a clean verify — the real zip path must NEVER point at a half-written file
// (a user unzipping mid-build must not hit a corrupt archive), and the version
// number bumps with package.json so older packages are pruned, not overwritten.
const ZIP_TMP = path.join(DIST, `.${path.basename(ZIP)}.partial`)
log(`zip → ${ZIP}`)
fs.rmSync(ZIP_TMP, { force: true })
sh(TAR, ['-a', '--format', 'zip', '-c', '-f', ZIP_TMP, '-C', DIST, path.basename(STAGE)])

// ---- verify ----
log('verify zip contents')
const list = spawnSync(TAR, ['-tf', ZIP_TMP], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 512 * 1024 * 1024 })
if (list.status !== 0) throw new Error('tar list failed')
const entries = list.stdout.split(/\r?\n/).filter(Boolean)
const has = (suffix) => entries.some((e) => e.replace(/\\/g, '/').endsWith(suffix))
const required = [
  'desktop/main.js',
  'desktop/relink.mjs',
  'desktop/shell-config.json',
  'desktop/node.exe',
  'desktop/portable-agents.md',
  'desktop/node_modules/electron/dist/electron.exe',
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
  'desktop/preset-gen.cjs',
  'repo/link-manifest.json',
  'repo/apps/web/dist/index.html',
  'repo/apps/cli/src/bin.ts',
  'repo/package.json',
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

// Format integrity: the entry list alone is format-blind (libarchive reads any
// format — a tar named .zip lists fine). Assert real ZIP structure and, when
// unzip exists on PATH, run a full CRC pass.
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
// The old file at the real path is removed only after the .partial has passed
// every check, so the real path never points at an unverified archive (and
// Windows rename does not replace an existing file).
fs.rmSync(ZIP, { force: true })
fs.renameSync(ZIP_TMP, ZIP)
for (const f of fs.readdirSync(DIST)) {
  if (f.endsWith('-green.zip') && f !== path.basename(ZIP)) {
    fs.rmSync(path.join(DIST, f), { force: true })
    log(`pruned old package ${f}`)
  }
}
log(`published ${path.basename(ZIP)}`)
process.exit(0)
