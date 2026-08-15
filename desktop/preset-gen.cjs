// Preset generators — the single source of truth shared by main.js (model
// dialog) and CLI maintenance. Generates user presets under ~/.dsh/.agent-presets/
// from the bundled templates under desktop/presets/.
//
//   fc-child         fc-child-fusion template — the gitbash-minimal anchor
//                    (first request: bash(GitBash) + str_replace_editor +
//                    1024 cap + no AGENTS/skill injections) fused with the
//                    anchored-standard promotion phase (first tool/call OR
//                    first assistant message → full Standard catalog + AGENTS
//                    resume) + child-model agentOptions on spawn/fork rows.
//   router-standard  reviewed router template (upstream
//                    yjh051108/dsh-router-standard @5737535, MIT + NOTICE),
//                    copied verbatim — kept author-original for A/B testing.
//   minimal-gitbash  reviewed Windows minimal variant (upstream
//                    lices/dsh-gitbash-preset @0.1.1, MIT) — official-minimal
//                    persona + str_replace_editor surface with bash routed
//                    through Git-for-Windows bash (sandbox-gated, no bypass),
//                    copied verbatim.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const presetsRoot = () => path.join(os.homedir(), '.dsh', '.agent-presets')
const fcChildDir = () => path.join(presetsRoot(), 'fc-child')
const routerDir = () => path.join(presetsRoot(), 'router-standard')
const gitbashDir = () => path.join(presetsRoot(), 'minimal-gitbash')

// Inject `agentOptions.model` into the subagent spawn/fork rows. The template
// rows are indented 8 spaces; `\s+` matches any indentation so minor upstream
// re-indentation does not break generation.
function injectChildModel(src, modelId) {
  return src
    .replace(
      /(provider: spawn\n\s+toolName: subagent\n\s+backgroundMode: continuable\n)/,
      `$1        agentOptions:\n          model: ${modelId}\n`,
    )
    .replace(
      /(provider: fork\n\s+toolName: subagent_fork\n\s+backgroundMode: continuable\n)/,
      `$1        agentOptions:\n          model: ${modelId}\n`,
    )
}

// Generate the ONE dynamic user preset `fc-child` (display name「自定义子模型」)
// from the bundled fc-child-fusion template — the gitbash-minimal anchor fused
// with the anchored-standard promotion phase. Re-applying a model re-derives
// everything from the current template; the preset dir is wiped first so
// generations never leave stale plugin files behind.
function generateFcChild(modelId, { desktopDir } = {}) {
  const base = desktopDir || __dirname
  const templateDir = path.join(base, 'presets', 'fc-child-fusion')
  let src = fs.readFileSync(path.join(templateDir, 'agent.cordis.yml'), 'utf8')
  src = injectChildModel(src, modelId)
  // Pin the gitbash executor to the bash.exe found on THIS machine (the
  // author's auto-detect misses custom install roots like D:\Git whose bin
  // dirs are not on the raw Windows PATH). Fail loud if the pattern does not
  // match — a silent no-op would ship the broken auto-detect again.
  const bash = findGitBash()
  if (bash) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n'
    const pinned = src.replace(
      /(name: \.\/gitbash-executor\.mjs[^\r\n]*\r?\n[ \t]+config:[^\r\n]*\r?\n)/,
      `$1        shellPath: '${bash}'${eol}`,
    )
    if (pinned === src || !pinned.includes(`shellPath: '${bash}'`)) {
      throw new Error('generateFcChild: failed to pin shellPath into the gitbash-executor config block')
    }
    src = pinned
  }
  fs.rmSync(fcChildDir(), { recursive: true, force: true })
  fs.mkdirSync(fcChildDir(), { recursive: true })
  fs.writeFileSync(path.join(fcChildDir(), 'agent.cordis.yml'), src)
  // The preset-local plugins ship by relative path from the composition —
  // copy them verbatim so the preset keeps working standalone. The old
  // first-prompt-filter plugin was absorbed upstream (suppressedContextSources
  // in tool-bootstrap) — the wiped dir takes care of any leftover copy.
  for (const plugin of ['tool-bootstrap.mjs', 'gitbash-executor.mjs']) {
    fs.copyFileSync(path.join(templateDir, plugin), path.join(fcChildDir(), plugin))
  }
  fs.writeFileSync(
    path.join(fcChildDir(), 'preset.yml'),
    [
      'name: 自定义子模型',
      'description: 融合预设（GitBash 锚定 + 开放升级）：首轮 = 官方极简对（bash(GitBash) + str_replace_editor）+ 1024 输出封顶 + 无 AGENTS/skill 注入（锚定出 V4Pro 新型思维链）；首个工具调用或首条回复后 = 全量 Standard 工具（subagent 全家/pwsh/web/todo/skill 等）+ AGENTS 恢复注入。bash 经 Git-for-Windows 执行，需会话沙箱为「完全访问」（或按提示单次升级）。子 Agent 默认模型在窗口标题栏「子 Agent 模型」中设置。',
      'order: 5',
    ].join('\n') + '\n',
  )
  return fcChildDir()
}

// Install the reviewed router-standard preset (upstream
// yjh051108/dsh-router-standard @5737535, MIT + NOTICE bundled) from the
// bundled template, verbatim (author-original, no child-model injection, so
// the A/B comparison against fc-child stays clean). Idempotent overwrite keeps
// the installed copy in sync with the bundled version.
function installRouterPreset({ desktopDir } = {}) {
  const base = desktopDir || __dirname
  const templateDir = path.join(base, 'presets', 'router-standard')
  fs.mkdirSync(routerDir(), { recursive: true })
  for (const f of ['agent.cordis.yml', 'preset.yml', 'router-bootstrap.mjs', 'router-core.mjs']) {
    fs.copyFileSync(path.join(templateDir, f), path.join(routerDir(), f))
  }
  return routerDir()
}

// Find a Git-for-Windows bash.exe on this machine. The author's executor
// auto-detect probes only the DEFAULT install roots (ProgramFiles/LOCALAPPDATA)
// plus PATH — but a custom install like D:\Git puts only D:\Git\cmd (git.exe
// wrappers) on the raw Windows PATH, and the usr/bin bash dirs live in Git
// Bash's own augmented PATH, invisible to the harness spawned from Electron.
// Probe the registry InstallPath and known local roots too; prefer usr\bin
// (the real MSYS bash) over bin\bash.exe (the 47KB wrapper).
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
// D:\Git\cmd → executor fell back to 'bash' → ENOENT).
function installMinimalGitbash({ desktopDir } = {}) {
  const base = desktopDir || __dirname
  const templateDir = path.join(base, 'presets', 'minimal-gitbash')
  fs.mkdirSync(gitbashDir(), { recursive: true })
  for (const f of ['preset.yml', 'gitbash-executor.mjs']) {
    fs.copyFileSync(path.join(templateDir, f), path.join(gitbashDir(), f))
  }
  let yml = fs.readFileSync(path.join(templateDir, 'agent.cordis.yml'), 'utf8')
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
  generateFcChild, installRouterPreset, installMinimalGitbash,
  findGitBash, fcChildDir, routerDir, gitbashDir,
}
