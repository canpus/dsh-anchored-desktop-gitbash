// Preset generators — the single source of truth shared by main.js (model
// dialog) and CLI maintenance. Generates user presets under ~/.dsh/.agent-presets/
// from the bundled templates under desktop/presets/.
//
//   fc-child         anchored-standard template (upstream
//                    xiaobright/dsh-anchored-standard @6472c1c) + child-model
//                    agentOptions injected on the spawn/fork subagent rows.
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
// from the bundled anchored-standard template. Re-applying a model re-derives
// everything from the current template.
function generateFcChild(modelId, { desktopDir } = {}) {
  const base = desktopDir || __dirname
  const templateDir = path.join(base, 'presets', 'anchored-standard')
  const src = fs.readFileSync(path.join(templateDir, 'agent.cordis.yml'), 'utf8')
  const out = injectChildModel(src, modelId)
  fs.mkdirSync(fcChildDir(), { recursive: true })
  fs.writeFileSync(path.join(fcChildDir(), 'agent.cordis.yml'), out)
  // The preset-local plugin ships by relative path from the composition —
  // copy it verbatim so the preset keeps working standalone. The old
  // first-prompt-filter plugin was absorbed upstream (suppressedContextSources
  // in tool-bootstrap) — drop any leftover copy from earlier generations.
  for (const plugin of ['tool-bootstrap.mjs']) {
    fs.copyFileSync(path.join(templateDir, plugin), path.join(fcChildDir(), plugin))
  }
  fs.rmSync(path.join(fcChildDir(), 'first-prompt-filter.mjs'), { force: true })
  fs.writeFileSync(
    path.join(fcChildDir(), 'preset.yml'),
    [
      'name: 自定义子模型',
      'description: 基于社区 Anchored Standard 方案（V4Pro 锚定：首轮 Minimal 轨迹 = persona 对齐 + shell/read 工具目录 + 1024 输出封顶 + 无自动注入；首个工具调用或首个回复后恢复 Standard 全量工具与上下文注入）+ 子 Agent 默认模型可自选（在窗口标题栏「子 Agent 模型」中设置）；其余能力与标准模式一致。',
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

// Install the reviewed minimal-gitbash preset (upstream
// lices/dsh-gitbash-preset @0.1.1, MIT bundled) from the bundled template,
// verbatim. The executor auto-detects Git-for-Windows bash (GIT_BASH → install
// roots → PATH) and gates commands on danger-full-access — author-original, no
// local drift. The preset group disables itself on non-win32.
function installMinimalGitbash({ desktopDir } = {}) {
  const base = desktopDir || __dirname
  const templateDir = path.join(base, 'presets', 'minimal-gitbash')
  fs.mkdirSync(gitbashDir(), { recursive: true })
  for (const f of ['agent.cordis.yml', 'preset.yml', 'gitbash-executor.mjs']) {
    fs.copyFileSync(path.join(templateDir, f), path.join(gitbashDir(), f))
  }
  return gitbashDir()
}

module.exports = { generateFcChild, installRouterPreset, installMinimalGitbash, fcChildDir, routerDir, gitbashDir }
