// 「省钱模式预设」（economy）独立包安装器 — 与主程序内置的生成逻辑同源：
// 从随包官方 Standard 快照（economy-standard/agent.cordis.yml）注入
// provider/model 完整 pair，生成 ~/.dsh/.agent-presets/economy。
//
// 用法：
//   node install-economy-preset.cjs [providerId] [modelId]
//   不带参数时交互询问（回车 = 默认值）。
//
// 与主程序 GUI 生成的 economy 唯一区别：快照版本以本包内的 NOTICE 为准；
// 主程序每次发布会随官方引擎同步更新本包（用户指示：跟随主程序更新省钱模式）。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline')

// 与 desktop/preset-gen.cjs 的 injectChildRoute 同款：spawn/fork 两行强制
// provider+model 双行注入，缺一即报错 —— 绝不静默降级为"只写 model、
// 继承主 Agent provider"的不确定行为。
function injectChildRoute(src, providerId, modelId) {
  if (!providerId || !modelId) throw new Error('providerId 和 modelId 都必须提供')
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
    throw new Error('注入失败：Standard 快照中找不到 spawn/fork 配置行（快照与当前 Harness 版本不匹配？）')
  }
  return out
}

function ask(rl, question, def) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      const v = String(answer || '').trim()
      resolve(v || def)
    })
  })
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const providerId = process.argv[2] || (await ask(rl, 'providerId（服务商路由标识，如 deepseek）[deepseek]: ', 'deepseek'))
    const modelId = process.argv[3] || (await ask(rl, 'modelId（子 Agent 模型，如 deepseek-v4-flash）[deepseek-v4-flash]: ', 'deepseek-v4-flash'))
    rl.close()
    if (!providerId || !modelId) throw new Error('providerId/modelId 不能为空')

    const stdYml = path.join(__dirname, 'economy-standard', 'agent.cordis.yml')
    if (!fs.existsSync(stdYml)) throw new Error('缺少官方 Standard 快照 economy-standard/agent.cordis.yml（包不完整）')

    let src = fs.readFileSync(stdYml, 'utf8')
    src = injectChildRoute(src, providerId, modelId)

    const root = path.join(os.homedir(), '.dsh', '.agent-presets')
    const dest = path.join(root, 'economy')
    const tmp = path.join(root, `.economy.tmp-${process.pid}`)
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'agent.cordis.yml'), src)
    fs.writeFileSync(path.join(tmp, 'preset.yml'), [
      'name: 省钱模式',
      `description: 基于官方 Standard 预设（快照自 @deepseek-ai/dsh，见 economy-standard/NOTICE）+ 子 Agent 默认路由注入（${providerId}/${modelId}）。普通/分支/嵌套子 Agent 使用所选便宜模型。省钱模式不覆盖 Workflow/Ralph worker：Workflow 未显式指定模型时、以及当前内置 Ralph，默认继承主 Agent 路由，可能按主模型计费。`,
      'order: 5',
    ].join('\n') + '\n')
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(tmp, dest)

    console.log('已生成省钱模式预设：' + dest)
    console.log('在 GUI（模式切换）或 dsh 设置中将默认预设切换为 economy（显示名「省钱模式」）即生效。')
  } finally {
    rl.close()
  }
}

main().catch((e) => { console.error('安装失败：' + String((e && e.message) || e)); process.exit(1) })
