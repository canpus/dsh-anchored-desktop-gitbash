// Preset generators — the single source of truth shared by main.js (model
// dialog + titlebar experiment toggles) and CLI maintenance. Generates user
// presets under ~/.dsh/.agent-presets/ (plan_v0.4.2).
//
//   economy            THE generated preset (显示名「省钱模式」): the official
//                      Standard composition read from the VENDORED engine at
//                      generation time + agentOptions provider/model injected
//                      into the spawn/fork rows. No anchor/tool-bootstrap/
//                      compaction/Minimal-persona logic — pure official
//                      standard + child route. The old fc-child fusion is
//                      legacy: hidden, NEVER generated, dir untouched.
//   anchored-standard  verbatim upstream xiaobright/dsh-anchored-standard
//                      (base preset/ only) — hash-verified against the bundled
//                      .manifest.json, then ONE transparent local adaptation:
//                      the hardcoded bashPath is replaced with the machine's
//                      probed Git Bash (upstream hardcodes C:\Program Files).
//   router-standard    verbatim upstream yjh051108/dsh-routing-suite preset
//                      submodule (router-standard, suite-locked eff787e) —
//                      hash-verified, zero adaptation.
//   minimal-gitbash    legacy Windows minimal variant (kept for old sessions).
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const presetsRoot = () => path.join(os.homedir(), '.dsh', '.agent-presets')
const economyDir = () => path.join(presetsRoot(), 'economy')
const fcChildDir = () => path.join(presetsRoot(), 'fc-child')
const anchoredDir = () => path.join(presetsRoot(), 'anchored-standard')
const routerDir = () => path.join(presetsRoot(), 'router-standard')
const gitbashDir = () => path.join(presetsRoot(), 'minimal-gitbash')

// Vendored engine paths (0.4.0-slim: the engine IS the npm package).
const enginePackageJson = (desktopDir) => path.join(desktopDir, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const engineStandardYml = (desktopDir) => path.join(desktopDir, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')

function engineVersion(desktopDir) {
  try { return JSON.parse(fs.readFileSync(enginePackageJson(desktopDir), 'utf8')).version } catch { return 'unknown' }
}

// Inject `agentOptions` (provider + model, BOTH mandatory — never a
// model-only downgrade, plan_v0.4.2 §0) into the official standard spawn/fork
// rows. The rows are indented 8 spaces; `\s+` matches any indentation so minor
// upstream re-indentation does not break generation. Fail loud when a row
// stops matching — a silent no-op would generate a preset without the child
// route, silently falling back to inheriting the main agent (Pro).
function injectChildRoute(src, { providerId, modelId }) {
  if (!providerId || !modelId) throw new Error('injectChildRoute: providerId and modelId are both required')
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  let hits = 0
  const out = src
    .replace(
      /(provider: spawn\r?\n\s+toolName: subagent\r?\n\s+backgroundMode: continuable\r?\n)/,
      (m) => { hits += 1; return `${m}        agentOptions:${eol}          provider: ${providerId}${eol}          model: ${modelId}${eol}` },
    )
    .replace(
      /(provider: fork\r?\n\s+toolName: subagent_fork\r?\n\s+backgroundMode: continuable\r?\n)/,
      (m) => { hits += 1; return `${m}        agentOptions:${eol}          provider: ${providerId}${eol}          model: ${modelId}${eol}` },
    )
  if (hits !== 2 || !out.includes(`model: ${modelId}`) || !out.includes(`provider: ${providerId}`)) {
    throw new Error('injectChildRoute: failed to inject agentOptions provider/model into the spawn/fork rows')
  }
  return out
}

// Generate the ONE dynamic user preset `economy` (显示名「省钱模式」) from the
// VENDORED official standard + the validated provider/model pair. Atomic:
// write to a sibling temp dir, then rename into place (a crash mid-write must
// never leave a half preset behind). The dir is re-derived every time, so
// generations never leave stale plugin files behind.
function generateEconomy({ providerId, modelId, desktopDir } = {}) {
  if (!providerId || !modelId) throw new Error('generateEconomy: providerId and modelId are both required')
  const base = desktopDir || __dirname
  let src = fs.readFileSync(engineStandardYml(base), 'utf8')
  src = injectChildRoute(src, { providerId, modelId })
  const version = engineVersion(base)
  const presetYml = [
    'name: 省钱模式',
    `description: 基于官方 Standard 预设（快照自 @deepseek-ai/dsh ${version}）+ 子 Agent 默认路由注入（${providerId}/${modelId}）。普通/分支/嵌套子 Agent 使用所选便宜模型。省钱模式不覆盖 Workflow/Ralph worker：Workflow 未显式指定模型时、以及当前内置 Ralph，默认继承主 Agent 路由，可能按主模型计费。`,
    'order: 5',
  ].join('\n') + '\n'
  const tmp = path.join(presetsRoot(), `.economy.tmp-${process.pid}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'agent.cordis.yml'), src)
  fs.writeFileSync(path.join(tmp, 'preset.yml'), presetYml)
  fs.rmSync(economyDir(), { recursive: true, force: true })
  fs.renameSync(tmp, economyDir())
  return economyDir()
}

// Read the injected route back from the installed economy preset (may be null
// when economy was never generated on this machine).
function readEconomyRoute() {
  try {
    const text = fs.readFileSync(path.join(economyDir(), 'agent.cordis.yml'), 'utf8')
    const m = text.match(/agentOptions:\s*\r?\n\s+provider:\s*(\S+)\s*\r?\n\s+model:\s*(\S+)/)
    if (!m) return null
    return { providerId: m[1], modelId: m[2] }
  } catch { return null }
}

// The engine version the installed economy preset was generated from (for the
// startup regeneration check — economy must track the vendored standard).
function economyEngineVersion() {
  try {
    const text = fs.readFileSync(path.join(economyDir(), 'preset.yml'), 'utf8')
    const m = text.match(/@deepseek-ai\/dsh ([\w.-]+)/)
    return m ? m[1] : null
  } catch { return null }
}

// Verify a bundled template against its .manifest.json (upstream commits +
// per-file sha256). Any missing file or hash mismatch throws BEFORE the user
// dir is touched — a partial copy must never mount as a half-preset (D77).
function verifyTemplate(templateDir) {
  const manifestPath = path.join(templateDir, '.manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    throw new Error(`template manifest unreadable: ${templateDir} (${String(e && e.message || e)})`)
  }
  const files = manifest.files || {}
  if (!Object.keys(files).length) throw new Error(`template manifest empty: ${templateDir}`)
  for (const [name, want] of Object.entries(files)) {
    const p = path.join(templateDir, name)
    if (!fs.existsSync(p)) throw new Error(`template file missing: ${name}`)
    const got = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    if (got !== want) throw new Error(`template hash mismatch: ${name}`)
  }
  return manifest
}

// Copy every manifest-listed file into the destination and hash-verify the
// copies (whole dir replaced first, so stale files from older versions never
// linger).
function installPresetFromTemplate(templateDir, destDir) {
  const manifest = verifyTemplate(templateDir)
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })
  for (const name of Object.keys(manifest.files)) {
    fs.copyFileSync(path.join(templateDir, name), path.join(destDir, name))
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(destDir, name))).digest('hex')
    if (got !== manifest.files[name]) throw new Error(`installed file hash mismatch: ${name}`)
  }
  return manifest
}

// Install the verbatim upstream anchored-standard preset. The ONLY local
// adaptation (transparent boundary, plan_v0.4.2 §0): the upstream agent.cordis.yml
// hardcodes bashPath 'C:\Program Files\Git\bin\bash.exe' (the executor only
// falls back to 'bash' on PATH) — a machine with Git elsewhere would install a
// known-broken preset. Replace it with the probed executable (the bin\bash.exe
// WRAPPER preferred — it initializes the MSYS environment; the bare
// usr\bin\bash.exe loses /usr/bin on its PATH and every external command
// fails, observed live). NO Git Bash on the machine → refuse to install (no
// half-success state): the caller keeps the previous mode and shows the
// reason. templateDir overrides the bundled template (runtime-updated
// snapshots from upstream-update.cjs take precedence).
function installAnchoredPreset({ desktopDir, templateDir } = {}) {
  const base = desktopDir || __dirname
  const tpl = templateDir || path.join(base, 'presets', 'anchored-standard')
  const manifest = verifyTemplate(tpl)
  const bash = findGitBashWrapper()
  if (!bash) {
    return { ok: false, error: '未找到可用的 Git Bash（anchored 实验预设的锚定阶段需要它）。请先安装 Git for Windows 再开启。' }
  }
  installPresetFromTemplate(tpl, anchoredDir())
  const ymlPath = path.join(anchoredDir(), 'agent.cordis.yml')
  let yml = fs.readFileSync(ymlPath, 'utf8')
  const adapted = yml.replace(/(bashPath:\s*)'[^']*'/, `$1'${bash}'`)
  if (adapted === yml) {
    fs.rmSync(anchoredDir(), { recursive: true, force: true })
    throw new Error('installAnchoredPreset: bashPath row not found — upstream structure changed, refusing to install')
  }
  fs.writeFileSync(ymlPath, adapted)
  return { ok: true, dir: anchoredDir(), upstream: manifest.commit || manifest.presetCommit || 'snapshot', adapted: { bashPath: bash } }
}

// Install the verbatim suite-locked router-standard preset (zero adaptation).
function installRouterPreset({ desktopDir, templateDir } = {}) {
  const base = desktopDir || __dirname
  const tpl = templateDir || path.join(base, 'presets', 'router-standard')
  const manifest = installPresetFromTemplate(tpl, routerDir())
  return { ok: true, dir: routerDir(), upstream: manifest.presetCommit || manifest.commit, suite: manifest.suiteCommit }
}

// Git Bash lookup for the ANCHORED preset adaptation. Upstream custom-bash.mjs
// spawns the bare executable (`bash -c`) with the inherited environment — the
// real MSYS bash (usr\bin\bash.exe) then has no /usr/bin on its PATH and
// every external command fails with "command not found" (observed live:
// "ls: command not found" in anchored mode). Git's bin\bash.exe (the ~47KB
// launcher wrapper) initializes the MSYS environment (PATH augmentation)
// before exec'ing the real bash, so a bare `-c` works — prefer it here.
// findGitBash() (used by the legacy minimal-gitbash, whose executor sets its
// own ENV_OVERRIDES) keeps preferring usr\bin.
function findGitBashWrapper() {
  const env = process.env
  const roots = []
  for (const p of [
    env.GIT_BASH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git'),
  ]) {
    if (p) roots.push(p)
  }
  for (const hive of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows']) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'InstallPath'], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const m = /REG_SZ\s+(.+)/.exec(out)
      if (m) roots.push(m[1].trim())
    } catch { /* key absent on this machine */ }
  }
  roots.push('D:\\Git')
  const seen = new Set()
  // Wrapper first (initializes the MSYS env), real bash second (falls back to
  // the working -c behavior only when no wrapper exists), PATH 'bash' last.
  for (const root of roots) {
    for (const rel of ['bin\\bash.exe', 'usr\\bin\\bash.exe']) {
      const p = path.join(root, rel)
      if (!p || seen.has(p.toLowerCase())) continue
      seen.add(p.toLowerCase())
      if (fs.existsSync(p)) return p
    }
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, 'bash.exe')
    if (seen.has(p.toLowerCase())) continue
    seen.add(p.toLowerCase())
    if (fs.existsSync(p)) return p
  }
  return null
}
// Find a Git-for-Windows bash.exe on this machine (legacy minimal-gitbash
// pinning; prefers the real MSYS bash — its executor sets ENV_OVERRIDES, so
// no wrapper needed). See findGitBashWrapper for the anchored-preset variant.
function findGitBash() {
  const env = process.env
  const roots = []
  for (const p of [
    env.GIT_BASH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]) {
    if (p) roots.push(p)
  }
  for (const hive of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows']) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'InstallPath'], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const m = /REG_SZ\s+(.+)/.exec(out)
      if (m) {
        const ip = m[1].trim()
        roots.push(path.join(ip, 'usr', 'bin', 'bash.exe'), path.join(ip, 'bin', 'bash.exe'))
      }
    } catch { /* key absent on this machine */ }
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) roots.push(path.join(dir, 'bash.exe'))
  }
  roots.push('D:\\Git\\usr\\bin\\bash.exe', 'D:\\Git\\bin\\bash.exe')
  const seen = new Set()
  for (const p of roots) {
    if (!p || seen.has(p.toLowerCase())) continue
    seen.add(p.toLowerCase())
    if (fs.existsSync(p)) return p
  }
  return null
}

// Install the reviewed minimal-gitbash preset (upstream
// lices/dsh-gitbash-preset @0.1.1, MIT bundled) from the bundled template.
// The bundled template stays author-original (auto-detect, machine-agnostic
// for distribution); the INSTALLED copy pins the executor's shellPath to the
// bash.exe found on THIS machine, because the author's auto-detect misses
// custom Git install roots (observed: Git at D:\Git, raw PATH has only
// D:\Git\cmd → executor fell back to 'bash' → ENOENT). LEGACY since 0.4.2
// (kept for old sessions referencing minimal-gitbash; not selectable in the
// picker anymore).
function installMinimalGitbash({ desktopDir, templateDir } = {}) {
  const base = desktopDir || __dirname
  const tpl = templateDir || path.join(base, 'presets', 'minimal-gitbash')
  fs.mkdirSync(gitbashDir(), { recursive: true })
  for (const f of ['preset.yml', 'gitbash-executor.mjs', 'LICENSE']) {
    fs.copyFileSync(path.join(tpl, f), path.join(gitbashDir(), f))
  }
  let yml = fs.readFileSync(path.join(tpl, 'agent.cordis.yml'), 'utf8')
  const bash = findGitBash()
  if (bash) {
    // YAML single quotes keep backslashes literal — write the Windows path as-is.
    // The template may carry CRLF line endings (git autocrlf); match any EOL
    // and re-use it for the injected line. Fail loud if the pattern does not
    // match — a silent no-op here would ship the broken auto-detect again.
    const eol = yml.includes('\r\n') ? '\r\n' : '\n'
    const injected = yml.replace(
      /(name: \.\/gitbash-executor\.mjs[^\r\n]*\r?\n[ \t]+config:[^\r\n]*\r?\n)/,
      `$1        shellPath: '${bash}'${eol}`,
    )
    if (injected === yml || !injected.includes(`shellPath: '${bash}'`)) {
      throw new Error('installMinimalGitbash: failed to inject shellPath into the executor config block')
    }
    yml = injected
  }
  fs.writeFileSync(path.join(gitbashDir(), 'agent.cordis.yml'), yml)
  return gitbashDir()
}

module.exports = {
  generateEconomy, readEconomyRoute, economyEngineVersion, engineVersion,
  installAnchoredPreset, installRouterPreset, installMinimalGitbash,
  findGitBash, findGitBashWrapper,
  economyDir, fcChildDir, anchoredDir, routerDir, gitbashDir,
}
