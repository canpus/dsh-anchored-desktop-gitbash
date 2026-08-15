// M7 upgrade SOP — Stage 3 thin-shell form.
// The full-auto upgrade (fetch → checkout → install → build → smoke → rollback)
// now lives in desktop/updater.js as the single source of truth; it drives
// both the GUI "检查更新" button and this CLI entry.
//
// Usage:
//   node scripts/upgrade-upstream.mjs check    — compare remote vs locked commit
//   node scripts/upgrade-upstream.mjs upgrade  — full-auto upgrade with rollback
//
// Post-upgrade SOP (Agent, after a successful upgrade):
//   1. Record in History_log.md: 阶段条目 + 上游 commit 变更 + 冒烟结果;
//   2. Note any shell-config.json auto-adaptation (startCommand/port/ready);
//   3. Re-run the desktop smoke (DSH_DESKTOP_SMOKE=15000 npm start in desktop/).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? 'check'
if (!['check', 'upgrade'].includes(mode)) {
  console.log('usage: node scripts/upgrade-upstream.mjs <check|upgrade>')
  process.exit(2)
}

const res = spawnSync(process.execPath, [path.join(ROOT, 'desktop', 'updater.js'), mode], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  timeout: 60 * 60_000,
})
if (res.status === 0 && mode === 'upgrade') {
  console.log('\n[upgrade-sop] 升级成功。后续（Agent 执行）：')
  console.log('  1. History_log.md 新增阶段条目（上游 commit 变更 + 冒烟结果）；')
  console.log('  2. 核对 shell-config.json 是否被自动适配；')
  console.log('  3. desktop 目录跑 DSH_DESKTOP_SMOKE=15000 npm start 复核。')
}
process.exit(res.status ?? 1)
